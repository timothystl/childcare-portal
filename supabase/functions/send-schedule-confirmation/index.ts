import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const ALLOWED_ORIGIN = "https://mdo.timothystl.org";

interface DateEntry {
    date: string;
    dayType: string;
    amount: number;
    childName: string;
    label?: string;          // e.g. "Weekly rate (Aug 3 – Aug 7)" — shown instead of the date when set
    multiDiscount?: number;  // sibling discount already applied to `amount`, shown as a note
}

// Groups date rows by child, preserving the order children first appear in `childNames`.
function groupByChild(dates: DateEntry[], childNames: string[]): Array<{ name: string; rows: DateEntry[]; subtotal: number }> {
    const order = childNames.length ? childNames : [...new Set(dates.map(d => d.childName))];
    return order
        .map(name => {
            const rows = dates.filter(d => d.childName === name).sort((a, b) => a.date.localeCompare(b.date));
            return { name, rows, subtotal: rows.reduce((s, r) => s + r.amount, 0) };
        })
        .filter(group => group.rows.length > 0);
}

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

function friendlyDateLong(dateStr: string): string {
    return new Date(dateStr + "T00:00:00").toLocaleDateString(
        "en-US", { weekday: "short", month: "long", day: "numeric", year: "numeric" }
    );
}

function uint8ToBase64(bytes: Uint8Array): string {
    let bin = "";
    for (let i = 0; i < bytes.byteLength; i++) bin += String.fromCharCode(bytes[i]);
    return btoa(bin);
}

function buildIcal(dates: DateEntry[], monthLabel: string): string {
    const events = dates.map(d => {
        const compact = d.date.replace(/-/g, "");
        const nextDay = (() => {
            const dt = new Date(d.date + "T00:00:00");
            dt.setDate(dt.getDate() + 1);
            return dt.toISOString().slice(0, 10).replace(/-/g, "");
        })();
        const typeLabel = d.dayType === "half" ? "Half Day" : "Full Day";
        const uid = `mdo-${d.date}-${d.childName.replace(/[\s,]+/g, "")}@timothystl.org`;
        return [
            "BEGIN:VEVENT",
            `UID:${uid}`,
            `DTSTART;VALUE=DATE:${compact}`,
            `DTEND;VALUE=DATE:${nextDay}`,
            `SUMMARY:MDO – ${d.childName} – ${typeLabel}`,
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

// Returns null on any failure so the email can still send without a PDF.
async function buildInvoicePdf(
    parentName: string,
    parentEmail: string,
    childList: string,
    childNames: string[],
    monthLabel: string,
    dates: DateEntry[],
    grandTotal: number,
): Promise<Uint8Array | null> {
    try {
        // Dynamic import keeps a module-load failure from crashing the whole function.
        const { PDFDocument, StandardFonts, rgb } =
            await import("https://esm.sh/pdf-lib@1.17.1?target=deno");

        const PAGE_W = 612; // US Letter
        const PAGE_H = 792;
        const MARGIN  = 50;
        const COL_W   = PAGE_W - MARGIN * 2;
        const COL_TYPE_X   = MARGIN + 230;
        const RIGHT_EDGE   = MARGIN + COL_W;
        const ROW_H        = 20;
        const BOTTOM_LIMIT = MARGIN + 30; // keep table content above this on every page

        const NAVY     = rgb(1 / 255, 41 / 255, 74 / 255);
        const SUN      = rgb(245 / 255, 183 / 255, 49 / 255);
        const WHITE    = rgb(1, 1, 1);
        const DARK     = rgb(0.13, 0.13, 0.13);
        const MID      = rgb(0.4, 0.4, 0.4);
        const LITE     = rgb(0.88, 0.88, 0.88);
        const SUN_PALE = rgb(1, 0.97, 0.88);
        const LINEN    = rgb(0.98, 0.97, 0.93);

        const pdfDoc = await PDFDocument.create();
        const bold   = await pdfDoc.embedFont(StandardFonts.HelveticaBold);
        const reg    = await pdfDoc.embedFont(StandardFonts.Helvetica);

        let page = pdfDoc.addPage([PAGE_W, PAGE_H]);
        let y = PAGE_H;

        function drawHeaderBand(isFirstPage: boolean) {
            page.drawRectangle({ x: 0, y: PAGE_H - 80, width: PAGE_W, height: 80, color: NAVY });
            page.drawText("my", { x: MARGIN, y: PAGE_H - 46, size: 26, font: bold, color: SUN });
            page.drawText(" MDO", {
                x: MARGIN + bold.widthOfTextAtSize("my", 26), y: PAGE_H - 46,
                size: 26, font: bold, color: WHITE,
            });
            page.drawText("Timothy Lutheran Church – Mother's Day Out", {
                x: MARGIN, y: PAGE_H - 65, size: 9, font: reg, color: rgb(0.65, 0.75, 0.82),
            });
            const invLabel = isFirstPage ? "Invoice / Receipt" : "Invoice / Receipt (continued)";
            page.drawText(invLabel, {
                x: PAGE_W - MARGIN - bold.widthOfTextAtSize(invLabel, 13),
                y: PAGE_H - 44, size: 13, font: bold, color: WHITE,
            });
            const dateIssued = new Date().toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric" });
            const issuedLabel = `Issued: ${dateIssued}`;
            page.drawText(issuedLabel, {
                x: PAGE_W - MARGIN - reg.widthOfTextAtSize(issuedLabel, 9),
                y: PAGE_H - 62, size: 9, font: reg, color: rgb(0.65, 0.75, 0.82),
            });
            page.drawRectangle({ x: 0, y: PAGE_H - 84, width: PAGE_W, height: 4, color: SUN });
        }

        function drawTableHeader(startY: number): number {
            page.drawRectangle({ x: MARGIN, y: startY - 6, width: COL_W, height: ROW_H + 4, color: NAVY });
            page.drawText("Date",   { x: MARGIN + 6,     y: startY + 2, size: 9, font: bold, color: WHITE });
            page.drawText("Type",   { x: COL_TYPE_X + 6, y: startY + 2, size: 9, font: bold, color: WHITE });
            const amtHead = "Amount";
            page.drawText(amtHead, {
                x: RIGHT_EDGE - bold.widthOfTextAtSize(amtHead, 9) - 8,
                y: startY + 2, size: 9, font: bold, color: WHITE,
            });
            return startY - ROW_H;
        }

        // Page 1: letterhead + bill-to/meta, then the table header
        drawHeaderBand(true);
        y = PAGE_H - 112;
        page.drawText("Bill To", { x: MARGIN, y, size: 9, font: bold, color: MID });
        y -= 15;
        page.drawText(parentName,  { x: MARGIN, y, size: 11, font: bold, color: DARK });
        y -= 14;
        page.drawText(parentEmail, { x: MARGIN, y, size: 9, font: reg, color: MID });

        const metaTopY = PAGE_H - 127;
        const periodLabel  = "Period:";
        const studentLabel = "Student(s):";
        page.drawText(periodLabel, { x: PAGE_W - MARGIN - 240, y: metaTopY, size: 9, font: bold, color: MID });
        page.drawText(monthLabel, {
            x: PAGE_W - MARGIN - 240 + bold.widthOfTextAtSize(periodLabel, 9) + 6,
            y: metaTopY, size: 9, font: reg, color: DARK,
        });
        page.drawText(studentLabel, { x: PAGE_W - MARGIN - 240, y: metaTopY - 15, size: 9, font: bold, color: MID });
        page.drawText(childList, {
            x: PAGE_W - MARGIN - 240 + bold.widthOfTextAtSize(studentLabel, 9) + 6,
            y: metaTopY - 15, size: 9, font: reg, color: DARK,
        });

        y -= 28;
        y = drawTableHeader(y);

        // Ensures `neededHeight` of room remains before the bottom margin; if not,
        // starts a fresh page with a repeated table header. A multi-child invoice
        // (each with their own day count) can easily run past a single page.
        function ensureRoom(neededHeight: number) {
            if (y - neededHeight < BOTTOM_LIMIT) {
                page = pdfDoc.addPage([PAGE_W, PAGE_H]);
                drawHeaderBand(false);
                y = drawTableHeader(PAGE_H - 112);
            }
        }

        const groups = groupByChild(dates, childNames);

        for (const group of groups) {
            ensureRoom(ROW_H * 2); // subheading row + at least one date row
            page.drawRectangle({ x: MARGIN, y: y - 4, width: COL_W, height: ROW_H, color: LINEN });
            page.drawText(group.name, { x: MARGIN + 6, y: y + 2, size: 9, font: bold, color: NAVY });
            y -= ROW_H;

            group.rows.forEach((d, i) => {
                ensureRoom(ROW_H);
                if (i % 2 === 1) {
                    page.drawRectangle({ x: MARGIN, y: y - 4, width: COL_W, height: ROW_H, color: rgb(0.97, 0.97, 0.97) });
                }
                const dateLabel = d.label || friendlyDateLong(d.date);
                const typeLabel = d.label ? "" : (d.dayType === "half" ? "Half Day" : "Full Day");
                const amtStr    = `$${d.amount.toFixed(2)}`;
                page.drawText(dateLabel, { x: MARGIN + 6, y: y + 2, size: 9, font: reg, color: DARK });
                if (typeLabel) page.drawText(typeLabel, { x: COL_TYPE_X + 6, y: y + 2, size: 9, font: reg, color: MID });
                page.drawText(amtStr, {
                    x: RIGHT_EDGE - reg.widthOfTextAtSize(amtStr, 9) - 8,
                    y: y + 2, size: 9, font: reg, color: DARK,
                });
                page.drawLine({
                    start: { x: MARGIN, y: y - 4 }, end: { x: RIGHT_EDGE, y: y - 4 },
                    thickness: 0.4, color: LITE,
                });
                if (d.multiDiscount) {
                    page.drawText("(sibling discount applied)", {
                        x: COL_TYPE_X + 6, y: y - 7, size: 7, font: reg, color: MID,
                    });
                    y -= 8;
                }
                y -= ROW_H;
            });

            ensureRoom(ROW_H);
            const subtotalStr = `Subtotal: $${group.subtotal.toFixed(2)}`;
            page.drawText(subtotalStr, {
                x: RIGHT_EDGE - reg.widthOfTextAtSize(subtotalStr, 9) - 8,
                y: y + 2, size: 9, font: bold, color: NAVY,
            });
            y -= ROW_H;
        }

        // Total row + footer — keep both together on the same page
        ensureRoom(ROW_H + 62);
        y -= 2;
        page.drawLine({ start: { x: MARGIN, y: y + ROW_H }, end: { x: RIGHT_EDGE, y: y + ROW_H }, thickness: 2, color: SUN });
        page.drawRectangle({ x: MARGIN, y: y - 4, width: COL_W, height: ROW_H + 2, color: SUN_PALE });
        page.drawText("Total Due", { x: MARGIN + 6, y: y + 2, size: 10, font: bold, color: DARK });
        const totalStr = `$${grandTotal.toFixed(2)}`;
        page.drawText(totalStr, {
            x: RIGHT_EDGE - bold.widthOfTextAtSize(totalStr, 12) - 8,
            y: y + 1, size: 12, font: bold, color: NAVY,
        });

        // Footer
        y -= 36;
        page.drawLine({ start: { x: MARGIN, y }, end: { x: RIGHT_EDGE, y }, thickness: 0.5, color: LITE });
        y -= 13;
        page.drawText("Please retain this invoice for your records (FSA / dependent care).", {
            x: MARGIN, y, size: 8, font: reg, color: MID,
        });
        y -= 12;
        page.drawText("Billing questions: mdo@timothystl.org  ·  Timothy Lutheran Church MDO  ·  St. Louis, MO", {
            x: MARGIN, y, size: 8, font: reg, color: MID,
        });

        return await pdfDoc.save();

    } catch (_) {
        return null; // email sends without PDF rather than failing entirely
    }
}

serve(async (req) => {
    const ch = corsHeaders(req);

    if (req.method === "OPTIONS") {
        return new Response("ok", { headers: ch });
    }

    try {
        const { parentName, parentEmail, monthLabel, childNames, dates, grandTotal } =
            await req.json();

        if (!parentEmail || !dates?.length) {
            return new Response(
                JSON.stringify({ error: "Missing required fields" }),
                { status: 400, headers: { ...ch, "Content-Type": "application/json" } }
            );
        }

        // Reject PostgREST .or()/.ilike() metacharacters: `,()*` are the URL-decoded
        // shorthand PostgREST itself interprets, and `%`/`_` are literal Postgres
        // ILIKE wildcards that pass straight through regardless of that shorthand.
        if (typeof parentEmail !== "string" || !/^[^\s,()*%_@]+@[^\s,()*%_@]+\.[^\s,()*%_@]+$/.test(parentEmail)) {
            return new Response(
                JSON.stringify({ error: "Invalid email" }),
                { status: 400, headers: { ...ch, "Content-Type": "application/json" } }
            );
        }

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

        // Defensive default: a stale cached client predating per-child scheduling
        // could omit childName — fall back rather than silently dropping the row.
        const normalizedDates = (dates as DateEntry[]).map(d => ({
            ...d,
            childName: d.childName || (childNames as string[])[0] || "Registration",
        }));
        const childGroups = groupByChild(normalizedDates, childNames as string[]);
        const rows = childGroups.map(group => {
            const subheadingRow = `<tr>
                <td colspan="3" style="padding:8px 14px;background:#f7f5ef;font-weight:700;color:#01294A;font-size:13px;">${escHtml(group.name)}</td>
            </tr>`;
            const dateRows = group.rows.map(d => {
                const typeLabel = d.label ? "" : (d.dayType === "half" ? "Half Day" : "Full Day");
                const dateLabel = d.label || friendlyDate(d.date);
                const discNote  = d.multiDiscount
                    ? `<div style="font-size:11px;color:#888;">(−$${d.multiDiscount.toFixed(2)} sibling discount)</div>` : "";
                return `<tr>
                    <td style="padding:8px 14px;border-bottom:1px solid #f0f0f0;">${escHtml(dateLabel)}</td>
                    <td style="padding:8px 14px;border-bottom:1px solid #f0f0f0;color:#666;">${typeLabel}</td>
                    <td style="padding:8px 14px;border-bottom:1px solid #f0f0f0;text-align:right;">$${d.amount.toFixed(2)}${discNote}</td>
                </tr>`;
            }).join("");
            const subtotalRow = `<tr>
                <td colspan="2" style="padding:6px 14px;text-align:right;color:#555;font-size:12px;">Subtotal</td>
                <td style="padding:6px 14px;text-align:right;font-weight:700;color:#01294A;font-size:13px;">$${group.subtotal.toFixed(2)}</td>
            </tr>`;
            return subheadingRow + dateRows + subtotalRow;
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
              A calendar file (.ics) and a PDF invoice are attached. If you have any questions or need to make changes, please reply to this email.
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

        // ICS attachment — one event per care date.
        // Encode UTF-8 → base64; plain btoa() throws on non-Latin1 chars (the en-dash
        // in the SUMMARY line), which would 500 the whole request.
        const icalContent = buildIcal(normalizedDates, monthLabel);
        const icalBase64  = uint8ToBase64(new TextEncoder().encode(icalContent));

        // PDF invoice — optional; null means generation failed, skip the attachment
        const pdfBytes  = await buildInvoicePdf(
            parentName, parentEmail, childList, childNames as string[], monthLabel,
            normalizedDates, grandTotal as number,
        );
        const pdfBase64 = pdfBytes ? uint8ToBase64(pdfBytes) : null;

        const attachments: Array<{ filename: string; content: string; content_type: string }> = [
            { filename: "mdo-schedule.ics", content: icalBase64, content_type: "text/calendar" },
        ];
        if (pdfBase64) {
            attachments.push({ filename: "mdo-invoice.pdf", content: pdfBase64, content_type: "application/pdf" });
        }

        const res = await fetch("https://api.resend.com/emails", {
            method:  "POST",
            headers: { "Authorization": `Bearer ${apiKey}`, "Content-Type": "application/json" },
            body: JSON.stringify({
                from:        fromEmail,
                to:          [parentEmail],
                reply_to:    replyTo,
                subject:     `Schedule Confirmation — ${String(childList ?? '')} — ${String(monthLabel ?? '')}`,
                html,
                attachments,
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
