import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const ALLOWED_ORIGIN = "https://mdo.timothystl.org";
const ADMIN_URL = "https://mdo.timothystl.org/admin";

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

function friendlyDayType(t: string): string {
    return t === "half" ? "Half Day" : "Full Day";
}

serve(async (req) => {
    const ch = corsHeaders(req);

    if (req.method === "OPTIONS") {
        return new Response("ok", { headers: ch });
    }

    try {
        const { applicationId } = await req.json();
        if (!applicationId) {
            return new Response(
                JSON.stringify({ error: "Missing applicationId" }),
                { status: 400, headers: { ...ch, "Content-Type": "application/json" } }
            );
        }

        const serviceClient = createClient(
            Deno.env.get("SUPABASE_URL")!,
            Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
            { auth: { autoRefreshToken: false, persistSession: false } },
        );

        // Every address this function ever emails comes from this row (looked up
        // server-side by id), never from the request body — the anonymous caller
        // can't redirect mail to an address of their choosing (anti-relay).
        const { data: app, error: fetchErr } = await serviceClient
            .from("waitlist_applications")
            .select("*")
            .eq("id", applicationId)
            .maybeSingle();

        if (fetchErr || !app) {
            return new Response(
                JSON.stringify({ error: "Application not found" }),
                { status: 404, headers: { ...ch, "Content-Type": "application/json" } }
            );
        }

        // Idempotent: only ever fires once per application, and only for
        // applications that were just submitted (blunts ID-enumeration abuse
        // since bigserial ids are sequential/guessable).
        if (app.confirmation_sent_at) {
            return new Response(
                JSON.stringify({ success: true, alreadySent: true }),
                { status: 200, headers: { ...ch, "Content-Type": "application/json" } }
            );
        }
        const appliedAt = new Date(app.applied_at);
        if (Date.now() - appliedAt.getTime() > 30 * 60 * 1000) {
            return new Response(
                JSON.stringify({ success: true, skipped: "stale" }),
                { status: 200, headers: { ...ch, "Content-Type": "application/json" } }
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

        const submittedFormatted = appliedAt.toLocaleString("en-US", {
            weekday: "long", month: "long", day: "numeric", year: "numeric",
            hour: "numeric", minute: "2-digit",
        });
        const startFormatted = app.desired_start_date
            ? new Date(app.desired_start_date + "T00:00:00").toLocaleDateString(
                "en-US", { month: "long", day: "numeric", year: "numeric" })
            : "Flexible";
        const daysStr = (app.days_of_week || "").split(",").map((s: string) => s.trim()).filter(Boolean).join(", ") || "—";
        const isUnborn = !app.child_dob && !!app.expected_due_date;

        const parentHtml = `
<!DOCTYPE html>
<html lang="en">
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;font-family:Georgia,serif;background:#f4f4f4;">
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#f4f4f4;padding:32px 16px;">
    <tr><td align="center">
      <table width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;background:#fff;border-radius:12px;overflow:hidden;box-shadow:0 2px 12px rgba(0,0,0,.08);">
        <tr>
          <td style="background:#4f46e5;padding:28px 32px;text-align:center;">
            <p style="margin:0;color:#c7d2fe;font-size:13px;letter-spacing:.06em;text-transform:uppercase;">Timothy Lutheran Church</p>
            <h1 style="margin:6px 0 0;color:#fff;font-size:22px;font-weight:700;">Mother's Day Out</h1>
          </td>
        </tr>
        <tr>
          <td style="padding:32px 32px 24px;">
            <p style="margin:0 0 16px;color:#333;font-size:16px;">Dear ${escHtml(app.parent_name)},</p>
            <p style="color:#333;font-size:15px;line-height:1.6;">
              Thank you for your interest in Timothy Lutheran Church Mother's Day Out! We've received your waitlist inquiry for <strong>${escHtml(app.child_name)}</strong>${isUnborn ? " (expecting)" : ""}.
            </p>
            <table width="100%" cellpadding="0" cellspacing="0" style="margin:20px 0;">
              <tr>
                <td style="background:#f0f9ff;border:1px solid #bae6fd;border-radius:8px;padding:16px 20px;">
                  <p style="margin:0 0 6px;color:#0369a1;font-size:12px;text-transform:uppercase;letter-spacing:.05em;font-weight:700;">Received</p>
                  <p style="margin:0 0 12px;color:#333;font-size:15px;font-weight:700;">${escHtml(submittedFormatted)}</p>
                  <p style="margin:0;color:#444;font-size:13px;line-height:1.6;">
                    Desired start: <strong>${escHtml(startFormatted)}</strong><br>
                    Days: <strong>${escHtml(daysStr)}</strong> · ${friendlyDayType(app.day_type)}
                  </p>
                </td>
              </tr>
            </table>
            <p style="color:#333;font-size:15px;line-height:1.6;">
              Spots are offered on a first-come, first-served basis as they become available, so your place is secured by the timestamp above. We'll be in touch about scheduling a tour, and we'll reach out directly the moment a spot opens up for your family.
            </p>
            <p style="color:#555;font-size:14px;line-height:1.6;margin-top:16px;">
              If anything changes — your plans, contact info, or you're no longer interested — just reply to this email and let us know.
            </p>
            <p style="color:#333;font-size:15px;margin-top:24px;">Warm regards,<br>
            <strong>Timothy Lutheran Church MDO</strong></p>
          </td>
        </tr>
        <tr>
          <td style="background:#f8fafc;padding:16px 32px;text-align:center;border-top:1px solid #e2e8f0;">
            <p style="margin:0;color:#94a3b8;font-size:12px;">You're receiving this because you submitted a waitlist inquiry with Timothy Lutheran Church MDO.</p>
          </td>
        </tr>
      </table>
    </td></tr>
  </table>
</body>
</html>`;

        const results: Record<string, unknown> = {};

        const parentRes = await fetch("https://api.resend.com/emails", {
            method:  "POST",
            headers: { "Authorization": `Bearer ${apiKey}`, "Content-Type": "application/json" },
            body: JSON.stringify({
                from:     fromEmail,
                to:       [app.parent_email],
                reply_to: replyTo,
                subject:  `We've Received Your Waitlist Inquiry — Timothy Lutheran MDO`,
                html:     parentHtml,
            }),
        });
        results.parent = { ok: parentRes.ok, body: await parentRes.json() };

        // Admin heads-up, if a notify address is configured.
        const { data: settingsRow } = await serviceClient
            .from("settings")
            .select("value")
            .eq("key", "waitlist_notify")
            .maybeSingle();
        const notifyEmail = settingsRow?.value?.notifyEmail;

        if (notifyEmail && typeof notifyEmail === "string") {
            const adminHtml = `
<!DOCTYPE html>
<html lang="en"><head><meta charset="UTF-8"></head>
<body style="margin:0;padding:0;font-family:Georgia,serif;background:#f4f4f4;">
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#f4f4f4;padding:32px 16px;">
    <tr><td align="center">
      <table width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;background:#fff;border-radius:12px;overflow:hidden;box-shadow:0 2px 12px rgba(0,0,0,.08);">
        <tr>
          <td style="background:#166534;padding:24px 32px;text-align:center;">
            <h1 style="margin:0;color:#fff;font-size:20px;font-weight:700;">📋 New Waitlist Inquiry</h1>
          </td>
        </tr>
        <tr>
          <td style="padding:28px 32px;">
            <p style="margin:0 0 14px;color:#333;font-size:15px;">
              <strong>${escHtml(app.child_name)}</strong>${isUnborn ? " (expecting)" : ""} — submitted ${escHtml(submittedFormatted)}
            </p>
            <table width="100%" cellpadding="6" cellspacing="0" style="font-size:14px;color:#444;">
              <tr><td style="color:#888;">Parent</td><td>${escHtml(app.parent_name)} · ${escHtml(app.parent_email)}${app.parent_phone ? " · " + escHtml(app.parent_phone) : ""}</td></tr>
              <tr><td style="color:#888;">Desired start</td><td>${escHtml(startFormatted)}</td></tr>
              <tr><td style="color:#888;">Days / Type</td><td>${escHtml(daysStr)} · ${friendlyDayType(app.day_type)}</td></tr>
              ${app.notes ? `<tr><td style="color:#888;">Notes</td><td>${escHtml(app.notes)}</td></tr>` : ""}
            </table>
            <p style="margin-top:22px;">
              <a href="${ADMIN_URL}" style="display:inline-block;background:#4f46e5;color:#fff;padding:10px 20px;border-radius:6px;text-decoration:none;font-weight:700;font-size:14px;">Open Waitlist in Admin</a>
            </p>
          </td>
        </tr>
      </table>
    </td></tr>
  </table>
</body></html>`;

            const adminRes = await fetch("https://api.resend.com/emails", {
                method:  "POST",
                headers: { "Authorization": `Bearer ${apiKey}`, "Content-Type": "application/json" },
                body: JSON.stringify({
                    from:    fromEmail,
                    to:      [notifyEmail],
                    subject: `New Waitlist Inquiry: ${app.child_name}`,
                    html:    adminHtml,
                }),
            });
            results.admin = { ok: adminRes.ok, body: await adminRes.json() };
        }

        await serviceClient
            .from("waitlist_applications")
            .update({ confirmation_sent_at: new Date().toISOString() })
            .eq("id", applicationId);

        return new Response(
            JSON.stringify({ success: true, results }),
            { status: 200, headers: { ...ch, "Content-Type": "application/json" } }
        );

    } catch (err) {
        return new Response(
            JSON.stringify({ error: err.message }),
            { status: 500, headers: { ...ch, "Content-Type": "application/json" } }
        );
    }
});
