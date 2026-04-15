// ============================================================
// EDGE FUNCTION: auto-clockout-check
//
// Called every 15 minutes by pg_cron (Mon–Fri).
// Enforces automatic clock-outs for:
//   • Missed lunch punch   (15-min grace after scheduled lunch_out)
//   • Missed end-of-shift  (15-min grace after scheduled_end)
//   • 5:00 pm hard cutoff  (closes every open punch)
//
// Sends a director notification email for each auto-clockout.
// Writes an audit row to auto_clockout_log for every action.
// Idempotent: re-checks the log table to prevent duplicate alerts.
//
// Authorization: caller must pass the CRON_SECRET as a Bearer token.
// ============================================================

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const TIMEZONE = "America/Chicago";

// ── Helpers ────────────────────────────────────────────────────

/** Return the current wall-clock moment expressed in the given IANA timezone. */
function nowInTZ(tz: string): Date {
    // Create a date whose local fields reflect the TZ-adjusted time.
    const str = new Date().toLocaleString("en-US", { timeZone: tz });
    return new Date(str);
}

/** Format a UTC ISO string as a readable local time in America/Chicago. */
function fmtChicago(isoStr: string): string {
    return new Date(isoStr).toLocaleString("en-US", {
        timeZone: TIMEZONE,
        weekday: "short",
        month:   "short",
        day:     "numeric",
        hour:    "numeric",
        minute:  "2-digit",
        hour12:  true,
    });
}

/** "HH:MM" → total minutes since midnight. */
function timeToMinutes(t: string): number {
    const [h, m] = t.split(":").map(Number);
    return h * 60 + m;
}

/** Build a UTC Date from a work_date string (YYYY-MM-DD) and a "HH:MM"
 *  time string that is interpreted as America/Chicago local time. */
function chicagoTimeToUTC(workDate: string, timeHHMM: string): Date {
    // Build an ISO-ish string with no TZ offset and parse it as Chicago time.
    // Approach: create the date in the format the Intl engine can parse.
    const dtStr = `${workDate}T${timeHHMM}:00`;

    // We need to find the UTC equivalent of "workDate timeHHMM" in Chicago.
    // Use the Temporal-lite trick: format a known UTC instant in Chicago and
    // binary-search — but for our use case a simpler method suffices:
    // create a Date assuming UTC, then adjust by the TZ offset at that moment.

    // Step 1: parse as if it were UTC (gives us a starting point)
    const utcGuess = new Date(dtStr + "Z");

    // Step 2: find what "local" Chicago time that UTC maps to
    const chiStr = utcGuess.toLocaleString("en-US", {
        timeZone: TIMEZONE,
        hour12:   false,
        year:     "numeric", month: "2-digit", day: "2-digit",
        hour:     "2-digit", minute: "2-digit", second: "2-digit",
    });
    // chiStr looks like "04/15/2026, 07:30:00"
    const chiDate = new Date(chiStr.replace(",", ""));
    const offsetMs = utcGuess.getTime() - chiDate.getTime();

    // Step 3: the true UTC time is our original naïve parse + offset
    return new Date(new Date(dtStr).getTime() + offsetMs);
}

// ── Email ──────────────────────────────────────────────────────

interface AlertPayload {
    staffName:     string;
    scheduledTime: string | null;
    actualTime:    string;
    triggerType:   string;
    workDate:      string;
}

async function sendDirectorAlert(
    payload: AlertPayload,
    directorEmail: string,
    resendApiKey: string,
    fromEmail: string,
): Promise<void> {
    const typeLabel: Record<string, string> = {
        auto_lunch:          "Missed Lunch Punch",
        auto_end_of_shift:   "Missed End-of-Shift Punch",
        auto_hard_cutoff:    "5:00 PM Hard Cutoff",
    };
    const label = typeLabel[payload.triggerType] ?? payload.triggerType;

    const subject = `[MDO Auto Clock-Out] ${payload.staffName} — ${label}`;

    const scheduledRow = payload.scheduledTime
        ? `<tr>
             <td style="padding:6px 12px;color:#555;font-weight:600;">Scheduled punch&nbsp;out</td>
             <td style="padding:6px 12px;">${payload.scheduledTime}</td>
           </tr>`
        : "";

    const html = `
<!DOCTYPE html>
<html lang="en">
<head><meta charset="UTF-8"></head>
<body style="margin:0;padding:0;font-family:'Helvetica Neue',Arial,sans-serif;background:#f4f4f4;">
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#f4f4f4;padding:28px 16px;">
    <tr><td align="center">
      <table width="100%" cellpadding="0" cellspacing="0"
             style="max-width:520px;background:#fff;border-radius:10px;overflow:hidden;
                    box-shadow:0 2px 10px rgba(0,0,0,.10);">

        <!-- Header -->
        <tr>
          <td style="background:#01294A;padding:22px 28px;text-align:center;">
            <p style="margin:0;color:#F5B731;font-size:11px;letter-spacing:.07em;text-transform:uppercase;font-weight:700;">
              Timothy Lutheran MDO
            </p>
            <h1 style="margin:6px 0 0;color:#fff;font-size:18px;font-weight:700;">
              Auto Clock-Out Alert
            </h1>
          </td>
        </tr>

        <!-- Body -->
        <tr>
          <td style="padding:24px 28px;">
            <p style="margin:0 0 16px;color:#333;font-size:15px;line-height:1.6;">
              An automatic clock-out was applied because a staff member did not
              punch out within the required window.
            </p>

            <table width="100%" cellpadding="0" cellspacing="0"
                   style="border:1px solid #e5e7eb;border-radius:8px;overflow:hidden;font-size:14px;margin-bottom:20px;">
              <tbody>
                <tr style="background:#f8fafc;">
                  <td style="padding:6px 12px;color:#555;font-weight:600;">Staff member</td>
                  <td style="padding:6px 12px;font-weight:700;color:#01294A;">${payload.staffName}</td>
                </tr>
                <tr>
                  <td style="padding:6px 12px;color:#555;font-weight:600;">Date</td>
                  <td style="padding:6px 12px;">${payload.workDate}</td>
                </tr>
                <tr style="background:#f8fafc;">
                  <td style="padding:6px 12px;color:#555;font-weight:600;">Reason</td>
                  <td style="padding:6px 12px;font-weight:600;color:#E97D55;">${label}</td>
                </tr>
                ${scheduledRow}
                <tr ${payload.scheduledTime ? "" : 'style="background:#f8fafc;"'}>
                  <td style="padding:6px 12px;color:#555;font-weight:600;">Auto clock-out time</td>
                  <td style="padding:6px 12px;font-weight:700;">${payload.actualTime}</td>
                </tr>
              </tbody>
            </table>

            <p style="color:#555;font-size:13px;line-height:1.6;margin:0;">
              This event has been recorded in the compliance audit log.
              Review the Staff Hours report in the admin portal for any corrections needed.
            </p>
          </td>
        </tr>

        <!-- Footer -->
        <tr>
          <td style="background:#f8fafc;padding:14px 28px;text-align:center;border-top:1px solid #e2e8f0;">
            <p style="margin:0;color:#94a3b8;font-size:11px;">
              Sent automatically by the MDO staff portal · Do not reply to this address
            </p>
          </td>
        </tr>

      </table>
    </td></tr>
  </table>
</body>
</html>`;

    const res = await fetch("https://api.resend.com/emails", {
        method:  "POST",
        headers: {
            "Authorization": `Bearer ${resendApiKey}`,
            "Content-Type":  "application/json",
        },
        body: JSON.stringify({
            from:    fromEmail,
            to:      [directorEmail],
            subject,
            html,
        }),
    });

    if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        console.error("Resend error:", err);
        // Non-fatal: log and continue — we still record the auto-clockout.
    }
}

// ── Main handler ───────────────────────────────────────────────

Deno.serve(async (req: Request) => {
    // ── Auth: verify CRON_SECRET ──────────────────────────────
    const cronSecret = Deno.env.get("CRON_SECRET") ?? "";
    if (cronSecret) {
        const auth   = req.headers.get("authorization") ?? "";
        const token  = auth.startsWith("Bearer ") ? auth.slice(7) : "";
        if (token !== cronSecret) {
            return new Response(JSON.stringify({ error: "Unauthorized" }), {
                status:  401,
                headers: { "Content-Type": "application/json" },
            });
        }
    }

    // ── Operating-hours gate ──────────────────────────────────
    const chiNow    = nowInTZ(TIMEZONE);
    const chiHour   = chiNow.getHours();
    const chiMin    = chiNow.getMinutes();
    const chiDow    = chiNow.getDay(); // 0=Sun … 6=Sat
    const isWeekday = chiDow >= 1 && chiDow <= 5;

    // Allow from 08:15 through end of the 17:xx run (hard cutoff at 17:00)
    const totalMin  = chiHour * 60 + chiMin;
    const startMin  = 8 * 60 + 15;   // 08:15
    const cutoffMin = 17 * 60;        // 17:00 (hard cutoff fires at this run)
    const endMin    = 17 * 60 + 14;   // 17:14 — last run that might still close things

    const isHardCutoffRun = isWeekday && (totalMin >= cutoffMin && totalMin <= endMin);
    const isOperatingRun  = isWeekday && (totalMin >= startMin  && totalMin <= endMin);

    if (!isOperatingRun) {
        return new Response(
            JSON.stringify({ skipped: true, reason: "Outside operating hours", chiTime: chiNow.toISOString() }),
            { status: 200, headers: { "Content-Type": "application/json" } },
        );
    }

    // ── Supabase client (service role) ────────────────────────
    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const serviceKey  = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const sb = createClient(supabaseUrl, serviceKey, {
        auth: { persistSession: false },
    });

    // ── Config ────────────────────────────────────────────────
    const resendApiKey = Deno.env.get("RESEND_API_KEY") ?? "";
    const fromEmail    = Deno.env.get("RESEND_FROM_EMAIL") ?? "noreply@timothystl.org";

    // Fetch settings: director_email, geofence config, etc.
    const { data: settingsRows } = await sb
        .from("settings")
        .select("key, value")
        .in("key", ["director_email", "shift_defaults"]);

    const settingsMap: Record<string, unknown> = {};
    for (const row of settingsRows ?? []) {
        settingsMap[row.key] = row.value;
    }

    const directorEmail: string =
        (settingsMap["director_email"] as string) || Deno.env.get("RESEND_REPLY_TO") || fromEmail;

    // ── Today in Chicago ──────────────────────────────────────
    const todayStr = chiNow.toLocaleDateString("en-CA"); // YYYY-MM-DD

    // ── Open clock events for today ───────────────────────────
    const { data: openEvents, error: openErr } = await sb
        .from("staff_clock_events")
        .select("id, staff_id, clock_in, work_date, staff:staff_id(name)")
        .eq("work_date", todayStr)
        .is("clock_out", null);

    if (openErr) {
        console.error("fetchOpenEvents:", openErr);
        return new Response(JSON.stringify({ error: openErr.message }), {
            status: 500, headers: { "Content-Type": "application/json" },
        });
    }

    if (!openEvents?.length) {
        return new Response(
            JSON.stringify({ processed: 0, reason: "No open clock events" }),
            { status: 200, headers: { "Content-Type": "application/json" } },
        );
    }

    // ── Schedule times for today ──────────────────────────────
    const staffIds = [...new Set(openEvents.map((e: Record<string, unknown>) => e.staff_id as string))];

    const { data: schedTimes } = await sb
        .from("staff_schedule_times")
        .select("staff_id, scheduled_start, lunch_out, lunch_in, scheduled_end")
        .eq("work_date", todayStr)
        .in("staff_id", staffIds);

    const schedMap: Record<string, { lunch_out: string | null; scheduled_end: string }> = {};
    for (const row of schedTimes ?? []) {
        schedMap[row.staff_id] = {
            lunch_out:     row.lunch_out     ?? null,
            scheduled_end: row.scheduled_end,
        };
    }

    // ── Already-fired alerts today (dedup guard) ──────────────
    const { data: existingLogs } = await sb
        .from("auto_clockout_log")
        .select("staff_id, trigger_type")
        .eq("work_date", todayStr);

    // fired[staffId][triggerType] = true
    const fired: Record<string, Record<string, boolean>> = {};
    for (const row of existingLogs ?? []) {
        if (!fired[row.staff_id]) fired[row.staff_id] = {};
        fired[row.staff_id][row.trigger_type] = true;
    }

    // ── Evaluate each open event ──────────────────────────────
    const results: string[] = [];
    const nowUTC = new Date();

    for (const evt of openEvents) {
        const eventId  = evt.id as number;
        const staffId  = evt.staff_id as string;
        const staffName = (evt.staff as { name: string })?.name ?? "Unknown";
        const sched    = schedMap[staffId];

        // ── Hard cutoff: runs at 17:00 Chicago regardless of schedule ──
        if (isHardCutoffRun) {
            const alreadyFired = fired[staffId]?.["auto_hard_cutoff"];
            if (!alreadyFired) {
                await applyAutoClockout({
                    sb, eventId, staffId, staffName, workDate: todayStr,
                    triggerType: "auto_hard_cutoff",
                    scheduledTime: "17:00",
                    nowUTC,
                    directorEmail, resendApiKey, fromEmail,
                });
                if (!fired[staffId]) fired[staffId] = {};
                fired[staffId]["auto_hard_cutoff"] = true;
                results.push(`${staffName}: auto_hard_cutoff`);
                continue; // no need to check lunch/end-of-shift too
            }
        }

        // ── Schedule-based checks (requires a staff_schedule_times row) ──
        if (!sched) continue;

        const nowMinutes = chiHour * 60 + chiMin;

        // Lunch punch enforcement
        if (sched.lunch_out) {
            const lunchMin   = timeToMinutes(sched.lunch_out) + 15; // 15-min grace
            const alreadyFired = fired[staffId]?.["auto_lunch"];
            if (!alreadyFired && nowMinutes >= lunchMin) {
                await applyAutoClockout({
                    sb, eventId, staffId, staffName, workDate: todayStr,
                    triggerType: "auto_lunch",
                    scheduledTime: sched.lunch_out,
                    nowUTC,
                    directorEmail, resendApiKey, fromEmail,
                });
                if (!fired[staffId]) fired[staffId] = {};
                fired[staffId]["auto_lunch"] = true;
                results.push(`${staffName}: auto_lunch`);
                continue; // don't also check end-of-shift on same open event
            }
        }

        // End-of-shift enforcement
        if (sched.scheduled_end) {
            const endMin     = timeToMinutes(sched.scheduled_end) + 15; // 15-min grace
            const alreadyFired = fired[staffId]?.["auto_end_of_shift"];
            if (!alreadyFired && nowMinutes >= endMin) {
                await applyAutoClockout({
                    sb, eventId, staffId, staffName, workDate: todayStr,
                    triggerType: "auto_end_of_shift",
                    scheduledTime: sched.scheduled_end,
                    nowUTC,
                    directorEmail, resendApiKey, fromEmail,
                });
                if (!fired[staffId]) fired[staffId] = {};
                fired[staffId]["auto_end_of_shift"] = true;
                results.push(`${staffName}: auto_end_of_shift`);
            }
        }
    }

    return new Response(
        JSON.stringify({ processed: results.length, actions: results, chiTime: chiNow.toISOString() }),
        { status: 200, headers: { "Content-Type": "application/json" } },
    );
});

// ── applyAutoClockout ──────────────────────────────────────────
interface ApplyOpts {
    // deno-lint-ignore no-explicit-any
    sb: any;
    eventId:       number;
    staffId:       string;
    staffName:     string;
    workDate:      string;
    triggerType:   string;
    scheduledTime: string | null;
    nowUTC:        Date;
    directorEmail: string;
    resendApiKey:  string;
    fromEmail:     string;
}

async function applyAutoClockout(o: ApplyOpts): Promise<void> {
    const nowISO = o.nowUTC.toISOString();

    // 1. Update the clock event
    const { error: updateErr } = await o.sb
        .from("staff_clock_events")
        .update({ clock_out: nowISO, clock_out_method: o.triggerType })
        .eq("id", o.eventId)
        .is("clock_out", null); // guard: only if still open

    if (updateErr) {
        console.error(`applyAutoClockout update failed for event ${o.eventId}:`, updateErr);
        return;
    }

    // 2. Write audit log
    const { error: logErr } = await o.sb
        .from("auto_clockout_log")
        .insert({
            work_date:        o.workDate,
            staff_id:         o.staffId,
            staff_name:       o.staffName,
            clock_event_id:   o.eventId,
            trigger_type:     o.triggerType,
            scheduled_time:   o.scheduledTime,
            actual_clock_out: nowISO,
            alert_sent:       false,
        });

    if (logErr) {
        console.error("auto_clockout_log insert failed:", logErr);
    }

    // 3. Send director email
    if (o.resendApiKey && o.directorEmail) {
        await sendDirectorAlert(
            {
                staffName:     o.staffName,
                scheduledTime: o.scheduledTime
                    ? `${o.scheduledTime} (scheduled) — grace window expired`
                    : null,
                actualTime:    fmtChicago(nowISO),
                triggerType:   o.triggerType,
                workDate:      o.workDate,
            },
            o.directorEmail,
            o.resendApiKey,
            o.fromEmail,
        );

        // Mark alert sent
        await o.sb
            .from("auto_clockout_log")
            .update({ alert_sent: true, alert_sent_at: nowISO })
            .eq("staff_id", o.staffId)
            .eq("work_date", o.workDate)
            .eq("trigger_type", o.triggerType)
            .eq("actual_clock_out", nowISO);
    }
}
