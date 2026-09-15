const assert = require('node:assert/strict')
const test = require('node:test')

test('extractStaxPaymentFields', async (t) => {
  const { extractStaxPaymentFields } = await import('../../supabase/functions/_shared/stax-transaction-fields.ts')

  await t.test('reads interchange_fee, a card payment_method, and its bin_type', () => {
    const result = extractStaxPaymentFields({
      interchange_fee: 3.47,
      payment_method: { method: 'card', card_type: 'visa', card_last_four: '4242', bin_type: 'DEBIT' },
    })
    assert.equal(result.processorFee, 3.47)
    assert.equal(result.paymentMethod, 'card')
    assert.equal(result.cardFundingType, 'debit')
  })

  await t.test('reads a credit bin_type too', () => {
    const result = extractStaxPaymentFields({
      payment_method: { method: 'card', bin_type: 'CREDIT' },
    })
    assert.equal(result.cardFundingType, 'credit')
  })

  await t.test('maps a bank payment_method to ach, with no funding type', () => {
    const result = extractStaxPaymentFields({
      interchange_fee: 0.5,
      payment_method: { method: 'bank', bank_type: 'checking' },
    })
    assert.equal(result.paymentMethod, 'ach')
    assert.equal(result.cardFundingType, null)
  })

  await t.test('falls back to response.payment_method when top-level is absent', () => {
    const result = extractStaxPaymentFields({
      response: { payment_method: { method: 'bank' } },
    })
    assert.equal(result.paymentMethod, 'ach')
  })

  await t.test('never throws on a missing/malformed transaction, and returns nulls', () => {
    const allNull = { processorFee: null, paymentMethod: null, cardFundingType: null }
    assert.deepEqual(extractStaxPaymentFields(null), allNull)
    assert.deepEqual(extractStaxPaymentFields(undefined), allNull)
    assert.deepEqual(extractStaxPaymentFields({}), allNull)
    assert.deepEqual(extractStaxPaymentFields({ payment_method: 'not-an-object' }), allNull)
  })

  await t.test('an unrecognized method or bin_type value is dropped rather than guessed', () => {
    const result = extractStaxPaymentFields({ payment_method: { method: 'wallet', bin_type: 'PREPAID' } })
    assert.equal(result.paymentMethod, null)
    assert.equal(result.cardFundingType, null)
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
