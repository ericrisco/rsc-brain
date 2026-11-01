// Spec B5 «Flujo de eventos»: a program follows a brain live over Server-Sent Events (CA12); who sees
// what (CA12b); resuming after a cut from the last event received (CA13), but never past 24 hours
// without saying so (CA20); and revoking the key or changing the role closes the stream (B4 CA30).
import assert from 'node:assert/strict'
import { after, before, describe, it } from 'node:test'
import { EVENT_TIMINGS } from '../../src/http/routes/events.ts'
import { skipPg } from '../helpers/pg.ts'
import { type World, world } from '../helpers/world.ts'

type Ev = {
  id: string
  event: string
  data: {
    id: string
    at: string
    brain: string
    kind: string
    who: { id: string; name: string } | null
    key: { id: string; ref: string | null } | null
    target: { id: string; label: string | null } | null
    query: string | null
    client?: string | null
    message?: string
    reason?: string
  }
  raw: string
  receivedAt: number
}

type Stream = {
  status: number
  events: Ev[]
  comments: () => number
  ended: () => boolean
  waitFor(pred: (e: Ev) => boolean, ms?: number): Promise<Ev>
  waitEnd(ms: number): Promise<void>
  close(): void
}

const BODY = 'Viewers who reach the first minute stay to the end. SECRET-BODY-OF-THE-PAGE'
const ENTRY = 'We test thumbnails against retention. SECRET-BODY-OF-THE-ENTRY'

describe('the event stream of a brain', { skip: skipPg }, () => {
  let w: World
  let eric: { id: string; key: string }
  let ana: { id: string; key: string }
  let bob: { id: string; key: string }
  let factory: { id: string; key: string }
  let ericWeb: string
  const open: Stream[] = []

  async function subscribe(
    key: string,
    slug = 'yt',
    o: { lastEventId?: string; inQuery?: boolean } = {},
  ): Promise<Stream> {
    const ac = new AbortController()
    const q = o.lastEventId && o.inQuery ? `?lastEventId=${o.lastEventId}` : ''
    const res = await fetch(`${w.base}/v1/brains/${slug}/events${q}`, {
      headers: {
        authorization: `Bearer ${key}`,
        ...(o.lastEventId && !o.inQuery ? { 'last-event-id': o.lastEventId } : {}),
      },
      signal: ac.signal,
    })
    const events: Ev[] = []
    let comments = 0
    let ended = false
    // Not a stream: keep the refusal readable.
    const refusal = res.status === 200 ? null : await res.json().catch(() => null)
    const reading = (async () => {
      if (!res.body || refusal) return
      const decoder = new TextDecoder()
      let buf = ''
      for await (const chunk of res.body) {
        buf += decoder.decode(chunk as Uint8Array, { stream: true })
        let at = buf.indexOf('\n\n')
        while (at >= 0) {
          const block = buf.slice(0, at)
          buf = buf.slice(at + 2)
          at = buf.indexOf('\n\n')
          const lines = block.split('\n')
          if (lines.every((l) => l.startsWith(':'))) {
            comments += 1
            continue
          }
          const field = (name: string) =>
            lines
              .filter((l) => l.startsWith(`${name}:`))
              .map((l) => l.slice(name.length + 1).trimStart())
              .join('\n')
          const data = field('data')
          events.push({
            id: field('id'),
            event: field('event') || 'message',
            data: data ? JSON.parse(data) : {},
            raw: block,
            receivedAt: Date.now(),
          })
        }
      }
    })()
      .catch(() => {})
      .finally(() => {
        ended = true
      })
    const s: Stream = {
      status: res.status,
      events,
      comments: () => comments,
      ended: () => ended,
      async waitFor(pred, ms = 2000) {
        const end = Date.now() + ms
        for (;;) {
          const e = events.find(pred)
          if (e) return e
          if (Date.now() > end) {
            throw new Error(`no such event within ${ms} ms; got ${events.map((x) => x.event).join(', ')}`)
          }
          await new Promise((r) => setTimeout(r, 10))
        }
      },
      async waitEnd(ms) {
        await Promise.race([reading, new Promise((r) => setTimeout(r, ms))])
      },
      close: () => ac.abort(),
    }
    if (refusal) (s as Stream & { body?: unknown }).body = refusal
    else open.push(s)
    return s
  }

  const shortKey = async (ref: string) =>
    (await w.call(factory.key, 'POST', '/v1/keys/short', { writeBrain: 'yt', ref, ttlMinutes: 60 })).body
      .key as { id: string; secret: string }

  before(async () => {
    w = await world({ events: { pollMs: 20, heartbeatMs: 100, recheckMs: 100 } })
    eric = await w.person('Eric')
    ana = await w.person('Ana')
    bob = await w.person('Bob')
    factory = await w.service('RSC Factory')
    ericWeb = await w.web(eric.id)
    await w.call(eric.key, 'POST', '/v1/brains', { slug: 'yt', purpose: 'Videos.' })
    await w.call(eric.key, 'POST', '/v1/brains', { slug: 'other' })
    await w.member('yt', ana.id, 'contributor')
    await w.member('yt', bob.id, 'contributor')
    await w.member('yt', factory.id, 'contributor')
    const r = await w.callWeb(ericWeb, 'POST', '/v1/brains/yt/wiki/changes', {
      op: 'create',
      address: 'audience/retention',
      type: 'topic',
      title: 'Retention',
      summary: '',
      body: BODY,
    })
    assert.equal(r.status, 201, r.text)
  })
  after(async () => {
    for (const s of open) s.close()
    await w.close()
  })

  it('the default rhythm: live within 2 s, a heartbeat every 15 s, the key checked every 2 s', () => {
    assert.ok(EVENT_TIMINGS.pollMs < 2000)
    assert.equal(EVENT_TIMINGS.heartbeatMs, 15_000)
    assert.equal(EVENT_TIMINGS.recheckMs, 2_000)
  })

  it('a brain without access answers like a missing one, and is no stream', async () => {
    const stranger = await w.person('Stranger')
    const s = await subscribe(stranger.key)
    assert.equal(s.status, 404)
    assert.equal((s as Stream & { body: { error: { code: string } } }).body.error.code, 'brain_not_found')
    const bad = await subscribe(factory.key, 'yt', { lastEventId: 'yesterday' })
    assert.equal(bad.status, 400)
  })

  it('CA12: Factory sees the search, the write and the read of its agent in under 2 s, with the text, the address and the key, never a body', async () => {
    const ref = 'run r_1, step 2'
    const agent = await shortKey(ref)
    const s = await subscribe(factory.key)
    assert.equal(s.status, 200)
    const t0 = Date.now()
    assert.equal((await w.call(agent.secret, 'GET', '/v1/search?q=retention')).status, 200)
    const saved = await w.call(agent.secret, 'POST', '/v1/brains/yt/entries', {
      type: 'decision',
      title: 'Thumbnails against retention',
      content: ENTRY,
    })
    assert.equal(saved.status, 201, saved.text)
    assert.equal((await w.call(agent.secret, 'GET', '/v1/brains/yt/pages/audience/retention')).status, 200)
    const search = await s.waitFor((e) => e.data.kind === 'search' && e.data.key?.id === agent.id)
    const write = await s.waitFor((e) => e.data.kind === 'entry.saved' && e.data.key?.id === agent.id)
    const read = await s.waitFor((e) => e.data.kind === 'read' && e.data.key?.id === agent.id)
    for (const e of [search, write, read]) {
      assert.ok(e.receivedAt - t0 < 2000, `${e.data.kind} after ${e.receivedAt - t0} ms`)
      assert.equal(e.data.key?.ref, ref)
      assert.equal(e.data.brain, 'yt')
      assert.equal(e.data.who?.id, factory.id)
      assert.equal(e.id, e.data.id)
      assert.doesNotMatch(e.raw, /SECRET-BODY/)
    }
    assert.equal(search.data.query, 'retention')
    assert.equal(read.data.target?.label, 'audience/retention')
    assert.equal(write.data.target?.label, 'Thumbnails against retention')
    assert.equal(write.data.target?.id, (saved.body.receipt as { entryId: string }).entryId)
    // In the order they happened.
    assert.ok(Number(search.id) < Number(write.id) && Number(write.id) < Number(read.id))
    s.close()
  })

  it('the searched text in an event is redacted like everything stored', async () => {
    const s = await subscribe(eric.key)
    const secret = 'sk-live-0123456789abcdefghijklmnopqrstuv'
    await w.call(eric.key, 'GET', `/v1/search?q=${encodeURIComponent(`deploy ${secret}`)}`)
    const e = await s.waitFor((x) => x.data.kind === 'search' && (x.data.query ?? '').startsWith('deploy'))
    assert.doesNotMatch(e.raw, /0123456789abcdefghij/)
    s.close()
  })

  it("CA12b: Factory does not see Eric's searches and reads, but sees his writes; curators see everything", async () => {
    const ref = 'run r_2'
    const agent = await shortKey(ref)
    const f = await subscribe(factory.key)
    const curator = await subscribe(eric.key)
    await w.call(eric.key, 'GET', '/v1/search?q=retention')
    await w.call(eric.key, 'GET', '/v1/brains/yt/pages/audience/retention')
    await w.call(agent.secret, 'GET', '/v1/search?q=hooks')
    const saved = await w.call(eric.key, 'POST', '/v1/brains/yt/entries', {
      type: 'note',
      title: 'Eric writes',
      content: 'Something.',
    })
    assert.equal(saved.status, 201)
    const write = await f.waitFor((e) => e.data.kind === 'entry.saved' && e.data.who?.id === eric.id)
    assert.equal(write.data.target?.label, 'Eric writes')
    // Events arrive in order: by the time the write is here, the searches and reads before it are too.
    const ericsLooks = f.events.filter(
      (e) => (e.data.kind === 'search' || e.data.kind === 'read') && e.data.who?.id === eric.id,
    )
    assert.deepEqual(ericsLooks, [])
    // Its own agent's search it does see.
    assert.ok(f.events.some((e) => e.data.kind === 'search' && e.data.key?.id === agent.id))
    // The curator sees all of it.
    await curator.waitFor((e) => e.data.kind === 'entry.saved' && e.data.who?.id === eric.id)
    for (const [kind, who] of [
      ['search', eric.id],
      ['read', eric.id],
      ['search', factory.id],
    ] as const) {
      assert.ok(
        curator.events.some((e) => e.data.kind === kind && e.data.who?.id === who),
        `the curator misses ${kind} by ${who}`,
      )
    }
    f.close()
    curator.close()
  })

  it("CA12b: a member sees writes and their own searches, not someone else's; an agent's key sees only its own", async () => {
    const one = await shortKey('run r_3, person one')
    const two = await shortKey('run r_3, person two')
    const a = await subscribe(ana.key)
    const agentView = await subscribe(one.secret)
    await w.call(bob.key, 'GET', '/v1/search?q=bob-looks')
    await w.call(ana.key, 'GET', '/v1/search?q=ana-looks')
    await w.call(two.secret, 'GET', '/v1/search?q=two-looks')
    await w.call(one.secret, 'GET', '/v1/search?q=one-looks')
    await w.call(bob.key, 'POST', '/v1/brains/yt/entries', {
      type: 'note',
      title: 'Bob writes',
      content: 'x',
    })
    await a.waitFor((e) => e.data.kind === 'entry.saved' && e.data.who?.id === bob.id)
    await agentView.waitFor((e) => e.data.kind === 'entry.saved' && e.data.who?.id === bob.id)
    const searches = (s: Stream) => s.events.filter((e) => e.data.kind === 'search').map((e) => e.data.query)
    assert.deepEqual(searches(a), ['ana-looks'])
    assert.deepEqual(searches(agentView), ['one-looks'])
    a.close()
    agentView.close()
  })

  it('CA13: reconnecting with the last event received replays what was missed, in order, then goes on live', async () => {
    const s = await subscribe(factory.key)
    await w.call(eric.key, 'POST', '/v1/brains/yt/entries', {
      type: 'note',
      title: 'Before the cut',
      content: 'x',
    })
    const last = await s.waitFor((e) => e.data.target?.label === 'Before the cut')
    s.close()
    // Ten minutes away; the brain goes on.
    const missed = ['Missed one', 'Missed two', 'Missed three']
    for (const title of missed) {
      w.advance(200_000)
      await w.call(eric.key, 'POST', '/v1/brains/yt/entries', { type: 'note', title, content: 'x' })
    }
    for (const inQuery of [false, true]) {
      const back = await subscribe(factory.key, 'yt', { lastEventId: last.id, inQuery })
      await back.waitFor((e) => e.data.target?.label === 'Missed three')
      const titles = back.events.filter((e) => e.data.kind === 'entry.saved').map((e) => e.data.target?.label)
      assert.deepEqual(titles, missed)
      const ids = back.events.map((e) => Number(e.id))
      assert.deepEqual(
        ids,
        [...ids].sort((x, y) => x - y),
      )
      assert.ok(ids.every((id) => id > Number(last.id)))
      // And then live, without repeating what was replayed.
      await w.call(eric.key, 'POST', '/v1/brains/yt/entries', {
        type: 'note',
        title: `Live ${inQuery}`,
        content: 'x',
      })
      await back.waitFor((e) => e.data.target?.label === `Live ${inQuery}`)
      const after = back.events.filter((e) => e.data.kind === 'entry.saved').map((e) => e.data.target?.label)
      assert.deepEqual(after, [...missed, `Live ${inQuery}`])
      back.close()
      if (!inQuery) missed.push(`Live ${inQuery}`)
    }
  })

  it('CA20: after 30 hours away the stream says the gap passes 24 hours, and replays only the last 24', async () => {
    const s = await subscribe(factory.key)
    await w.call(eric.key, 'POST', '/v1/brains/yt/entries', { type: 'note', title: 'Day zero', content: 'x' })
    const last = await s.waitFor((e) => e.data.target?.label === 'Day zero')
    s.close()
    w.advance(3_600_000)
    await w.call(eric.key, 'POST', '/v1/brains/yt/entries', { type: 'note', title: 'Too old', content: 'x' })
    w.advance(29 * 3_600_000)
    await w.call(eric.key, 'POST', '/v1/brains/yt/entries', { type: 'note', title: 'Recent', content: 'x' })
    w.advance(3_600_000)
    const back = await subscribe(factory.key, 'yt', { lastEventId: last.id })
    const gap = await back.waitFor((e) => e.event === 'gap')
    assert.equal(back.events[0]?.event, 'gap')
    assert.match(gap.data.message ?? '', /more than 24 hours/)
    assert.match(gap.data.message ?? '', /lists/)
    await back.waitFor((e) => e.data.target?.label === 'Recent')
    assert.ok(!back.events.some((e) => e.data.target?.label === 'Too old'))
    back.close()
    // Coming back long after, having missed nothing too old, is no gap.
    const again = await subscribe(factory.key)
    await w.call(eric.key, 'POST', '/v1/brains/yt/entries', { type: 'note', title: 'Quiet', content: 'x' })
    const quiet = await again.waitFor((e) => e.data.target?.label === 'Quiet')
    again.close()
    w.advance(30 * 3_600_000)
    const calm = await subscribe(factory.key, 'yt', { lastEventId: quiet.id })
    await w.call(eric.key, 'POST', '/v1/brains/yt/entries', {
      type: 'note',
      title: 'After calm',
      content: 'x',
    })
    await calm.waitFor((e) => e.data.target?.label === 'After calm')
    assert.ok(!calm.events.some((e) => e.event === 'gap'))
    calm.close()
  })

  it('a heartbeat comment keeps the connection open', async () => {
    const s = await subscribe(factory.key)
    const end = Date.now() + 1000
    while (s.comments() < 2 && Date.now() < end) await new Promise((r) => setTimeout(r, 20))
    assert.ok(s.comments() >= 2, `${s.comments()} heartbeats`)
    s.close()
  })

  it('B4 CA30: revoking the key closes the stream within 5 seconds', async () => {
    const token = await w.token(eric.id)
    const keyId = ((await w.call(token, 'GET', '/v1/me')).body.key as { id: string }).id
    const s = await subscribe(token)
    assert.equal(s.status, 200)
    const t0 = Date.now()
    assert.equal((await w.callWeb(ericWeb, 'DELETE', `/v1/me/tokens/${keyId}`)).status, 200)
    await s.waitEnd(5000)
    assert.ok(s.ended(), 'the stream is still open')
    assert.ok(Date.now() - t0 < 5000)
    const closed = s.events.find((e) => e.event === 'closed')
    assert.ok(closed, 'the stream says why it closed')
    assert.equal(closed.data.reason, 'key_revoked')
  })

  it('B4 CA30: losing the role, or having it changed, closes the stream', async () => {
    const carl = await w.person('Carl')
    await w.member('yt', carl.id, 'contributor')
    const s = await subscribe(carl.key)
    assert.equal(s.status, 200)
    assert.equal(
      (await w.callWeb(ericWeb, 'PUT', `/v1/brains/yt/members/${carl.id}`, { role: 'reader' })).status,
      200,
    )
    await s.waitEnd(5000)
    assert.ok(s.ended())
    assert.equal(s.events.find((e) => e.event === 'closed')?.data.reason, 'role_changed')
    const again = await subscribe(carl.key)
    assert.equal(again.status, 200)
    assert.equal((await w.callWeb(ericWeb, 'DELETE', `/v1/brains/yt/members/${carl.id}`)).status, 200)
    await again.waitEnd(5000)
    assert.ok(again.ended())
    assert.equal(again.events.find((e) => e.event === 'closed')?.data.reason, 'role_changed')
  })

  // Spec B6 «Activity», G13: each event names the client of the key that did it, as the journal names it
  // (the web for a person's web session, the agent of a short key, else the program), so Activity filters
  // by client.
  it('G13: an event names its client: the web, the agent of a short key, or the program of a token', async () => {
    const f = await subscribe(factory.key)
    const agent = (
      await w.call(factory.key, 'POST', '/v1/keys/short', {
        writeBrain: 'yt',
        ref: 'run r_9',
        agent: 'claude-code',
        ttlMinutes: 60,
      })
    ).body.key as { id: string; secret: string }
    assert.equal(
      (
        await w.callWeb(ericWeb, 'POST', '/v1/brains/yt/entries', {
          type: 'note',
          title: 'From the web',
          content: 'x',
        })
      ).status,
      201,
    )
    await w.call(agent.secret, 'POST', '/v1/brains/yt/entries', {
      type: 'note',
      title: 'From the agent',
      content: 'x',
    })
    const web = await f.waitFor((e) => e.data.target?.label === 'From the web')
    const short = await f.waitFor((e) => e.data.target?.label === 'From the agent')
    assert.equal(web.data.client, 'web')
    assert.equal(short.data.client, 'claude-code')
    // Resumed, the same names: the client is kept with the event, not looked up again.
    const back = await subscribe(factory.key, 'yt', { lastEventId: String(Number(web.id) - 1) })
    const again = await back.waitFor((e) => e.data.target?.label === 'From the agent')
    assert.equal(again.data.client, 'claude-code')
    f.close()
    back.close()
  })

  // Spec B6 CA6b: Activity follows pack rule 7 on the server, live and when resuming. Ana's agent searches;
  // Bob, a contributor who is not Ana, never gets those searches; Eric, a curator, does; Ana does too.
  it("CA6b: a contributor never gets Ana's agent's searches, live or replayed; a curator and Ana do", async () => {
    const anaAgent = await w.call(ana.key, 'POST', '/v1/brains/yt/entries', {
      type: 'note',
      title: 'Ana marks the start',
      content: 'x',
    })
    assert.equal(anaAgent.status, 201)
    const bobLive = await subscribe(bob.key)
    const start = await bobLive
      .waitFor((e) => e.data.target?.label === 'Ana marks the start', 3000)
      .catch(() => null)
    const from = start ? String(Number(start.id) - 1) : '0'
    await w.call(ana.key, 'GET', '/v1/search?q=ana-secret-plans')
    await w.call(ana.key, 'GET', '/v1/brains/yt/pages/audience/retention')
    await w.call(ana.key, 'POST', '/v1/brains/yt/entries', {
      type: 'note',
      title: 'Ana writes',
      content: 'x',
    })
    await bobLive.waitFor((e) => e.data.target?.label === 'Ana writes')
    const looks = (s: Stream) =>
      s.events.filter(
        (e) => (e.data.kind === 'search' || e.data.kind === 'read') && e.data.who?.id === ana.id,
      )
    assert.deepEqual(looks(bobLive), [], 'live')
    for (const [who, key, sees] of [
      ['Bob', bob.key, false],
      ['Eric', eric.key, true],
      ['Ana', ana.key, true],
    ] as const) {
      const back = await subscribe(key, 'yt', { lastEventId: from })
      await back.waitFor((e) => e.data.target?.label === 'Ana writes')
      const got = looks(back)
      if (sees) {
        assert.ok(
          got.some((e) => e.data.kind === 'search' && e.data.query === 'ana-secret-plans'),
          `${who} gets the search`,
        )
        assert.ok(
          got.some((e) => e.data.kind === 'read'),
          `${who} gets the read`,
        )
      } else assert.deepEqual(got, [], `${who} gets no search or read of Ana's when resuming`)
      // Writes reach everyone.
      assert.ok(back.events.some((e) => e.data.target?.label === 'Ana writes'))
      back.close()
    }
    bobLive.close()
  })
})
