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

    const supabase = createClient(
      Deno.env.get('SUPABASE_URL') ?? '',
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '',
    )

    const pinStr = String(pin).trim()
    if (!/^\d{4,8}$/.test(pinStr)) return json({ error: 'invalid_credentials' })

    // Delegate to the Postgres RPC which uses bcrypt (pgcrypto) and handles
    // attempt tracking + lockout atomically in a single DB transaction.
    // PIN passed as TEXT so leading zeros (e.g. "0123") are preserved.
    const { data, error } = await supabase.rpc('family_login', {
      p_email: email,
      p_pin:   pinStr,
    })

    if (error) return json({ error: 'server_error', message: error.message }, 500)

    // Normalize: never distinguish "not found" from "wrong PIN" — prevents
    // attackers from using the API to enumerate which emails are registered.
    if (!data || data.error === 'not_found' || data.error === 'invalid_pin') {
      return json({ error: 'invalid_credentials', attempts_left: data?.attempts_left ?? null })
    }

    if (data.error === 'login_locked') return json({ error: 'login_locked' })
    if (data.error) return json({ error: 'server_error' }, 500)

    // Success — issue a short-lived HMAC token so the Cloudflare Worker can
    // verify that push subscription calls come from an authenticated family.
    const sessionToken = await buildFamilyToken(data.family.id)

    return json({ family: data.family, isParent2: data.isParent2, sessionToken })

  } catch (err) {
    return json({ error: 'server_error', message: (err as Error).message }, 500)
  }
})
