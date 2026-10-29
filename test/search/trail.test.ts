// Spec B3 «Rastro de lo consultado»: the trail by reference, by session and by page; who sees which
// lines; and what is left after 90 days.
import assert from 'node:assert/strict'
import { after, before, describe, it } from 'node:test'
import { foldTrail } from '../../src/domain/trail.ts'
import { skipPg } from '../helpers/pg.ts'
import { type World, world } from '../helpers/world.ts'

type Line = {
  id: number
  at: string
  kind: string
  query: string | null
  resultIds: string[]
  account: { id: string; name: string }
  credential: { id: string; kind: string }
  ref: string | null
  sessionId: string | null
}
type Trail = {
  items: Line[]
  next: number | null
  older?: { reads: number; searches: number; contexts: number }
}

describe('the trail of what was consulted', { skip: skipPg }, () => {
  let w: World
  let eric: { id: string; key: string }
  let ana: { id: string; key: string }
  let bob: { id: string; key: string }
  let factory: { id: string; key: string }
  let pageId: string

  const trail = async (key: string, query: string) => {
    const r = await w.call(key, 'GET', `/v1/brains/yt/trail?${query}`)
    assert.equal(r.status, 200, r.text)
    return r.body as unknown as Trail
  }

  before(async () => {
    w = await world()
    eric = await w.person('Eric')
    ana = await w.person('Ana')
    bob = await w.person('Bob')
    factory = await w.service('RSC Factory')
    await w.call(eric.key, 'POST', '/v1/brains', { slug: 'yt', purpose: 'Videos.' })
    await w.member('yt', ana.id, 'contributor')
    await w.member('yt', bob.id, 'reader')
    await w.member('yt', factory.id, 'contributor')
    const web = await w.web(eric.id)
    const r = await w.callWeb(web, 'POST', '/v1/brains/yt/wiki/changes', {
      op: 'create',
      address: 'retention',
      type: 'topic',
      title: 'Retention',
      summary: '',
      body: 'How viewers stay to the end.',
    })
    assert.equal(r.status, 201, r.text)
    pageId = ((await w.call(eric.key, 'GET', '/v1/brains/yt/pages/retention')).body.page as { id: string }).id
    await w.db.query('DELETE FROM trail') // the read above is not part of what the tests count
  })
  after(async () => w.close())

  it('CA15: a step of Factory: its context, two searches and a read by its short key, in order, each with its key', async () => {
    const ref = 'run r_x, step 3'
    const short = (
      await w.call(factory.key, 'POST', '/v1/keys/short', { writeBrain: 'yt', ref, ttlMinutes: 30 })
    ).body.key as { id: string; secret: string }
    const opened = await w.call(factory.key, 'POST', '/v1/brains/yt/sessions', { forKey: short.id, ref })
    assert.equal(opened.status, 201, opened.text)
    const sessionId = (opened.body.session as { id: string }).id
    const main = await w.db.one<{ credential_id: string }>(
      "SELECT id AS credential_id FROM credentials WHERE account_id = $1 AND kind = 'main'",
      [factory.id],
    )
    const ctx = await w.call(
      factory.key,
      'GET',
      `/v1/brains/yt/context?ref=${encodeURIComponent(ref)}&task=retention`,
    )
    assert.equal(ctx.status, 200)
    w.advance(1)
    await w.call(short.secret, 'GET', '/v1/search?q=retention')
    w.advance(1)
    await w.call(short.secret, 'GET', '/v1/search?q=viewers')
    w.advance(1)
    assert.equal((await w.call(short.secret, 'GET', '/v1/brains/yt/pages/retention')).status, 200)
    const t = await trail(factory.key, `ref=${encodeURIComponent(ref)}`)
    assert.deepEqual(
      t.items.map((l) => [l.kind, l.credential.id, l.query]),
      [
        ['context', main?.credential_id, 'retention'],
        ['search', short.id, 'retention'],
        ['search', short.id, 'viewers'],
        ['read', short.id, null],
      ],
    )
    assert.deepEqual(t.items[3]?.resultIds, [pageId])
    // The short key's lines carry its bound session, so the step can also be asked by session.
    assert.deepEqual(
      t.items.map((l) => l.sessionId),
      [null, sessionId, sessionId, sessionId],
    )
    assert.deepEqual(
      (await trail(factory.key, `session=${sessionId}`)).items.map((l) => l.kind),
      ['search', 'search', 'read'],
    )
  })

  it("CA15b: a service sees only what its own keys did; a curator sees everyone's; a member sees their own", async () => {
    await w.call(eric.key, 'GET', '/v1/search?q=secretplan&brains=yt')
    await w.call(ana.key, 'GET', '/v1/search?q=anaquery&brains=yt')
    const asFactory = await trail(factory.key, 'limit=200')
    assert.ok(asFactory.items.length > 0)
    assert.ok(asFactory.items.every((l) => l.account.id === factory.id))
    assert.ok(!asFactory.items.some((l) => l.query === 'secretplan'))
    const asAna = await trail(ana.key, 'limit=200')
    assert.deepEqual(
      asAna.items.map((l) => l.query),
      ['anaquery'],
    )
    const asCurator = await trail(eric.key, 'limit=200')
    assert.ok(asCurator.items.some((l) => l.query === 'secretplan'))
    assert.ok(asCurator.items.some((l) => l.query === 'anaquery'))
    assert.ok(asCurator.items.some((l) => l.account.id === factory.id))
    // Not a member: the brain does not exist for you.
    const stranger = await w.person('Stranger')
    assert.equal((await w.call(stranger.key, 'GET', '/v1/brains/yt/trail')).status, 404)
  })

  it('CA16: who read this page: three clients, with the date', async () => {
    for (const key of [ana.key, bob.key, eric.key]) {
      w.advance(1000)
      assert.equal((await w.call(key, 'GET', '/v1/brains/yt/pages/retention')).status, 200)
    }
    const t = await trail(eric.key, 'page=retention&limit=200')
    const readers = new Set(t.items.filter((l) => l.kind === 'read').map((l) => l.account.id))
    for (const id of [ana.id, bob.id, eric.id, factory.id]) assert.ok(readers.has(id), id)
    assert.ok(t.items.every((l) => l.resultIds.includes(pageId) && l.at))
    // A search that found the page is not a read of it.
    assert.ok(!t.items.some((l) => l.kind === 'search'))
    // An unknown page: nobody read it.
    assert.deepEqual((await trail(eric.key, 'page=nothing/here')).items, [])
    assert.equal((await w.call(eric.key, 'GET', '/v1/brains/yt/trail?page=retention&ref=x')).status, 400)
  })

  it('pages of the trail follow "next"', async () => {
    const all = await trail(eric.key, 'limit=200')
    const first = await trail(eric.key, 'limit=2')
    assert.equal(first.items.length, 2)
    const second = await trail(eric.key, `limit=2&after=${first.next}`)
    assert.deepEqual(
      [...first.items, ...second.items].map((l) => l.id),
      all.items.slice(0, 4).map((l) => l.id),
    )
    assert.equal((await w.call(eric.key, 'GET', '/v1/brains/yt/trail?after=-1')).status, 400)
    const last = await trail(eric.key, `limit=200&after=${all.items.at(-2)?.id}`)
    assert.deepEqual([last.items.length, last.next], [1, null])
  })

  it('after 90 days the trail folds into counters per page, which a curator sees', async () => {
    const before = (await trail(eric.key, 'page=retention&limit=200')).items.filter(
      (l) => l.kind === 'read',
    ).length
    w.advance(91 * 86_400_000)
    eric.key = await w.token(eric.id) // person tokens last 90 days
    ana.key = await w.token(ana.id)
    const folded = await foldTrail(w.db, w.clock())
    assert.ok(folded > 0)
    assert.equal((await w.db.one<{ n: number }>('SELECT count(*)::int AS n FROM trail'))?.n, 0)
    const t = await trail(eric.key, 'page=retention')
    assert.deepEqual(t.items, [])
    assert.equal(t.older?.reads, before)
    assert.ok((t.older?.searches ?? 0) >= 1)
    // Only curators see the counters.
    assert.equal((await trail(ana.key, 'page=retention')).older, undefined)
    assert.equal(t.older?.contexts, 1)
    // Folding again changes nothing; a later fold adds to the counters.
    assert.equal(await foldTrail(w.db, w.clock()), 0)
    await w.call(eric.key, 'GET', '/v1/brains/yt/pages/retention')
    await w.call(eric.key, 'GET', '/v1/brains/yt/pages/retention?revision=1')
    w.advance(91 * 86_400_000)
    eric.key = await w.token(eric.id)
    ana.key = await w.token(ana.id)
    assert.equal(await foldTrail(w.db, w.clock()), 2)
    assert.equal((await trail(eric.key, 'page=retention')).older?.reads, before + 2)
  })

  it("review: an agent's short key for one person does not see another person's run", async () => {
    const forAna = (
      await w.call(factory.key, 'POST', '/v1/keys/short', {
        writeBrain: 'yt',
        ref: 'run ana',
        ttlMinutes: 30,
      })
    ).body.key as { secret: string }
    const forBob = (
      await w.call(factory.key, 'POST', '/v1/keys/short', {
        writeBrain: 'yt',
        ref: 'run bob',
        ttlMinutes: 30,
      })
    ).body.key as { secret: string }
    await w.call(forAna.secret, 'GET', '/v1/search?q=salary')
    await w.call(forBob.secret, 'GET', '/v1/search?q=hooks')
    const seen = (await trail(forBob.secret, 'limit=200')).items.map((l) => l.query)
    assert.deepEqual(seen, ['hooks'])
    // The service's main key sees what all its keys did.
    const all = (await trail(factory.key, 'limit=200')).items.map((l) => l.query)
    assert.ok(all.includes('salary') && all.includes('hooks'))
  })

  it('review: reading an old revision, a comparison or the history is a read', async () => {
    await w.db.query('DELETE FROM trail')
    for (const q of ['?revision=1', '?history=1', '?compare=1,1']) {
      assert.equal((await w.call(ana.key, 'GET', `/v1/brains/yt/pages/retention${q}`)).status, 200, q)
    }
    const t = await trail(eric.key, 'page=retention')
    assert.equal(t.items.filter((l) => l.kind === 'read' && l.account.id === ana.id).length, 3)
  })

  it("review: after midnight a line goes to today's session, like the writes, not yesterday's", async () => {
    w.now = new Date('2026-12-01T23:00:00.000Z')
    const key = await w.token(ana.id)
    const write = async () =>
      (
        await w.call(key, 'POST', '/v1/brains/yt/entries', {
          type: 'note',
          title: 'n',
          content: `c ${w.now.getTime()}`,
        })
      ).body.receipt as { entryId: string }
    const sessionOf = async (id: string) =>
      ((await w.call(key, 'GET', `/v1/entries/${id}`)).body.entry as { sessionId: string }).sessionId
    const lineOf = async (q: string) =>
      (await w.db.one<{ session_id: string | null }>('SELECT session_id FROM trail WHERE query = $1', [q]))
        ?.session_id
    const yesterday = await sessionOf((await write()).entryId)
    w.now = new Date('2026-12-02T01:00:00.000Z')
    // Before any write today there is no session of today yet: the line has none, not yesterday's.
    await w.call(key, 'GET', '/v1/search?q=beforewrite&brains=yt')
    assert.equal(await lineOf('beforewrite'), null)
    const today = await sessionOf((await write()).entryId)
    assert.notEqual(today, yesterday)
    await w.call(key, 'GET', '/v1/search?q=afterwrite&brains=yt')
    assert.equal(await lineOf('afterwrite'), today)
  })
})
