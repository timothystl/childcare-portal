import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const ALLOWED_ORIGIN = "https://mdo.timothystl.org";

interface DateEntry { date: string; dayType: string; amount: number; }

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

function buildIcal(childList: string, dates: DateEntry[], monthLabel: string): string {
    const events = dates.map(d => {
        const compact = d.date.replace(/-/g, "");
        const nextDay = (() => {
            const dt = new Date(d.date + "T00:00:00");
            dt.setDate(dt.getDate() + 1);
            return dt.toISOString().slice(0, 10).replace(/-/g, "");
        })();
        const typeLabel = d.dayType === "half" ? "Half Day" : "Full Day";
        const uid = `mdo-${d.date}-${childList.replace(/[\s,]+/g, "")}@timothystl.org`;
        return [
            "BEGIN:VEVENT",
            `UID:${uid}`,
            `DTSTART;VALUE=DATE:${compact}`,
            `DTEND;VALUE=DATE:${nextDay}`,
            `SUMMARY:MDO – ${childList} – ${typeLabel}`,
            `DESCRIPTION:Mother's Day Out care day\\n${monthLabel}\\n$${d.amount.toFixed(2)}`,
            "END:VEVENT",
        ].join("\r\n");
    });
    return [
        "BEGIN:VCALENDAR",
        "VERSION:2.0",
        "PRODID:-//Timothy Lutheran MDO//Schedule Confirmation//EN",
        "METHOD:PUBLISH",
        ...events,
        "END:VCALENDAR",
    ].join("\r\n");
}

function buildInvoiceHtml(
    parentName: string,
    parentEmail: string,
    childList: string,
    monthLabel: string,
    dates: DateEntry[],
    grandTotal: number,
): string {
    const dateIssued = new Date().toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric" });
    const rows = dates.map(d => {
        const friendly = new Date(d.date + "T00:00:00").toLocaleDateString(
            "en-US", { weekday: "short", month: "long", day: "numeric", year: "numeric" }
        );
        const typeLabel = d.dayType === "half" ? "Half Day" : "Full Day";
        return `<tr><td>${friendly}</td><td>${typeLabel}</td><td class="amount">$${d.amount.toFixed(2)}</td></tr>`;
    }).join("\n");

    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<title>MDO Invoice &mdash; ${monthLabel}</title>
<style>
  body{font-family:Arial,Helvetica,sans-serif;max-width:620px;margin:40px auto;color:#222;padding:0 16px}
  .header{border-bottom:4px solid #01294A;padding-bottom:20px;margin-bottom:28px;display:flex;justify-content:space-between;align-items:flex-end}
  .brand{color:#01294A;font-size:30px;font-weight:800;margin:0;letter-spacing:-1px}
  .brand span{color:#F5B731}
  .sub{margin:4px 0 0;color:#555;font-size:13px}
  .meta{display:flex;justify-content:space-between;margin-bottom:24px;gap:16px}
  .meta-block p{margin:3px 0;font-size:14px}
  table{width:100%;border-collapse:collapse;margin-top:8px}
  th{background:#01294A;color:#fff;padding:9px 14px;text-align:left;font-size:13px}
  th:last-child{text-align:right}
  td{padding:9px 14px;border-bottom:1px solid #eee;font-size:14px}
  td.amount{text-align:right}
  .total-row td{font-weight:700;border-top:3px solid #01294A;border-bottom:none;font-size:15px}
  .total-row .amount{color:#01294A}
  .footer{margin-top:36px;color:#999;font-size:11px;border-top:1px solid #ddd;padding-top:16px}
  @media print{body{margin:0}button{display:none}}
</style>
</head>
<body>
  <div class="header">
    <div>
      <p class="brand"><span>my</span> MDO</p>
      <p class="sub">Timothy Lutheran Church &ndash; Mother&rsquo;s Day Out</p>
    </div>
    <div style="text-align:right;font-size:13px;color:#555">
      <p style="margin:0;font-weight:700;font-size:16px">Invoice / Receipt</p>
      <p style="margin:4px 0 0">Issued: ${dateIssued}</p>
    </div>
  </div>
  <div class="meta">
    <div class="meta-block">
      <p><strong>Bill To:</strong></p>
      <p>${parentName}</p>
      <p>${parentEmail}</p>
    </div>
    <div class="meta-block" style="text-align:right">
      <p><strong>Period:</strong> ${monthLabel}</p>
      <p><strong>Student(s):</strong> ${childList}</p>
    </div>
  </div>
  <table>
    <thead><tr><th>Date</th><th>Type</th><th style="text-align:right">Amount</th></tr></thead>
    <tbody>${rows}</tbody>
    <tfoot>
      <tr class="total-row">
        <td colspan="2">Total Due</td>
        <td class="amount">$${grandTotal.toFixed(2)}</td>
      </tr>
    </tfoot>
  </table>
  <div class="footer">
    <p>Please retain this invoice for your records (FSA / dependent care). For billing questions contact mdo@timothystl.org.</p>
    <p>Timothy Lutheran Church Mother&rsquo;s Day Out &middot; St. Louis, MO</p>
  </div>
</body>
</html>`;
}

serve(async (req) => {
    const ch = corsHeaders(req);

    if (req.method === "OPTIONS") {
        return new Response("ok", { headers: ch });
    }

    try {
        const { parentName, parentEmail, monthLabel, childNames, dates, grandTotal } =
            await req.json();

        // dates: [{ date: 'YYYY-MM-DD', dayType: 'full'|'half', amount: number }]
        if (!parentEmail || !dates?.length) {
            return new Response(
                JSON.stringify({ error: "Missing required fields" }),
                { status: 400, headers: { ...ch, "Content-Type": "application/json" } }
            );
        }

        // Strict email validation BEFORE the value is used in the PostgREST .or()
        // filter below — a string containing , ( ) or * would otherwise change the
        // filter semantics and defeat the anti-relay guard.
        if (typeof parentEmail !== "string" || !/^[^\s,()*@]+@[^\s,()*@]+\.[^\s,()*@]+$/.test(parentEmail)) {
            return new Response(
                JSON.stringify({ error: "Invalid email" }),
                { status: 400, headers: { ...ch, "Content-Type": "application/json" } }
            );
        }

        // Verify the recipient email belongs to a registered family — prevents
        // using this unauthenticated endpoint as a spam relay.
        const serviceClient = createClient(
            Deno.env.get("SUPABASE_URL")!,
            Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
            { auth: { autoRefreshToken: false, persistSession: false } },
        );
        const { data: family } = await serviceClient
            .from("families")
            .select("id")
            .or(`parent_email.ilike.${parentEmail},parent2_email.ilike.${parentEmail}`)
            .limit(1)
            .maybeSingle();
        if (!family) {
            return new Response(
                JSON.stringify({ error: "Recipient not found" }),
                { status: 403, headers: { ...ch, "Content-Type": "application/json" } }
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

        const childList = (childNames as string[]).join(", ");

        const rows = (dates as DateEntry[]).map(d => {
            const typeLabel = d.dayType === "half" ? "Half Day" : "Full Day";
            return `<tr>
                <td style="padding:8px 14px;border-bottom:1px solid #f0f0f0;">${friendlyDate(d.date)}</td>
                <td style="padding:8px 14px;border-bottom:1px solid #f0f0f0;color:#666;">${typeLabel}</td>
                <td style="padding:8px 14px;border-bottom:1px solid #f0f0f0;text-align:right;">$${d.amount.toFixed(2)}</td>
            </tr>`;
        }).join("");

        const html = `
<!DOCTYPE html>
<html lang="en">
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;font-family:Arial,Helvetica,sans-serif;background:#f0f4f8;">
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#f0f4f8;padding:32px 16px;">
    <tr><td align="center">
      <table width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;background:#fff;border-radius:12px;overflow:hidden;box-shadow:0 2px 16px rgba(0,0,0,.10);">

        <!-- Header -->
        <tr>
          <td style="background:#01294A;padding:28px 32px;text-align:center;">
            <img src="https://mdo.timothystl.org/images/logo/myMDO_primary_logo_light.png"
                 alt="my MDO" width="120" height="auto"
                 style="display:block;margin:0 auto 10px;">
            <p style="margin:0;color:#F5B731;font-size:12px;letter-spacing:.08em;text-transform:uppercase;font-weight:700;">Timothy Lutheran Church</p>
            <p style="margin:4px 0 0;color:rgba(255,255,255,.75);font-size:13px;">Mother&rsquo;s Day Out</p>
          </td>
        </tr>

        <!-- Sun bar -->
        <tr><td style="background:#F5B731;height:4px;"></td></tr>

        <!-- Body -->
        <tr>
          <td style="padding:32px 32px 24px;">
            <p style="margin:0 0 16px;color:#222;font-size:16px;">Dear ${escHtml(parentName)},</p>

            <p style="color:#333;font-size:15px;line-height:1.65;">
              Your care schedule for <strong>${escHtml(childList)}</strong> has been registered for <strong>${escHtml(monthLabel)}</strong>.
              Here&rsquo;s your confirmation:
            </p>

            <!-- Schedule table -->
            <table width="100%" cellpadding="0" cellspacing="0" style="margin:20px 0;border:1px solid #e2e8f0;border-radius:8px;overflow:hidden;font-size:14px;">
              <thead>
                <tr style="background:#01294A;">
                  <th style="padding:9px 14px;text-align:left;font-weight:600;color:#fff;font-size:13px;">Date</th>
                  <th style="padding:9px 14px;text-align:left;font-weight:600;color:#fff;font-size:13px;">Type</th>
                  <th style="padding:9px 14px;text-align:right;font-weight:600;color:#fff;font-size:13px;">Amount</th>
                </tr>
              </thead>
              <tbody>${rows}</tbody>
              <tfoot>
                <tr style="background:#FFF8E1;">
                  <td colspan="2" style="padding:10px 14px;font-weight:700;color:#333;border-top:2px solid #F5B731;">Total Due</td>
                  <td style="padding:10px 14px;text-align:right;font-weight:700;color:#01294A;font-size:16px;border-top:2px solid #F5B731;">$${(grandTotal as number).toFixed(2)}</td>
                </tr>
              </tfoot>
            </table>

            <p style="color:#555;font-size:14px;line-height:1.65;">
              A calendar file (.ics) and a printable invoice are attached. If you have any questions or need to make changes, please reply to this email.
            </p>

            <p style="color:#333;font-size:15px;margin-top:24px;">Warm regards,<br>
            <strong>Timothy Lutheran Church MDO</strong></p>
          </td>
        </tr>

        <!-- Footer -->
        <tr>
          <td style="background:#f8fafc;padding:16px 32px;text-align:center;border-top:1px solid #e2e8f0;">
            <p style="margin:0;color:#94a3b8;font-size:12px;">You&rsquo;re receiving this because you registered for the Timothy Lutheran Church MDO program.</p>
          </td>
        </tr>

      </table>
    </td></tr>
  </table>
</body>
</html>`;

        // ICS: one event per care date
        const icalContent = buildIcal(childList, dates as DateEntry[], monthLabel);
        const icalBase64  = btoa(icalContent);

        // Invoice: clean printable HTML
        const invoiceHtml   = buildInvoiceHtml(
            parentName, parentEmail, childList, monthLabel, dates as DateEntry[], grandTotal as number
        );
        const invoiceBase64 = btoa(unescape(encodeURIComponent(invoiceHtml)));

        const res = await fetch("https://api.resend.com/emails", {
            method:  "POST",
            headers: { "Authorization": `Bearer ${apiKey}`, "Content-Type": "application/json" },
            body: JSON.stringify({
                from:     fromEmail,
                to:       [parentEmail],
                reply_to: replyTo,
                subject:  `Schedule Confirmation — ${String(childList ?? '')} — ${String(monthLabel ?? '')}`,
                html,
                attachments: [
                    {
                        filename:     "mdo-schedule.ics",
                        content:      icalBase64,
                        content_type: "text/calendar",
                    },
                    {
                        filename:     "mdo-invoice.html",
                        content:      invoiceBase64,
                        content_type: "text/html",
                    },
                ],
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
