// The maintenance band across the web (B7 PR35; spec «Actualizar»: writes wait during an update, reads keep
// working): the web learns it from GET /v1/health (when it starts, then now and then) and from any write refused with
// 503 under_maintenance, shows one band on every page while it lasts, and looks again more often until it ends. And
// «Last update» on Admin › Backups & system: what the launcher recorded, in words (CA7: the failure is seen).
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { ApiError, createClient, type Transport } from '../../web/src/api/client.ts'
import { lastUpdateOf, lastUpdateText } from '../../web/src/lib/backups.ts'
import { isMaintenance, nextLook, POLL_OFF_MS } from '../../web/src/lib/maintenance.ts'

const refused = {
  error: {
    code: 'under_maintenance',
    message: 'rsc-brain is under maintenance, retry after 40 seconds',
    howToProceed: 'Send it again after that time; reading keeps working meanwhile.',
    retryAfter: 40,
  },
  retryAfter: 40,
}

describe('maintenance, as the web learns it', () => {
  it('a write refused with 503 under_maintenance tells the web, with how long to wait; other refusals do not', async () => {
    const heard: number[] = []
    let answer = { status: 503, body: refused as unknown }
    const transport: Transport = async () => ({
      status: answer.status,
      text: async () => JSON.stringify(answer.body),
    })
    const api = createClient({
      transport,
      onSignedOut: () => {},
      here: () => '/',
      onMaintenance: (s) => heard.push(s ?? -1),
    })
    await assert.rejects(api.call('createBrain', { body: { slug: 'x' } }), (e: ApiError) => {
      assert.equal(e.code, 'under_maintenance')
      assert.equal(isMaintenance(e), true)
      return true
    })
    assert.deepEqual(heard, [40])
    answer = { status: 503, body: { error: { code: 'busy', message: 'Busy.', howToProceed: 'Wait.' } } }
    await assert.rejects(api.call('createBrain', { body: { slug: 'x' } }))
    assert.deepEqual(heard, [40])
    assert.equal(isMaintenance(new ApiError(409, 'conflict', 'x', 'y')), false)
    assert.equal(isMaintenance(new Error('x')), false)
  })

  it('looks again soon while it lasts (what the server said, 5 to 30 s), and once a minute otherwise', () => {
    assert.equal(nextLook(true, 40), 30_000)
    assert.equal(nextLook(true, 2), 5_000)
    assert.equal(nextLook(true, 12), 12_000)
    assert.equal(nextLook(true), 10_000)
    assert.equal(nextLook(false, 12), POLL_OFF_MS)
    assert.equal(POLL_OFF_MS, 60_000)
  })
})

describe('the last update, in words', () => {
  it('reads only what the launcher records; anything else is no update', () => {
    for (const x of [
      null,
      undefined,
      'x',
      1,
      {},
      { ok: 'yes', from: '0.1.0', to: '0.2.0', at: 'x' },
      { ok: true, from: '0.1.0' },
    ])
      assert.equal(lastUpdateOf(x), null, JSON.stringify(x))
    assert.deepEqual(lastUpdateOf({ ok: true, from: '0.1.0', to: '0.2.0', at: '2026-11-03T12:00:00.000Z' }), {
      ok: true,
      from: '0.1.0',
      to: '0.2.0',
      at: '2026-11-03T12:00:00.000Z',
      log: null,
    })
    assert.equal(
      lastUpdateOf({ ok: false, from: '0.2.0', to: '0.3.0', at: '2026-11-03T12:00:00.000Z', log: 'boom' })
        ?.log,
      'boom',
    )
  })

  it('a good update says from and to; a failed one says it went back and that nothing was lost', () => {
    const at = '2026-11-03T12:00:00.000Z'
    assert.equal(
      lastUpdateText({ ok: true, from: '0.1.0', to: '0.2.0', at, log: null }),
      'Updated from 0.1.0 to 0.2.0.',
    )
    const failed = lastUpdateText({ ok: false, from: '0.2.0', to: '0.3.0', at, log: 'x' })
    assert.match(failed, /^The update from 0\.2\.0 to 0\.3\.0 failed\./)
    assert.match(failed, /went back to 0\.2\.0/)
    assert.match(failed, /sessions and keys still work/)
  })
})
