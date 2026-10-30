// Spec B6 «Wiki» (PR19, plan §3.5 G9 in its minimal form): the pages of a wiki by pages, filtered, with how
// many links go in and out — the list behind the `[[` autocomplete of the curator's editor (the full form,
// with link kinds and sorting, comes with the graph, PR22). And what the web needs to show the wiki to a
// person: who wrote each revision and each line of the log by name, the log filtered by kind and page, and
// the tags of the map's pages (the Map screen filters by them). Same permissions as every reading of the
// wiki: any member reads; anyone else is told the brain does not exist.
import assert from 'node:assert/strict'
import { after, before, describe, it } from 'node:test'
import { skipPg } from '../helpers/pg.ts'
import { type World, world } from '../helpers/world.ts'

type Item = {
  address: string
  title: string
  type: string
  status: string
  tags: string[]
  in: number
  out: number
  updatedAt: string
}
type Listing = { items: Item[]; next: string | null; total: number }

describe('the pages of a wiki (G9, minimal), names and filters for the web', { skip: skipPg }, () => {
  let w: World
  let eric: { id: string; key: string }
  let rita: { id: string; key: string }
  let stranger: { id: string; key: string }
  let web: string

  const change = async (op: Record<string, unknown>) => {
    const r = await w.callWeb(web, 'POST', '/v1/brains/wk/wiki/changes', { reason: 'Seeding.', ...op })
    assert.equal(r.status, 201, r.text)
  }
  const create = (address: string, extra: Record<string, unknown> = {}) =>
    change({
      op: 'create',
      address,
      type: 'topic',
      title: `Page ${address}`,
      summary: `About ${address}.`,
      body: `Text of ${address}.`,
      tags: [],
      sources: [],
      ...extra,
    })
  const list = async (query = '', key = eric.key) => {
    const r = await w.call(key, 'GET', `/v1/brains/wk/wiki/pages${query}`)
    assert.equal(r.status, 200, r.text)
    return r.body as unknown as Listing
  }

  before(async () => {
    w = await world()
    eric = await w.person('Eric')
    rita = await w.person('Rita')
    stranger = await w.person('Stranger')
    await w.call(eric.key, 'POST', '/v1/brains', { slug: 'wk', purpose: 'Pages.' })
    await w.member('wk', rita.id, 'reader')
    web = await w.web(eric.id)
    await create('audience/retention', {
      title: 'Retention 100%_first',
      tags: ['metric', 'q4'],
      body: 'Read [[audience/intros]] and [[product/pricing]].',
    })
    await create('audience/intros', { type: 'guide', tags: ['q4'] })
    await create('product/pricing', { type: 'decision', body: 'See [[audience/retention]].' })
    await create('product/old-pricing', { type: 'decision' })
    await change({ op: 'link', address: 'product/pricing', kind: 'related', to: 'audience/intros' })
    await change({ op: 'status', address: 'product/old-pricing', status: 'retired' })
    await change({ op: 'edit', address: 'audience/intros', baseRevision: 1, body: 'Shorter.' })
  })
  after(async () => w.close())

  it('lists every page in address order with its type, status, tags and link counts', async () => {
    const all = await list()
    assert.equal(all.total, 4)
    assert.equal(all.next, null)
    assert.deepEqual(
      all.items.map((i) => i.address),
      ['audience/intros', 'audience/retention', 'product/old-pricing', 'product/pricing'],
    )
    const retention = all.items[1] as Item
    assert.deepEqual(
      { ...retention, updatedAt: typeof retention.updatedAt },
      {
        address: 'audience/retention',
        title: 'Retention 100%_first',
        type: 'topic',
        status: 'current',
        tags: ['metric', 'q4'],
        in: 1,
        out: 2,
        updatedAt: 'string',
      },
    )
    // Mentioned by retention, linked by pricing: two pages link in.
    assert.equal(all.items[0]?.in, 2)
    assert.equal(all.items[2]?.status, 'retired')
  })

  it('goes by pages with a cursor, the total counting them all', async () => {
    const first = await list('?limit=3')
    assert.equal(first.items.length, 3)
    assert.equal(first.total, 4)
    assert.ok(first.next)
    const rest = await list(`?limit=3&cursor=${encodeURIComponent(first.next ?? '')}`)
    assert.deepEqual(
      rest.items.map((i) => i.address),
      ['product/pricing'],
    )
    assert.equal(rest.next, null)
  })

  it('finds by part of the address or the title, in any case, with % and _ taken literally', async () => {
    assert.deepEqual(
      (await list('?q=RETEN')).items.map((i) => i.address),
      ['audience/retention'],
    )
    assert.deepEqual(
      (await list('?q=intr')).items.map((i) => i.address),
      ['audience/intros'],
    )
    assert.deepEqual(
      (await list(`?q=${encodeURIComponent('100%_')}`)).items.map((i) => i.address),
      ['audience/retention'],
    )
    assert.equal((await list(`?q=${encodeURIComponent('%')}`)).total, 1)
  })

  it('filters by type, status, tag and the first part of the address', async () => {
    assert.deepEqual(
      (await list('?type=decision')).items.map((i) => i.address),
      ['product/old-pricing', 'product/pricing'],
    )
    assert.deepEqual(
      (await list('?status=retired')).items.map((i) => i.address),
      ['product/old-pricing'],
    )
    assert.deepEqual(
      (await list('?tag=q4')).items.map((i) => i.address),
      ['audience/intros', 'audience/retention'],
    )
    assert.deepEqual(
      (await list('?prefix=product')).items.map((i) => i.address),
      ['product/old-pricing', 'product/pricing'],
    )
    // "audience" is a prefix of an address part, not of a word: "aud" names no group.
    assert.equal((await list('?prefix=aud')).total, 0)
  })

  it('refuses a type or a status that does not exist, saying which exist', async () => {
    const r = await w.call(eric.key, 'GET', '/v1/brains/wk/wiki/pages?type=essay')
    assert.equal(r.status, 400)
    assert.equal(r.body.error?.code, 'invalid_request')
    assert.match(String(r.body.error?.message), /topic/)
    const s = await w.call(eric.key, 'GET', '/v1/brains/wk/wiki/pages?status=gone')
    assert.equal(s.status, 400)
  })

  it('any member reads it; anyone else hears the brain does not exist', async () => {
    assert.equal((await list('', rita.key)).total, 4)
    const no = await w.call(stranger.key, 'GET', '/v1/brains/wk/wiki/pages')
    const none = await w.call(stranger.key, 'GET', '/v1/brains/nowhere/wiki/pages')
    assert.deepEqual([no.status, no.body.error?.code], [404, 'brain_not_found'])
    assert.deepEqual(no.body, none.body)
  })

  it('names who wrote each revision and each line of the log', async () => {
    const h = await w.call(eric.key, 'GET', '/v1/brains/wk/pages/audience/intros?history=1')
    const history = h.body.history as Array<{ revision: number; authorId: string; authorName: string }>
    assert.deepEqual(
      history.map((x) => [x.revision, x.authorId, x.authorName]),
      [
        [1, eric.id, 'Eric'],
        [2, eric.id, 'Eric'],
      ],
    )
    const log = (await w.call(eric.key, 'GET', '/v1/brains/wk/wiki/log')).body.items as Array<{
      actorName: string
    }>
    assert.ok(log.length > 0)
    for (const l of log) assert.equal(l.actorName, 'Eric')
  })

  it('filters the log by kind and by page', async () => {
    const all = (await w.call(eric.key, 'GET', '/v1/brains/wk/wiki/log')).body as { total: number }
    const byPage = (await w.call(eric.key, 'GET', '/v1/brains/wk/wiki/log?page=audience/intros')).body as {
      items: Array<{ pages: string[] }>
      total: number
    }
    assert.ok(byPage.total >= 2 && byPage.total < all.total, `${byPage.total} of ${all.total}`)
    for (const l of byPage.items) assert.ok(l.pages.includes('audience/intros'))
    const direct = (await w.call(eric.key, 'GET', '/v1/brains/wk/wiki/log?kind=direct')).body as {
      total: number
    }
    assert.equal(direct.total, all.total)
    const reverts = (await w.call(eric.key, 'GET', '/v1/brains/wk/wiki/log?kind=revert')).body as {
      total: number
    }
    assert.equal(reverts.total, 0)
    const bad = await w.call(eric.key, 'GET', '/v1/brains/wk/wiki/log?kind=other')
    assert.equal(bad.status, 400)
  })

  it('the map gives the tags of each page', async () => {
    const map = (await w.call(eric.key, 'GET', '/v1/brains/wk/wiki/map')).body as {
      groups: Array<{ pages: Array<{ address: string; tags: string[] }> }>
    }
    const pages = map.groups.flatMap((g) => g.pages)
    assert.deepEqual(pages.find((p) => p.address === 'audience/retention')?.tags, ['metric', 'q4'])
  })
})
