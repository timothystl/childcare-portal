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

// Public endpoint reached from the "still interested?" link in tour-reminder
// emails. The token is an unguessable UUID stored only server-side and emailed
// only to the applicant, so no separate auth is required — knowing the token
// IS the authorization, same trust model as a password-reset link.
serve(async (req) => {
    const ch = corsHeaders(req);

    if (req.method === "OPTIONS") {
        return new Response("ok", { headers: ch });
    }

    try {
        const { token, interested } = await req.json();
        if (!token || typeof interested !== "boolean") {
            return new Response(
                JSON.stringify({ error: "Missing token or interested" }),
                { status: 400, headers: { ...ch, "Content-Type": "application/json" } }
            );
        }

        const serviceClient = createClient(
            Deno.env.get("SUPABASE_URL")!,
            Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
            { auth: { autoRefreshToken: false, persistSession: false } },
        );

        const { data: app, error: fetchErr } = await serviceClient
            .from("waitlist_applications")
            .select("id, child_name, status")
            .eq("interest_token", token)
            .maybeSingle();

        if (fetchErr || !app) {
            return new Response(
                JSON.stringify({ error: "This link is invalid or has expired." }),
                { status: 404, headers: { ...ch, "Content-Type": "application/json" } }
            );
        }

        const isActive = ["pending", "offered", "accepted"].includes(app.status);

        if (interested) {
            await serviceClient
                .from("waitlist_applications")
                .update({ still_interested_confirmed_at: new Date().toISOString() })
                .eq("id", app.id);
        } else if (isActive) {
            await serviceClient
                .from("waitlist_applications")
                .update({
                    status:         "declined",
                    archived_at:    new Date().toISOString(),
                    archive_reason: "no_longer_needed",
                })
                .eq("id", app.id);
        }

        return new Response(
            JSON.stringify({ success: true, childName: app.child_name }),
            { status: 200, headers: { ...ch, "Content-Type": "application/json" } }
        );

    } catch (err) {
        return new Response(
            JSON.stringify({ error: err.message }),
            { status: 500, headers: { ...ch, "Content-Type": "application/json" } }
        );
    }
});
