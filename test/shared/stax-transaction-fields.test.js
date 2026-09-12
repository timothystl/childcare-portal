const assert = require('node:assert/strict')
const test = require('node:test')

test('extractStaxPaymentFields', async (t) => {
  const { extractStaxPaymentFields } = await import('../../supabase/functions/_shared/stax-transaction-fields.ts')

  await t.test('reads interchange_fee and a card payment_method', () => {
    const result = extractStaxPaymentFields({
      interchange_fee: 3.47,
      payment_method: { method: 'card', card_type: 'visa', card_last_four: '4242' },
    })
    assert.equal(result.processorFee, 3.47)
    assert.equal(result.paymentMethod, 'card')
  })

  await t.test('maps a bank payment_method to ach', () => {
    const result = extractStaxPaymentFields({
      interchange_fee: 0.5,
      payment_method: { method: 'bank', bank_type: 'checking' },
    })
    assert.equal(result.paymentMethod, 'ach')
  })

  await t.test('falls back to response.payment_method when top-level is absent', () => {
    const result = extractStaxPaymentFields({
      response: { payment_method: { method: 'bank' } },
    })
    assert.equal(result.paymentMethod, 'ach')
  })

  await t.test('never throws on a missing/malformed transaction, and returns nulls', () => {
    assert.deepEqual(extractStaxPaymentFields(null), { processorFee: null, paymentMethod: null })
    assert.deepEqual(extractStaxPaymentFields(undefined), { processorFee: null, paymentMethod: null })
    assert.deepEqual(extractStaxPaymentFields({}), { processorFee: null, paymentMethod: null })
    assert.deepEqual(extractStaxPaymentFields({ payment_method: 'not-an-object' }), { processorFee: null, paymentMethod: null })
  })

  await t.test('an unrecognized method value is dropped rather than guessed', () => {
    const result = extractStaxPaymentFields({ payment_method: { method: 'wallet' } })
    assert.equal(result.paymentMethod, null)
  })

  await t.test('a negative or non-numeric fee is dropped, never trusted as a real cost', () => {
    assert.equal(extractStaxPaymentFields({ interchange_fee: -1 }).processorFee, null)
    assert.equal(extractStaxPaymentFields({ interchange_fee: 'oops' }).processorFee, null)
    assert.equal(extractStaxPaymentFields({ interchange_fee: 0 }).processorFee, 0)
  })

  await t.test('rounds a fee to the nearest cent', () => {
    assert.equal(extractStaxPaymentFields({ interchange_fee: 1.005 }).processorFee, 1)
    assert.equal(extractStaxPaymentFields({ interchange_fee: 2.987 }).processorFee, 2.99)
  })
})
