const assert = require('node:assert/strict')
const test = require('node:test')

test('html', async (t) => {
  const { escHtml } = await import('../../supabase/functions/_shared/html.ts')

  await t.test('escapes all five HTML-significant characters', () => {
    assert.equal(escHtml(`<b>Tom & "Jerry" O'Brien</b>`), '&lt;b&gt;Tom &amp; &quot;Jerry&quot; O&#39;Brien&lt;/b&gt;')
  })

  await t.test('escapes a lone apostrophe -- the exact gap check-missed-clocks had before sharing this helper', () => {
    assert.equal(escHtml(`O'Brien`), 'O&#39;Brien')
  })

  await t.test('coerces null and undefined to an empty string rather than the literal text', () => {
    assert.equal(escHtml(null), '')
    assert.equal(escHtml(undefined), '')
  })

  await t.test('passes plain text through unchanged', () => {
    assert.equal(escHtml('plain text'), 'plain text')
  })

  await t.test('coerces a non-string value via String()', () => {
    assert.equal(escHtml(42), '42')
  })
})
