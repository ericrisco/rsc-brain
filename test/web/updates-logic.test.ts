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
  refused: null,
  rollbackFailed: null,
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

describe('a refusal and a way back that failed (closing review, findings 2 and 3)', () => {
  const refused = {
    version: 'v0.3.0',
    at: '2026-11-05T09:58:00.000Z',
    reason: 'Cannot update: not enough disk.',
  }
  const wrecked = {
    from: '0.2.0',
    to: '0.3.0',
    copy: 'rsc-brain-1-pre-update.rscb',
    restore: 'sh rsc-brain.sh restore --file x.rscb --confirm <name> --dir "/srv/b"',
  }
  it('a refusal of the newest version: the button stays, and the reason is shown with it', () => {
    assert.deepEqual(updateView(newer, on({ refused }), NOW), {
      kind: 'available',
      to: 'v0.3.0',
      refused: { at: refused.at, reason: refused.reason },
    })
  })
  it('the refusal of another version is not shown', () => {
    assert.deepEqual(updateView(newer, on({ refused: { ...refused, version: 'v0.2.9' } }), NOW), {
      kind: 'available',
      to: 'v0.3.0',
    })
  })
  it('a request waiting or an update running hides an old refusal', () => {
    assert.deepEqual(updateView(newer, on({ refused, requested: true }), NOW), { kind: 'waiting' })
  })
  it('a way back that failed: no button and no Try again, only what happened and the terminal steps', () => {
    for (const u of [
      on({ rollbackFailed: wrecked }),
      on({ rollbackFailed: wrecked, attempts: [failed(0, '2026-11-05T09:45:00.000Z')] }),
    ])
      assert.deepEqual(updateView(newer, u, NOW), {
        kind: 'unsafe',
        from: '0.2.0',
        to: '0.3.0',
        restore: wrecked.restore,
      })
    // Also when nothing newer is out: the damage is still there.
    assert.equal(updateView(newest, on({ rollbackFailed: wrecked }), NOW).kind, 'unsafe')
  })
  it('off and companion do not show it', () => {
    assert.equal(updateView(newer, on({ mode: 'off', rollbackFailed: wrecked }), NOW).kind, 'terminal')
  })
  it('a refusal reaches the page in every view that has a button: after a failure too (review round 1)', () => {
    const r = { reason: refused.reason, at: refused.at }
    const base = {
      kind: 'failed',
      to: 'v0.3.0',
      failedAt: '2026-11-05T09:30:00.000Z',
      reason: 'the image did not build',
      refused: r,
    }
    assert.deepEqual(
      updateView(newer, on({ refused, attempts: [failed(0, '2026-11-05T09:45:00.000Z')] }), NOW),
      {
        ...base,
        retry: 'now',
      },
    )
    assert.deepEqual(
      updateView(newer, on({ refused, attempts: [failed(1, '2026-11-05T10:15:00.000Z')] }), NOW),
      {
        ...base,
        retry: { from: '2026-11-05T10:15:00.000Z' },
      },
    )
    assert.deepEqual(updateView(newer, on({ refused, attempts: [failed(3, null)] }), NOW), {
      ...base,
      retry: 'server',
    })
    // The refusal of another version is not shown with this failure.
    const other = updateView(
      newer,
      on({ refused: { ...refused, version: 'v0.2.9' }, attempts: [failed(0, null)] }),
      NOW,
    )
    assert.equal('refused' in other, false)
  })
  it('a way back that failed with no details: still unsafe, with an empty command', () => {
    assert.deepEqual(
      updateView(newer, on({ rollbackFailed: { from: '', to: '', copy: '', restore: '' } }), NOW),
      { kind: 'unsafe', from: '', to: '', restore: '' },
    )
  })
})
