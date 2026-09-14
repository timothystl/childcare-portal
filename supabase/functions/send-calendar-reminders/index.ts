// ============================================================
// send-calendar-reminders — weekly nudge for missing monthly care calendars
// ============================================================
// Once the registration window is deep enough into the month that a family
// who hasn't submitted is genuinely at risk of showing up without a spot,
// remind them. Scoped to families who actually had (non-waitlisted) care
// days last month — a family that wasn't enrolled last month gets no
// pressure to re-register on this job; that's what the public registration
// page and admin outreach are for.
//
// Cadence lives in _shared/calendar-reminder-cadence.ts: nothing before the
// 15th, weekly follow-ups, capped at 3 reminders per family per month
// (calendar_reminder_log is keyed by family_id + month_key, so the cap and
// history reset every month on their own).
//
// One email per family, not per child — mirrors send-day-summary's "both
// parents share a family" framing and lists every child of theirs still
// missing a calendar rather than sending one email per kid.
// ============================================================

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { isAuthorizedCronRequest, unauthorizedCronResponse } from "../_shared/cron-auth.ts";
import { escHtml } from "../_shared/html.ts";
import { json } from "../_shared/http.ts";
import { isCalendarReminderDue } from "../_shared/calendar-reminder-cadence.ts";

const CALENDAR_URL = "https://mdo.timothystl.org/calendar";
const ADMIN_URL = "https://mdo.timothystl.org/admin";

function parseSettingsValue(raw: unknown): Record<string, unknown> {
    if (raw && typeof raw === "object") return raw as Record<string, unknown>;
    if (typeof raw === "string") {
        try { return JSON.parse(raw); } catch { return {}; }
    }
    return {};
}

function monthKey(year: number, month1: number): string {
    return `${year}-${String(month1).padStart(2, "0")}`;
}

interface Student { child_name?: string | null }
interface Family {
    id: string;
    parent_name?: string | null;
    parent_email?: string | null;
    parent2_name?: string | null;
    parent2_email?: string | null;
    active?: boolean | null;
    students?: Student[] | null;
}

serve(async (req) => {
    if (!await isAuthorizedCronRequest(req)) return unauthorizedCronResponse();

    try {
        const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
        const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
        const sb = createClient(supabaseUrl, serviceRoleKey);

        // Admin-facing on/off switch (Registrations tab → Missing Care
        // Calendar Report → "Weekly Missing-Calendar Reminders"). Off unless
        // explicitly enabled — a missing settings row or missing key must
        // never be read as "on".
        const { data: notifySettingsRow } = await sb
            .from("settings").select("value").eq("key", "calendar_reminder_notify").maybeSingle();
        const notifySettings = parseSettingsValue(notifySettingsRow?.value);
        if (notifySettings.remindersEnabled !== true) {
            return json({ skipped: "reminders disabled in settings" }, 200);
        }

        const centralToday = new Date().toLocaleDateString("en-CA", { timeZone: "America/Chicago" });
        const [yearStr, monthStr, dayStr] = centralToday.split("-");
        const year = Number(yearStr), month = Number(monthStr), dayOfMonth = Number(dayStr);
        const currentMonthKey = monthKey(year, month);

        if (dayOfMonth < 15) {
            return json({ skipped: `too early in the month (day ${dayOfMonth})`, currentMonthKey }, 200);
        }

        const prevMonth = month === 1 ? 12 : month - 1;
        const prevYear = month === 1 ? year - 1 : year;
        const lastMonthStart = `${monthKey(prevYear, prevMonth)}-01`;
        const lastMonthEndExclusive = `${currentMonthKey}-01`;

        // Families with at least one confirmed, non-waitlisted care day last
        // month — the same "was here" signal count_family_month_care_days()
        // and compute_family_month_charges() already use for billing, so this
        // job can never disagree with what the family was actually billed for.
        const { data: lastMonthRegs, error: lastMonthErr } = await sb
            .from("registrations")
            .select("parent_email, registration_dates!inner(care_date, waitlisted)")
            .eq("status", "confirmed")
            .eq("registration_dates.waitlisted", false)
            .gte("registration_dates.care_date", lastMonthStart)
            .lt("registration_dates.care_date", lastMonthEndExclusive);
        if (lastMonthErr) throw lastMonthErr;

        const wasHereLastMonth = new Set(
            (lastMonthRegs || []).map(r => (r.parent_email || "").toLowerCase().trim()).filter(Boolean)
        );
        if (!wasHereLastMonth.size) {
            return json({ checked: 0, reminded: 0, note: "no families with care days last month" }, 200);
        }

        // Children already covered by a confirmed registration this month —
        // same "submitted" definition generateMissingCalendarReport() uses.
        const { data: currentRegs, error: currentErr } = await sb
            .from("registrations")
            .select("child_name")
            .eq("status", "confirmed")
            .eq("month_key", currentMonthKey);
        if (currentErr) throw currentErr;

        const submittedChildren = new Set(
            (currentRegs || []).map(r => (r.child_name || "").toLowerCase().trim()).filter(Boolean)
        );

        const { data: families, error: famErr } = await sb
            .from("families")
            .select("id, parent_name, parent_email, parent2_name, parent2_email, active, students");
        if (famErr) throw famErr;

        const candidates: Array<{ family: Family; missingChildren: string[] }> = [];
        for (const family of (families || []) as Family[]) {
            if (family.active === false) continue;
            const emails = [family.parent_email, family.parent2_email]
                .filter((e): e is string => !!e)
                .map(e => e.toLowerCase().trim());
            if (!emails.some(e => wasHereLastMonth.has(e))) continue;

            const missingChildren = (family.students || [])
                .map(s => s.child_name)
                .filter((name): name is string => !!name && !submittedChildren.has(name.toLowerCase().trim()));
            if (missingChildren.length) candidates.push({ family, missingChildren });
        }

        if (!candidates.length) {
            return json({ checked: wasHereLastMonth.size, reminded: 0 }, 200);
        }

        const familyIds = candidates.map(c => c.family.id);
        const { data: logRows, error: logErr } = await sb
            .from("calendar_reminder_log")
            .select("family_id, last_sent_at, send_count")
            .eq("month_key", currentMonthKey)
            .in("family_id", familyIds);
        if (logErr) throw logErr;

        const logByFamily = new Map((logRows || []).map(r => [r.family_id, r]));

        const due = candidates.filter(c => {
            const log = logByFamily.get(c.family.id);
            return isCalendarReminderDue(dayOfMonth, log?.last_sent_at ?? null, log?.send_count ?? 0);
        });

        if (!due.length) {
            return json({ checked: candidates.length, reminded: 0, note: "no one due today" }, 200);
        }

        const apiKey = Deno.env.get("RESEND_API_KEY");
        const fromEmail = `"Timothy MDO" <${Deno.env.get("RESEND_FROM_EMAIL") || "onboarding@resend.dev"}>`;
        const replyTo = Deno.env.get("RESEND_REPLY_TO") || fromEmail;

        const sentTo: Array<{ parentName: string; childNames: string[] }> = [];
        let failed = 0;

        for (const { family, missingChildren } of due) {
            const to = [family.parent_email, family.parent2_email].filter((e): e is string => !!e);
            if (!to.length) continue;

            if (apiKey) {
                const childList = missingChildren.map(n => `<li style="margin:4px 0;">${escHtml(n)}</li>`).join("");
                const html = `
<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;font-family:Georgia,serif;background:#f4f4f4;">
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#f4f4f4;padding:32px 16px;">
    <tr><td align="center">
      <table width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;background:#fff;border-radius:12px;overflow:hidden;box-shadow:0 2px 12px rgba(0,0,0,.08);">
        <tr><td style="background:#4f46e5;padding:28px 32px;text-align:center;">
          <p style="margin:0;color:#c7d2fe;font-size:13px;letter-spacing:.06em;text-transform:uppercase;">Timothy Lutheran Church</p>
          <h1 style="margin:6px 0 0;color:#fff;font-size:22px;font-weight:700;">Mother's Day Out</h1>
        </td></tr>
        <tr><td style="padding:32px 32px 24px;">
          <p style="margin:0 0 16px;color:#333;font-size:16px;">Hi ${escHtml(family.parent_name || "there")},</p>
          <p style="color:#333;font-size:15px;line-height:1.6;">
            We don't have a care calendar submitted yet this month for:
          </p>
          <ul style="color:#333;font-size:15px;line-height:1.6;">${childList}</ul>
          <table width="100%" cellpadding="0" cellspacing="0" style="margin:22px 0;">
            <tr><td style="background:#fef3c7;border:2px solid #f59e0b;border-radius:8px;padding:16px 20px;text-align:center;">
              <p style="margin:0 0 10px;color:#78350f;font-size:14px;font-weight:700;">Please submit this month's calendar</p>
              <a href="${CALENDAR_URL}" style="display:inline-block;background:#4f46e5;color:#fff;padding:10px 20px;border-radius:6px;text-decoration:none;font-weight:700;font-size:14px;">Submit Calendar</a>
            </td></tr>
          </table>
          <p style="color:#555;font-size:14px;line-height:1.6;">
            We reserve spots based on submitted calendars, so please let us know your child's days as soon as you can.
          </p>
          <p style="color:#333;font-size:15px;margin-top:24px;">Warm regards,<br><strong>Timothy Lutheran Church MDO</strong></p>
        </td></tr>
        <tr><td style="background:#f8fafc;padding:16px 32px;text-align:center;border-top:1px solid #e2e8f0;">
          <p style="margin:0;color:#94a3b8;font-size:12px;">You're receiving this because your family had care days with us last month.</p>
        </td></tr>
      </table>
    </td></tr>
  </table>
</body></html>`;

                const response = await fetch("https://api.resend.com/emails", {
                    method: "POST",
                    headers: { "Authorization": `Bearer ${apiKey}`, "Content-Type": "application/json" },
                    body: JSON.stringify({
                        from: fromEmail,
                        to,
                        reply_to: replyTo,
                        subject: `Please Submit This Month's Care Calendar — Timothy Lutheran MDO`,
                        html,
                    }),
                }).catch(() => null);
                if (!response?.ok) {
                    failed++;
                    console.error("calendar reminder delivery failed", family.id, response?.status || "network");
                    continue;
                }
            } else {
                failed++;
                console.error("calendar reminder delivery failed: email provider not configured");
                continue;
            }

            const log = logByFamily.get(family.id);
            const { error: upsertError } = await sb.from("calendar_reminder_log").upsert({
                family_id: family.id,
                month_key: currentMonthKey,
                last_sent_at: new Date().toISOString(),
                send_count: (log?.send_count || 0) + 1,
            }, { onConflict: "family_id,month_key" });
            if (upsertError) {
                failed++;
                console.error("calendar reminder state update failed", family.id);
                continue;
            }

            sentTo.push({ parentName: family.parent_name || "", childNames: missingChildren });
        }

        // Digest to the director, if a notify address is configured.
        const notifyEmail = notifySettings.notifyEmail as string | undefined;
        if (notifyEmail && apiKey && sentTo.length) {
            const rows = sentTo.map(s =>
                `<tr><td style="padding:6px 10px;border-bottom:1px solid #eee;">${escHtml(s.parentName)}</td><td style="padding:6px 10px;border-bottom:1px solid #eee;">${escHtml(s.childNames.join(", "))}</td></tr>`
            ).join("");
            const digestHtml = `
<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"></head>
<body style="margin:0;padding:0;font-family:Georgia,serif;background:#f4f4f4;">
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#f4f4f4;padding:32px 16px;">
    <tr><td align="center">
      <table width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;background:#fff;border-radius:12px;overflow:hidden;box-shadow:0 2px 12px rgba(0,0,0,.08);">
        <tr><td style="background:#166534;padding:24px 32px;text-align:center;">
          <h1 style="margin:0;color:#fff;font-size:20px;font-weight:700;">📬 Calendar Reminders Sent</h1>
        </td></tr>
        <tr><td style="padding:24px 32px;">
          <p style="color:#333;font-size:14px;margin:0 0 14px;">${sentTo.length} famil${sentTo.length === 1 ? "y was" : "ies were"} reminded to submit ${currentMonthKey}'s care calendar.</p>
          <table width="100%" cellpadding="0" cellspacing="0" style="font-size:13px;color:#444;border-collapse:collapse;">
            <tr><th style="text-align:left;padding:6px 10px;border-bottom:2px solid #ddd;">Parent</th><th style="text-align:left;padding:6px 10px;border-bottom:2px solid #ddd;">Missing Children</th></tr>
            ${rows}
          </table>
          <p style="margin-top:20px;"><a href="${ADMIN_URL}" style="display:inline-block;background:#4f46e5;color:#fff;padding:10px 20px;border-radius:6px;text-decoration:none;font-weight:700;font-size:14px;">Open Missing Calendar Report</a></p>
        </td></tr>
      </table>
    </td></tr>
  </table>
</body></html>`;
            const digestResponse = await fetch("https://api.resend.com/emails", {
                method: "POST",
                headers: { "Authorization": `Bearer ${apiKey}`, "Content-Type": "application/json" },
                body: JSON.stringify({
                    from: fromEmail,
                    to: [notifyEmail],
                    subject: `Calendar Reminders Sent — ${sentTo.length} famil${sentTo.length === 1 ? "y" : "ies"}`,
                    html: digestHtml,
                }),
            }).catch(() => null);
            if (!digestResponse?.ok) {
                failed++;
                console.error("calendar reminder digest failed", digestResponse?.status || "network");
            }
        }

        return json({ checked: candidates.length, reminded: sentTo.length, failed }, failed ? 502 : 200);

    } catch (err) {
        return json({ error: (err as Error).message }, 500);
    }
});
