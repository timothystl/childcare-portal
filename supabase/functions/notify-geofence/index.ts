import { serve } from "https://deno.land/std@0.168.0/http/server.ts";

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
    if (req.method === "OPTIONS") return new Response("ok", { headers: ch });

    try {
        const { staffName, eventType, distanceFt, timestamp, notifyEmail } =
            await req.json() as {
                staffName:   string;
                eventType:   string;
                distanceFt:  number;
                timestamp:   string;
                notifyEmail: string;
            };

        if (!notifyEmail || !staffName) {
            return new Response(JSON.stringify({ error: "Missing required fields" }), {
                status: 400, headers: { ...ch, "Content-Type": "application/json" },
            });
        }

        const apiKey    = Deno.env.get("RESEND_API_KEY");
        const fromEmail = Deno.env.get("RESEND_FROM_EMAIL") || "onboarding@resend.dev";
        const replyTo   = Deno.env.get("RESEND_REPLY_TO")   || fromEmail;

        if (!apiKey) {
            return new Response(JSON.stringify({ error: "RESEND_API_KEY not set" }), {
                status: 500, headers: { ...ch, "Content-Type": "application/json" },
            });
        }

        const actionLabel = eventType === "clock_in" ? "clocked IN" : "clocked OUT";
        const timeLabel   = new Date(timestamp).toLocaleTimeString(
            "en-US", { hour: "numeric", minute: "2-digit", timeZoneName: "short" }
        );
        const distLabel   = distanceFt != null ? `${distanceFt.toLocaleString()} ft` : "unknown distance";

        const html = `
<!DOCTYPE html>
<html lang="en">
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;font-family:Georgia,serif;background:#f4f4f4;">
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#f4f4f4;padding:32px 16px;">
    <tr><td align="center">
      <table width="100%" cellpadding="0" cellspacing="0" style="max-width:520px;background:#fff;border-radius:12px;overflow:hidden;box-shadow:0 2px 12px rgba(0,0,0,.08);">

        <tr>
          <td style="background:#92400e;padding:22px 32px;text-align:center;">
            <p style="margin:0;color:#fde68a;font-size:12px;letter-spacing:.06em;text-transform:uppercase;">Timothy Lutheran Church</p>
            <h1 style="margin:6px 0 0;color:#fff;font-size:20px;font-weight:700;">⚠️ Geofence Alert</h1>
          </td>
        </tr>

        <tr>
          <td style="background:#fffbeb;padding:10px 32px;border-bottom:2px solid #fbbf24;">
            <p style="margin:0;color:#92400e;font-size:14px;font-weight:600;">Staff member ${actionLabel} outside the school boundary</p>
          </td>
        </tr>

        <tr>
          <td style="padding:28px 32px 24px;">
            <table width="100%" cellpadding="0" cellspacing="0" style="font-size:14px;border:1px solid #e5e7eb;border-radius:8px;overflow:hidden;">
              <tr style="background:#f8fafc;">
                <td style="padding:9px 14px;font-weight:600;color:#555;border-bottom:1px solid #e5e7eb;width:40%">Staff Member</td>
                <td style="padding:9px 14px;color:#333;border-bottom:1px solid #e5e7eb;">${escHtml(staffName)}</td>
              </tr>
              <tr>
                <td style="padding:9px 14px;font-weight:600;color:#555;border-bottom:1px solid #e5e7eb;">Event</td>
                <td style="padding:9px 14px;color:#333;border-bottom:1px solid #e5e7eb;text-transform:capitalize;">${escHtml(eventType.replace('_', ' '))}</td>
              </tr>
              <tr style="background:#fef9f0;">
                <td style="padding:9px 14px;font-weight:600;color:#555;border-bottom:1px solid #e5e7eb;">Distance from School</td>
                <td style="padding:9px 14px;font-weight:700;color:#92400e;border-bottom:1px solid #e5e7eb;">${escHtml(distLabel)}</td>
              </tr>
              <tr>
                <td style="padding:9px 14px;font-weight:600;color:#555;">Time</td>
                <td style="padding:9px 14px;color:#333;">${escHtml(timeLabel)}</td>
              </tr>
            </table>

            <p style="color:#555;font-size:14px;line-height:1.6;margin-top:20px;">
              The staff member was still able to complete their clock ${eventType === "clock_in" ? "in" : "out"}.
              This is an informational alert only — no action is required unless this appears suspicious.
            </p>
          </td>
        </tr>

        <tr>
          <td style="background:#f8fafc;padding:14px 32px;text-align:center;border-top:1px solid #e2e8f0;">
            <p style="margin:0;color:#94a3b8;font-size:11px;">Automated alert from the MDO Staff Clock-In system.</p>
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
                to:       [notifyEmail],
                reply_to: replyTo,
                subject:  `⚠️ Geofence Alert — ${staffName} ${actionLabel} (${distLabel} from school)`,
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
