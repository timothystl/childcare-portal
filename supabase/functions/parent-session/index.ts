// ============================================================
// parent-session — Option B: parents as real Supabase Auth users
// ============================================================
// Email + PIN remains the credential. family_login still owns the bcrypt
// compare, the attempt counter and the lockout. What changed is what a
// successful login produces: a genuine Supabase session instead of a
// hand-signed HS256 token.
//
// WHY THE CHANGE. The Phase 0 version signed its own token with the project's
// LEGACY JWT secret. The dashboard states that secret is verification-only and
// on a deprecation path; the moment it is revoked, every token signed with it
// dies. Real auth users survive that rotation.
//
// ⚠️ WHY GIVING PARENTS `authenticated` IS SAFE NOW, AND WAS NOT THIS MORNING.
// An auth user's token carries role = 'authenticated'. Until the policy-scoping
// work, that role had blanket read/write on 27 tables including staff wages and
// the billing ledger — so this design would have been a breach. Every one of
// those is now scoped to is_admin(), so a parent gets NOTHING by default.
// Access comes only from explicit parent policies keyed through
// parent_accounts / parent_family_ids().
//
// That is also why there is no custom access-token hook rewriting the role
// claim: the boundary is table policies, not a hook that has to keep firing.
//
// Deploy with JWT verification OFF — parents arrive with an email and a PIN,
// not a token.
// ============================================================

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const ALLOWED_ORIGINS = new Set([
    "https://mdo.timothystl.org",
    "http://localhost:8000",
]);

function corsHeaders(req: Request): Record<string, string> {
    const origin = req.headers.get("origin") || "";
    return {
        "Access-Control-Allow-Origin":  ALLOWED_ORIGINS.has(origin) ? origin : "",
        "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
        "Access-Control-Allow-Methods": "POST, OPTIONS",
        "Content-Type": "application/json",
    };
}

function json(req: Request, body: unknown, status = 200): Response {
    return new Response(JSON.stringify(body), { status, headers: corsHeaders(req) });
}

// A password nobody ever learns — not the parent, not the browser. Parents
// authenticate with their PIN through family_login; this exists only because
// creating an auth user requires the column to be something. It is set once, at
// account creation, and never used again in the normal path.
function randomPassword(): string {
    const b = crypto.getRandomValues(new Uint8Array(48));
    return btoa(String.fromCharCode(...b)).replace(/[^a-zA-Z0-9]/g, "") + "aA1!";
}

serve(async (req) => {
    if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders(req) });
    if (req.method !== "POST")    return json(req, { error: "method_not_allowed" }, 405);

    const origin = req.headers.get("origin") || "";
    if (origin && !ALLOWED_ORIGINS.has(origin)) return json(req, { error: "forbidden" }, 403);

    const supabaseUrl = Deno.env.get("SUPABASE_URL") ?? "";
    const serviceKey  = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
    const anonKey     = Deno.env.get("SUPABASE_ANON_KEY") ?? "";

    const admin = createClient(supabaseUrl, serviceKey, {
        auth: { autoRefreshToken: false, persistSession: false },
    });

    let body: Record<string, unknown>;
    try { body = await req.json(); } catch { return json(req, { error: "bad_request" }, 400); }

    const action = String(body.action ?? "login");

    try {
        if (action !== "login") return json(req, { error: "unknown_action" }, 400);

        const email = String(body.email ?? "").trim().toLowerCase();
        const pin   = String(body.pin ?? "").trim();
        if (!email || !/^\d{4,8}$/.test(pin)) {
            return json(req, { error: "invalid_credentials" }, 400);
        }

        // 1. The PIN check. family_login owns bcrypt, the attempt counter and
        //    the lockout — none of that is reimplemented here.
        const { data: login, error: loginErr } =
            await admin.rpc("family_login", { p_email: email, p_pin: pin });
        if (loginErr) {
            console.error("family_login:", loginErr);
            return json(req, { error: "login_failed" }, 500);
        }
        if (login?.error) {
            return json(req, { error: login.error, attempts_left: login.attempts_left }, 401);
        }

        const familyId   = login?.family?.id;
        const parentSlot = login?.isParent2 ? 2 : 1;
        if (!familyId) return json(req, { error: "login_failed" }, 500);

        // 2. Find or create the auth user for this address. Public signups are
        //    disabled (S4); the service role creates users directly, which is
        //    unaffected by that and is the only way an account can appear here.
        let userId: string | null = null;

        const { data: existing } = await admin
            .from("parent_accounts").select("user_id").eq("email", email).maybeSingle();
        if (existing?.user_id) userId = existing.user_id;

        if (!userId) {
            const { data: created, error } = await admin.auth.admin.createUser({
                email,
                password: randomPassword(),
                email_confirm: true,          // no verification mail; the PIN is the proof
                user_metadata: { portal: "parent" },
            });
            if (error || !created?.user) {
                // A user can already exist without a parent_accounts row (an
                // admin who is also a parent, or a half-finished earlier login).
                // generateLink below resolves the address either way, so only a
                // genuine failure to resolve it is fatal — recorded, not thrown.
                console.error("createUser:", error);
            } else {
                userId = created.user.id;
            }
        }

        // 3. Mint a one-time token for this address and redeem it for a real
        //    session. generateLink does NOT send mail — it only returns the
        //    token — so nothing lands in the parent's inbox.
        //
        //    Why not sign in with a password we rotate each time: an admin
        //    password update revokes every existing session for that user, so
        //    logging in on a phone would silently kill the session on a laptop.
        //    A one-time token leaves other sessions alone.
        const { data: linked, error: linkErr } = await admin.auth.admin.generateLink({
            type: "magiclink",
            email,
        });
        const tokenHash = linked?.properties?.hashed_token;
        if (linkErr || !tokenHash) {
            console.error("generateLink:", linkErr);
            return json(req, { error: "session_failed" }, 500);
        }
        userId = linked?.user?.id ?? userId;
        if (!userId) return json(req, { error: "session_failed" }, 500);

        // 4. The mapping that every parent RLS policy reads. Written with the
        //    service role; parents cannot see or change it. It goes in before
        //    the session is handed out, so a token never exists without the
        //    row that scopes it.
        const { error: mapErr } = await admin.from("parent_accounts").upsert({
            user_id: userId,
            family_id: familyId,
            parent_slot: parentSlot,
            email,
            last_login_at: new Date().toISOString(),
        }, { onConflict: "user_id" });
        if (mapErr) {
            console.error("parent_accounts upsert:", mapErr);
            return json(req, { error: "session_failed" }, 500);
        }

        // 5. Redeem the token. GoTrue keys the lookup on the token TYPE as well
        //    as the hash, and which type a magic-link hash answers to has moved
        //    between releases, so both spellings are tried rather than assumed.
        //    A single generated hash is valid for either attempt because a
        //    failed verify does not consume it.
        const publicClient = createClient(supabaseUrl, anonKey, {
            auth: { autoRefreshToken: false, persistSession: false },
        });

        let session = null;
        let lastErr: unknown = null;
        for (const type of ["magiclink", "email"] as const) {
            const { data, error } = await publicClient.auth.verifyOtp({
                token_hash: tokenHash, type,
            });
            if (data?.session) { session = data.session; break; }
            lastErr = error;
        }
        if (!session) {
            console.error("verifyOtp:", lastErr);
            return json(req, { error: "session_failed" }, 500);
        }

        return json(req, {
            access_token:  session.access_token,
            refresh_token: session.refresh_token,
            expires_at:    session.expires_at,
            family:        login.family,
            parent_slot:   parentSlot,
        });

    } catch (err) {
        console.error("parent-session:", err);
        return json(req, { error: "server_error" }, 500);
    }
});
