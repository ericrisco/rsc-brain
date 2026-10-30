// Review of PR20 (spec B6 «Journal», B1 «Corregir, olvidar», «Relaciones»): what the review found wrong on
// the server. The reason of a relation to an entry hidden from the reader stays hidden too; superseding or
// dismissing a correction, and superseding someone else's entry, is for that entry's author or a curator
// (the rule of forgetting); a person's confirmation counts from when it was given, so it settles a
// contradiction recorded after the agent asked; a correction about a page follows the page when it moves;
// the reference filter of Sessions ignores forgotten entries; and the client that wrote an entry or a
// session is the one at the time of writing, not whatever used the key last.
import assert from 'node:assert/strict'
import { after, before, describe, it } from 'node:test'
import { skipPg } from '../helpers/pg.ts'
import { type World, world } from '../helpers/world.ts'

type Json = Record<string, unknown>
type Receipt = { entryId: string }
type Relation = {
  id: string
  status: string
  reason: string | null
  other: { id: string; title: string | null }
}

describe('the journal after the review of PR20', { skip: skipPg }, () => {
  let w: World
  let eric: { id: string; key: string } // curator
  let ana: { id: string; key: string } // contributor
  let bob: { id: string; key: string } // contributor
  let rita: { id: string; key: string } // reader
  let ericWeb: string
  let anaWeb: string

  const save = async (key: string, body: Json, slug = 'yt') => {
    const r = await w.call(key, 'POST', `/v1/brains/${slug}/entries`, body)
    assert.equal(r.status, 201, r.text)
    return (r.body.receipt as Receipt).entryId
  }
  const correct = async (session: string, body: Json, slug = 'yt') => {
    const r = await w.callWeb(session, 'POST', `/v1/brains/${slug}/corrections`, body)
    assert.equal(r.status, 201, r.text)
    return (r.body.receipt as Receipt).entryId
  }
  const relateWeb = (session: string, body: Json, slug = 'yt') =>
    w.callWeb(session, 'POST', `/v1/brains/${slug}/relations`, body)
  const relations = async (key: string, id: string) =>
    (await w.call(key, 'GET', `/v1/entries/${id}`)).body.relations as Relation[]
  const context = async (key: string, q: string) =>
    String((await w.call(key, 'GET', `/v1/brains/yt/context?${q}`)).body.text)

  before(async () => {
    w = await world()
    eric = await w.person('Eric')
    ana = await w.person('Ana')
    bob = await w.person('Bob')
    rita = await w.person('Rita')
    await w.call(eric.key, 'POST', '/v1/brains', { slug: 'yt', purpose: 'Videos.' })
    await w.member('yt', ana.id, 'contributor')
    await w.member('yt', bob.id, 'contributor')
    await w.member('yt', rita.id, 'reader')
    ericWeb = await w.web(eric.id)
    anaWeb = await w.web(ana.id)
  })
  after(async () => w.close())

  it('the reason of a relation to an entry hidden from the reader is hidden too; a curator reads it', async () => {
    const a = await save(ana.key, { type: 'learning', title: 'Kept', content: 'Kept claim.' })
    const b = await save(ana.key, { type: 'learning', title: 'Gone', content: 'Gone claim.' })
    const rel = await w.call(ana.key, 'POST', '/v1/brains/yt/relations', {
      from: b,
      to: a,
      kind: 'contradicts',
      reason: 'The gone one says the client is Acme.',
    })
    assert.equal(rel.status, 201, rel.text)
    await w.call(ana.key, 'POST', `/v1/entries/${b}/forget`, { reason: 'Wrong.' })
    for (const key of [rita.key, ana.key]) {
      const [r] = await relations(key, a)
      assert.equal(r?.other.title, null)
      assert.equal(r?.reason, null, 'what the reason says would tell what the hidden entry said')
    }
    const [c] = await relations(eric.key, a)
    assert.equal(c?.other.title, 'Gone')
    assert.equal(c?.reason, 'The gone one says the client is Acme.')
  })

  it('superseding or dismissing a correction, or superseding someone else’s entry, needs its author or a curator', async () => {
    const ericsCorrection = await correct(ericWeb, { title: 'Hooks', content: 'Hook in five seconds.' })
    const anas = await save(ana.key, { type: 'learning', title: 'Ana says', content: 'Hook at twenty.' })
    const bobs = await save(bob.key, { type: 'learning', title: 'Bob says', content: 'Hook at ten.' })
    const refused = async (body: Json) => {
      const r = await relateWeb(anaWeb, body)
      assert.equal(r.status, 403, `${JSON.stringify(body)}: ${r.text}`)
      assert.equal(r.body.error?.code, 'forbidden')
      assert.match(r.body.error?.howToProceed ?? '', /Eric/, 'says which curator to ask')
    }
    await refused({ from: anas, to: ericsCorrection, kind: 'supersedes' })
    await refused({ from: anas, to: ericsCorrection, kind: 'not_related' })
    await refused({ from: ericsCorrection, to: anas, kind: 'not_related' })
    await refused({ from: anas, to: bobs, kind: 'supersedes' })
    // Nothing changed.
    assert.match(await context(eric.key, 'agent=x'), /Hook in five seconds/)
    // Saying they contradict each other is for any contributor.
    assert.equal((await relateWeb(anaWeb, { from: anas, to: bobs, kind: 'contradicts' })).status, 201)
    // Her own entry may lose to Bob's; her own correction may be superseded by her.
    const own = await relateWeb(anaWeb, { from: bobs, to: anas, kind: 'supersedes' })
    assert.equal(own.status, 201, own.text)
    const anasCorrection = await correct(anaWeb, { title: 'Thumbs', content: 'Faces on thumbnails.' })
    const later = await save(ana.key, { type: 'learning', title: 'No faces', content: 'Text only.' })
    const mine = await relateWeb(anaWeb, { from: later, to: anasCorrection, kind: 'supersedes' })
    assert.equal(mine.status, 201, mine.text)
    // A curator may supersede anyone's.
    const bobs2 = await save(bob.key, { type: 'note', title: 'Bob two', content: 'Two.' })
    const cur = await relateWeb(ericWeb, { from: anas, to: bobs2, kind: 'supersedes' })
    assert.equal(cur.status, 201, cur.text)
    // Agents through keys keep their rules: about a correction it waits for a person; otherwise it applies.
    const asked = await w.call(ana.key, 'POST', '/v1/brains/yt/relations', {
      from: anas,
      to: ericsCorrection,
      kind: 'supersedes',
    })
    assert.equal(asked.status, 201, asked.text)
    assert.equal((asked.body.relation as Relation).status, 'pending_person')
    const bobs3 = await save(bob.key, { type: 'note', title: 'Bob three', content: 'Three.' })
    const agent = await w.call(ana.key, 'POST', '/v1/brains/yt/relations', {
      from: anas,
      to: bobs3,
      kind: 'supersedes',
    })
    assert.equal(agent.status, 201, agent.text)
    assert.equal((agent.body.relation as Relation).status, 'active')
  })

  it('a person’s confirmation counts from when it was given: a contradiction recorded meanwhile is settled', async () => {
    await w.call(eric.key, 'POST', '/v1/brains', { slug: 'conf', purpose: 'Conflicts.' })
    const confWeb = await w.web(eric.id)
    const c = await correct(confWeb, { title: 'Greeting', content: 'No greeting.' }, 'conf')
    const e = await save(eric.key, { type: 'learning', title: 'Greet', content: 'Greet first.' }, 'conf')
    const asked = await w.call(eric.key, 'POST', '/v1/brains/conf/relations', {
      from: e,
      to: c,
      kind: 'supersedes',
    })
    assert.equal((asked.body.relation as Relation).status, 'pending_person')
    w.advance(60_000)
    const contra = await w.call(eric.key, 'POST', '/v1/brains/conf/relations', {
      from: e,
      to: c,
      kind: 'contradicts',
    })
    assert.equal(contra.status, 201, contra.text)
    const before = await w.call(eric.key, 'GET', '/v1/brains/conf/conflicts')
    assert.equal(before.body.total, 2)
    w.advance(60_000)
    // A person picks E: the waiting relation is confirmed, and that settles the contradiction too.
    const picked = await relateWeb(confWeb, { from: e, to: c, kind: 'supersedes' }, 'conf')
    assert.equal(picked.status, 201, picked.text)
    assert.equal((picked.body.relation as Relation).id, (asked.body.relation as Relation).id)
    const left = await w.call(eric.key, 'GET', '/v1/brains/conf/conflicts')
    assert.deepEqual(left.body.conflicts, [])
    assert.equal(left.body.total, 0)
    const stats = (await w.call(eric.key, 'GET', '/v1/brains/conf')).body.brain as {
      stats: { conflicts: number }
    }
    assert.equal(stats.stats.conflicts, 0)
    const ov = (await w.callWeb(confWeb, 'GET', '/v1/brains/conf/overview')).body as {
      stats: { conflicts: number }
    }
    assert.equal(ov.stats.conflicts, 0)
  })

  it('a person relating the other way round turns down what waits instead of confirming it', async () => {
    const c = await correct(ericWeb, { title: 'Music', content: 'Quiet music.' })
    const e = await save(ana.key, { type: 'learning', title: 'Loud', content: 'Loud music.' })
    const asked = await w.call(ana.key, 'POST', '/v1/brains/yt/relations', {
      from: e,
      to: c,
      kind: 'supersedes',
    })
    const askedId = (asked.body.relation as Relation).id
    const opposite = await relateWeb(ericWeb, { from: c, to: e, kind: 'supersedes' })
    assert.equal(opposite.status, 201, opposite.text)
    assert.notEqual((opposite.body.relation as Relation).id, askedId)
    const row = await w.db.one<{ status: string }>('SELECT status FROM relations WHERE id = $1', [askedId])
    assert.equal(row?.status, 'rejected')
    const corr = (await w.call(eric.key, 'GET', `/v1/entries/${c}`)).body.entry as {
      supersededBy: string | null
    }
    assert.equal(corr.supersededBy, null, 'the correction stands')
    const loud = (await w.call(eric.key, 'GET', `/v1/entries/${e}`)).body.entry as {
      supersededBy: string | null
    }
    assert.equal(loud.supersededBy, c)
  })

  it('a correction about a page still reaches the agents after the page moves', async () => {
    const page = await w.callWeb(ericWeb, 'POST', '/v1/brains/yt/wiki/changes', {
      op: 'create',
      address: 'style/intros',
      type: 'guide',
      title: 'Intros',
      summary: 'How we open a video.',
      body: 'Open the intros with the question of the video.',
      reason: 'Seed.',
    })
    assert.equal(page.status, 201, page.text)
    const corr = await correct(ericWeb, {
      title: 'The long greeting loses viewers',
      content: 'Cut the greeting; a third of viewers leave before the hook.',
      appliesTo: 'narrator',
      page: 'style/intros',
    })
    assert.match(await context(eric.key, 'task=rewrite+the+intros&agent=writer'), /Cut the greeting/)
    const moved = await w.callWeb(ericWeb, 'POST', '/v1/brains/yt/wiki/changes', {
      op: 'move',
      address: 'style/intros',
      to: 'style/openings',
      reason: 'Renamed.',
    })
    assert.equal(moved.status, 201, moved.text)
    assert.match(await context(eric.key, 'task=rewrite+the+intros&agent=writer'), /Cut the greeting/)
    assert.doesNotMatch(await context(eric.key, 'task=pricing+tiers&agent=writer'), /Cut the greeting/)
    // The page lists it under «Something wrong here?», at its new address too, while it is in force.
    const read = async () =>
      ((await w.call(rita.key, 'GET', '/v1/brains/yt/pages/style/openings')).body.corrections as Json[]).map(
        (c) => [c.id, c.title, c.appliesTo, (c.author as Json).name],
      )
    assert.deepEqual(await read(), [[corr, 'The long greeting loses viewers', 'narrator', 'Eric']])
    await w.callWeb(ericWeb, 'POST', `/v1/entries/${corr}/forget`, { reason: 'Done.' })
    assert.deepEqual(await read(), [])
  })

  it('the reference filter of Sessions ignores forgotten entries', async () => {
    const factory = await w.service('Factory')
    await w.member('yt', factory.id, 'contributor')
    const short = (
      await w.call(factory.key, 'POST', '/v1/keys/short', {
        writeBrain: 'yt',
        ref: 'run r_901, step 1',
        agent: 'narrator',
        ttlMinutes: 30,
      })
    ).body.key as { id: string; secret: string }
    const id = await save(short.secret, { type: 'step', title: 'Narrated', content: 'One take.' })
    const sid = (await w.db.one<{ session_id: string }>('SELECT session_id FROM entries WHERE id = $1', [id]))
      ?.session_id as string
    // The session's own reference aside: only the entry's stamped one can match.
    await w.db.query('UPDATE sessions SET ref = NULL WHERE id = $1', [sid])
    const ids = async () =>
      ((await w.call(eric.key, 'GET', '/v1/brains/yt/sessions?ref=r_901')).body.items as Json[]).map(
        (s) => s.id,
      )
    assert.deepEqual(await ids(), [sid])
    await w.callWeb(ericWeb, 'POST', `/v1/entries/${id}/forget`, { reason: 'Wrong run.' })
    assert.deepEqual(await ids(), [])
  })

  it('the client that wrote an entry or a session is the one at the time of writing', async () => {
    await w.call(eric.key, 'POST', '/v1/brains', { slug: 'cli', purpose: 'Clients.' })
    const token = await w.token(eric.id)
    const as = (ua: string, method: string, path: string, body?: unknown) =>
      w.raw(method, path, {
        headers: { authorization: `Bearer ${token}`, 'user-agent': ua },
        ...(body ? { body } : {}),
      })
    const saved = await as('Client A/1.0', 'POST', '/v1/brains/cli/entries', {
      type: 'note',
      title: 'From A',
      content: 'Written by A.',
    })
    assert.equal(saved.status, 201, saved.text)
    const id = (saved.body.receipt as Receipt).entryId
    // The same token, used later from another program.
    w.advance(5 * 60_000)
    assert.equal((await as('Client B/2.0', 'GET', '/v1/brains')).status, 200)
    w.advance(5 * 60_000)
    assert.equal((await as('Client B/2.0', 'GET', '/v1/me')).status, 200)
    const read = (await w.call(eric.key, 'GET', `/v1/entries/${id}`)).body.entry as { client: string }
    assert.equal(read.client, 'Client A/1.0')
    const sessions = (await w.call(eric.key, 'GET', '/v1/brains/cli/sessions')).body as {
      items: Array<{ client: string }>
      facets: { clients: string[] }
    }
    assert.equal(sessions.items[0]?.client, 'Client A/1.0')
    // The session of a day says its day as a day (it read "Thu Oct 29 2026 00:00:00 GMT…" before).
    assert.equal((sessions.items[0] as { day?: string }).day, '2026-10-29')
    const one = (await w.call(eric.key, 'GET', `/v1/entries/${id}`)).body.session as { day: string }
    assert.equal(one.day, '2026-10-29')
    assert.deepEqual(sessions.facets.clients, ['Client A/1.0'])
    const filtered = (await w.call(eric.key, 'GET', '/v1/brains/cli/sessions?client=Client%20A%2F1.0'))
      .body as {
      total: number
    }
    assert.equal(filtered.total, 1)
    const ov = (await w.call(eric.key, 'GET', '/v1/brains/cli/overview')).body as {
      todaySessions: Array<{ client: string }>
    }
    assert.equal(ov.todaySessions[0]?.client, 'Client A/1.0', 'the overview and Sessions agree')
  })
})
