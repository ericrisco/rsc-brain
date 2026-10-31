// Spec B6 «Graph» (PR22, plan §3.5 G9 full and G10, T031), on PostgreSQL: the graph of a wiki leaves retired
// pages out and marks superseded ones; above 2 000 pages it comes as groups, each opened with `prefix`; a big
// answer travels compressed. The list of pages sorts by any column and filters by link kind, as the graph
// does. Same permissions as every reading of the wiki: any member reads; anyone else is told the brain does
// not exist.
import assert from 'node:assert/strict'
import { after, before, describe, it } from 'node:test'
import { GRAPH_KINDS } from '../../src/domain/wiki/graph.ts'
import { skipPg } from '../helpers/pg.ts'
import { type World, world } from '../helpers/world.ts'

type Node = [string, string, string, string, string[]]
type Graph = {
  mode: string
  prefix: string | null
  total: number
  kinds: string[]
  nodes: Node[]
  edges: [number, number, number][]
  across: [number, string, number][]
  groups: { prefix: string; count: number; types: Record<string, number> }[]
  groupEdges: [string, string, number][]
}
type Item = { address: string; title: string; type: string; status: string; in: number; out: number }
type Listing = { items: Item[]; next: string | null; total: number }

describe('the graph of a wiki (G10) and its list (G9)', { skip: skipPg }, () => {
  let w: World
  let eric: { id: string; key: string }
  let rita: { id: string; key: string }
  let stranger: { id: string; key: string }
  let web: string

  const change = async (op: Record<string, unknown>) => {
    const r = await w.callWeb(web, 'POST', '/v1/brains/gr/wiki/changes', { reason: 'Seeding.', ...op })
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
  const graph = async (query = '', key = eric.key, slug = 'gr') => {
    const r = await w.call(key, 'GET', `/v1/brains/${slug}/wiki/graph${query}`)
    assert.equal(r.status, 200, r.text)
    return r.body as unknown as Graph
  }
  const list = async (query = '', slug = 'gr') => {
    const r = await w.call(eric.key, 'GET', `/v1/brains/${slug}/wiki/pages${query}`)
    assert.equal(r.status, 200, r.text)
    return r.body as unknown as Listing
  }
  const addresses = (g: Graph) => g.nodes.map((n) => n[0])
  const edgesOf = (g: Graph) =>
    g.edges.map(([i, j, k]) => `${g.nodes[i]?.[0]} ${g.kinds[k]} ${g.nodes[j]?.[0]}`)

  before(async () => {
    w = await world()
    eric = await w.person('Eric')
    rita = await w.person('Rita')
    stranger = await w.person('Stranger')
    await w.call(eric.key, 'POST', '/v1/brains', { slug: 'gr', purpose: 'Graph.' })
    await w.member('gr', rita.id, 'reader')
    web = await w.web(eric.id)
    await create('audience/retention', {
      tags: ['metric'],
      body: 'See [[audience/intros]] and [[nowhere/x]].',
    })
    await create('audience/intros', { type: 'guide' })
    await create('product/pricing', { type: 'decision', body: 'Read [[audience/old-name]].' })
    await create('product/old-pricing', { type: 'decision' })
    await create('product/gone', { body: 'Mentions [[audience/retention]].' })
    await change({ op: 'link', address: 'product/pricing', kind: 'depends-on', to: 'audience/retention' })
    await change({ op: 'link', address: 'product/old-pricing', kind: 'related', to: 'product/gone' })
    await change({
      op: 'status',
      address: 'product/old-pricing',
      status: 'superseded',
      supersededBy: 'product/pricing',
    })
    await change({ op: 'status', address: 'product/gone', status: 'retired' })
    // An old address still leads to its page: the mention of "audience/old-name" lands on intros.
    await change({ op: 'move', address: 'audience/intros', to: 'audience/old-name' })
    await change({ op: 'move', address: 'audience/old-name', to: 'audience/intros' })
  })
  after(async () => w.close())

  it('draws every page but the retired ones, superseded ones with their status, links by kind', async () => {
    const g = await graph()
    assert.equal(g.mode, 'pages')
    assert.equal(g.total, 4)
    assert.deepEqual(g.kinds, [...GRAPH_KINDS])
    assert.deepEqual(addresses(g), [
      'audience/intros',
      'audience/retention',
      'product/old-pricing',
      'product/pricing',
    ])
    assert.equal(g.nodes[2]?.[3], 'superseded')
    assert.deepEqual(g.nodes[1], [
      'audience/retention',
      'Page audience/retention',
      'topic',
      'current',
      ['metric'],
    ])
    assert.deepEqual(edgesOf(g).sort(), [
      'audience/retention mentions audience/intros',
      'product/pricing depends-on audience/retention',
      'product/pricing mentions audience/intros',
    ])
  })

  it('a reader reads it; someone outside is told the brain does not exist, as for a brain that does not', async () => {
    assert.equal((await graph('', rita.key)).total, 4)
    const out = await w.call(stranger.key, 'GET', '/v1/brains/gr/wiki/graph')
    const none = await w.call(stranger.key, 'GET', '/v1/brains/nope/wiki/graph')
    assert.deepEqual([out.status, out.body.error?.code], [none.status, none.body.error?.code])
    assert.equal(out.status, 404)
  })

  it('opens one group with prefix, and refuses a prefix that is not a first part of an address', async () => {
    const g = await graph('?prefix=product')
    assert.deepEqual([g.mode, g.prefix, g.total], ['pages', 'product', 2])
    assert.deepEqual(addresses(g), ['product/old-pricing', 'product/pricing'])
    // pricing links with audience twice (depends-on retention, mentions intros).
    assert.deepEqual(g.across, [[1, 'audience', 2]])
    assert.deepEqual(g.groups, [{ prefix: 'audience', count: 2, types: { guide: 1, topic: 1 } }])
    const bad = await w.call(eric.key, 'GET', '/v1/brains/gr/wiki/graph?prefix=a//b')
    assert.equal(bad.status, 400)
    assert.equal(bad.body.error?.code, 'invalid_request')
  })

  it('the list sorts by any column, both ways, and goes by pages in that order', async () => {
    const byIn = await list('?sort=-in')
    assert.equal(byIn.items[0]?.address, 'audience/intros')
    assert.equal(byIn.items[0]?.in, 2)
    const byTitle = await list('?sort=title&limit=2')
    assert.deepEqual(
      byTitle.items.map((i) => i.title),
      ['Page audience/intros', 'Page audience/retention'],
    )
    const rest = await list(`?sort=title&limit=2&cursor=${encodeURIComponent(byTitle.next ?? '')}`)
    assert.deepEqual(
      rest.items.map((i) => i.title),
      ['Page product/gone', 'Page product/old-pricing'],
    )
    const all = await list('?sort=-type')
    assert.equal(all.total, 5)
    assert.deepEqual(
      all.items.map((i) => i.type),
      ['topic', 'topic', 'guide', 'decision', 'decision'],
    )
    for (const s of ['out', '-out', 'updatedAt', '-updatedAt', 'address', '-address'])
      assert.equal((await list(`?sort=${s}`)).items.length, 5, s)
    const bad = await w.call(eric.key, 'GET', '/v1/brains/gr/wiki/pages?sort=size')
    assert.equal(bad.status, 400)
  })

  it('the list filters by link kind, either way, as the graph does', async () => {
    assert.deepEqual(
      (await list('?linkKind=depends-on')).items.map((i) => i.address),
      ['audience/retention', 'product/pricing'],
    )
    assert.equal((await list('?linkKind=contradicts')).total, 0)
    const bad = await w.call(eric.key, 'GET', '/v1/brains/gr/wiki/pages?linkKind=likes')
    assert.equal(bad.status, 400)
  })

  it('the list sorts by status, and shows several statuses at once (the graph screen hides retired pages)', async () => {
    const byStatus = await list('?sort=status')
    assert.deepEqual(
      byStatus.items.map((i) => i.status),
      ['current', 'current', 'current', 'retired', 'superseded'],
    )
    const drawn = await list('?status=current,stale,superseded')
    assert.equal(drawn.total, 4)
    assert.ok(drawn.items.every((i) => i.status !== 'retired'))
    const bad = await w.call(eric.key, 'GET', '/v1/brains/gr/wiki/pages?status=current,gone')
    assert.equal(bad.status, 400)
  })

  it('counts links in and out only between pages that exist and are not retired, as the graph draws them', async () => {
    const at = async (address: string) =>
      (await list(`?q=${encodeURIComponent(address)}`)).items.find((i) => i.address === address)
    // retention mentions intros and an address with no page: one link out.
    assert.equal((await at('audience/retention'))?.out, 1)
    // retention is linked by pricing and mentioned by the retired "gone": one link in.
    assert.equal((await at('audience/retention'))?.in, 1)
    // old-pricing links only to the retired "gone".
    assert.equal((await at('product/old-pricing'))?.out, 0)
  })

  it('a cursor of one order is refused in another', async () => {
    const byAddress = await list('?limit=2')
    const r = await w.call(eric.key, 'GET', `/v1/brains/gr/wiki/pages?sort=title&cursor=${byAddress.next}`)
    assert.equal(r.status, 400)
    const byTitle = await list('?sort=title&limit=2')
    const back = await w.call(eric.key, 'GET', `/v1/brains/gr/wiki/pages?cursor=${byTitle.next}`)
    assert.equal(back.status, 400)
  })

  it('the graph takes the filters of the list, and refuses what the list refuses', async () => {
    const g = await graph('?type=decision')
    assert.deepEqual(addresses(g), ['product/old-pricing', 'product/pricing'])
    for (const q of ['?linkKind=likes', '?type=page', '?status=gone', '?sort=title'])
      assert.equal((await w.call(eric.key, 'GET', `/v1/brains/gr/wiki/graph${q}`)).status, 400, q)
    // A group can be more than one part deep.
    assert.equal((await graph('?prefix=audience/intros')).total, 1)
  })

  it('reads the links of its own brain only', async () => {
    await w.call(eric.key, 'POST', '/v1/brains', { slug: 'twin', purpose: 'Same addresses.' })
    const twinWeb = web
    for (const address of ['audience/retention', 'audience/intros', 'product/pricing'])
      await w.callWeb(twinWeb, 'POST', '/v1/brains/twin/wiki/changes', {
        reason: 'Seeding.',
        op: 'create',
        address,
        type: 'topic',
        title: address,
        summary: '',
        body: '',
        tags: [],
        sources: [],
      })
    const g = await graph('', eric.key, 'twin')
    assert.equal(g.total, 3)
    assert.deepEqual(g.edges, [])
  })

  it('says it varies by encoding, and never compresses for a client that does not accept it', async () => {
    const key = { authorization: `Bearer ${eric.key}` }
    const r = await w.raw('GET', '/v1/brains/gr/wiki/graph', {
      headers: { ...key, 'accept-encoding': 'identity' },
    })
    assert.match(r.headers.get('vary') ?? '', /Accept-Encoding/i)
  })

  describe('above 2 000 pages', () => {
    before(async () => {
      await w.call(eric.key, 'POST', '/v1/brains', { slug: 'big', purpose: 'Many pages.' })
      const b = await w.db.one<{ id: string }>("SELECT id FROM brains WHERE slug = 'big'")
      // 2 004 pages in 12 areas, four of them retired (2 000 left: one more makes it groups).
      await w.db.query(
        `INSERT INTO pages (id, brain_id, address, type, title, status, created_at, updated_at)
         SELECT 'pg_big' || i, $1, 'area' || (i % 12) || '/page-' || i,
                CASE WHEN i % 5 = 0 THEN 'decision' ELSE 'topic' END, 'Page ' || i || ' ' || repeat('word ', 40),
                CASE WHEN i < 4 THEN 'retired' WHEN i % 50 = 0 THEN 'superseded' ELSE 'current' END, now(), now()
           FROM generate_series(0, 2004) i`,
        [b?.id],
      )
      await w.db.query(
        `INSERT INTO page_addresses (brain_id, address, page_id, created_at)
         SELECT brain_id, address, id, now() FROM pages WHERE brain_id = $1`,
        [b?.id],
      )
      await w.db.query(
        `INSERT INTO page_links (brain_id, from_page, kind, to_page)
         SELECT $1, 'pg_big' || i, 'related', 'pg_big' || ((i + 1) % 2005) FROM generate_series(0, 2004) i`,
        [b?.id],
      )
    })

    it('comes as groups by the first part of the address, retired pages not counted', async () => {
      const g = await graph('', eric.key, 'big')
      assert.equal(g.mode, 'groups')
      assert.equal(g.total, 2001)
      assert.equal(g.groups.length, 12)
      assert.equal(
        g.groups.reduce((n, x) => n + x.count, 0),
        2001,
      )
      assert.deepEqual(g.nodes, [])
      // Each page links to the next one, which is in the next area.
      assert.ok(g.groupEdges.length >= 11)
      const one = g.groups.find((x) => x.prefix === 'area8')
      const opened = await graph('?prefix=area8', eric.key, 'big')
      assert.equal(opened.mode, 'pages')
      assert.equal(opened.total, one?.count)
      assert.ok(opened.nodes.some((n) => n[3] === 'superseded'))
      assert.ok(opened.across.length > 0)
    })

    it('a big answer is compressed for a client that accepts it', async () => {
      const r = await w.raw('GET', '/v1/brains/big/wiki/graph?prefix=area3', {
        headers: { authorization: `Bearer ${eric.key}`, 'accept-encoding': 'gzip' },
      })
      assert.equal(r.status, 200)
      assert.equal(r.headers.get('content-encoding'), 'gzip')
      assert.equal((r.body as unknown as Graph).mode, 'pages')
      assert.match(r.headers.get('vary') ?? '', /Accept-Encoding/i)
      const small = await w.raw('GET', '/v1/brains/gr/wiki/graph', {
        headers: { authorization: `Bearer ${eric.key}`, 'accept-encoding': 'gzip' },
      })
      assert.equal(small.headers.get('content-encoding'), null)
      // Big, but the client does not take gzip, or refuses it with q=0: plain JSON.
      for (const accept of ['identity', 'gzip;q=0, br', 'deflate']) {
        const plain = await w.raw('GET', '/v1/brains/big/wiki/graph?prefix=area3', {
          headers: { authorization: `Bearer ${eric.key}`, 'accept-encoding': accept },
        })
        assert.equal(plain.headers.get('content-encoding'), null, accept)
        assert.equal((plain.body as unknown as Graph).mode, 'pages', accept)
      }
    })

    it('filters by link kind quickly on 5 000 pages', async () => {
      await w.call(eric.key, 'POST', '/v1/brains', { slug: 'kinds', purpose: 'Many links.' })
      const b = await w.db.one<{ id: string }>("SELECT id FROM brains WHERE slug = 'kinds'")
      await w.db.query(
        `INSERT INTO pages (id, brain_id, address, type, title, status, created_at, updated_at)
         SELECT 'pg_k' || i, $1, 'area' || (i % 12) || '/page-' || i, 'topic', 'Page ' || i, 'current', now(), now()
           FROM generate_series(0, 4999) i`,
        [b?.id],
      )
      await w.db.query(
        'INSERT INTO page_addresses SELECT brain_id, address, id, now() FROM pages WHERE brain_id = $1',
        [b?.id],
      )
      await w.db.query(
        `INSERT INTO page_links (brain_id, from_page, kind, to_page)
         SELECT $1, 'pg_k' || i, CASE WHEN i % 7 = 0 THEN 'depends-on' ELSE 'related' END, 'pg_k' || ((i * 7 + 3) % 5000)
           FROM generate_series(0, 4999) i WHERE (i * 7 + 3) % 5000 <> i`,
        [b?.id],
      )
      await w.db.query('ANALYZE')
      await list('?linkKind=depends-on&limit=200', 'kinds')
      const t = performance.now()
      const r = await list('?linkKind=depends-on&limit=200&sort=-in', 'kinds')
      const ms = performance.now() - t
      assert.ok(r.total > 1000)
      // Measured: 1.2 s before the rewrite, ~30 ms after; the bound leaves room for a slow machine.
      assert.ok(ms < 300, `${Math.round(ms)} ms`)
    })

    it('the list stays whole, by pages', async () => {
      const first = await list('?limit=200&sort=-in', 'big')
      assert.equal(first.total, 2005)
      assert.equal(first.items.length, 200)
      assert.ok(first.next)
    })
  })
})
