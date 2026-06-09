import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

// Shift windows in 24-hr minutes
const SHIFT_AM_START = 8 * 60 + 15;   // 08:15
const SHIFT_AM_END   = 13 * 60 + 15;  // 13:15
const SHIFT_PM_START = 12 * 60;        // 12:00
const SHIFT_PM_END   = 17 * 60;        // 17:00

function minutesNow(tz: string): number {
    const str = new Date().toLocaleString("en-US", { timeZone: tz, hour: "2-digit", minute: "2-digit", hour12: false });
    const [h, m] = str.split(":").map(Number);
    return h * 60 + m;
}

function localDateStr(tz: string): string {
    return new Date().toLocaleDateString("en-CA", { timeZone: tz }); // YYYY-MM-DD
}

function escHtml(s: string): string {
    return String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

serve(async (req) => {
    // Only allow service role calls
    const auth = req.headers.get("Authorization") || "";
    const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    if (!auth.includes(serviceRoleKey)) {
        return new Response(JSON.stringify({ error: "Unauthorized" }), { status: 401 });
    }

    try {
        const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
        const sb = createClient(supabaseUrl, serviceRoleKey);

        // Load geofence settings for grace_minutes, notify_email, and timezone
        const { data: settingRow } = await sb.from("settings").select("value").eq("key", "geofence").maybeSingle();
        const settings = settingRow?.value || {};
        const graceMins:  number = settings.grace_minutes ?? 15;
        const notifyEmail: string = settings.notify_email  ?? "";
        // Default to US Central time if no timezone configured
        const tz = settings.timezone ?? "America/Chicago";

        const workDate = localDateStr(tz);
        const nowMins  = minutesNow(tz);

        // Only run Mon–Fri
        const dow = new Date(workDate + "T12:00:00Z").getUTCDay(); // 0=Sun 6=Sat
        if (dow === 0 || dow === 6) {
            return new Response(JSON.stringify({ skipped: "weekend" }), { status: 200 });
        }

        // Determine which alert types to check based on current time
        const checkAmIn    = nowMins >= SHIFT_AM_START + graceMins;
        const checkPmIn    = nowMins >= SHIFT_PM_START + graceMins;
        const checkAmOut   = nowMins >= SHIFT_AM_END   + graceMins;
        const checkPmOut   = nowMins >= SHIFT_PM_END   + graceMins;

        if (!checkAmIn && !checkPmIn && !checkAmOut && !checkPmOut) {
            return new Response(JSON.stringify({ skipped: "too early" }), { status: 200 });
        }

        // Fetch today's schedules with staff info
        const { data: schedules } = await sb
            .from("staff_schedules")
            .select("staff_id, shift, staff:staff_id(id, name)")
            .eq("work_date", workDate);

        // Fetch today's clock events
        const { data: clockEvents } = await sb
            .from("staff_clock_events")
            .select("staff_id, clock_in, clock_out")
            .eq("work_date", workDate);

        // Fetch already-sent notifications today to avoid dupes
        const { data: sentNotifs } = await sb
            .from("staff_clock_notifications")
            .select("staff_id, notification_type")
            .eq("work_date", workDate);

        const schedList   = schedules   || [];
        const clockList   = clockEvents || [];
        const sentList    = sentNotifs  || [];

        // Build lookup sets
        const clockedInIds = new Set(clockList.filter(e => e.clock_in).map(e => e.staff_id));
        const openClockIds = new Set(
            clockList.filter(e => e.clock_in && !e.clock_out).map(e => e.staff_id)
        );
        const sentSet = new Set(sentList.map(n => `${n.staff_id}:${n.notification_type}`));

        // Build a map of staffId → set of shifts scheduled today
        const staffShifts = new Map<string, Set<string>>();
        const staffNames  = new Map<string, string>();
        for (const sched of schedList) {
            const id   = sched.staff_id;
            const name = (sched.staff as { name?: string })?.name ?? "Staff";
            if (!staffShifts.has(id)) staffShifts.set(id, new Set());
            staffShifts.get(id)!.add(sched.shift as string);
            staffNames.set(id, name);
        }

        const alerts: Array<{ staffId: string; staffName: string; type: string }> = [];

        // Missed clock-in checks
        for (const [staffId, shifts] of staffShifts) {
            const staffName = staffNames.get(staffId) ?? "Staff";
            if (shifts.has("am") && checkAmIn && !clockedInIds.has(staffId)) {
                const type = "missed_clock_in_am";
                if (!sentSet.has(`${staffId}:${type}`)) alerts.push({ staffId, staffName, type });
            }
            if (shifts.has("pm") && checkPmIn && !clockedInIds.has(staffId)) {
                const type = "missed_clock_in_pm";
                if (!sentSet.has(`${staffId}:${type}`)) alerts.push({ staffId, staffName, type });
            }
        }

        // Missed clock-out: fire only after that staff member's last scheduled shift ends
        for (const staffId of openClockIds) {
            const shifts    = staffShifts.get(staffId);
            const staffName = staffNames.get(staffId) ?? "Staff";
            // Use the latest shift deadline this person is scheduled for
            const deadline  = shifts?.has("pm") ? checkPmOut : checkAmOut;
            if (!deadline) continue;
            const type = "missed_clock_out";
            if (!sentSet.has(`${staffId}:${type}`)) alerts.push({ staffId, staffName, type });
        }

        if (!alerts.length) {
            return new Response(JSON.stringify({ checked: true, alerts: 0 }), { status: 200 });
        }

        const apiKey    = Deno.env.get("RESEND_API_KEY");
        const fromEmail = Deno.env.get("RESEND_FROM_EMAIL") || "onboarding@resend.dev";
        const replyTo   = Deno.env.get("RESEND_REPLY_TO")   || fromEmail;
        const workerUrl = Deno.env.get("WORKER_URL") || ""; // e.g. https://mdo.timothystl.org

        const results = await Promise.allSettled(alerts.map(async alert => {
            // 1. Send push notification to staff member
            if (workerUrl) {
                await fetch(`${workerUrl}/send-staff-push`, {
                    method:  "POST",
                    headers: { "Authorization": `Bearer ${serviceRoleKey}`, "Content-Type": "application/json" },
                    body: JSON.stringify({
                        staff_id: alert.staffId,
                        title:    alert.type === "missed_clock_out" ? "Don't forget to clock out!" : "Don't forget to clock in!",
                        body:     alert.type === "missed_clock_out"
                            ? "You're still shown as clocked in. Please clock out when you leave."
                            : `Your shift started and you haven't clocked in yet. Please clock in now.`,
                    }),
                }).catch(() => {});
            }

            // 2. Send director email if notify_email configured
            if (notifyEmail && apiKey) {
                const typeLabels: Record<string, string> = {
                    missed_clock_in_am:  "hasn't clocked in for their AM shift",
                    missed_clock_in_pm:  "hasn't clocked in for their PM shift",
                    missed_clock_out:    "hasn't clocked out and is still shown as clocked in",
                };
                const label = typeLabels[alert.type] ?? alert.type;
                const html = `
<!DOCTYPE html><html lang="en">
<head><meta charset="UTF-8"></head>
<body style="margin:0;padding:0;font-family:Georgia,serif;background:#f4f4f4;">
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#f4f4f4;padding:32px 16px;">
    <tr><td align="center">
      <table width="100%" cellpadding="0" cellspacing="0" style="max-width:480px;background:#fff;border-radius:12px;overflow:hidden;box-shadow:0 2px 12px rgba(0,0,0,.08);">
        <tr><td style="background:#1e40af;padding:22px 32px;text-align:center;">
          <p style="margin:0;color:#bfdbfe;font-size:12px;letter-spacing:.06em;text-transform:uppercase;">Timothy Lutheran Church</p>
          <h1 style="margin:6px 0 0;color:#fff;font-size:18px;font-weight:700;">🕐 Missed Clock Alert</h1>
        </td></tr>
        <tr><td style="padding:24px 32px;">
          <p style="color:#333;font-size:15px;margin:0 0 12px;"><strong>${escHtml(alert.staffName)}</strong> ${escHtml(label)} today (${escHtml(workDate)}).</p>
          <p style="color:#555;font-size:13px;">This is an automated reminder. Please follow up with them directly if needed.</p>
        </td></tr>
        <tr><td style="background:#f8fafc;padding:12px 32px;text-align:center;border-top:1px solid #e2e8f0;">
          <p style="margin:0;color:#94a3b8;font-size:11px;">Automated alert from the MDO Staff Clock-In system.</p>
        </td></tr>
      </table>
    </td></tr>
  </table>
</body></html>`;

                await fetch("https://api.resend.com/emails", {
                    method:  "POST",
                    headers: { "Authorization": `Bearer ${apiKey}`, "Content-Type": "application/json" },
                    body: JSON.stringify({
                        from:     fromEmail,
                        to:       [notifyEmail],
                        reply_to: replyTo,
                        subject:  `🕐 Missed Clock — ${alert.staffName} — ${workDate}`,
                        html,
                    }),
                }).catch(() => {});
            }

            // 3. Record notification to prevent duplicates. Use upsert with
            // ignoreDuplicates so a concurrent/retried run is a no-op instead of
            // a unique-violation — and so the dedupe row is always written.
            // (A plain insert with the non-existent .onConflict().ignore() chain
            // rejects and leaves no record, re-alerting every 15 minutes.)
            await sb.from("staff_clock_notifications").upsert({
                staff_id:          alert.staffId,
                work_date:         workDate,
                notification_type: alert.type,
            }, { onConflict: "staff_id,work_date,notification_type", ignoreDuplicates: true });
        }));

        const sent = results.filter(r => r.status === "fulfilled").length;
        return new Response(JSON.stringify({ checked: true, alerts: alerts.length, sent }), { status: 200 });

    } catch (err) {
        return new Response(JSON.stringify({ error: (err as Error).message }), { status: 500 });
    }
});
