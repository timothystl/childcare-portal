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
        const { parentName, parentEmail, childName, offerDeadline, offerNotes } =
            await req.json();

        if (!parentEmail || !childName || !offerDeadline) {
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

        const deadlineFormatted = new Date(offerDeadline + "T00:00:00").toLocaleDateString(
            "en-US", { weekday: "long", year: "numeric", month: "long", day: "numeric" }
        );

        const notesBlock = offerNotes
            ? `<p style="background:#fffbeb;border-left:4px solid #f59e0b;padding:10px 14px;border-radius:4px;color:#444;margin:20px 0;">${offerNotes}</p>`
            : "";

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
              Great news — <strong>a spot has opened up for ${childName}</strong> at Timothy Lutheran Church Mother's Day Out!
              We'd love to have your family join us.
            </p>

            ${notesBlock}

            <!-- Deadline box -->
            <table width="100%" cellpadding="0" cellspacing="0" style="margin:24px 0;">
              <tr>
                <td style="background:#fef3c7;border:2px solid #f59e0b;border-radius:8px;padding:16px 20px;text-align:center;">
                  <p style="margin:0;color:#78350f;font-size:13px;text-transform:uppercase;letter-spacing:.05em;font-weight:700;">Accept by</p>
                  <p style="margin:6px 0 0;color:#78350f;font-size:20px;font-weight:700;">${deadlineFormatted}</p>
                </td>
              </tr>
            </table>

            <p style="color:#333;font-size:15px;line-height:1.6;">
              To accept this offer, simply <strong>reply to this email</strong>. Once we hear from you, we'll send the enrollment paperwork and deposit information.
            </p>

            <p style="color:#555;font-size:14px;line-height:1.6;margin-top:16px;">
              If we don't hear back by the deadline above, we'll need to offer the spot to the next family on our waitlist. If you need a bit more time or have any questions at all, please don't hesitate to reach out — we're happy to work with you.
            </p>

            <p style="color:#333;font-size:15px;margin-top:24px;">Warm regards,<br>
            <strong>Timothy Lutheran Church MDO</strong></p>
          </td>
        </tr>

        <!-- Footer -->
        <tr>
          <td style="background:#f8fafc;padding:16px 32px;text-align:center;border-top:1px solid #e2e8f0;">
            <p style="margin:0;color:#94a3b8;font-size:12px;">You're receiving this because you joined the Timothy Lutheran Church MDO enrollment waitlist.</p>
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
                subject:  `Enrollment Offer for ${childName} — Timothy Lutheran MDO`,
                html,
            }),
        });

        const payload = await res.json();

        console.log("Resend status:", res.status, "payload:", JSON.stringify(payload));

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
            JSON.stringify({ error: err.message }),
            { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
        );
    }
});
