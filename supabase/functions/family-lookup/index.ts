import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const CORS_ORIGIN = 'https://mdo.timothystl.org'
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
    return json({ family: safeFamily, isParent2 })

  } catch (err) {
    return json({ error: 'server_error', message: (err as Error).message }, 500)
  }
})
