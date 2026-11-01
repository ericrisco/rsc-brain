// Plan §3.3 (T036, PR23): the live module of the web. One stream per screen that follows a brain; when the
// connection drops it says «reconnecting» and comes back on its own, from the last event it got, so the
// server replays what was missed (B5); a gap the server cannot replay is said; «closed» (a role changed, a
// key revoked) stops it and says why; pausing keeps the list still and counts what arrives; a hidden tab
// lets the stream go and catches up when shown again.
import assert from 'node:assert/strict'
import { afterEach, beforeEach, describe, it, mock } from 'node:test'
import { follow, type LiveDeps, RECONNECT_MS, type SourceLike } from '../../web/src/live/stream.ts'

type Fake = SourceLike & {
  url: string
  closed: boolean
  listeners: Map<string, (m: { data: string }) => void>
}

function world(hidden = false) {
  const sources: Fake[] = []
  let visibility: (() => void) | null = null
  const doc = {
    hidden,
    addEventListener: (_t: 'visibilitychange', f: () => void) => {
      visibility = f
    },
    removeEventListener: () => {
      visibility = null
    },
  }
  const deps: LiveDeps = {
    open: (url) => {
      const s: Fake = {
        url,
        closed: false,
        listeners: new Map(),
        onopen: null,
        onmessage: null,
        onerror: null,
        addEventListener(type, f) {
          this.listeners.set(type, f)
        },
        close() {
          this.closed = true
        },
      }
      sources.push(s)
      return s
    },
    doc,
  }
  const last = () => sources.at(-1) as Fake
  let seq = 0
  const event = (kind = 'entry.saved', o: Record<string, unknown> = {}) => {
    seq += 1
    const e = {
      id: String(seq),
      at: '2026-11-01T10:00:00.000Z',
      brain: 'growth',
      kind,
      who: { id: 'acc_ana', name: 'Ana' },
      key: { id: 'crd_1', ref: null },
      target: { id: 'ent_1', label: `Entry ${seq}` },
      query: null,
      client: 'claude-code',
      ...o,
    }
    last().onmessage?.({ data: JSON.stringify(e), lastEventId: e.id })
    return e
  }
  return {
    deps,
    sources,
    last,
    event,
    setHidden(h: boolean) {
      doc.hidden = h
      visibility?.()
    },
  }
}

describe('the live module', () => {
  beforeEach(() => mock.timers.enable({ apis: ['setTimeout'] }))
  afterEach(() => mock.timers.reset())

  it('opens one stream from the last 24 hours, and is live once it opens', () => {
    const w = world()
    const s = follow('growth', w.deps, { history: true })
    assert.equal(w.sources.length, 1)
    assert.equal(w.last().url, '/v1/brains/growth/events?lastEventId=0')
    assert.equal(s.state.value, 'connecting')
    w.last().onopen?.()
    assert.equal(s.state.value, 'live')
    s.stop()
    assert.ok(w.last().closed)
  })

  it('puts the newest event first, once, and keeps at most the cap', () => {
    const w = world()
    const s = follow('growth', w.deps, { keep: 3 })
    w.last().onopen?.()
    for (let i = 0; i < 5; i++) w.event()
    assert.deepEqual(
      s.events.value.map((e) => e.id),
      ['5', '4', '3'],
    )
    // A replayed event already shown is not shown twice.
    w.last().onmessage?.({ data: JSON.stringify({ id: '4', kind: 'entry.saved' }), lastEventId: '4' })
    assert.equal(s.events.value.length, 3)
    // Not an event of rsc-brain: nothing.
    w.last().onmessage?.({ data: 'not json', lastEventId: '' })
    assert.equal(s.events.value[0]?.id, '5')
    s.stop()
  })

  it('says «reconnecting» when the connection drops, and comes back from the last event with backing off', () => {
    const w = world()
    const s = follow('growth', w.deps, { history: true })
    w.last().onopen?.()
    w.event()
    w.event()
    w.last().onerror?.()
    assert.equal(s.state.value, 'reconnecting')
    assert.ok(w.sources[0]?.closed, 'the dropped stream is let go')
    assert.equal(w.sources.length, 1)
    mock.timers.tick(RECONNECT_MS[0] as number)
    assert.equal(w.sources.length, 2)
    // From the last event it got: the server replays what came after (B5).
    assert.equal(w.last().url, '/v1/brains/growth/events?lastEventId=2')
    // It fails again: it waits longer.
    w.last().onerror?.()
    mock.timers.tick(RECONNECT_MS[0] as number)
    assert.equal(w.sources.length, 2)
    mock.timers.tick((RECONNECT_MS[1] as number) - (RECONNECT_MS[0] as number))
    assert.equal(w.sources.length, 3)
    w.last().onopen?.()
    assert.equal(s.state.value, 'live')
    // What was missed arrives, after what was there.
    w.event()
    assert.deepEqual(
      s.events.value.map((e) => e.id),
      ['3', '2', '1'],
    )
    // Live again: the next drop waits the shortest time again.
    w.last().onerror?.()
    mock.timers.tick(RECONNECT_MS[0] as number)
    assert.equal(w.sources.length, 4)
    s.stop()
  })

  it('a gap is said, except the one of the history it asked for', () => {
    const w = world()
    const heard: string[] = []
    const s = follow('growth', w.deps, { history: true, onGap: () => heard.push('gap') })
    // Asking for the last 24 hours: older events exist, which is not something missed.
    w.last().listeners.get('gap')?.({ data: JSON.stringify({ message: 'You missed events…' }) })
    assert.equal(s.gap.value, null)
    w.last().onopen?.()
    w.event()
    w.last().onerror?.()
    mock.timers.tick(RECONNECT_MS[0] as number)
    w.last().listeners.get('gap')?.({ data: JSON.stringify({ message: 'You missed events from long ago.' }) })
    assert.equal(s.gap.value, 'You missed events from long ago.')
    assert.deepEqual(heard, ['gap'])
    s.stop()
  })

  it('«closed» stops it, says why, and does not come back by itself; «reconnect» does', () => {
    const w = world()
    let told = 0
    const s = follow('growth', w.deps, { onClosed: () => told++ })
    w.last().onopen?.()
    w.last().listeners.get('closed')?.({
      data: JSON.stringify({ reason: 'role_changed', message: 'Your role in this brain changed.' }),
    })
    assert.equal(s.state.value, 'closed')
    assert.equal(s.closed.value, 'Your role in this brain changed.')
    assert.ok(w.last().closed)
    assert.equal(told, 1)
    mock.timers.tick(60_000)
    assert.equal(w.sources.length, 1)
    s.retry()
    assert.equal(w.sources.length, 2)
    assert.equal(s.closed.value, null)
    s.stop()
  })

  it('CA8: paused, the list does not move; what arrives is counted, and resume puts it on top', () => {
    const w = world()
    const s = follow('growth', w.deps)
    w.last().onopen?.()
    w.event()
    s.pause()
    assert.equal(s.paused.value, true)
    w.event()
    w.event()
    assert.deepEqual(
      s.events.value.map((e) => e.id),
      ['1'],
    )
    assert.equal(s.waiting.value.length, 2)
    s.resume()
    assert.equal(s.paused.value, false)
    assert.deepEqual(
      s.events.value.map((e) => e.id),
      ['3', '2', '1'],
    )
    assert.equal(s.waiting.value.length, 0)
    s.stop()
  })

  it('a hidden tab lets the stream go and catches up from the last event when shown', () => {
    const w = world()
    const s = follow('growth', w.deps)
    w.last().onopen?.()
    w.event()
    w.setHidden(true)
    assert.equal(s.state.value, 'idle')
    assert.ok(w.last().closed)
    w.setHidden(false)
    assert.equal(w.sources.length, 2)
    assert.equal(w.last().url, '/v1/brains/growth/events?lastEventId=1')
    // A drop while hidden does not wake it: it waits until shown.
    w.last().onopen?.()
    w.setHidden(true)
    w.sources[1]?.onerror?.()
    mock.timers.tick(30_000)
    assert.equal(w.sources.length, 2)
    s.stop()
  })

  it('a tab hidden from the start opens nothing until shown', () => {
    const w = world(true)
    const s = follow('growth', w.deps, { history: true })
    assert.equal(w.sources.length, 0)
    assert.equal(s.state.value, 'idle')
    w.setHidden(false)
    assert.equal(w.sources.length, 1)
    s.stop()
  })

  it('names the brain in the address safely', () => {
    const w = world()
    const s = follow('a b/c', w.deps)
    assert.equal(w.last().url, '/v1/brains/a%20b%2Fc/events')
    s.stop()
  })
})
