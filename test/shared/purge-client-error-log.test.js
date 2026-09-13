const assert = require('node:assert/strict')
const test = require('node:test')

test('purge-client-error-log logic', async (t) => {
  const { purgeClientErrorLog } = await import('../../supabase/functions/purge-client-error-log/logic.ts')

  await t.test('returns the deleted count on a successful purge', async () => {
    const admin = { rpc: async (fn) => {
      assert.equal(fn, 'purge_client_error_log')
      return { data: 42, error: null }
    } }
    const res = await purgeClientErrorLog(admin)
    assert.equal(res.status, 200)
    assert.deepEqual(await res.json(), { deleted: 42 })
  })

  await t.test('treats a zero-row purge as a clean 200, not an error', async () => {
    const admin = { rpc: async () => ({ data: 0, error: null }) }
    const res = await purgeClientErrorLog(admin)
    assert.equal(res.status, 200)
    assert.deepEqual(await res.json(), { deleted: 0 })
  })

  await t.test('coerces a stringified bigint count (as some drivers return) into a number', async () => {
    const admin = { rpc: async () => ({ data: '7', error: null }) }
    const res = await purgeClientErrorLog(admin)
    assert.equal(res.status, 200)
    assert.deepEqual(await res.json(), { deleted: 7 })
  })

  await t.test('returns 500 and never throws when the RPC reports an error', async () => {
    const admin = { rpc: async () => ({ data: null, error: { message: 'boom' } }) }
    const res = await purgeClientErrorLog(admin)
    assert.equal(res.status, 500)
    assert.deepEqual(await res.json(), { error: 'purge_failed' })
  })

  await t.test('returns 500 and never throws when the RPC call itself rejects', async () => {
    const admin = { rpc: async () => { throw new Error('network down') } }
    const res = await purgeClientErrorLog(admin)
    assert.equal(res.status, 500)
    assert.deepEqual(await res.json(), { error: 'server_error' })
  })

  await t.test('response carries no CORS headers, matching every other server-to-server cron function', async () => {
    const admin = { rpc: async () => ({ data: 1, error: null }) }
    const res = await purgeClientErrorLog(admin)
    assert.equal(res.headers.get('Access-Control-Allow-Origin'), null)
    assert.equal(res.headers.get('Content-Type'), 'application/json')
  })
})
