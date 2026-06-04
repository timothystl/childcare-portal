import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const ALLOWED_ORIGIN = "https://mdo.timothystl.org";

function escHtml(s: string): string {
    return String(s ?? '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

function corsHeaders(req: Request): Record<string, string> {
    const origin = req.headers.get("origin") || "";
    return {
        "Access-Control-Allow-Origin":  origin === ALLOWED_ORIGIN ? ALLOWED_ORIGIN : "",
        "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
    };
}

function friendlyDate(dateStr: string): string {
    return new Date(dateStr + "T00:00:00").toLocaleDateString(
        "en-US", { weekday: "short", month: "short", day: "numeric" }
    );
}

function buildIcal(childName: string, dateStr: string, dayTypeLabel: string, rate: number): string {
    // All-day event format: YYYYMMDD
    const compact = dateStr.replace(/-/g, "");
    const nextDay  = (() => {
        const d = new Date(dateStr + "T00:00:00");
        d.setDate(d.getDate() + 1);
        return d.toISOString().slice(0, 10).replace(/-/g, "");
    })();
    const uid  = `mdo-change-${dateStr}-${childName.replace(/\s+/g, "")}@timothystl.org`;
    const desc = `Mother's Day Out added day. $${rate.toFixed(2)} + $5.00 change fee.`;
    return [
        "BEGIN:VCALENDAR",
        "VERSION:2.0",
        "PRODID:-//Timothy Lutheran MDO//Schedule Change//EN",
        "METHOD:PUBLISH",
        "BEGIN:VEVENT",
        `UID:${uid}`,
        `DTSTART;VALUE=DATE:${compact}`,
        `DTEND;VALUE=DATE:${nextDay}`,
        `SUMMARY:MDO \u2013 ${childName} \u2013 ${dayTypeLabel}`,
        `DESCRIPTION:${desc}`,
        "END:VEVENT",
        "END:VCALENDAR",
    ].join("\r\n");
}

serve(async (req) => {
    const ch = corsHeaders(req);

    if (req.method === "OPTIONS") {
        return new Response("ok", { headers: ch });
    }

    try {
        // Require a valid admin session
        const authHeader = req.headers.get("Authorization");
        if (!authHeader) {
            return new Response(JSON.stringify({ error: "Unauthorized" }), {
                status: 401, headers: { ...ch, "Content-Type": "application/json" },
            });
        }
        const callerClient = createClient(
            Deno.env.get("SUPABASE_URL")!,
            Deno.env.get("SUPABASE_ANON_KEY")!,
            { global: { headers: { Authorization: authHeader } } },
        );
        const { data: { user }, error: authError } = await callerClient.auth.getUser();
        if (authError || !user) {
            return new Response(JSON.stringify({ error: "Unauthorized" }), {
                status: 401, headers: { ...ch, "Content-Type": "application/json" },
            });
        }

        const { parentName, parentEmail, childName, monthLabel, existingDates, addedDate, changeFee } =
            await req.json();

        // existingDates: [{ date, dayType, amount }]
        // addedDate: { date, dayType, amount }
        if (!parentEmail || !addedDate?.date) {
            return new Response(
                JSON.stringify({ error: "Missing required fields" }),
                { status: 400, headers: { ...ch, "Content-Type": "application/json" } }
            );
        }

        const apiKey    = Deno.env.get("RESEND_API_KEY");
        const fromEmail = Deno.env.get("RESEND_FROM_EMAIL") || "onboarding@resend.dev";
        const replyTo   = Deno.env.get("RESEND_REPLY_TO")   || fromEmail;

        if (!apiKey) {
            return new Response(
                JSON.stringify({ error: "RESEND_API_KEY secret is not set" }),
                { status: 500, headers: { ...ch, "Content-Type": "application/json" } }
            );
        }

        const addedTypeLabel = addedDate.dayType === "half" ? "Half Day" : "Full Day";
        const fee = changeFee ?? 5;
        const newTotal = (addedDate.amount || 0) + fee;
        const grandTotal = (existingDates || []).reduce((s: number, d: { amount: number }) => s + (d.amount || 0), 0) + newTotal;

        // Existing dates rows (muted)
        const existingRows = (existingDates || []).map((d: { date: string; dayType: string; amount: number }) => `
            <tr>
                <td style="padding:7px 12px;border-bottom:1px solid #f0f0f0;color:#888;">${friendlyDate(d.date)}</td>
                <td style="padding:7px 12px;border-bottom:1px solid #f0f0f0;color:#aaa;">${d.dayType === "half" ? "Half Day" : "Full Day"}</td>
                <td style="padding:7px 12px;border-bottom:1px solid #f0f0f0;text-align:right;color:#aaa;">$${(d.amount || 0).toFixed(2)}</td>
            </tr>`).join("");

        // Added date row (highlighted)
        const addedRow = `
            <tr style="background:#fffbeb;">
                <td style="padding:7px 12px;border-bottom:1px solid #f0f0f0;font-weight:700;color:#333;">
                    ✦ ${friendlyDate(addedDate.date)} <span style="font-size:11px;color:#d97706;font-weight:400;">(new)</span>
                </td>
                <td style="padding:7px 12px;border-bottom:1px solid #f0f0f0;font-weight:700;color:#333;">${addedTypeLabel}</td>
                <td style="padding:7px 12px;border-bottom:1px solid #f0f0f0;text-align:right;font-weight:700;color:#333;">$${(addedDate.amount || 0).toFixed(2)}</td>
            </tr>
            <tr style="background:#fffbeb;">
                <td colspan="2" style="padding:5px 12px;border-bottom:1px solid #f0f0f0;color:#d97706;font-size:13px;">Schedule change fee</td>
                <td style="padding:5px 12px;border-bottom:1px solid #f0f0f0;text-align:right;color:#d97706;font-size:13px;">$${fee.toFixed(2)}</td>
            </tr>`;

        const html = `
<!DOCTYPE html>
<html lang="en">
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;font-family:Georgia,serif;background:#f4f4f4;">
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#f4f4f4;padding:32px 16px;">
    <tr><td align="center">
      <table width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;background:#fff;border-radius:12px;overflow:hidden;box-shadow:0 2px 12px rgba(0,0,0,.08);">

        <!-- Header -->
        <tr>
          <td style="background:#4f46e5;padding:28px 32px;text-align:center;">
            <p style="margin:0;color:#c7d2fe;font-size:13px;letter-spacing:.06em;text-transform:uppercase;">Timothy Lutheran Church</p>
            <h1 style="margin:6px 0 0;color:#fff;font-size:22px;font-weight:700;">Mother's Day Out</h1>
          </td>
        </tr>

        <!-- Notice banner -->
        <tr>
          <td style="background:#fef3c7;padding:12px 32px;border-bottom:2px solid #fbbf24;">
            <p style="margin:0;color:#92400e;font-size:14px;font-weight:600;">📅 Schedule Change Notice</p>
          </td>
        </tr>

        <!-- Body -->
        <tr>
          <td style="padding:32px 32px 24px;">
            <p style="margin:0 0 16px;color:#333;font-size:16px;">Dear ${escHtml(parentName)},</p>

            <p style="color:#333;font-size:15px;line-height:1.6;">
              A day has been added to <strong>${escHtml(childName)}</strong>'s schedule for <strong>${escHtml(monthLabel)}</strong>.
              A $${fee.toFixed(2)} schedule change fee applies. Your updated schedule is below:
            </p>

            <!-- Schedule table -->
            <table width="100%" cellpadding="0" cellspacing="0" style="margin:20px 0;border:1px solid #e5e7eb;border-radius:8px;overflow:hidden;font-size:14px;">
              <thead>
                <tr style="background:#f8fafc;">
                  <th style="padding:8px 12px;text-align:left;font-weight:600;color:#555;border-bottom:2px solid #e5e7eb;">Date</th>
                  <th style="padding:8px 12px;text-align:left;font-weight:600;color:#555;border-bottom:2px solid #e5e7eb;">Type</th>
                  <th style="padding:8px 12px;text-align:right;font-weight:600;color:#555;border-bottom:2px solid #e5e7eb;">Amount</th>
                </tr>
              </thead>
              <tbody>${existingRows}${addedRow}</tbody>
              <tfoot>
                <tr style="background:#f8fafc;">
                  <td colspan="2" style="padding:9px 12px;font-weight:700;color:#333;">Updated Total</td>
                  <td style="padding:9px 12px;text-align:right;font-weight:700;color:#4f46e5;">$${grandTotal.toFixed(2)}</td>
                </tr>
              </tfoot>
            </table>

            <p style="color:#555;font-size:14px;line-height:1.6;">
              A calendar invite for the added day is attached. If you have any questions, please reply to this email.
            </p>

            <p style="color:#333;font-size:15px;margin-top:24px;">Warm regards,<br>
            <strong>Timothy Lutheran Church MDO</strong></p>
          </td>
        </tr>

        <!-- Footer -->
        <tr>
          <td style="background:#f8fafc;padding:16px 32px;text-align:center;border-top:1px solid #e2e8f0;">
            <p style="margin:0;color:#94a3b8;font-size:12px;">You're receiving this because a schedule change was made by MDO staff for your child.</p>
          </td>
        </tr>

      </table>
    </td></tr>
  </table>
</body>
</html>`;

        // Build iCal attachment
        const icalContent = buildIcal(childName, addedDate.date, addedTypeLabel, addedDate.amount || 0);
        const icalBase64  = btoa(icalContent);

        const res = await fetch("https://api.resend.com/emails", {
            method:  "POST",
            headers: { "Authorization": `Bearer ${apiKey}`, "Content-Type": "application/json" },
            body: JSON.stringify({
                from:     fromEmail,
                to:       [parentEmail],
                reply_to: replyTo,
                subject:  `Schedule Change — ${String(childName ?? '')} — ${String(monthLabel ?? '')}`,
                html,
                attachments: [{
                    filename:     "added-day.ics",
                    content:      icalBase64,
                    content_type: "text/calendar",
                }],
            }),
        });

        const payload = await res.json();

        if (!res.ok) {
            return new Response(
                JSON.stringify({ error: payload }),
                { status: res.status, headers: { ...ch, "Content-Type": "application/json" } }
            );
        }

        return new Response(
            JSON.stringify({ success: true, id: payload.id }),
            { status: 200, headers: { ...ch, "Content-Type": "application/json" } }
        );

    } catch (err) {
        return new Response(
            JSON.stringify({ error: (err as Error).message }),
            { status: 500, headers: { ...ch, "Content-Type": "application/json" } }
        );
    }
});
