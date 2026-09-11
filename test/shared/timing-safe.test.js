const assert = require('node:assert/strict')
const test = require('node:test')

test('safeEqual', async (t) => {
  const { safeEqual } = await import('../../supabase/functions/_shared/timing-safe.ts')

  await t.test('true for identical strings', async () => {
    assert.equal(await safeEqual('same-secret', 'same-secret'), true)
  })

  await t.test('false for different strings of the same length', async () => {
    assert.equal(await safeEqual('secret-aaaa', 'secret-bbbb'), false)
  })

  await t.test('false for different-length strings, without a length-based short-circuit', async () => {
    assert.equal(await safeEqual('short', 'a-much-longer-secret-value'), false)
  })

  await t.test('false against an empty string', async () => {
    assert.equal(await safeEqual('', 'not-empty'), false)
  })

  await t.test('true for two empty strings', async () => {
    assert.equal(await safeEqual('', ''), true)
  })
})
