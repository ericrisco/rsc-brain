// Spec B6 «Journal › Sessions» through v1 (plan G12, T022): the sessions of a brain filtered by status,
// client, author, external reference, dates, entry type and «uncompiled», each with its client, author,
// number of entries and summary; one session read on its own; and the clients and authors a filter can
// pick from, so nobody types an id. A brain the caller cannot read answers like one that does not exist.
import assert from 'node:assert/strict'
import { after, before, describe, it } from 'node:test'
import { skipPg } from '../helpers/pg.ts'
import { type World, world } from '../helpers/world.ts'

type Item = {
  id: string
  purpose: string
  status: string
  ref: string | null
  day: string | null
  client: string | null
  author: { id: string; name: string }
  entries: number
  summary: string | null
}
type Listed = {
  items: Item[]
  total: number
  next: string | null
  liveFrom: string
  facets?: { clients: string[]; authors: Array<{ id: string; name: string }> }
}

describe('G12: sessions with filters and fields', { skip: skipPg }, () => {
  let w: World
  let eric: { id: string; key: string }
  let ana: { id: string; key: string }
  let outsider: { id: string; key: string }
  let factory: { id: string; key: string }
  const ids: Record<string, string> = {}

  const list = async (key: string, q = '') =>
    (await w.call(key, 'GET', `/v1/brains/yt/sessions${q ? `?${q}` : ''}`)) as unknown as {
      status: number
      body: Listed & { error?: { code: string } }
    }

  before(async () => {
    w = await world()
    eric = await w.person('Eric')
    ana = await w.person('Ana')
    outsider = await w.person('Olga')
    factory = await w.service('RSC Factory')
    await w.call(eric.key, 'POST', '/v1/brains', { slug: 'yt', purpose: 'Videos.' })
    await w.member('yt', ana.id, 'contributor')
    await w.member('yt', factory.id, 'contributor')
    // Eric's agent (a connection named Claude Code): a session closed with a summary, two entries.
    const app = await w.app(eric.id, [
      String((await w.db.one('SELECT id FROM brains WHERE slug = $1', ['yt']))?.id),
    ])
    const s1 = await w.call(app, 'POST', '/v1/brains/yt/sessions', { purpose: 'Intros of October' })
    ids.closed = (s1.body.session as { id: string }).id
    for (const [type, title] of [
      ['decision', 'Short intros'],
      ['learning', 'Hooks first'],
    ])
      await w.call(app, 'POST', '/v1/brains/yt/entries', {
        type,
        title,
        content: `${title}: what we saw.`,
        sessionId: ids.closed,
      })
    await w.call(app, 'POST', `/v1/sessions/${ids.closed}/summary`, {
      content: 'Short intros keep viewers past 30 seconds.',
    })
    w.advance(60_000)
    // Ana, with a token: a session still open, one attempt.
    const s2 = await w.call(ana.key, 'POST', '/v1/brains/yt/sessions', { purpose: 'Emails', ref: 'repo web' })
    ids.open = (s2.body.session as { id: string }).id
    await w.call(ana.key, 'POST', '/v1/brains/yt/entries', {
      type: 'attempt',
      title: 'Plain text emails',
      content: 'Tried plain text; no change.',
      sessionId: ids.open,
    })
    w.advance(60_000)
    // A step of Factory, through a short key with its reference stamped: closed without a summary.
    const short = (
      await w.call(factory.key, 'POST', '/v1/keys/short', {
        writeBrain: 'yt',
        ref: 'run r_77, step 3',
        agent: 'narrator',
        ttlMinutes: 30,
      })
    ).body.key as { id: string; secret: string }
    const s3 = await w.call(factory.key, 'POST', '/v1/brains/yt/sessions', { forKey: short.id })
    ids.factory = (s3.body.session as { id: string }).id
    await w.call(short.secret, 'POST', '/v1/brains/yt/entries', {
      type: 'step',
      title: 'Narrated the intro',
      content: 'Took 3 takes.',
    })
    await w.call(factory.key, 'POST', `/v1/sessions/${ids.factory}/end`)
  })
  after(async () => w.close())

  it('lists newest first with client, author, entries and summary, and where live news starts', async () => {
    const r = await list(eric.key)
    assert.equal(r.status, 200, JSON.stringify(r.body))
    assert.deepEqual(
      r.body.items.map((s) => s.id),
      [ids.factory, ids.open, ids.closed],
    )
    assert.equal(r.body.total, 3)
    const closed = r.body.items.find((s) => s.id === ids.closed) as Item
    assert.equal(closed.client, 'Claude Code')
    assert.deepEqual(closed.author, { id: eric.id, name: 'Eric' })
    assert.equal(closed.entries, 2, 'the summary is not counted as work')
    assert.equal(closed.summary, 'Short intros keep viewers past 30 seconds.')
    assert.equal(closed.status, 'closed')
    assert.equal(closed.day, null)
    const step = r.body.items.find((s) => s.id === ids.factory) as Item
    assert.equal(step.client, 'narrator')
    assert.equal(step.ref, 'run r_77, step 3')
    assert.equal(step.status, 'closed_no_summary')
    assert.equal(step.summary, null)
    assert.match(r.body.liveFrom, /^\d+$/)
    // Ana's token is named by the program that used it last (its user agent).
    const anas = (r.body.items.find((s) => s.id === ids.open) as Item).client as string
    assert.ok(anas)
    assert.deepEqual(r.body.facets?.clients.sort(), ['Claude Code', 'narrator', anas].sort())
    assert.deepEqual(r.body.facets?.authors.map((a) => a.name).sort(), ['Ana', 'Eric', 'RSC Factory'])
  })

  it('filters by status, client, author, reference, entry type, dates and uncompiled, and counts them', async () => {
    const only = async (q: string) => {
      const r = await list(eric.key, q)
      assert.equal(r.status, 200, `${q}: ${JSON.stringify(r.body)}`)
      assert.equal(r.body.total, r.body.items.length, `${q}: total`)
      return r.body.items.map((s) => s.id).sort()
    }
    assert.deepEqual(await only('status=open'), [ids.open])
    assert.deepEqual(await only('status=closed'), [ids.closed])
    assert.deepEqual(await only('status=closed_no_summary'), [ids.factory])
    assert.deepEqual(await only('client=Claude%20Code'), [ids.closed])
    assert.deepEqual(await only(`author=${ana.id}`), [ids.open])
    // A reference matches the session's own, or one stamped on its entries; part of it is enough.
    assert.deepEqual(await only('ref=r_77'), [ids.factory])
    assert.deepEqual(await only('ref=REPO'), [ids.open])
    // % and _ are themselves, not wildcards.
    assert.deepEqual(await only('ref=r%25'), [])
    assert.deepEqual(await only('ref=run_r'), [])
    assert.deepEqual(await only('type=attempt'), [ids.open])
    assert.deepEqual(await only('type=decision&client=Claude%20Code'), [ids.closed])
    // Days: a session counts on every day it was active.
    assert.deepEqual(await only('from=2026-10-29&to=2026-10-29'), [ids.closed, ids.factory, ids.open].sort())
    assert.deepEqual(await only('from=2026-10-30'), [])
    assert.deepEqual(await only('to=2026-10-28'), [])
    assert.deepEqual(await only('uncompiled=1'), [ids.closed, ids.factory, ids.open].sort())
    assert.deepEqual(await only('status=open&author=nobody'), [])
  })

  it('pages with the same filters, and facets come with the first page only', async () => {
    const first = await list(eric.key, 'limit=2')
    assert.equal(first.body.items.length, 2)
    assert.equal(first.body.total, 3)
    assert.ok(first.body.next)
    const second = await list(eric.key, `limit=2&cursor=${encodeURIComponent(first.body.next as string)}`)
    assert.deepEqual(
      second.body.items.map((s) => s.id),
      [ids.closed],
    )
    assert.equal(second.body.next, null)
    assert.equal(second.body.facets, undefined)
    const filtered = await list(eric.key, 'limit=1&status=closed_no_summary')
    assert.equal(filtered.body.next, null)
  })

  it('refuses filters that are not what they say, with how to proceed', async () => {
    for (const q of ['status=done', 'type=gossip', 'from=yesterday', 'uncompiled=maybe']) {
      const r = await list(eric.key, q)
      assert.equal(r.status, 400, q)
      assert.equal(r.body.error?.code, 'invalid_request', q)
    }
  })

  it('reads one session with the same fields; a stranger gets the same answer as for nothing', async () => {
    const one = await w.call(ana.key, 'GET', `/v1/sessions/${ids.closed}`)
    assert.equal(one.status, 200, one.text)
    const s = one.body.session as Item
    assert.equal(s.id, ids.closed)
    assert.equal(s.client, 'Claude Code')
    assert.equal(s.entries, 2)
    assert.equal(s.summary, 'Short intros keep viewers past 30 seconds.')
    const stranger = await w.call(outsider.key, 'GET', `/v1/sessions/${ids.closed}`)
    const nothing = await w.call(outsider.key, 'GET', '/v1/sessions/ses_nope')
    assert.equal(stranger.status, 404)
    assert.deepEqual(stranger.body, nothing.body)
    const brain = await list(outsider.key)
    assert.equal(brain.status, 404)
    assert.equal(brain.body.error?.code, 'brain_not_found')
  })
})
