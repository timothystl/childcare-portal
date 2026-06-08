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
        "en-US", { weekday: "long", month: "long", day: "numeric" }
    );
}

interface Shift {
    date: string;
    dayLabel: string;
    roomLabel: string;
    shift: "am" | "pm";
}

serve(async (req) => {
    const ch = corsHeaders(req);
    if (req.method === "OPTIONS") return new Response("ok", { headers: ch });

    try {
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

        const { staffName, staffEmail, weekStart, shifts } = await req.json() as {
            staffName: string;
            staffEmail: string;
            weekStart: string;
            shifts: Shift[];
        };

        if (!staffEmail || !staffName || !Array.isArray(shifts) || !shifts.length) {
            return new Response(JSON.stringify({ error: "Missing required fields" }), {
                status: 400, headers: { ...ch, "Content-Type": "application/json" },
            });
        }

        const apiKey    = Deno.env.get("RESEND_API_KEY");
        const fromEmail = Deno.env.get("RESEND_FROM_EMAIL") || "onboarding@resend.dev";
        const replyTo   = Deno.env.get("RESEND_REPLY_TO")   || fromEmail;

        if (!apiKey) {
            return new Response(JSON.stringify({ error: "RESEND_API_KEY secret is not set" }), {
                status: 500, headers: { ...ch, "Content-Type": "application/json" },
            });
        }

        // Group shifts by date
        const byDate: Record<string, Shift[]> = {};
        for (const s of shifts) {
            if (!byDate[s.date]) byDate[s.date] = [];
            byDate[s.date].push(s);
        }
        const sortedDates = Object.keys(byDate).sort();

        const shiftRows = sortedDates.map(d => {
            const dayShifts = byDate[d];
            return dayShifts.map((s, i) => `
            <tr${i === 0 ? ` style="border-top:2px solid #e5e7eb"` : ''}>
                ${i === 0 ? `<td rowspan="${dayShifts.length}" style="padding:8px 14px;font-weight:700;color:#333;vertical-align:top;border-right:1px solid #f0f0f0;white-space:nowrap">${escHtml(friendlyDate(d))}</td>` : ''}
                <td style="padding:6px 14px;color:${s.shift === 'am' ? '#1d4ed8' : '#92400e'};font-weight:600">${s.shift === 'am' ? 'AM  8:15 – 1:15' : 'PM  12:00 – 5:00'}</td>
                <td style="padding:6px 14px;color:#333">${escHtml(s.roomLabel)}</td>
            </tr>`).join('');
        }).join('');

        const weekLabel = new Date(weekStart + 'T00:00:00').toLocaleDateString(
            'en-US', { month: 'long', day: 'numeric', year: 'numeric' }
        );

        const html = `
<!DOCTYPE html>
<html lang="en">
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;font-family:Georgia,serif;background:#f4f4f4;">
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#f4f4f4;padding:32px 16px;">
    <tr><td align="center">
      <table width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;background:#fff;border-radius:12px;overflow:hidden;box-shadow:0 2px 12px rgba(0,0,0,.08);">

        <tr>
          <td style="background:#01294A;padding:26px 32px;text-align:center;">
            <p style="margin:0;color:#93c5fd;font-size:12px;letter-spacing:.06em;text-transform:uppercase;">Timothy Lutheran Church</p>
            <h1 style="margin:6px 0 0;color:#fff;font-size:20px;font-weight:700;">Mother's Day Out</h1>
          </td>
        </tr>

        <tr>
          <td style="background:#eff6ff;padding:10px 32px;border-bottom:2px solid #bfdbfe;">
            <p style="margin:0;color:#1e40af;font-size:14px;font-weight:600;">📅 Your Schedule — Week of ${escHtml(weekLabel)}</p>
          </td>
        </tr>

        <tr>
          <td style="padding:28px 32px 20px;">
            <p style="margin:0 0 16px;color:#333;font-size:15px;">Hi ${escHtml(staffName)},</p>
            <p style="color:#555;font-size:14px;line-height:1.6;margin:0 0 20px;">
              Here is your staff schedule for the week of <strong>${escHtml(weekLabel)}</strong>. Please reply if you have any questions or conflicts.
            </p>

            <table width="100%" cellpadding="0" cellspacing="0" style="border:1px solid #e5e7eb;border-radius:8px;overflow:hidden;font-size:14px;">
              <thead>
                <tr style="background:#f8fafc;">
                  <th style="padding:8px 14px;text-align:left;font-weight:600;color:#555;border-bottom:2px solid #e5e7eb;">Date</th>
                  <th style="padding:8px 14px;text-align:left;font-weight:600;color:#555;border-bottom:2px solid #e5e7eb;">Shift</th>
                  <th style="padding:8px 14px;text-align:left;font-weight:600;color:#555;border-bottom:2px solid #e5e7eb;">Room</th>
                </tr>
              </thead>
              <tbody>${shiftRows}</tbody>
            </table>

            <p style="color:#333;font-size:14px;margin-top:24px;">Thank you!<br>
            <strong>Timothy Lutheran Church MDO</strong></p>
          </td>
        </tr>

        <tr>
          <td style="background:#f8fafc;padding:14px 32px;text-align:center;border-top:1px solid #e2e8f0;">
            <p style="margin:0;color:#94a3b8;font-size:11px;">You're receiving this because an admin sent your weekly schedule from the MDO staff portal.</p>
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
                to:       [staffEmail],
                reply_to: replyTo,
                subject:  `Your MDO Schedule — Week of ${weekLabel}`,
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
