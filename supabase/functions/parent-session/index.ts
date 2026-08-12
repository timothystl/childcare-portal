// ============================================================
// parent-session — login / refresh / sign-out for the parent portal
// ============================================================
// Issues a Supabase-signed access JWT carrying a `family_id` claim, so every
// parent-facing table can be protected by an ordinary RLS policy:
//
//     USING (family_id = (auth.jwt() ->> 'family_id')::uuid)
//
// The database enforces family isolation itself. A parent physically cannot
// fetch another family's photos, day logs, messages or incidents, whatever the
// browser asks for.
//
// ⚠️ THE ROLE CLAIM IS `parent_portal`, NEVER `authenticated`.
// Every admin table in this project is policied `FOR ALL TO authenticated
// USING (true)` — billing_invoices, staff (wages), admin_audit_log. Minting
// parents an `authenticated` token would hand all ~242 of them full read/write
// on the center's payroll and ledger. `parent_portal` is NOLOGIN and starts
// with zero table privileges (see parent_portal_phase0.sql); each parent-facing
// table grants to it explicitly as it is built.
//
// SIGNING: this project is on Supabase's LEGACY shared JWT secret (the anon key
// is HS256 and there is no auth.jwks table), so tokens are HS256-signed with
// that secret. It is NOT available to SQL or the management API — set it as a
// function secret:
//
//     supabase secrets set PARENT_JWT_SECRET="<Dashboard → Settings → API → JWT Secret>"
//
// Without it the function returns 500 rather than issuing an unverifiable token.
//
// Deploy with JWT verification OFF — parents authenticate here with email+PIN,
// they do not arrive holding a token:
//     supabase functions deploy parent-session --no-verify-jwt
// ============================================================

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const ALLOWED_ORIGINS = new Set([
    "https://mdo.timothystl.org",
    "http://localhost:8000",
]);

const ACCESS_TTL_SECONDS  = 60 * 60;            // 1 hour
const REFRESH_TTL_DAYS    = 30;

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

// ── JWT (HS256) ──────────────────────────────────────────────
// Hand-rolled rather than pulling a JWT library: this signs tokens that grant
// database access, and a compromised dependency here is a compromised database.
// Web Crypto is in the Deno runtime already.
function b64url(bytes: Uint8Array): string {
    let bin = "";
    for (const b of bytes) bin += String.fromCharCode(b);
    return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function b64urlJson(obj: unknown): string {
    return b64url(new TextEncoder().encode(JSON.stringify(obj)));
}

async function signJwt(payload: Record<string, unknown>, secret: string): Promise<string> {
    const header = { alg: "HS256", typ: "JWT" };
    const data   = `${b64urlJson(header)}.${b64urlJson(payload)}`;
    const key    = await crypto.subtle.importKey(
        "raw", new TextEncoder().encode(secret),
        { name: "HMAC", hash: "SHA-256" }, false, ["sign"],
    );
    const sig = new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(data)));
    return `${data}.${b64url(sig)}`;
}

// ── Refresh tokens ───────────────────────────────────────────
// Stored hashed. A refresh token IS a session, so the table must not hold
// anything usable if it leaks. SHA-256 is right here (not bcrypt): these are
// 256 bits of CSPRNG output, not guessable passwords, and the refresh path
// looks them up by hash on every call.
function newRefreshToken(): string {
    return b64url(crypto.getRandomValues(new Uint8Array(32)));
}

async function hashToken(token: string): Promise<string> {
    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token));
    return b64url(new Uint8Array(digest));
}

async function issueSession(
    admin: ReturnType<typeof createClient>,
    secret: string,
    familyId: string,
    parentSlot: number,
    deviceLabel: string | null,
) {
    const now = Math.floor(Date.now() / 1000);
    const accessToken = await signJwt({
        iss:         "supabase",
        role:        "parent_portal",   // NEVER "authenticated" — see header
        family_id:   familyId,
        parent_slot: parentSlot,
        iat:         now,
        exp:         now + ACCESS_TTL_SECONDS,
    }, secret);

    const refreshToken = newRefreshToken();
    const expiresAt    = new Date(Date.now() + REFRESH_TTL_DAYS * 86400_000).toISOString();

    const { error } = await admin.from("parent_refresh_tokens").insert({
        family_id:    familyId,
        parent_slot:  parentSlot,
        token_hash:   await hashToken(refreshToken),
        device_label: deviceLabel,
        expires_at:   expiresAt,
    });
    if (error) throw new Error(`could not store session: ${error.message}`);

    return {
        access_token:  accessToken,
        expires_in:    ACCESS_TTL_SECONDS,
        refresh_token: refreshToken,
        refresh_expires_at: expiresAt,
    };
}

serve(async (req) => {
    if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders(req) });
    if (req.method !== "POST")    return json(req, { error: "method_not_allowed" }, 405);

    const origin = req.headers.get("origin") || "";
    if (origin && !ALLOWED_ORIGINS.has(origin)) return json(req, { error: "forbidden" }, 403);

    const secret = Deno.env.get("PARENT_JWT_SECRET") ?? "";
    if (!secret) {
        console.error("PARENT_JWT_SECRET is not set — refusing to issue tokens");
        return json(req, { error: "server_misconfigured" }, 500);
    }

    const admin = createClient(
        Deno.env.get("SUPABASE_URL") ?? "",
        Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "",
    );

    let body: Record<string, unknown>;
    try { body = await req.json(); } catch { return json(req, { error: "bad_request" }, 400); }

    const action = String(body.action ?? "");

    try {
        // ── login ────────────────────────────────────────────
        if (action === "login") {
            const email = String(body.email ?? "").trim();
            const pin   = String(body.pin ?? "").trim();
            if (!email || !/^\d{4,8}$/.test(pin)) return json(req, { error: "invalid_credentials" }, 400);

            // family_login owns PIN verification, the bcrypt compare, the
            // attempt counter and the lockout. Do not reimplement any of it.
            const { data, error } = await admin.rpc("family_login", { p_email: email, p_pin: pin });
            if (error) return json(req, { error: "login_failed" }, 500);
            if (data?.error) return json(req, { error: data.error, attempts_left: data.attempts_left }, 401);

            const familyId   = data?.family?.id;
            const parentSlot = data?.isParent2 ? 2 : 1;
            if (!familyId) return json(req, { error: "login_failed" }, 500);

            const session = await issueSession(
                admin, secret, familyId, parentSlot,
                (body.device_label ? String(body.device_label) : null)?.slice(0, 120) ?? null,
            );
            return json(req, { ...session, family: data.family, parent_slot: parentSlot });
        }

        // ── refresh ──────────────────────────────────────────
        if (action === "refresh") {
            const token = String(body.refresh_token ?? "");
            if (!token) return json(req, { error: "invalid_refresh" }, 400);

            const hash = await hashToken(token);
            const { data: row, error } = await admin
                .from("parent_refresh_tokens")
                .select("id, family_id, parent_slot, expires_at, revoked_at, device_label")
                .eq("token_hash", hash)
                .maybeSingle();

            if (error) return json(req, { error: "refresh_failed" }, 500);
            if (!row || row.revoked_at || new Date(row.expires_at) < new Date()) {
                return json(req, { error: "invalid_refresh" }, 401);
            }

            // Rotate: the presented token is spent immediately. If it is ever
            // presented again the session is already gone, which is what turns
            // a stolen refresh token into a dead end rather than a standing key.
            await admin.from("parent_refresh_tokens")
                .update({ revoked_at: new Date().toISOString(), last_used_at: new Date().toISOString() })
                .eq("id", row.id);

            const session = await issueSession(
                admin, secret, row.family_id, row.parent_slot, row.device_label ?? null,
            );
            return json(req, session);
        }

        // ── sign out ─────────────────────────────────────────
        if (action === "signout") {
            const token = String(body.refresh_token ?? "");
            const all   = body.all_devices === true;

            if (token) {
                const hash = await hashToken(token);
                if (all) {
                    // Revoke every live session for this family, not just this
                    // device — "sign out everywhere" after a lost phone.
                    const { data: row } = await admin.from("parent_refresh_tokens")
                        .select("family_id").eq("token_hash", hash).maybeSingle();
                    if (row?.family_id) {
                        await admin.from("parent_refresh_tokens")
                            .update({ revoked_at: new Date().toISOString() })
                            .eq("family_id", row.family_id).is("revoked_at", null);
                    }
                } else {
                    await admin.from("parent_refresh_tokens")
                        .update({ revoked_at: new Date().toISOString() })
                        .eq("token_hash", hash).is("revoked_at", null);
                }
            }
            // Always 200: telling a caller whether a token existed is a probe.
            return json(req, { ok: true });
        }

        return json(req, { error: "unknown_action" }, 400);

    } catch (err) {
        console.error("parent-session:", err);
        return json(req, { error: "server_error" }, 500);
    }
});
