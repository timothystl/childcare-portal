// ============================================================
// sweep-child-photos — enforce the one-week daily-photo retention
// ============================================================
// Parents are told on the page that daily photos are kept for about a week.
// Without something calling this, that sentence is false — the photos would sit
// in the bucket forever. The retention promise is the reason this exists.
//
// ⚠️ INCIDENT PHOTOS ARE NEVER SWEPT. sweep_expired_child_photos() filters to
// kind = 'daily'. Incident photographs are evidence: guidelines say 3 years,
// the statute of limitations is 5, and a major injury is kept until the child
// is 23. No cron should decide when injury documentation stops existing — the
// director removes those by hand.
//
// Order matters. The RPC deletes the ROWS and returns their paths, then the
// objects go. An orphaned object is invisible and recoverable; an orphaned row
// pointing at bytes that no longer exist renders as a broken photo in a
// parent's feed.
//
// Scheduled by pg_cron — see schedule_child_photo_sweep.sql. Requires the
// service role, so deploy with JWT verification ON: cron sends the service key,
// and nothing else should be able to trigger a bulk delete.

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

serve(async (_req) => {
    const admin = createClient(
        Deno.env.get("SUPABASE_URL") ?? "",
        Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "",
        { auth: { autoRefreshToken: false, persistSession: false } },
    );

    try {
        const { data: rows, error } = await admin.rpc("sweep_expired_child_photos");
        if (error) {
            console.error("sweep rpc:", error);
            return new Response(JSON.stringify({ error: "sweep_failed" }), {
                status: 500, headers: { "Content-Type": "application/json" },
            });
        }

        const paths = (rows ?? []).map((r: { removed_path: string }) => r.removed_path).filter(Boolean);
        if (!paths.length) {
            return new Response(JSON.stringify({ removed: 0 }), {
                status: 200, headers: { "Content-Type": "application/json" },
            });
        }

        // Storage remove caps out well below any plausible week of photos, but
        // chunk anyway so a busy week cannot silently drop the tail.
        let removed = 0;
        for (let i = 0; i < paths.length; i += 100) {
            const chunk = paths.slice(i, i + 100);
            const { error: rmErr } = await admin.storage.from("child-photos").remove(chunk);
            if (rmErr) {
                // The rows are already gone, so the photos are unreachable
                // either way. Log loudly rather than failing — a retry would
                // find nothing to delete and report success, hiding this.
                console.error("storage remove failed for chunk:", chunk, rmErr);
            } else {
                removed += chunk.length;
            }
        }

        console.log(`swept ${removed}/${paths.length} expired daily photos`);
        return new Response(JSON.stringify({ removed, rows_deleted: paths.length }), {
            status: 200, headers: { "Content-Type": "application/json" },
        });

    } catch (err) {
        console.error("sweep-child-photos:", err);
        return new Response(JSON.stringify({ error: "server_error" }), {
            status: 500, headers: { "Content-Type": "application/json" },
        });
    }
});
