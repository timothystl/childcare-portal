import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const ALLOWED_ORIGIN = 'https://mdo.timothystl.org'
const TOKEN_TTL_MS   = 60 * 60 * 1000 // 1 hour

const corsHeaders = (origin: string | null) => ({
  'Access-Control-Allow-Origin':  origin === ALLOWED_ORIGIN ? ALLOWED_ORIGIN : '',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
})

function json(body: unknown, status: number, ch: Record<string, string>) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...ch, 'Content-Type': 'application/json' },
  })
}

function generateToken(): string {
  const buf = new Uint8Array(32)
  crypto.getRandomValues(buf)
  return btoa(String.fromCharCode(...buf))
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

function emailHtml(parentName: string, link: string): string {
  const safeName = parentName
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  return `<!DOCTYPE html>
<html><body style="margin:0;padding:0;font-family:Georgia,serif;background:#f4f4f4;color:#333">
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#f4f4f4;padding:32px 16px">
    <tr><td align="center">
      <table width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;background:#fff;border-radius:12px;padding:32px;box-shadow:0 2px 12px rgba(0,0,0,.08)">
        <tr><td>
          <h1 style="margin:0 0 16px;color:#01294A;font-size:22px">Reset your PIN</h1>
          <p>Hi ${safeName || 'there'},</p>
          <p>We received a request to reset the PIN for your Timothy Lutheran MDO parent account. Click the button below to choose a new PIN. The link expires in 1&nbsp;hour and can only be used once.</p>
          <p style="margin:24px 0">
            <a href="${link}" style="display:inline-block;background:#01294A;color:#fff;padding:12px 24px;border-radius:6px;text-decoration:none;font-weight:600">Set a new PIN</a>
          </p>
          <p style="font-size:13px;color:#666">If you didn't request this, you can ignore this email — your existing PIN will keep working.</p>
          <p style="font-size:12px;color:#999;margin-top:24px">Trouble with the button? Copy and paste this link:<br><span style="word-break:break-all">${link}</span></p>
        </td></tr>
      </table>
    </td></tr>
  </table>
</body></html>`
}

Deno.serve(async (req) => {
  const ch = corsHeaders(req.headers.get('origin'))
  if (req.method === 'OPTIONS') return new Response('ok', { headers: ch })

  // Always answer 200 with { ok: true } so callers can't probe whether
  // an email is registered.
  const ok = () => json({ ok: true }, 200, ch)

  try {
    const { email } = await req.json().catch(() => ({}))
    if (!email || typeof email !== 'string') return ok()

    const supabase = createClient(
      Deno.env.get('SUPABASE_URL') ?? '',
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '',
    )

    const { data: byP1 } = await supabase
      .from('families')
      .select('id, parent_name, parent_email')
      .ilike('parent_email', email)
      .limit(1)
      .maybeSingle()

    let familyId:   string | null = null
    let parentName: string | null = null
    let isParent2 = false

    if (byP1) {
      familyId   = byP1.id
      parentName = byP1.parent_name
    } else {
      const { data: byP2 } = await supabase
        .from('families')
        .select('id, parent2_name, parent2_email')
        .ilike('parent2_email', email)
        .limit(1)
        .maybeSingle()
      if (byP2) {
        familyId   = byP2.id
        parentName = byP2.parent2_name
        isParent2  = true
      }
    }

    if (!familyId) return ok()

    const token = generateToken()
    const expires_at = new Date(Date.now() + TOKEN_TTL_MS).toISOString()

    const { error: insErr } = await supabase
      .from('pin_reset_tokens')
      .insert({ token, family_id: familyId, is_parent2: isParent2, expires_at })
    if (insErr) return ok()

    const link = `${ALLOWED_ORIGIN}/reset-pin.html?token=${encodeURIComponent(token)}`

    const apiKey    = Deno.env.get('RESEND_API_KEY')
    const fromEmail = Deno.env.get('RESEND_FROM_EMAIL') || 'onboarding@resend.dev'
    const replyTo   = Deno.env.get('RESEND_REPLY_TO')   || fromEmail

    if (apiKey) {
      await fetch('https://api.resend.com/emails', {
        method:  'POST',
        headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          from:     fromEmail,
          to:       [email],
          reply_to: replyTo,
          subject:  'Reset your Timothy Lutheran MDO PIN',
          html:     emailHtml(parentName || '', link),
        }),
      }).catch(() => { /* swallow — never reveal whether email was sent */ })
    }

    return ok()
  } catch (_err) {
    return ok()
  }
})
