// ============================================================
// send-invoice — emails a family their monthly invoice
// ============================================================
// The last missing step of the money flow. The Invoices tool could draft a
// bill and record that it was issued; this actually sends it.
//
// SECURITY POSTURE — deliberately stricter than the older email functions,
// which the code review flagged (T1: no auth check + client-supplied
// amounts; FS6/FS11: client-supplied recipients, session-only gating):
//
//   1. The request body carries ONLY invoice ids. Nothing about who to
//      email, or how much to bill, comes from the caller. Recipient,
//      family name, month and every figure are read from the database with
//      the service role. There is no way to aim this function at an
//      arbitrary address, so it cannot be used as a mail relay.
//   2. The caller must hold a valid session AND be a `full`-access admin
//      per settings.admin_roles. A session alone is not enough.
//   3. sent_at / sent_to are stamped by THIS function after Resend accepts
//      the message, so the record cannot claim a send that did not happen.
//   4. The batch is capped, and an already-sent invoice is skipped unless
//      `resend: true` is passed — re-running the button cannot double-send.
//   5. `test: true` sends one sample to the CALLER'S OWN address, taken from
//      the verified JWT and never from the body, so the test affordance
//      cannot become the relay that rule 1 exists to prevent. A test does
//      not stamp anything and is clearly marked in the subject and body.
//
// Deploy:  supabase functions deploy send-invoice
// Secrets: RESEND_API_KEY, RESEND_FROM_EMAIL, RESEND_REPLY_TO
// ============================================================

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const ALLOWED_ORIGIN = "https://mdo.timothystl.org";
const MAX_BATCH = 200;

function escHtml(s: unknown): string {
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

function json(body: unknown, status: number, ch: Record<string, string>) {
    return new Response(JSON.stringify(body), {
        status, headers: { ...ch, "Content-Type": "application/json" },
    });
}

const money = (n: unknown) =>
    '$' + (Math.round((Number(n) || 0) * 100) / 100).toLocaleString('en-US', {
        minimumFractionDigits: 2, maximumFractionDigits: 2,
    });

/** Conservative address check — enough to catch a malformed row, not a validator. */
function looksLikeEmail(s: unknown): boolean {
    const v = String(s ?? '').trim();
    return v.length > 3 && v.length < 255 && /^[^\s@,;]+@[^\s@,;]+\.[^\s@,;]+$/.test(v);
}

/**
 * settings.value is a TEXT column, so PostgREST hands it back as a string
 * even when it holds JSON — the same text-vs-object trap the code review
 * logged as T3. A note may therefore arrive as a bare string, as a JSON
 * string, or as {"text": "..."}. Without this, an object-shaped note would
 * be emailed to families as raw JSON.
 */
function readNote(raw: unknown): string {
    if (raw == null) return "";
    let v: unknown = raw;
    if (typeof v === "string") {
        const t = v.trim();
        if (!t) return "";
        if (t.startsWith("{") || t.startsWith("\"")) {
            try { v = JSON.parse(t); } catch { return v as string; }
        } else {
            return v as string;
        }
    }
    if (typeof v === "string") return v;
    if (v && typeof v === "object") return String((v as Record<string, unknown>).text ?? "");
    return String(v ?? "");
}

function monthLabel(month: string): string {
    // billing_cycles.month is 'YYYY-MM'
    const m = /^(\d{4})-(\d{2})$/.exec(String(month || ''));
    if (!m) return String(month || '');
    return new Date(Number(m[1]), Number(m[2]) - 1, 1)
        .toLocaleDateString('en-US', { month: 'long', year: 'numeric' });
}

function buildHtml(o: {
    parentName: string; month: string; base: number; discount: number;
    adjustment: number; adjustmentNote: string; total: number; note: string;
    isTest?: boolean;
}): string {
    const line = (label: string, value: string, strong = false) => `
        <tr>
          <td style="padding:9px 0;border-bottom:1px solid #F0EADA;color:#2E2A22;font-size:15px;${strong ? 'font-weight:700;' : ''}">${escHtml(label)}</td>
          <td style="padding:9px 0;border-bottom:1px solid #F0EADA;color:#01294A;font-size:15px;text-align:right;${strong ? 'font-weight:700;' : ''}">${escHtml(value)}</td>
        </tr>`;

    const noteBlock = o.note
        ? `<div style="background:#FFF8E1;border:1px solid #F5B731;border-radius:8px;padding:14px 18px;margin:22px 0;color:#2E2A22;font-size:14px;line-height:1.6;">${escHtml(o.note)}</div>`
        : "";

    return `<!DOCTYPE html>
<html lang="en">
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:#F5F0E4;font-family:'Nunito',Helvetica,Arial,sans-serif;">
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#F5F0E4;padding:32px 16px;">
    <tr><td align="center">
      <table width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;background:#FFFFFF;border-radius:12px;overflow:hidden;box-shadow:0 2px 12px rgba(1,41,74,.08);">

        ${o.isTest ? `<tr>
          <td style="background:#01294A;padding:12px 32px;text-align:center;">
            <p style="margin:0;color:#F5B731;font-size:13px;font-weight:800;letter-spacing:.04em;">TEST PREVIEW — this bill was not sent to any family</p>
          </td>
        </tr>` : ''}

        <tr>
          <td style="background:#C9E6DC;padding:26px 32px;border-bottom:3px solid #F5B731;text-align:center;">
            <p style="margin:0;color:#01294A;font-size:12px;letter-spacing:.08em;text-transform:uppercase;font-weight:700;">Timothy Lutheran Church</p>
            <h1 style="margin:6px 0 0;color:#01294A;font-size:22px;font-weight:800;">Mother's Day Out</h1>
          </td>
        </tr>

        <tr>
          <td style="padding:30px 32px 8px;">
            <p style="margin:0 0 6px;color:#7A6E5A;font-size:12px;letter-spacing:.08em;text-transform:uppercase;font-weight:700;">Invoice</p>
            <h2 style="margin:0 0 18px;color:#01294A;font-size:20px;font-weight:700;">${escHtml(monthLabel(o.month))}</h2>

            <p style="margin:0 0 18px;color:#2E2A22;font-size:15px;line-height:1.6;">
              Hello ${escHtml(o.parentName)},<br>
              Here is your statement for ${escHtml(monthLabel(o.month))}, based on the days booked for your child${'('}ren${')'}.
            </p>

            <table width="100%" cellpadding="0" cellspacing="0" style="margin:0 0 6px;">
              ${line('Care days', money(o.base))}
              ${o.discount > 0 ? line('Discounts', '−' + money(o.discount)) : ''}
              ${o.adjustment !== 0 ? line(o.adjustmentNote || 'Adjustment', (o.adjustment < 0 ? '−' : '') + money(Math.abs(o.adjustment))) : ''}
              ${line('Amount due', money(o.total), true)}
            </table>
          </td>
        </tr>

        <tr>
          <td style="padding:14px 32px 6px;">
            <table width="100%" cellpadding="0" cellspacing="0">
              <tr><td style="background:#EAF5EF;border:1px solid #C8EADC;border-radius:10px;padding:18px 20px;text-align:center;">
                <p style="margin:0;color:#3A7B60;font-size:12px;letter-spacing:.06em;text-transform:uppercase;font-weight:700;">Amount due</p>
                <p style="margin:6px 0 0;color:#01294A;font-size:28px;font-weight:800;">${escHtml(money(o.total))}</p>
              </td></tr>
            </table>
            ${noteBlock}
          </td>
        </tr>

        <tr>
          <td style="padding:8px 32px 28px;">
            <p style="margin:0;color:#7A6E5A;font-size:14px;line-height:1.6;">
              If anything here looks wrong, just reply to this email and we'll take a look — it's no trouble at all.
            </p>
            <p style="margin:20px 0 0;color:#2E2A22;font-size:15px;">Thank you,<br>
              <strong style="color:#01294A;">Timothy Lutheran MDO</strong></p>
          </td>
        </tr>

        <tr>
          <td style="background:#FDFAF0;padding:16px 32px;text-align:center;border-top:1px solid #E8E0CC;">
            <p style="margin:0;color:#7A6E5A;font-size:12px;">You're receiving this because your child is enrolled at Timothy Lutheran Church MDO.</p>
          </td>
        </tr>

      </table>
    </td></tr>
  </table>
</body>
</html>`;
}

serve(async (req) => {
    const ch = corsHeaders(req);
    if (req.method === "OPTIONS") return new Response("ok", { headers: ch });

    try {
        // ── 1. Caller must be an authenticated admin ─────────────
        const authHeader = req.headers.get("Authorization");
        if (!authHeader) return json({ error: "Unauthorized" }, 401, ch);

        const callerClient = createClient(
            Deno.env.get("SUPABASE_URL")!,
            Deno.env.get("SUPABASE_ANON_KEY")!,
            { global: { headers: { Authorization: authHeader } } },
        );
        const { data: { user }, error: authError } = await callerClient.auth.getUser();
        if (authError || !user) return json({ error: "Unauthorized" }, 401, ch);

        const admin = createClient(
            Deno.env.get("SUPABASE_URL")!,
            Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
        );

        // ── 2. …and hold full access, not merely a session ───────
        // A session alone gates nothing useful here: `restricted` and `staff`
        // accounts have one too, and this function sends money demands to
        // families under the church's name.
        const { data: rolesRow } = await admin
            .from("settings").select("value").eq("key", "admin_roles").maybeSingle();
        let roles: Record<string, string> = {};
        const rawRoles = rolesRow?.value;
        if (rawRoles) {
            roles = typeof rawRoles === "string" ? (JSON.parse(rawRoles) || {}) : rawRoles;
        }
        const callerEmail = (user.email || "").toLowerCase().trim();
        // Mirrors applySessionRole() in the browser: when no rules are
        // configured at all the app treats every admin as full.
        const hasRules = Object.keys(roles).length > 0;
        const callerRole = hasRules ? (roles[callerEmail] || "staff") : "full";
        if (callerRole !== "full") {
            return json({ error: "Full admin access is required to send invoices." }, 403, ch);
        }

        // ── 3. Input: invoice ids only ───────────────────────────
        const body = await req.json().catch(() => ({}));
        const ids = Array.isArray(body?.invoiceIds)
            ? body.invoiceIds.map((n: unknown) => Number(n)).filter((n: number) => Number.isFinite(n))
            : [];
        const resend = body?.resend === true;
        const isTest = body?.test === true;

        if (!ids.length && !isTest) return json({ error: "No invoices given." }, 400, ch);
        if (ids.length > MAX_BATCH) return json({ error: `Too many invoices in one call (max ${MAX_BATCH}).` }, 400, ch);

        const apiKey    = Deno.env.get("RESEND_API_KEY");
        const fromEmail = Deno.env.get("RESEND_FROM_EMAIL") || "onboarding@resend.dev";
        const replyTo   = Deno.env.get("RESEND_REPLY_TO")   || fromEmail;
        if (!apiKey) return json({ error: "RESEND_API_KEY secret is not set" }, 500, ch);

        // Optional director-authored line ("How to pay…"), so the wording can
        // change without a redeploy.
        const { data: noteRow } = await admin
            .from("settings").select("value").eq("key", "invoice_email_note").maybeSingle();
        const note = readNote(noteRow?.value);

        // ── 3b. Test send: one sample, to the caller, stamping nothing ──
        // The recipient is the address on the verified session, never the
        // request body, so this cannot be aimed anywhere else.
        if (isTest) {
            if (!looksLikeEmail(callerEmail)) {
                return json({ error: "Your admin account has no usable email address." }, 400, ch);
            }
            // Prefer a real drafted invoice so the preview matches what
            // families will get; fall back to a representative sample when
            // nothing is drafted yet.
            const { data: sampleRows } = ids.length
                ? await admin.from("billing_invoices")
                    .select("base_amount, discount_amount, adjustment_amount, adjustment_note, final_amount, billing_cycles(month)")
                    .in("id", ids).limit(1)
                : await admin.from("billing_invoices")
                    .select("base_amount, discount_amount, adjustment_amount, adjustment_note, final_amount, billing_cycles(month)")
                    .order("id", { ascending: false }).limit(1);
            const sample = sampleRows?.[0];

            const now = new Date();
            const html = buildHtml({
                parentName:     "there",
                month:          (sample as any)?.billing_cycles?.month
                                  || `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`,
                base:           Number(sample?.base_amount)       || 320,
                discount:       Number(sample?.discount_amount)   || 0,
                adjustment:     Number(sample?.adjustment_amount) || 0,
                adjustmentNote: sample?.adjustment_note || "",
                total:          Number(sample?.final_amount)      || 320,
                note,
                isTest:         true,
            });

            const res = await fetch("https://api.resend.com/emails", {
                method: "POST",
                headers: { "Authorization": `Bearer ${apiKey}`, "Content-Type": "application/json" },
                body: JSON.stringify({
                    from:     fromEmail,
                    to:       [callerEmail],
                    reply_to: replyTo,
                    subject:  "[TEST] Your invoice — Timothy Lutheran MDO",
                    html,
                }),
            });
            if (!res.ok) {
                let detail = String(res.status);
                try { detail = JSON.stringify(await res.json()); } catch { /* keep the status */ }
                return json({ error: `Resend rejected the test: ${detail}` }, 502, ch);
            }
            await admin.from("admin_audit_log").insert({
                admin_email: callerEmail, action: "email_test", entity: "billing_invoice",
                details: { to: callerEmail, usedRealInvoice: !!sample },
            }).then(() => {}, (e: unknown) => console.error("send-invoice: audit write failed", e));

            return json({
                success: true, test: true, to: callerEmail, usedRealInvoice: !!sample,
                sent: [], skipped: [],
            }, 200, ch);
        }

        // ── 4. Everything else is read server-side ───────────────
        const { data: invoices, error: invErr } = await admin
            .from("billing_invoices")
            .select("id, family_id, base_amount, discount_amount, adjustment_amount, adjustment_note, final_amount, status, sent_at, billing_cycles(month)")
            .in("id", ids);
        if (invErr) return json({ error: invErr.message }, 500, ch);

        const famIds = [...new Set((invoices || []).map(i => i.family_id).filter(Boolean))];
        const { data: families } = famIds.length
            ? await admin.from("families").select("id, parent_name, parent_email").in("id", famIds)
            : { data: [] as any[] };
        const famById = new Map((families || []).map((f: any) => [String(f.id), f]));

        const sent: Array<{ id: number; to: string }> = [];
        const skipped: Array<{ id: number; reason: string }> = [];

        for (const inv of invoices || []) {
            if (inv.sent_at && !resend) { skipped.push({ id: inv.id, reason: "already sent" }); continue; }

            const fam = famById.get(String(inv.family_id));
            if (!fam)                       { skipped.push({ id: inv.id, reason: "no family record" }); continue; }
            if (!looksLikeEmail(fam.parent_email)) {
                skipped.push({ id: inv.id, reason: "no usable email on the family record" });
                continue;
            }

            const month = (inv as any).billing_cycles?.month || "";
            const html = buildHtml({
                parentName:     fam.parent_name || "there",
                month,
                base:           Number(inv.base_amount) || 0,
                discount:       Number(inv.discount_amount) || 0,
                adjustment:     Number(inv.adjustment_amount) || 0,
                adjustmentNote: inv.adjustment_note || "",
                total:          Number(inv.final_amount) || 0,
                note,
            });

            const res = await fetch("https://api.resend.com/emails", {
                method: "POST",
                headers: { "Authorization": `Bearer ${apiKey}`, "Content-Type": "application/json" },
                body: JSON.stringify({
                    from:     fromEmail,
                    to:       [String(fam.parent_email).trim()],
                    reply_to: replyTo,
                    subject:  `Your ${monthLabel(month)} invoice — Timothy Lutheran MDO`,
                    html,
                }),
            });

            if (!res.ok) {
                let detail = String(res.status);
                try { detail = JSON.stringify(await res.json()); } catch { /* keep the status */ }
                skipped.push({ id: inv.id, reason: `email failed: ${detail}` });
                continue;
            }

            // Stamped only after Resend accepted it, so the record cannot
            // claim a send that did not happen.
            const stampedAt = new Date().toISOString();
            const { error: upErr } = await admin
                .from("billing_invoices")
                .update({ status: "sent", sent_at: stampedAt, sent_to: fam.parent_email })
                .eq("id", inv.id);
            if (upErr) {
                // The family has the email; failing to record it is worth
                // surfacing rather than silently reporting success.
                skipped.push({ id: inv.id, reason: `sent but not recorded: ${upErr.message}` });
                continue;
            }

            sent.push({ id: inv.id, to: fam.parent_email });
        }

        // Missing ids (deleted between drafting and sending) are reported too.
        const seen = new Set((invoices || []).map(i => i.id));
        ids.filter((id: number) => !seen.has(id))
           .forEach((id: number) => skipped.push({ id, reason: "invoice not found" }));

        await admin.from("admin_audit_log").insert({
            admin_email: callerEmail,
            action:      "email",
            entity:      "billing_invoice",
            details:     { sent: sent.length, skipped: skipped.length, resend },
        }).then(
            () => {},
            // The audit table is append-only for `authenticated`; the service
            // role can write. If it ever fails, the send still happened and
            // the invoice rows carry the stamp — do not fail the request.
            (e: unknown) => console.error("send-invoice: audit write failed", e),
        );

        return json({ success: true, sent, skipped }, 200, ch);

    } catch (err) {
        return json({ error: (err as Error).message }, 500, ch);
    }
});
