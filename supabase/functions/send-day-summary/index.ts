// ============================================================
// send-day-summary — one end-of-day notification per family
// ============================================================
// The notification policy from PARENT_PORTAL_PLAN §5: messages, one photo a
// day, and incidents interrupt a parent. EVERYTHING ELSE waits for this. A
// parent who gets pinged for each diaper stops reading the pings, and then the
// incident notification — the one that matters — arrives in a stream they have
// learned to ignore.
//
// One notification per FAMILY, not per child: both parents share a family and
// the plan says both get notified. Two children means one message naming both,
// not two buzzes.
//
// Scheduled at 23:00 UTC = 6pm Central, an hour after the 5pm close, so late
// pickups are already logged. Nothing is sent to a family whose children have
// no events — silence is the correct summary of a day the child did not attend.

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const WORKER_ORIGIN = "https://mdo.timothystl.org";

serve(async (_req) => {
    const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
    const admin = createClient(Deno.env.get("SUPABASE_URL") ?? "", serviceKey, {
        auth: { autoRefreshToken: false, persistSession: false },
    });

    try {
        const careDate = new Date().toLocaleDateString("en-CA", { timeZone: "America/Chicago" });

        const { data: events, error } = await admin
            .from("child_day_events")
            .select("student_id, event_type, detail, students!inner(child_name, family_id)")
            .eq("care_date", careDate);

        if (error) {
            console.error("events:", error);
            return json({ error: "query_failed" }, 500);
        }
        if (!events?.length) {
            console.log(`no events for ${careDate}; nothing sent`);
            return json({ families: 0, sent: 0 });
        }

        // Group by family, then by child within it.
        const byFamily = new Map<string, Map<string, string[]>>();
        for (const e of events as any[]) {
            const famId = e.students?.family_id;
            const name  = (e.students?.child_name || "").split(" ")[0] || "your child";
            if (!famId) continue;
            if (!byFamily.has(famId)) byFamily.set(famId, new Map());
            const kids = byFamily.get(famId)!;
            if (!kids.has(name)) kids.set(name, []);
            kids.get(name)!.push(e.event_type);
        }

        let sent = 0;
        for (const [familyId, kids] of byFamily) {
            const parts: string[] = [];
            for (const [name, types] of kids) {
                const naps    = types.filter(t => t === "nap_start").length;
                const meals   = types.filter(t => t === "meal").length;
                const diapers = types.filter(t => t === "diaper").length;
                const bottles = types.filter(t => t === "bottle").length;

                // Only mention what actually happened. "0 naps, 0 bottles" reads
                // like a system report; a parent wants the sentence a teacher
                // would say at the door.
                const bits: string[] = [];
                if (naps)    bits.push(naps === 1 ? "1 nap" : `${naps} naps`);
                if (meals)   bits.push(meals === 1 ? "1 meal" : `${meals} meals`);
                if (bottles) bits.push(bottles === 1 ? "1 bottle" : `${bottles} bottles`);
                if (diapers) bits.push(diapers === 1 ? "1 diaper change" : `${diapers} diaper changes`);

                parts.push(bits.length ? `${name}: ${bits.join(", ")}` : `${name}: checked in`);
            }

            const res = await fetch(`${WORKER_ORIGIN}/send-push`, {
                method: "POST",
                headers: {
                    "Content-Type":  "application/json",
                    "Authorization": `Bearer ${serviceKey}`,
                },
                body: JSON.stringify({
                    family_id: familyId,
                    title: "Today at MDO",
                    body:  `${parts.join(" · ")}. Open the portal for the full day.`,
                }),
            });
            if (res.ok) sent++;
            else console.error("send-push failed for family", familyId, res.status);
        }

        console.log(`day summary ${careDate}: ${sent}/${byFamily.size} families notified`);
        return json({ families: byFamily.size, sent });

    } catch (err) {
        console.error("send-day-summary:", err);
        return json({ error: "server_error" }, 500);
    }
});

function json(body: unknown, status = 200): Response {
    return new Response(JSON.stringify(body), {
        status, headers: { "Content-Type": "application/json" },
    });
}
