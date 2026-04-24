import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const CORS_ORIGIN = 'https://mdo.timothystl.org'

// Produces a 1-hour HMAC-SHA256 token: "{familyId}:{expiry}:{b64url(sig)}"
// The Cloudflare Worker validates this before saving a push subscription.
async function buildFamilyToken(familyId: string): Promise<string> {
  const secret = Deno.env.get('FAMILY_SESSION_SECRET') ?? ''
  const exp = Date.now() + 3_600_000
  const keyBytes = new TextEncoder().encode(secret)
  const key = await crypto.subtle.importKey(
    'raw', keyBytes, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'],
  )
  const msg = new TextEncoder().encode(`${familyId}:${exp}`)
  const sigBytes = new Uint8Array(await crypto.subtle.sign('HMAC', key, msg))
  const sig = btoa(String.fromCharCode(...sigBytes))
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
  return `${familyId}:${exp}:${sig}`
}
const MAX_ATTEMPTS = 5

const corsHeaders = {
  'Access-Control-Allow-Origin': CORS_ORIGIN,
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  })
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders })
  }

  try {
    const { email, pin } = await req.json()

    if (!email || !pin) return json({ error: 'missing_params' }, 400)

    // Service-role client — bypasses RLS so we can update attempt counters
    const supabase = createClient(
      Deno.env.get('SUPABASE_URL') ?? '',
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '',
    )

    const parsedPin = parseInt(pin, 10)
    if (isNaN(parsedPin)) return json({ error: 'invalid_pin', attempts_left: MAX_ATTEMPTS })

    const fields = [
      'id', 'parent_name', 'parent_email', 'parent_phone',
      'pin', 'parent2_name', 'parent2_email', 'parent2_phone', 'parent2_pin',
      'registration_locked', 'login_locked', 'login_attempts',
      'students(id, child_name, child_dob, room_override, discount_type, discount_value, discount_note, recurring_days)',
    ].join(', ')
    // NOTE: pin/parent2_pin are fetched only for server-side verification — they are stripped before returning to client

    // Try parent 1 first, then parent 2
    const { data: byP1 } = await supabase
      .from('families')
      .select(fields)
      .ilike('parent_email', email)
      .maybeSingle()

    const { data: byP2 } = !byP1
      ? await supabase
          .from('families')
          .select(fields)
          .ilike('parent2_email', email)
          .maybeSingle()
      : { data: null }

    const family = byP1 ?? byP2
    const isParent2 = !byP1 && !!byP2

    if (!family) return json({ error: 'not_found' })

    // If login is already locked, reject immediately
    if (family.login_locked) return json({ error: 'login_locked' })

    // Verify PIN
    const expectedPin = isParent2 ? family.parent2_pin : family.pin
    if (parsedPin !== expectedPin) {
      const newAttempts = (family.login_attempts ?? 0) + 1
      const shouldLock = newAttempts >= MAX_ATTEMPTS

      await supabase
        .from('families')
        .update({ login_attempts: newAttempts, ...(shouldLock ? { login_locked: true } : {}) })
        .eq('id', family.id)

      if (shouldLock) return json({ error: 'login_locked' })

      return json({ error: 'invalid_pin', attempts_left: MAX_ATTEMPTS - newAttempts })
    }

    // Success — reset attempt counter
    await supabase
      .from('families')
      .update({ login_attempts: 0 })
      .eq('id', family.id)

    // Strip server-only fields — client must never receive PINs or attempt counters
    const { pin: _p, parent2_pin: _p2, login_attempts: _a, ...safeFamily } = family

    // Issue a short-lived HMAC-signed token so the Cloudflare Worker can verify
    // that the push-subscribe caller is actually this authenticated family.
    const sessionToken = await buildFamilyToken(safeFamily.id)

    return json({ family: safeFamily, isParent2, sessionToken })

  } catch (err) {
    return json({ error: 'server_error', message: (err as Error).message }, 500)
  }
})
