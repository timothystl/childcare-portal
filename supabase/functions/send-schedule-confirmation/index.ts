import { serve } from "https://deno.land/std@0.168.0/http/server.ts";

const corsHeaders = {
    "Access-Control-Allow-Origin":  "*",
    "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

serve(async (req) => {
    if (req.method === "OPTIONS") {
        return new Response("ok", { headers: corsHeaders });
    }

    try {
        const { parentName, parentEmail, monthLabel, childNames, dates, grandTotal } =
            await req.json();

        // dates: [{ date: 'YYYY-MM-DD', dayType: 'full'|'half', amount: number }]
        if (!parentEmail || !dates?.length) {
            return new Response(
                JSON.stringify({ error: "Missing required fields" }),
                { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
            );
        }

        const apiKey    = Deno.env.get("RESEND_API_KEY");
        const fromEmail = Deno.env.get("RESEND_FROM_EMAIL") || "onboarding@resend.dev";
        const replyTo   = Deno.env.get("RESEND_REPLY_TO")   || fromEmail;

        if (!apiKey) {
            return new Response(
                JSON.stringify({ error: "RESEND_API_KEY secret is not set" }),
                { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
            );
        }

        const childList = childNames.join(", ");

        const rows = dates.map((d: { date: string; dayType: string; amount: number }) => {
            const friendly = new Date(d.date + "T00:00:00").toLocaleDateString(
                "en-US", { weekday: "short", month: "short", day: "numeric" }
            );
            const typeLabel = d.dayType === "half" ? "Half Day" : "Full Day";
            return `<tr>
                <td style="padding:7px 12px;border-bottom:1px solid #f0f0f0;">${friendly}</td>
                <td style="padding:7px 12px;border-bottom:1px solid #f0f0f0;color:#666;">${typeLabel}</td>
                <td style="padding:7px 12px;border-bottom:1px solid #f0f0f0;text-align:right;">$${d.amount.toFixed(2)}</td>
            </tr>`;
        }).join("");

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

        <!-- Body -->
        <tr>
          <td style="padding:32px 32px 24px;">
            <p style="margin:0 0 16px;color:#333;font-size:16px;">Dear ${parentName},</p>

            <p style="color:#333;font-size:15px;line-height:1.6;">
              Your care schedule for <strong>${childList}</strong> has been registered for <strong>${monthLabel}</strong>.
              Here's your confirmation:
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
              <tbody>${rows}</tbody>
              <tfoot>
                <tr style="background:#f8fafc;">
                  <td colspan="2" style="padding:9px 12px;font-weight:700;color:#333;">Total</td>
                  <td style="padding:9px 12px;text-align:right;font-weight:700;color:#4f46e5;">$${grandTotal.toFixed(2)}</td>
                </tr>
              </tfoot>
            </table>

            <p style="color:#555;font-size:14px;line-height:1.6;">
              If you have any questions about your schedule or need to make changes, please reply to this email.
            </p>

            <p style="color:#333;font-size:15px;margin-top:24px;">Warm regards,<br>
            <strong>Timothy Lutheran Church MDO</strong></p>
          </td>
        </tr>

        <!-- Footer -->
        <tr>
          <td style="background:#f8fafc;padding:16px 32px;text-align:center;border-top:1px solid #e2e8f0;">
            <p style="margin:0;color:#94a3b8;font-size:12px;">You're receiving this because you registered for the Timothy Lutheran Church MDO program.</p>
          </td>
        </tr>

      </table>
    </td></tr>
  </table>
</body>
</html>`;

        const res = await fetch("https://api.resend.com/emails", {
            method:  "POST",
            headers: { "Authorization": `Bearer ${apiKey}`, "Content-Type": "application/json" },
            body: JSON.stringify({
                from:     fromEmail,
                to:       [parentEmail],
                reply_to: replyTo,
                subject:  `Schedule Confirmation — ${childList} — ${monthLabel}`,
                html,
            }),
        });

        const payload = await res.json();

        if (!res.ok) {
            return new Response(
                JSON.stringify({ error: payload }),
                { status: res.status, headers: { ...corsHeaders, "Content-Type": "application/json" } }
            );
        }

        return new Response(
            JSON.stringify({ success: true, id: payload.id }),
            { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } }
        );

    } catch (err) {
        return new Response(
            JSON.stringify({ error: (err as Error).message }),
            { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
        );
    }
});
