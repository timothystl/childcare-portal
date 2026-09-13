const assert = require('node:assert/strict')
const test = require('node:test')

test('http', async (t) => {
  const { corsHeaders, json, MDO_ORIGIN } = await import('../../supabase/functions/_shared/http.ts')

  await t.test('corsHeaders echoes back the caller Origin when it matches the default single-origin allowlist', () => {
    const req = new Request('https://x.test', { headers: { origin: MDO_ORIGIN } })
    const headers = corsHeaders(req)
    assert.equal(headers['Access-Control-Allow-Origin'], MDO_ORIGIN)
    assert.equal(headers['Access-Control-Allow-Headers'], 'authorization, x-client-info, apikey, content-type')
  })

  await t.test('corsHeaders returns an empty allow-origin for an unrecognized Origin, never a wildcard', () => {
    const req = new Request('https://x.test', { headers: { origin: 'https://evil.example' } })
    const headers = corsHeaders(req)
    assert.equal(headers['Access-Control-Allow-Origin'], '')
  })

  await t.test('corsHeaders returns an empty allow-origin when no Origin header is present', () => {
    const req = new Request('https://x.test')
    assert.equal(corsHeaders(req)['Access-Control-Allow-Origin'], '')
  })

  await t.test('corsHeaders accepts a Set of allowed origins', () => {
    const allowed = new Set(['https://a.example', 'https://b.example'])
    const reqA = new Request('https://x.test', { headers: { origin: 'https://a.example' } })
    const reqC = new Request('https://x.test', { headers: { origin: 'https://c.example' } })
    assert.equal(corsHeaders(reqA, allowed)['Access-Control-Allow-Origin'], 'https://a.example')
    assert.equal(corsHeaders(reqC, allowed)['Access-Control-Allow-Origin'], '')
  })

  await t.test('corsHeaders accepts a custom single-origin string', () => {
    const req = new Request('https://x.test', { headers: { origin: 'https://custom.example' } })
    assert.equal(corsHeaders(req, 'https://custom.example')['Access-Control-Allow-Origin'], 'https://custom.example')
  })

  await t.test('json defaults to status 200 and sets Content-Type', async () => {
    const res = json({ ok: true })
    assert.equal(res.status, 200)
    assert.equal(res.headers.get('Content-Type'), 'application/json')
    assert.deepEqual(await res.json(), { ok: true })
  })

  await t.test('json applies the given status and merges in extra headers', () => {
    const res = json({ error: 'nope' }, 403, { 'Access-Control-Allow-Origin': MDO_ORIGIN, 'Cache-Control': 'no-store' })
    assert.equal(res.status, 403)
    assert.equal(res.headers.get('Access-Control-Allow-Origin'), MDO_ORIGIN)
    assert.equal(res.headers.get('Cache-Control'), 'no-store')
    assert.equal(res.headers.get('Content-Type'), 'application/json')
  })

  await t.test('json with no headers argument carries no CORS headers, for server-to-server callers', () => {
    const res = json({ received: true }, 200)
    assert.equal(res.headers.get('Access-Control-Allow-Origin'), null)
  })
})
