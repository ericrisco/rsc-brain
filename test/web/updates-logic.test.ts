// The logic of the version part of Admin › Backups & system (rsc-updates B3: CA27, CA28), out of the screen so it is
// tested on its own: one row of the table per case. What it decides: whether to offer the button, say that an update is
// waiting or running, say that one failed and when it may be tried again (or that only the server can), or send the
// administration to rsc-factory.
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { lastUpdateFor, type UpdateInfo, updateView } from '../../web/src/lib/updates.ts'

const NOW = new Date('2026-11-05T10:00:00.000Z')
const newer = { installed: 'v0.2.0', latest: 'v0.3.0', newer: true }
const newest = { installed: 'v0.2.0', latest: 'v0.2.0', newer: false }
const on = (o: Partial<UpdateInfo> = {}): UpdateInfo => ({
  mode: 'on',
  factoryUrl: null,
  requested: false,
  running: null,
  attempts: [],
  last: null,
  ...o,
})
const failed = (retries: number, retryFrom: string | null, version = 'v0.3.0') => ({
  version,
  failedAt: '2026-11-05T09:30:00.000Z',
  reason: 'the image did not build',
  retries,
  retryFrom,
})

describe('the update part of the version (what the screen offers)', () => {
  it('an older server that says nothing about updating: only the command', () => {
    assert.deepEqual(updateView(newer, undefined, NOW), { kind: 'terminal' })
  })
  it('off: only the command, newer or not', () => {
    assert.deepEqual(updateView(newer, on({ mode: 'off' }), NOW), { kind: 'terminal' })
    assert.deepEqual(updateView(newest, on({ mode: 'off' }), NOW), { kind: 'terminal' })
  })
  it('installed by rsc-factory: no button, and where to go', () => {
    const u = on({ mode: 'companion', factoryUrl: 'https://factory.example.test' })
    assert.deepEqual(updateView(newer, u, NOW), {
      kind: 'companion',
      factoryUrl: 'https://factory.example.test',
    })
    assert.deepEqual(updateView(newest, u, NOW), {
      kind: 'companion',
      factoryUrl: 'https://factory.example.test',
    })
  })
  it('on and a newer version: the button, for that version', () => {
    assert.deepEqual(updateView(newer, on(), NOW), { kind: 'available', to: 'v0.3.0' })
  })
  it('on and nothing newer: nothing to offer', () => {
    assert.deepEqual(updateView(newest, on(), NOW), { kind: 'terminal' })
  })
  it('a request waiting for the updater, and an update running: no button', () => {
    assert.deepEqual(updateView(newer, on({ requested: true }), NOW), { kind: 'waiting' })
    assert.deepEqual(
      updateView(newer, on({ running: { to: 'v0.3.0', startedAt: '2026-11-05T09:59:00.000Z' } }), NOW),
      { kind: 'running', to: 'v0.3.0' },
    )
    // Running wins over a stale failure.
    assert.deepEqual(
      updateView(
        newer,
        on({ running: { to: 'v0.3.0', startedAt: null }, attempts: [failed(0, '2026-11-05T10:15:00.000Z')] }),
        NOW,
      ),
      { kind: 'running', to: 'v0.3.0' },
    )
  })
  it('the newest failed: when it may be tried again, now, later, or only on the server', () => {
    const base = {
      kind: 'failed',
      to: 'v0.3.0',
      failedAt: '2026-11-05T09:30:00.000Z',
      reason: 'the image did not build',
    }
    assert.deepEqual(updateView(newer, on({ attempts: [failed(0, '2026-11-05T09:45:00.000Z')] }), NOW), {
      ...base,
      retry: 'now',
    })
    assert.deepEqual(updateView(newer, on({ attempts: [failed(1, '2026-11-05T10:15:00.000Z')] }), NOW), {
      ...base,
      retry: { from: '2026-11-05T10:15:00.000Z' },
    })
    assert.deepEqual(updateView(newer, on({ attempts: [failed(3, null)] }), NOW), {
      ...base,
      retry: 'server',
    })
  })
  it('the failure of another version is not this one: the button is offered', () => {
    assert.deepEqual(updateView(newer, on({ attempts: [failed(0, null, 'v0.2.9')] }), NOW), {
      kind: 'available',
      to: 'v0.3.0',
    })
  })
})

describe('the last update, when it is about the version running', () => {
  const ok = { ok: true, from: 'v0.1.0', to: 'v0.2.0', at: '2026-11-05T09:00:00.000Z' }
  const back = { ok: false, from: 'v0.2.0', to: 'v0.3.0', at: '2026-11-05T09:00:00.000Z' }
  it('went well and this is where it went: said, whether or not either side has the v', () => {
    assert.deepEqual(lastUpdateFor('v0.2.0', ok), ok)
    assert.deepEqual(lastUpdateFor('v0.2.0', { ...ok, to: '0.2.0' }), { ...ok, to: '0.2.0' })
    assert.deepEqual(lastUpdateFor('0.2.0', ok), ok)
  })
  it('failed and it came back to this one: said; failed from another one, or went to another: nothing', () => {
    assert.deepEqual(lastUpdateFor('v0.2.0', back), back)
    assert.equal(lastUpdateFor('v0.2.0', { ...back, from: 'v0.1.0' }), null)
    assert.equal(lastUpdateFor('v0.2.0', { ...ok, to: 'v0.3.0' }), null)
    assert.equal(lastUpdateFor('v0.2.0', null), null)
    assert.equal(lastUpdateFor('v0.2.0', undefined), null)
  })
})

describe('the edges', () => {
  it('running and a waiting request together: running', () => {
    assert.deepEqual(
      updateView(newer, on({ requested: true, running: { to: 'v0.3.0', startedAt: null } }), NOW),
      {
        kind: 'running',
        to: 'v0.3.0',
      },
    )
  })
  it('the moment it may be tried again is already now; a millisecond before is still later', () => {
    const at = (ms: number) => new Date(NOW.getTime() + ms).toISOString()
    const retryOf = (ms: number) =>
      (updateView(newer, on({ attempts: [failed(1, at(ms))] }), NOW) as { retry: unknown }).retry
    assert.equal(retryOf(0), 'now')
    assert.deepEqual(retryOf(1), { from: at(1) })
  })
  it('an update running for an hour is still running, whatever the time it started', () => {
    assert.deepEqual(
      updateView(newer, on({ running: { to: 'v0.3.0', startedAt: '2026-11-05T08:00:00.000Z' } }), NOW),
      { kind: 'running', to: 'v0.3.0' },
    )
  })
})
