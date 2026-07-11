import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const CONFIRM_URL = "https://mdo.timothystl.org/confirm-interest";
const ADMIN_URL   = "https://mdo.timothystl.org/admin";

// How long to wait before the first tour-reminder nudge, and the gap between
// follow-ups. Capped at REMINDER_CAP so nobody gets emailed forever.
const FIRST_REMINDER_DAYS = 7;
const FOLLOWUP_DAYS       = 21;
const REMINDER_CAP        = 4;

function escHtml(s: string): string {
    return String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function daysAgo(iso: string | null): number {
    if (!iso) return Infinity;
    return (Date.now() - new Date(iso).getTime()) / 86400000;
}

// settings.value is a TEXT column holding a JSON-encoded string (despite an
// outdated CREATE TABLE comment elsewhere describing it as jsonb) — parse it
// the same way the client-side loadWaitlistNotifySettings() does.
function parseSettingsValue(raw: unknown): Record<string, unknown> {
    if (raw && typeof raw === "object") return raw as Record<string, unknown>;
    if (typeof raw === "string") {
        try { return JSON.parse(raw); } catch { return {}; }
    }
    return {};
}

serve(async (req) => {
    // Only allow service role calls (invoked by pg_cron, never by browsers).
    const auth = req.headers.get("Authorization") || "";
    const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    if (!auth.includes(serviceRoleKey)) {
        return new Response(JSON.stringify({ error: "Unauthorized" }), { status: 401 });
    }

    try {
        const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
        const sb = createClient(supabaseUrl, serviceRoleKey);

        // Admin-facing on/off switch (Waitlist tab → Waitlist Inquiries →
        // "Weekly Tour / Check-In Reminders"). Off unless explicitly enabled —
        // a missing settings row or missing key must never be read as "on".
        const { data: notifySettingsRow } = await sb
            .from("settings").select("value").eq("key", "waitlist_notify").maybeSingle();
        const notifySettings = parseSettingsValue(notifySettingsRow?.value);
        if (notifySettings.remindersEnabled !== true) {
            return new Response(JSON.stringify({ skipped: "reminders disabled in settings" }), { status: 200 });
        }

        const { data: apps, error } = await sb
            .from("waitlist_applications")
            .select("*")
            .in("status", ["pending", "offered", "accepted"])
            .is("archived_at", null);

        if (error) throw error;

        const candidates = (apps || []).filter(a => {
            if ((a.reminder_count || 0) >= REMINDER_CAP) return false;
            if (!a.last_reminder_sent_at) return daysAgo(a.applied_at) >= FIRST_REMINDER_DAYS;
            return daysAgo(a.last_reminder_sent_at) >= FOLLOWUP_DAYS;
        });

        if (!candidates.length) {
            return new Response(JSON.stringify({ checked: apps?.length || 0, reminded: 0 }), { status: 200 });
        }

        const apiKey    = Deno.env.get("RESEND_API_KEY");
        const fromEmail = Deno.env.get("RESEND_FROM_EMAIL") || "onboarding@resend.dev";
        const replyTo   = Deno.env.get("RESEND_REPLY_TO")   || fromEmail;

        const sentTo: Array<{ childName: string; parentName: string; needsTour: boolean }> = [];

        for (const app of candidates) {
            const needsTour  = (app.tour_status || "not_scheduled") === "not_scheduled";
            const confirmUrl = `${CONFIRM_URL}?token=${app.interest_token}`;

            if (apiKey) {
                const tourBlock = needsTour ? `
                <table width="100%" cellpadding="0" cellspacing="0" style="margin:20px 0;">
                  <tr><td style="background:#fef3c7;border:2px solid #f59e0b;border-radius:8px;padding:16px 20px;text-align:center;">
                    <p style="margin:0 0 8px;color:#78350f;font-size:14px;font-weight:700;">📅 Ready to see our classrooms?</p>
                    <p style="margin:0;color:#78350f;font-size:13px;">Reply to this email or give us a call to schedule a tour while you wait for a spot to open up.</p>
                  </td></tr>
                </table>` : "";

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
          <p style="margin:0 0 16px;color:#333;font-size:16px;">Hi ${escHtml(app.parent_name)},</p>
          <p style="color:#333;font-size:15px;line-height:1.6;">
            Just checking in — <strong>${escHtml(app.child_name)}</strong> is still on our enrollment waitlist and we wanted to touch base.
          </p>
          ${tourBlock}
          <table width="100%" cellpadding="0" cellspacing="0" style="margin:22px 0;">
            <tr><td style="background:#f0f9ff;border:1px solid #bae6fd;border-radius:8px;padding:16px 20px;text-align:center;">
              <p style="margin:0 0 10px;color:#0369a1;font-size:14px;font-weight:700;">Still interested in a spot?</p>
              <a href="${confirmUrl}" style="display:inline-block;background:#4f46e5;color:#fff;padding:10px 20px;border-radius:6px;text-decoration:none;font-weight:700;font-size:14px;">Let Us Know</a>
            </td></tr>
          </table>
          <p style="color:#555;font-size:14px;line-height:1.6;">
            Your place on the waitlist is unaffected either way — this just helps us keep our list accurate.
          </p>
          <p style="color:#333;font-size:15px;margin-top:24px;">Warm regards,<br><strong>Timothy Lutheran Church MDO</strong></p>
        </td></tr>
        <tr><td style="background:#f8fafc;padding:16px 32px;text-align:center;border-top:1px solid #e2e8f0;">
          <p style="margin:0;color:#94a3b8;font-size:12px;">You're receiving this because you're on the Timothy Lutheran Church MDO enrollment waitlist.</p>
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
                        to:       [app.parent_email],
                        reply_to: replyTo,
                        subject:  needsTour
                            ? `Schedule a Tour + Quick Check-In — Timothy Lutheran MDO Waitlist`
                            : `Quick Check-In — Timothy Lutheran MDO Waitlist`,
                        html,
                    }),
                }).catch(() => {});
            }

            await sb.from("waitlist_applications").update({
                last_reminder_sent_at: new Date().toISOString(),
                reminder_count:        (app.reminder_count || 0) + 1,
            }).eq("id", app.id);

            sentTo.push({ childName: app.child_name, parentName: app.parent_name, needsTour });
        }

        // Weekly digest to the director, if a notify address is configured.
        const notifyEmail = notifySettings.notifyEmail as string | undefined;
        if (notifyEmail && apiKey && sentTo.length) {
            const rows = sentTo.map(s => `<tr><td style="padding:6px 10px;border-bottom:1px solid #eee;">${escHtml(s.childName)}</td><td style="padding:6px 10px;border-bottom:1px solid #eee;">${escHtml(s.parentName)}</td><td style="padding:6px 10px;border-bottom:1px solid #eee;">${s.needsTour ? "Tour + check-in" : "Check-in only"}</td></tr>`).join("");
            const digestHtml = `
<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"></head>
<body style="margin:0;padding:0;font-family:Georgia,serif;background:#f4f4f4;">
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#f4f4f4;padding:32px 16px;">
    <tr><td align="center">
      <table width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;background:#fff;border-radius:12px;overflow:hidden;box-shadow:0 2px 12px rgba(0,0,0,.08);">
        <tr><td style="background:#166534;padding:24px 32px;text-align:center;">
          <h1 style="margin:0;color:#fff;font-size:20px;font-weight:700;">📬 Waitlist Reminders Sent</h1>
        </td></tr>
        <tr><td style="padding:24px 32px;">
          <p style="color:#333;font-size:14px;margin:0 0 14px;">${sentTo.length} waitlist famil${sentTo.length === 1 ? "y" : "ies"} were sent a tour/check-in reminder this week.</p>
          <table width="100%" cellpadding="0" cellspacing="0" style="font-size:13px;color:#444;border-collapse:collapse;">
            <tr><th style="text-align:left;padding:6px 10px;border-bottom:2px solid #ddd;">Child</th><th style="text-align:left;padding:6px 10px;border-bottom:2px solid #ddd;">Parent</th><th style="text-align:left;padding:6px 10px;border-bottom:2px solid #ddd;">Reminder</th></tr>
            ${rows}
          </table>
          <p style="margin-top:20px;"><a href="${ADMIN_URL}" style="display:inline-block;background:#4f46e5;color:#fff;padding:10px 20px;border-radius:6px;text-decoration:none;font-weight:700;font-size:14px;">Open Waitlist in Admin</a></p>
        </td></tr>
      </table>
    </td></tr>
  </table>
</body></html>`;
            await fetch("https://api.resend.com/emails", {
                method:  "POST",
                headers: { "Authorization": `Bearer ${apiKey}`, "Content-Type": "application/json" },
                body: JSON.stringify({
                    from:    fromEmail,
                    to:      [notifyEmail],
                    subject: `Waitlist Reminders Sent — ${sentTo.length} famil${sentTo.length === 1 ? "y" : "ies"}`,
                    html:    digestHtml,
                }),
            }).catch(() => {});
        }

        return new Response(JSON.stringify({ checked: apps?.length || 0, reminded: sentTo.length }), { status: 200 });

    } catch (err) {
        return new Response(JSON.stringify({ error: (err as Error).message }), { status: 500 });
    }
});
