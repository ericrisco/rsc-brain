// Spec B5 «Flujo de eventos», the order of delivery: an event is handed out in the order it became
// visible, so a write whose transaction commits late is never lost (live or on resume), a rolled-back
// write never holds back the ones after it, and the seam between the replay and the live feed neither
// drops nor repeats. Also: a Last-Event-ID ahead of this installation, the gap check per viewer, and the
// exact 24-hour edge (CA13, CA20).
import assert from 'node:assert/strict'
import { after, before, describe, it } from 'node:test'
import type { Db } from '../../src/db/db.ts'
import { skipPg } from '../helpers/pg.ts'
import { type World, world } from '../helpers/world.ts'

type Ev = {
  id: string
  event: string
  data: { id?: string; kind?: string; target?: { label: string | null } | null; message?: string }
  receivedAt: number
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
const DAY = 24 * 3_600_000

describe('the order in which events are delivered', { skip: skipPg }, () => {
  let w: World
  let eric: { id: string; key: string }
  let ana: { id: string; key: string }
  let bob: { id: string; key: string }
  let factory: { id: string; key: string }
  const brains = new Map<string, string>()
  const open: AbortController[] = []

  async function subscribe(key: string, slug: string, lastEventId?: string) {
    const ac = new AbortController()
    open.push(ac)
    const res = await fetch(`${w.base}/v1/brains/${slug}/events`, {
      headers: { authorization: `Bearer ${key}`, ...(lastEventId ? { 'last-event-id': lastEventId } : {}) },
      signal: ac.signal,
    })
    assert.equal(res.status, 200)
    const events: Ev[] = []
    void (async () => {
      const decoder = new TextDecoder()
      let buf = ''
      for await (const chunk of res.body as AsyncIterable<Uint8Array>) {
        buf += decoder.decode(chunk, { stream: true })
        let at = buf.indexOf('\n\n')
        while (at >= 0) {
          const lines = buf.slice(0, at).split('\n')
          buf = buf.slice(at + 2)
          at = buf.indexOf('\n\n')
          if (lines.every((l) => l.startsWith(':'))) continue
          const field = (n: string) =>
            lines
              .filter((l) => l.startsWith(`${n}:`))
              .map((l) => l.slice(n.length + 1).trimStart())
              .join('\n')
          events.push({
            id: field('id'),
            event: field('event') || 'message',
            data: JSON.parse(field('data') || '{}'),
            receivedAt: Date.now(),
          })
        }
      }
    })().catch(() => {})
    return {
      events,
      labels: () => events.filter((e) => e.event === 'message').map((e) => e.data.target?.label),
      async waitFor(pred: (e: Ev) => boolean, ms = 3000): Promise<Ev> {
        const end = Date.now() + ms
        for (;;) {
          const e = events.find(pred)
          if (e) return e
          if (Date.now() > end) {
            throw new Error(`no such event within ${ms} ms; got ${JSON.stringify(events.map((x) => x.data))}`)
          }
          await sleep(10)
        }
      },
      close: () => ac.abort(),
    }
  }
  const labelled = (label: string) => (e: Ev) => e.data.target?.label === label

  // The same row a write leaves (domain/events.ts emit), inside whatever transaction is given.
  const insert = (db: Db, slug: string, label: string, o: { at?: Date; kind?: string; by?: string } = {}) =>
    db.query(
      `INSERT INTO events (brain_id, at, kind, account_id, target_id, label) VALUES ($1, $2, $3, $4, $5, $5)`,
      [brains.get(slug), o.at ?? w.clock(), o.kind ?? 'entry.saved', o.by ?? eric.id, label],
    )

  // An event the viewer received live, to resume from.
  async function mark(key: string, slug: string, label: string, at?: Date): Promise<string> {
    const s = await subscribe(key, slug)
    await sleep(100)
    await insert(w.db, slug, label, at ? { at } : {})
    const e = await s.waitFor(labelled(label))
    s.close()
    return e.id
  }

  before(async () => {
    w = await world({ events: { pollMs: 20, heartbeatMs: 100, recheckMs: 100 } })
    eric = await w.person('Eric')
    ana = await w.person('Ana')
    bob = await w.person('Bob')
    factory = await w.service('RSC Factory')
    for (const slug of ['yt', 'gone', 'ahead', 'viewer', 'edge', 'seam']) {
      await w.call(eric.key, 'POST', '/v1/brains', { slug })
      await w.member(slug, factory.id, 'contributor')
      await w.member(slug, ana.id, 'contributor')
      await w.member(slug, bob.id, 'contributor')
      brains.set(slug, String((await w.db.one('SELECT id FROM brains WHERE slug = $1', [slug]))?.id))
    }
  })
  after(async () => {
    for (const ac of open) ac.abort()
    await w.close()
  })

  it('a write whose transaction commits late arrives live after what committed before it, and a resume replays both in that order', async () => {
    const from = await mark(factory.key, 'yt', 'Before both')
    const s = await subscribe(factory.key, 'yt')
    await sleep(100)
    // Written first, committed 1.5 s later (a long save, a lock wait).
    const slow = w.db.tx(async (db) => {
      await insert(db, 'yt', 'Slow commit')
      await sleep(1500)
    })
    await sleep(100)
    const fast = await w.call(eric.key, 'POST', '/v1/brains/yt/entries', {
      type: 'note',
      title: 'Fast commit',
      content: 'x',
    })
    assert.equal(fast.status, 201, fast.text)
    await slow
    const f = await s.waitFor(labelled('Fast commit'))
    const late = await s.waitFor(labelled('Slow commit'))
    assert.ok(Number(late.id) > Number(f.id), `${late.id} after ${f.id}`)
    const ids = s.events.map((e) => Number(e.id))
    assert.deepEqual(
      ids,
      [...ids].sort((x, y) => x - y),
    )
    s.close()
    const back = await subscribe(factory.key, 'yt', from)
    await back.waitFor(labelled('Slow commit'))
    assert.deepEqual(back.labels(), ['Fast commit', 'Slow commit'])
    back.close()
  })

  it('a rolled-back write never holds back the events after it', async () => {
    const s = await subscribe(factory.key, 'gone')
    await sleep(100)
    const doomed = w.db
      .tx(async (db) => {
        await insert(db, 'gone', 'Rolled back')
        await sleep(600)
        throw new Error('rolled back on purpose')
      })
      .catch(() => {})
    await sleep(100)
    await insert(w.db, 'gone', 'After the rollback')
    const t0 = Date.now()
    const e = await s.waitFor(labelled('After the rollback'))
    assert.ok(e.receivedAt - t0 < 400, `arrived ${e.receivedAt - t0} ms after its commit`)
    await doomed
    await sleep(200)
    assert.deepEqual(s.labels(), ['After the rollback'])
    s.close()
  })

  it('a Last-Event-ID ahead of this installation says so, then follows from now', async () => {
    const s = await subscribe(factory.key, 'ahead', '999999999')
    const gap = await s.waitFor((e) => e.event === 'gap')
    assert.match(gap.data.message ?? '', /ahead/)
    assert.match(gap.data.message ?? '', /lists/)
    await insert(w.db, 'ahead', 'After the future')
    await s.waitFor(labelled('After the future'))
    s.close()
  })

  it("the gap respects the viewer: someone else's old searches are no gap for a member, an old write is", async () => {
    const long = new Date(w.clock().getTime() - 31 * 3_600_000)
    const from = await mark(ana.key, 'viewer', 'Ana was here', long)
    const resume = async (key: string, marker: string) => {
      const s = await subscribe(key, 'viewer', from)
      await sleep(100)
      await insert(w.db, 'viewer', marker)
      await s.waitFor(labelled(marker))
      s.close()
      return s.events.some((e) => e.event === 'gap')
    }
    const old = new Date(w.clock().getTime() - 30 * 3_600_000)
    await insert(w.db, 'viewer', 'Bob looks', { at: old, kind: 'search', by: bob.id })
    assert.equal(
      await resume(ana.key, 'Marker one'),
      false,
      'a member gets a gap for searches they cannot see',
    )
    assert.equal(await resume(eric.key, 'Marker two'), true, 'a curator sees every search, so misses it')
    await insert(w.db, 'viewer', 'Bob writes', { at: old, by: bob.id })
    assert.equal(await resume(ana.key, 'Marker three'), true, 'a member misses an old write')
  })

  it('an event exactly 24 hours old is replayed, and is no gap', async () => {
    const from = await mark(factory.key, 'edge', 'Day before', new Date(w.clock().getTime() - DAY - 60_000))
    await insert(w.db, 'edge', 'Exactly a day', { at: new Date(w.clock().getTime() - DAY) })
    const s = await subscribe(factory.key, 'edge', from)
    await s.waitFor(labelled('Exactly a day'))
    await sleep(100)
    assert.ok(!s.events.some((e) => e.event === 'gap'))
    s.close()
  })

  it('events that arrive during a long replay are neither lost nor repeated', async () => {
    const from = await mark(factory.key, 'seam', 'Seam start')
    const MISSED = 20_000
    await w.db.query(
      `INSERT INTO events (brain_id, at, kind, account_id, label)
       SELECT $1, $2, 'entry.saved', $3, 'Missed ' || g FROM generate_series(1, ${MISSED}) g`,
      [brains.get('seam'), w.clock(), eric.id],
    )
    const s = await subscribe(factory.key, 'seam', from)
    // Writes keep coming for as long as the replay lasts, and a little after.
    const live: string[] = []
    const write = async () => {
      const label = `Live ${live.length + 1}`
      await insert(w.db, 'seam', label)
      live.push(label)
      await sleep(3)
    }
    while (!s.events.some(labelled(`Missed ${MISSED}`))) await write()
    for (let i = 0; i < 10; i += 1) await write()
    await s.waitFor(labelled(live.at(-1) as string), 5000)
    await sleep(200)
    const got = s.labels()
    assert.equal(new Set(got).size, got.length, 'an event came twice')
    const want = [...Array.from({ length: MISSED }, (_, i) => `Missed ${i + 1}`), ...live]
    assert.deepEqual([...got].sort(), [...want].sort())
    const ids = s.events.map((e) => Number(e.id))
    assert.ok(
      ids.every((id, k) => k === 0 || id > (ids[k - 1] as number)),
      'ids grow',
    )
    s.close()
  })
})

// A slower feed, so a test can act between two of its rounds.
describe('the order of delivery across rounds of the feed', { skip: skipPg }, () => {
  let w: World
  let eric: { id: string; key: string }
  let brainId = ''
  const held: AbortController[] = []
  before(async () => {
    w = await world({ events: { pollMs: 300, heartbeatMs: 1000, recheckMs: 1000 } })
    eric = await w.person('Eric')
    await w.call(eric.key, 'POST', '/v1/brains', { slug: 'burst' })
    brainId = String((await w.db.one("SELECT id FROM brains WHERE slug = 'burst'"))?.id)
  })
  after(async () => {
    for (const ac of held) ac.abort()
    await w.close()
  })

  it('a burst larger than one round arrives whole, and a write committed between rounds comes after it', async () => {
    const ac = new AbortController()
    held.push(ac)
    const res = await fetch(`${w.base}/v1/brains/burst/events`, {
      headers: { authorization: `Bearer ${eric.key}` },
      signal: ac.signal,
    })
    const got: Array<{ id: number; label: string }> = []
    void (async () => {
      const decoder = new TextDecoder()
      let buf = ''
      for await (const chunk of res.body as AsyncIterable<Uint8Array>) {
        buf += decoder.decode(chunk, { stream: true })
        let at = buf.indexOf('\n\n')
        while (at >= 0) {
          const block = buf.slice(0, at)
          buf = buf.slice(at + 2)
          at = buf.indexOf('\n\n')
          const data = block.split('\n').find((l) => l.startsWith('data: '))
          if (!data) continue
          const e = JSON.parse(data.slice(6)) as { id: string; target: { label: string } | null }
          got.push({ id: Number(e.id), label: e.target?.label ?? '' })
        }
      }
    })().catch(() => {})
    await sleep(400)
    const add = (db: Db, label: string) =>
      db.query(
        `INSERT INTO events (brain_id, at, kind, account_id, label) VALUES ($1, $2, 'entry.saved', $3, $4)`,
        [brainId, w.clock(), eric.id, label],
      )
    let commit: () => void = () => {}
    const gate = new Promise<void>((r) => {
      commit = r
    })
    // Written before the burst, committed only once the first round of it has been delivered.
    const slow = w.db.tx(async (db) => {
      await add(db, 'Slow')
      await gate
    })
    await sleep(50)
    await w.db.query(
      `INSERT INTO events (brain_id, at, kind, account_id, label)
       SELECT $1, $2, 'entry.saved', $3, 'Burst ' || g FROM generate_series(1, 1200) g`,
      [brainId, w.clock(), eric.id],
    )
    const until = async (n: number) => {
      const end = Date.now() + 5000
      while (got.length < n && Date.now() < end) await sleep(5)
    }
    await until(1)
    commit()
    await slow
    await until(1201)
    await sleep(700)
    assert.equal(got.length, 1201, `${got.length} events`)
    assert.ok(
      got.every((e, k) => k === 0 || e.id > (got[k - 1] as { id: number }).id),
      'ids grow',
    )
    assert.deepEqual(
      got.slice(0, 1200).map((e) => e.label),
      Array.from({ length: 1200 }, (_, i) => `Burst ${i + 1}`),
    )
    assert.equal(got.at(-1)?.label, 'Slow')
    ac.abort()
  })
})
