const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const test = require('node:test')
const Ajv2020 = require('ajv/dist/2020')
const addFormats = require('ajv-formats')

const root = path.resolve(__dirname, '../..')
const schema = JSON.parse(fs.readFileSync(path.join(root, 'contracts/mymdo-finance-summary-v1.schema.json')))
const example = JSON.parse(fs.readFileSync(path.join(root, 'contracts/examples/mymdo-finance-summary-v1.synthetic.json')))

function validator() {
  const ajv = new Ajv2020({ allErrors: true, strict: true })
  addFormats(ajv)
  return ajv.compile(schema)
}

test('synthetic myMDO Finance summary satisfies the closed v1 schema', () => {
  const validate = validator()
  assert.equal(validate(example), true, JSON.stringify(validate.errors))
})

test('contract excludes person, family, child, staff, wage-rate, and payment identifiers', () => {
  const serialized = JSON.stringify(example).toLowerCase()
  for (const prohibited of ['personid', 'familyid', 'childid', 'staffid', 'hourlyrate', 'salarybiweekly', 'paymentid']) {
    assert.equal(serialized.includes(prohibited), false, prohibited)
  }
})

test('schema rejects an unexpected sensitive field', () => {
  const validate = validator()
  const invalid = structuredClone(example)
  invalid.periods[0].staffId = 'synthetic-staff'
  assert.equal(validate(invalid), false)
})
