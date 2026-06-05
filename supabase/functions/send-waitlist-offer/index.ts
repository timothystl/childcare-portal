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

serve(async (req) => {
    const ch = corsHeaders(req);

    if (req.method === "OPTIONS") {
        return new Response("ok", { headers: ch });
    }

    try {
        // Require a valid admin session — this function sends branded MDO emails to
        // arbitrary recipients, so it must not be callable anonymously (anti-relay).
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

        const { parentName, parentEmail, childName, offerDeadline, offerNotes, papeworkLinks, procareLink } =
            await req.json();

        if (!parentEmail || !childName || !offerDeadline) {
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

        const deadlineFormatted = new Date(offerDeadline + "T00:00:00").toLocaleDateString(
            "en-US", { weekday: "long", year: "numeric", month: "long", day: "numeric" }
        );

        const notesBlock = offerNotes
            ? `<p style="background:#fffbeb;border-left:4px solid #f59e0b;padding:10px 14px;border-radius:4px;color:#444;margin:20px 0;">${escHtml(offerNotes)}</p>`
            : "";

        const links: string[] = Array.isArray(papeworkLinks) ? papeworkLinks : [];
        const paperwkBlock = links.length > 0
            ? `<div style="background:#f0f9ff;border:1px solid #bae6fd;border-radius:8px;padding:16px 20px;margin:20px 0;">
                 <p style="margin:0 0 10px;font-weight:700;color:#0369a1;font-size:14px;">📄 Enrollment Paperwork</p>
                 <p style="margin:0 0 8px;color:#444;font-size:14px;">Please complete the following form(s) before your child's start date:</p>
                 <ul style="margin:0;padding-left:20px;">
                   ${links.map(url => `<li style="margin-bottom:6px;"><a href="${escHtml(url)}" style="color:#4f46e5;">${escHtml(url)}</a></li>`).join('')}
                 </ul>
               </div>`
            : "";

        const procareBlock = procareLink
            ? `<div style="background:#f0fdf4;border:1px solid #86efac;border-radius:8px;padding:16px 20px;margin:20px 0;">
                 <p style="margin:0 0 10px;font-weight:700;color:#166534;font-size:14px;">📱 Procare Parent App</p>
                 <p style="margin:0 0 8px;color:#444;font-size:14px;">We use Procare to manage attendance, billing, and communication. Please enroll using the link below:</p>
                 <a href="${escHtml(procareLink)}" style="display:inline-block;background:#4f46e5;color:#fff;padding:10px 20px;border-radius:6px;text-decoration:none;font-weight:700;font-size:14px;">Enroll in Procare</a>
               </div>`
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
            <p style="margin:0 0 16px;color:#333;font-size:16px;">Dear ${escHtml(parentName)},</p>

            <p style="color:#333;font-size:15px;line-height:1.6;">
              We're so excited to let you know — <strong>a spot has opened up for ${escHtml(childName)}</strong> at Timothy Lutheran Church Mother's Day Out, and we'd love to have your family join us!
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
              To accept this offer, simply <strong>reply to this email</strong>. Once we hear from you, we'll confirm your child's start date and share any remaining information.
            </p>

            ${paperwkBlock}
            ${procareBlock}

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
                subject:  `A Spot is Available for ${String(childName ?? '')} — Timothy Lutheran MDO`,
                html,
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
            JSON.stringify({ error: err.message }),
            { status: 500, headers: { ...ch, "Content-Type": "application/json" } }
        );
    }
});
