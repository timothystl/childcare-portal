import { serve } from "https://deno.land/std@0.168.0/http/server.ts";

const ALLOWED_ORIGIN = "https://mdo.timothystl.org";
const NOTIFY_EMAIL   = "mdo@timothystl.org";

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
    if (req.method === "OPTIONS") return new Response("ok", { headers: ch });

    try {
        const { parentName, parentEmail, message } =
            await req.json() as { parentName: string; parentEmail: string; message: string };

        if (!message || !message.trim()) {
            return new Response(JSON.stringify({ error: "Missing message" }), {
                status: 400, headers: { ...ch, "Content-Type": "application/json" },
            });
        }

        const apiKey    = Deno.env.get("RESEND_API_KEY");
        const fromEmail = Deno.env.get("RESEND_FROM_EMAIL") || "onboarding@resend.dev";

        if (!apiKey) {
            return new Response(JSON.stringify({ error: "RESEND_API_KEY not set" }), {
                status: 500, headers: { ...ch, "Content-Type": "application/json" },
            });
        }

        const nameLabel  = escHtml(parentName || "Unknown");
        const emailLabel = escHtml(parentEmail || "unknown");

        const html = `
<!DOCTYPE html>
<html lang="en">
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;font-family:Arial,Helvetica,sans-serif;background:#f0f4f8;">
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#f0f4f8;padding:32px 16px;">
    <tr><td align="center">
      <table width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;background:#fff;border-radius:12px;overflow:hidden;box-shadow:0 2px 16px rgba(0,0,0,.10);">

        <tr>
          <td style="background:#01294A;padding:22px 32px;text-align:center;">
            <p style="margin:0;color:#F5B731;font-size:12px;letter-spacing:.06em;text-transform:uppercase;font-weight:700;">Timothy Lutheran Church</p>
            <h1 style="margin:6px 0 0;color:#fff;font-size:20px;font-weight:700;">✉️ New Parent Message</h1>
          </td>
        </tr>

        <tr><td style="background:#F5B731;height:4px;"></td></tr>

        <tr>
          <td style="padding:28px 32px 24px;">
            <table width="100%" cellpadding="0" cellspacing="0" style="font-size:14px;border:1px solid #e5e7eb;border-radius:8px;overflow:hidden;margin-bottom:20px;">
              <tr style="background:#f8fafc;">
                <td style="padding:9px 14px;font-weight:600;color:#555;border-bottom:1px solid #e5e7eb;width:30%">From</td>
                <td style="padding:9px 14px;color:#333;border-bottom:1px solid #e5e7eb;">${nameLabel}</td>
              </tr>
              <tr>
                <td style="padding:9px 14px;font-weight:600;color:#555;">Email</td>
                <td style="padding:9px 14px;color:#333;"><a href="mailto:${emailLabel}" style="color:#01294A;">${emailLabel}</a></td>
              </tr>
            </table>

            <p style="margin:0 0 8px;color:#555;font-size:13px;font-weight:600;">Message</p>
            <div style="white-space:pre-wrap;background:#f8fafc;border:1px solid #e5e7eb;border-radius:8px;padding:16px;color:#222;font-size:14px;line-height:1.6;">${escHtml(message)}</div>
          </td>
        </tr>

        <tr>
          <td style="background:#f8fafc;padding:14px 32px;text-align:center;border-top:1px solid #e2e8f0;">
            <p style="margin:0;color:#94a3b8;font-size:11px;">Sent from the MDO parent portal message form. Reply directly to the sender's email above.</p>
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
                to:       [NOTIFY_EMAIL],
                reply_to: parentEmail || fromEmail,
                subject:  `New message from ${parentName || "a parent"} — MDO Portal`,
                html,
            }),
        });

        const payload = await res.json();
        if (!res.ok) {
            return new Response(JSON.stringify({ error: payload }), {
                status: res.status, headers: { ...ch, "Content-Type": "application/json" },
            });
        }

        return new Response(JSON.stringify({ success: true, id: payload.id }), {
            status: 200, headers: { ...ch, "Content-Type": "application/json" },
        });

    } catch (err) {
        return new Response(JSON.stringify({ error: (err as Error).message }), {
            status: 500, headers: { ...ch, "Content-Type": "application/json" },
        });
    }
});
