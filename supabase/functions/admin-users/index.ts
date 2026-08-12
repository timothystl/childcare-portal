import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const ALLOWED_ORIGIN = "https://mdo.timothystl.org";

function corsHeaders(req: Request): Record<string, string> {
    const origin = req.headers.get("origin") || "";
    return {
        "Access-Control-Allow-Origin":  origin === ALLOWED_ORIGIN ? ALLOWED_ORIGIN : "",
        "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
    };
}

serve(async (req) => {
    const ch = corsHeaders(req);

    if (req.method === "OPTIONS") {
        return new Response("ok", { headers: ch });
    }

    try {
        // Verify caller is authenticated
        const authHeader = req.headers.get("Authorization");
        if (!authHeader) {
            return new Response(JSON.stringify({ error: "No authorization header" }), {
                status: 401, headers: { ...ch, "Content-Type": "application/json" },
            });
        }

        const supabaseUrl    = Deno.env.get("SUPABASE_URL")!;
        const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
        const anonKey        = Deno.env.get("SUPABASE_ANON_KEY")!;

        // Validate the caller's JWT
        const callerClient = createClient(supabaseUrl, anonKey, {
            global: { headers: { Authorization: authHeader } },
        });
        const { data: { user }, error: authError } = await callerClient.auth.getUser();
        if (authError || !user) {
            return new Response(JSON.stringify({ error: "Unauthorized" }), {
                status: 401, headers: { ...ch, "Content-Type": "application/json" },
            });
        }

        // Admin client using service role key
        const adminClient = createClient(supabaseUrl, serviceRoleKey, {
            auth: { autoRefreshToken: false, persistSession: false },
        });

        // Verify caller has 'full' admin role
        const { data: roleSetting } = await adminClient
            .from('settings')
            .select('value')
            .eq('key', 'admin_roles')
            .maybeSingle();
        // FS10: this used to read `Object.keys(roles).length > 0 && …`, which
        // FAILED OPEN — an empty or missing admin_roles skipped the check and
        // handed any signed-in user the Auth Admin API. It also treated the
        // value as an object, but settings.value is a TEXT column, so `roles`
        // was a string and roles[email] was always undefined (the same T3 trap
        // recorded in CLAUDE.md).
        //
        // Now: parse defensively, then fail CLOSED. No roles configured means
        // nobody is an admin — which matches is_admin() in the database, so the
        // two cannot disagree about who is privileged.
        let roles: Record<string, string> = {};
        const rawRoles = roleSetting?.value;
        if (rawRoles && typeof rawRoles === 'object') {
            roles = rawRoles as Record<string, string>;
        } else if (typeof rawRoles === 'string') {
            try {
                const parsed = JSON.parse(rawRoles);
                if (parsed && typeof parsed === 'object') roles = parsed;
            } catch {
                console.error('admin-users: admin_roles is not valid JSON — denying');
            }
        }

        // Match case-insensitively: admin_roles is hand-edited, and the same
        // rule applies in the database predicate.
        const callerEmail = (user.email || '').toLowerCase().trim();
        const callerRole = Object.entries(roles)
            .find(([k]) => k.toLowerCase().trim() === callerEmail)?.[1];

        if (callerRole !== 'full') {
            return new Response(JSON.stringify({ error: "Forbidden: full admin role required" }), {
                status: 403, headers: { ...ch, "Content-Type": "application/json" },
            });
        }

        const body = await req.json();
        const { action, email, password, userId } = body;

        if (action === "list") {
            const { data, error } = await adminClient.auth.admin.listUsers();
            if (error) throw error;
            // Return only the fields the UI needs
            const users = data.users.map(u => ({
                id:         u.id,
                email:      u.email,
                created_at: u.created_at,
                last_sign_in_at: u.last_sign_in_at,
            }));
            return new Response(JSON.stringify({ users }), {
                headers: { ...ch, "Content-Type": "application/json" },
            });
        }

        if (action === "create") {
            if (!email || !password) {
                return new Response(JSON.stringify({ error: "email and password are required" }), {
                    status: 400, headers: { ...ch, "Content-Type": "application/json" },
                });
            }
            const { data, error } = await adminClient.auth.admin.createUser({
                email,
                password,
                email_confirm: true,
            });
            if (error) throw error;
            return new Response(JSON.stringify({ user: { id: data.user.id, email: data.user.email } }), {
                headers: { ...ch, "Content-Type": "application/json" },
            });
        }

        if (action === "delete") {
            if (!userId) {
                return new Response(JSON.stringify({ error: "userId is required" }), {
                    status: 400, headers: { ...ch, "Content-Type": "application/json" },
                });
            }
            const { error } = await adminClient.auth.admin.deleteUser(userId);
            if (error) throw error;
            return new Response(JSON.stringify({ success: true }), {
                headers: { ...ch, "Content-Type": "application/json" },
            });
        }

        return new Response(JSON.stringify({ error: "Unknown action" }), {
            status: 400, headers: { ...ch, "Content-Type": "application/json" },
        });

    } catch (err) {
        return new Response(JSON.stringify({ error: err.message }), {
            status: 500, headers: { ...ch, "Content-Type": "application/json" },
        });
    }
});
