// The journal as a person works it in the web (spec B6 «Journal», B1 «Corregir, olvidar», «Relaciones»;
// plan T023–T024): a person's correction written in the web, about a page or an entry; an entry read with
// its authorship, client, relations and history; a person — and only a person, in the web — changes,
// forgets, supersedes or dismisses a correction, and settles what an agent asked about one; conflicts by
// pages; the forgotten list says who forgot and why. Permissions are those of every other channel.
import assert from 'node:assert/strict'
import { after, before, describe, it } from 'node:test'
import { skipPg } from '../helpers/pg.ts'
import { type World, world } from '../helpers/world.ts'

type Json = Record<string, unknown>
type Receipt = { entryId: string; revision: number }
type Entry = Json & {
  id: string
  type: string
  state: string
  refs: string[]
  appliesTo: string | null
  topic: string | null
  supersededBy: string | null
  author: { id: string; name: string }
  onBehalf: { id: string; name: string } | null
  client: string | null
  forgotten: { by: { id: string; name: string }; reason: string; at: string } | null
}
type Relation = {
  id: string
  kind: string
  status: string
  direction: 'out' | 'in'
  other: { id: string; title: string | null; type: string; state: string }
  by: { id: string; name: string }
}

describe('the journal in the web', { skip: skipPg }, () => {
  let w: World
  let eric: { id: string; key: string } // curator
  let ana: { id: string; key: string } // contributor
  let rita: { id: string; key: string } // reader
  let ericWeb: string
  let anaWeb: string
  let ritaWeb: string

  const save = async (key: string, body: Json) => {
    const r = await w.call(key, 'POST', '/v1/brains/yt/entries', body)
    assert.equal(r.status, 201, r.text)
    return (r.body.receipt as Receipt).entryId
  }
  const correct = (session: string, body: Json, slug = 'yt') =>
    w.callWeb(session, 'POST', `/v1/brains/${slug}/corrections`, body)
  const entry = async (key: string, id: string, web = false) => {
    const r = web
      ? await w.callWeb(key, 'GET', `/v1/entries/${id}?history=1`)
      : await w.call(key, 'GET', `/v1/entries/${id}?history=1`)
    return r as unknown as { status: number; body: { entry: Entry; relations: Relation[]; history: Json[] } }
  }
  const context = async (key: string, q: string) =>
    String((await w.call(key, 'GET', `/v1/brains/yt/context?${q}`)).body.text)

  before(async () => {
    w = await world()
    eric = await w.person('Eric')
    ana = await w.person('Ana')
    rita = await w.person('Rita')
    await w.call(eric.key, 'POST', '/v1/brains', { slug: 'yt', purpose: 'Videos.' })
    await w.call(eric.key, 'POST', '/v1/brains', { slug: 'old', purpose: 'Archived.' })
    await w.member('yt', ana.id, 'contributor')
    await w.member('yt', rita.id, 'reader')
    await w.member('old', ana.id, 'contributor')
    ericWeb = await w.web(eric.id)
    anaWeb = await w.web(ana.id)
    ritaWeb = await w.web(rita.id)
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
    await w.callWeb(ericWeb, 'POST', '/v1/brains/old/archive')
  })
  after(async () => w.close())

  it('CA12: a person adds a correction to a page; an agent on a task about it gets it, others do not', async () => {
    const r = await correct(anaWeb, {
      title: 'The long greeting loses viewers',
      content: 'Cut the greeting; a third of viewers leave before the hook.',
      appliesTo: 'narrator',
      page: 'style/intros',
    })
    assert.equal(r.status, 201, r.text)
    const id = (r.body.receipt as Receipt).entryId
    const e = (await entry(ana.key, id)).body.entry
    assert.equal(e.type, 'correction')
    assert.equal(e.topic, null)
    assert.equal(e.appliesTo, 'narrator')
    assert.deepEqual(e.refs, ['page:style/intros'])
    assert.deepEqual(e.author, { id: ana.id, name: 'Ana' })
    assert.equal(e.client, 'web')
    // Another agent, on a task about intros: the correction is about a page of its task.
    assert.match(await context(eric.key, 'task=rewrite+the+intros&agent=writer'), /Cut the greeting/)
    // On a task about something else, it is not about its work.
    assert.doesNotMatch(await context(eric.key, 'task=pricing+tiers&agent=writer'), /Cut the greeting/)
    // The agent it applies to always gets it.
    assert.match(await context(eric.key, 'task=pricing+tiers&agent=narrator'), /Cut the greeting/)
  })

  it('a correction about an entry names it; the page or entry must exist in this brain', async () => {
    const target = await save(ana.key, { type: 'learning', title: 'Music', content: 'Loud music helps.' })
    const r = await correct(ericWeb, {
      title: 'Not loud',
      content: 'Quiet music, under the voice.',
      entry: target,
    })
    assert.equal(r.status, 201, r.text)
    const e = (await entry(eric.key, (r.body.receipt as Receipt).entryId)).body.entry
    assert.deepEqual(e.refs, [`entry:${target}`])
    const noPage = await correct(ericWeb, { title: 'x', content: 'y', page: 'no/such-page' })
    assert.equal(noPage.status, 404)
    assert.equal(noPage.body.error?.code, 'page_not_found')
    const noEntry = await correct(ericWeb, { title: 'x', content: 'y', entry: 'ent_nope' })
    assert.equal(noEntry.status, 404)
    assert.equal(noEntry.body.error?.code, 'not_found')
    const both = await correct(ericWeb, { title: 'x', content: 'y', page: 'style/intros', entry: target })
    assert.equal(both.status, 400)
  })

  it('only a person in the web, contributor or more, in an active brain, writes a correction', async () => {
    const body = { title: 'Short', content: 'Keep it short.' }
    const reader = await correct(ritaWeb, body)
    assert.equal(reader.status, 403)
    assert.match(reader.body.error?.howToProceed ?? '', /Eric/, 'says which curator to ask')
    const token = await w.call(ana.key, 'POST', '/v1/brains/yt/corrections', body)
    assert.equal(token.status, 403)
    assert.match(token.body.error?.howToProceed ?? '', /learning|preference/)
    const noHeader = await w.callWeb(anaWeb, 'POST', '/v1/brains/yt/corrections', body, { csrf: false })
    assert.equal(noHeader.status, 403)
    assert.equal(noHeader.body.error?.code, 'csrf')
    const archived = await correct(anaWeb, body, 'old')
    assert.equal(archived.status, 403)
    const stranger = await correct(ritaWeb, body, 'old')
    assert.equal(stranger.status, 404)
    assert.equal(stranger.body.error?.code, 'brain_not_found')
  })

  it('an entry reads with its authorship, client, relations and history with names', async () => {
    const app = await w.app(eric.id, [
      String((await w.db.one('SELECT id FROM brains WHERE slug = $1', ['yt']))?.id),
    ])
    const a = await save(app, { type: 'decision', title: 'Thirty seconds', content: 'Intros of 30s.' })
    const b = await save(ana.key, { type: 'learning', title: 'Ten seconds', content: 'Intros of 10s.' })
    await w.call(ana.key, 'PATCH', `/v1/entries/${b}`, { baseRevision: 1, content: 'Intros of 10s work.' })
    const rel = await w.call(ana.key, 'POST', '/v1/brains/yt/relations', {
      from: b,
      to: a,
      kind: 'contradicts',
      reason: 'Different numbers.',
    })
    assert.equal(rel.status, 201, rel.text)
    const read = await entry(rita.key, a)
    assert.equal(read.status, 200)
    assert.equal(read.body.entry.client, 'Claude Code')
    assert.deepEqual(read.body.entry.author, { id: eric.id, name: 'Eric' })
    assert.equal(read.body.entry.onBehalf, null)
    assert.equal(read.body.entry.forgotten, null)
    assert.equal(read.body.relations.length, 1)
    const r0 = read.body.relations[0] as Relation
    assert.equal(r0.kind, 'contradicts')
    assert.equal(r0.direction, 'in')
    assert.deepEqual(r0.other, { id: b, title: 'Ten seconds', type: 'learning', state: 'active' })
    assert.deepEqual(r0.by, { id: ana.id, name: 'Ana' })
    const hist = (await entry(rita.key, b)).body.history
    assert.deepEqual(
      hist.map((h) => [h.revision, h.authorName]),
      [
        [1, 'Ana'],
        [2, 'Ana'],
      ],
    )
    // Once b is forgotten, someone who is not a curator sees that a related entry is gone, not its title.
    await w.call(ana.key, 'POST', `/v1/entries/${b}/forget`, { reason: 'Wrong number.' })
    const later = (await entry(rita.key, a)).body.relations[0] as Relation
    assert.deepEqual(later.other, { id: b, title: null, type: 'learning', state: 'forgotten' })
    const curator = (await entry(eric.key, a)).body.relations[0] as Relation
    assert.equal(curator.other.title, 'Ten seconds')
    const gone = (await entry(eric.key, b)).body.entry
    assert.deepEqual(gone.forgotten?.by, { id: ana.id, name: 'Ana' })
    assert.equal(gone.forgotten?.reason, 'Wrong number.')
  })

  it('a person in the web changes, schedules and forgets a correction; keys still cannot', async () => {
    const made = await correct(anaWeb, { title: 'Voices', content: 'Use the warm voice for intros.' })
    const id = (made.body.receipt as Receipt).entryId
    const byKey = await w.call(eric.key, 'PATCH', `/v1/entries/${id}`, {
      baseRevision: 1,
      content: 'Changed.',
    })
    assert.equal(byKey.status, 400, 'a curator’s key is still an agent')
    const edited = await w.callWeb(anaWeb, 'PATCH', `/v1/entries/${id}`, {
      baseRevision: 1,
      content: 'Use the warm voice for every intro.',
    })
    assert.equal(edited.status, 200, edited.text)
    assert.equal((edited.body.entry as Entry).type, 'correction')
    // A person may not turn an agent's entry into a correction, nor a correction into something else.
    const typed = await w.callWeb(anaWeb, 'PATCH', `/v1/entries/${id}`, { baseRevision: 2, type: 'note' })
    assert.equal(typed.status, 400)
    const other = await save(ana.key, { type: 'note', title: 'Plain', content: 'Plain note.' })
    const into = await w.callWeb(anaWeb, 'PATCH', `/v1/entries/${other}`, {
      baseRevision: 1,
      type: 'correction',
    })
    assert.equal(into.status, 400)
    // Rita reads but changes nothing.
    const ritas = await w.callWeb(ritaWeb, 'PATCH', `/v1/entries/${id}`, { baseRevision: 2, content: 'x' })
    assert.equal(ritas.status, 403)
    const dated = await w.callWeb(anaWeb, 'POST', `/v1/entries/${id}/schedule`, { reviewAfter: '2026-11-30' })
    assert.equal(dated.status, 200, dated.text)
    assert.match(await context(eric.key, 'agent=x'), /warm voice for every intro/)
    const forgot = await w.callWeb(anaWeb, 'POST', `/v1/entries/${id}/forget`, {
      reason: 'Replaced by the style guide.',
    })
    assert.equal(forgot.status, 200, forgot.text)
    assert.doesNotMatch(await context(eric.key, 'agent=x'), /warm voice/)
    const back = await w.callWeb(ericWeb, 'POST', `/v1/entries/${id}/recover`)
    assert.equal(back.status, 200, back.text)
    assert.match(await context(eric.key, 'agent=x'), /warm voice/)
  })

  it('CA11 and B1: a person supersedes or dismisses a correction; what an agent asked waits for a person', async () => {
    const c = (
      (await correct(ericWeb, { title: 'Hooks', content: 'Put the hook in the first five seconds.' })).body
        .receipt as Receipt
    ).entryId
    const e = await save(ana.key, {
      type: 'learning',
      title: 'Hooks later',
      content: 'Hook at second twenty.',
    })
    // An agent asks: it waits for a person, and the correction stays in force.
    const asked = await w.call(ana.key, 'POST', '/v1/brains/yt/relations', {
      from: e,
      to: c,
      kind: 'supersedes',
    })
    assert.equal((asked.body.relation as Relation).status, 'pending_person')
    const waiting = await w.call(rita.key, 'GET', '/v1/brains/yt/conflicts')
    assert.ok(
      (waiting.body.conflicts as Json[]).some(
        (x) => (x.relation as Relation).id === (asked.body.relation as Relation).id,
      ),
    )
    assert.match(await context(eric.key, 'agent=x'), /first five seconds/)
    // A person confirms the same thing in the web: the waiting relation takes effect, no second one. Ana
    // may not (the correction is Eric's: its author or a curator decides); Eric may.
    const notHers = await w.callWeb(anaWeb, 'POST', '/v1/brains/yt/relations', {
      from: e,
      to: c,
      kind: 'supersedes',
    })
    assert.equal(notHers.status, 403, notHers.text)
    const confirmed = await w.callWeb(ericWeb, 'POST', '/v1/brains/yt/relations', {
      from: e,
      to: c,
      kind: 'supersedes',
    })
    assert.equal(confirmed.status, 201, confirmed.text)
    assert.equal((confirmed.body.relation as Relation).id, (asked.body.relation as Relation).id)
    assert.equal((confirmed.body.relation as Relation).status, 'active')
    assert.doesNotMatch(await context(eric.key, 'agent=x'), /first five seconds/)
    const after = await w.call(rita.key, 'GET', '/v1/brains/yt/conflicts')
    assert.ok(
      !(after.body.conflicts as Json[]).some(
        (x) => (x.relation as Relation).id === (asked.body.relation as Relation).id,
      ),
    )
    // Another: an agent asks to dismiss; a person decides otherwise (the correction wins).
    const c2 = (
      (await correct(ericWeb, { title: 'Titles', content: 'Titles under sixty characters.' })).body
        .receipt as Receipt
    ).entryId
    const e2 = await save(ana.key, {
      type: 'learning',
      title: 'Long titles',
      content: 'Titles of 90 characters.',
    })
    const dismiss = await w.call(ana.key, 'POST', '/v1/brains/yt/relations', {
      from: e2,
      to: c2,
      kind: 'not_related',
    })
    assert.equal((dismiss.body.relation as Relation).status, 'pending_person')
    const wins = await w.callWeb(ericWeb, 'POST', '/v1/brains/yt/relations', {
      from: c2,
      to: e2,
      kind: 'supersedes',
    })
    assert.equal((wins.body.relation as Relation).status, 'active')
    const left = (await w.call(rita.key, 'GET', '/v1/brains/yt/conflicts')).body.conflicts as Json[]
    assert.ok(!left.some((x) => (x.relation as Relation).id === (dismiss.body.relation as Relation).id))
    assert.equal((await entry(eric.key, e2)).body.entry.supersededBy, c2)
    assert.match(await context(eric.key, 'agent=x'), /sixty characters/)
    // A reader settles nothing.
    const e3 = await save(ana.key, { type: 'note', title: 'n3', content: 'Three.' })
    const ritas = await w.callWeb(ritaWeb, 'POST', '/v1/brains/yt/relations', {
      from: e3,
      to: c2,
      kind: 'supersedes',
    })
    assert.equal(ritas.status, 403)
  })

  it('conflicts come by pages with their total; the forgotten list says who forgot and why', async () => {
    const pair = async (n: number) => {
      const a = await save(ana.key, { type: 'learning', title: `A${n}`, content: `Claim ${n} yes.` })
      const b = await save(ana.key, { type: 'learning', title: `B${n}`, content: `Claim ${n} no.` })
      await w.call(ana.key, 'POST', '/v1/brains/yt/relations', { from: a, to: b, kind: 'contradicts' })
    }
    await pair(1)
    await pair(2)
    const all = await w.call(rita.key, 'GET', '/v1/brains/yt/conflicts')
    const total = all.body.total as number
    assert.equal((all.body.conflicts as Json[]).length, total)
    assert.equal(all.body.next, null)
    const one = await w.call(rita.key, 'GET', '/v1/brains/yt/conflicts?limit=1')
    assert.equal((one.body.conflicts as Json[]).length, 1)
    assert.equal(one.body.total, total)
    assert.equal(one.body.next, '1')
    const two = await w.call(rita.key, 'GET', `/v1/brains/yt/conflicts?limit=1&offset=${total - 1}`)
    assert.equal((two.body.conflicts as Json[]).length, 1)
    assert.equal(two.body.next, null)
    assert.equal((await w.call(rita.key, 'GET', '/v1/brains/yt/conflicts?limit=0')).status, 400)
    const f = await save(ana.key, { type: 'note', title: 'Forget me', content: 'Gone soon.' })
    await w.call(ana.key, 'POST', `/v1/entries/${f}/forget`, { reason: 'Typo.' })
    const forgotten = await w.call(eric.key, 'GET', '/v1/brains/yt/forgotten')
    const item = (forgotten.body.items as Entry[]).find((x) => x.id === f) as Entry
    assert.deepEqual(item.forgotten?.by, { id: ana.id, name: 'Ana' })
    assert.equal(item.forgotten?.reason, 'Typo.')
    assert.equal((await w.call(ana.key, 'GET', '/v1/brains/yt/forgotten')).status, 403)
  })
})
