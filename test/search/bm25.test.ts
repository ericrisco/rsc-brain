// Spec v0.6 «Búsqueda», CA12, CA13, CA15: with pg_search installed, results are ranked by BM25 — a rare word
// counts more than a common one repeated, and a word in the title more than the same word in the body; without
// it, search keeps its own ranking and never fails; on every database a superseded page goes after the page
// that replaced it. Run on the three databases (RSC_BRAIN_PG_EXTENSIONS, see test/helpers/pg.ts).
import assert from 'node:assert/strict'
import { after, before, describe, it } from 'node:test'
import { ensureSearchIndexes, forgetSearchFeatures, searchFeatures } from '../../src/db/extensions.ts'
import { skipPg } from '../helpers/pg.ts'
import { type World, world } from '../helpers/world.ts'

type Hit = { kind: string; address?: string; title: string; why: string }

describe('search ranks by BM25 when pg_search is there (v0.6)', { skip: skipPg }, () => {
  let w: World
  let eric: { id: string; key: string }
  let web: string
  let bm25 = false

  const page = async (address: string, title: string, body: string, summary = '') => {
    const r = await w.callWeb(web, 'POST', '/v1/brains/rk/wiki/changes', {
      op: 'create',
      address,
      type: 'topic',
      title,
      summary,
      body,
    })
    assert.equal(r.status, 201, r.text)
    // Each page newer than the last: on equal scores the newest goes first, so order alone proves nothing.
    w.advance(60_000)
  }
  const find = async (q: string, extra = '') => {
    const r = await w.call(
      eric.key,
      'GET',
      `/v1/search?brains=rk&in=pages&q=${encodeURIComponent(q)}${extra}`,
    )
    assert.equal(r.status, 200, r.text)
    return (r.body.items as Hit[]).map((h) => h.address)
  }

  before(async () => {
    w = await world()
    eric = await w.person('Eric')
    await w.call(eric.key, 'POST', '/v1/brains', { slug: 'rk', purpose: 'Ranking.' })
    web = await w.web(eric.id)
    // "graph" is everywhere; "Louvain" is named once, in one page, written before the others.
    await page('wiki/communities', 'Communities', 'Groups of pages are found with Louvain, then coloured.')
    await page(
      'graph/layout',
      'Graph layout',
      'The graph is drawn as a graph: graph nodes, graph edges, graph labels, a graph legend and graph zoom. '.repeat(
        4,
      ),
    )
    for (const n of ['one', 'two', 'three', 'four', 'five'])
      await page(`graph/notes-${n}`, `Graph note ${n}`, `A note about the graph, number ${n}.`)
    // The same word, once in the title and once in the body, in texts of the same length.
    await page('audience/first', 'Retention', 'How long people stay with a video before leaving it.')
    await page('audience/second', 'Watch', 'How long people stay with a retention video before leaving.')
    forgetSearchFeatures(w.db)
    bm25 = (await searchFeatures(w.db)).bm25
  })
  after(async () => w.close())

  it('CA12: a rare word wins over a common one repeated', async (t) => {
    if (!bm25) return t.skip('pg_search is not installed in this database')
    const got = await find('louvain graph')
    assert.equal(got[0], 'wiki/communities', got.join(', '))
  })

  it('CA12: a word in the title wins over the same word in the body', async (t) => {
    if (!bm25) return t.skip('pg_search is not installed in this database')
    const got = await find('retention')
    assert.deepEqual(got.slice(0, 2), ['audience/first', 'audience/second'])
  })

  it('CA13: every database answers, with words in any accent and form, phrases and exclusions as before', async () => {
    assert.ok((await find('louvain')).includes('wiki/communities'))
    // Without accents and in another form: "lóuvain", "videos".
    assert.ok((await find('lóuvain')).includes('wiki/communities'))
    assert.ok((await find('videos')).includes('audience/first'))
    // A phrase matches only its words in order; an excluded word leaves its pages out.
    assert.deepEqual(await find('"graph legend"'), ['graph/layout'])
    const without = await find('graph -louvain')
    assert.ok(without.length > 0 && !without.includes('wiki/communities'))
  })

  it('CA15: a superseded page never goes before the page that replaced it', async () => {
    await page('graph/old-colours', 'Louvain colours, Louvain groups, Louvain', 'Louvain Louvain Louvain.')
    await page('graph/colours', 'Colours', 'Each group has a colour; groups come from Louvain.')
    const r = await w.callWeb(web, 'POST', '/v1/brains/rk/wiki/changes', {
      op: 'status',
      address: 'graph/old-colours',
      status: 'superseded',
      supersededBy: 'graph/colours',
      reason: 'Replaced.',
    })
    assert.equal(r.status < 300, true, r.text)
    const got = await find('louvain', '&include=superseded')
    assert.ok(got.indexOf('graph/colours') < got.indexOf('graph/old-colours'), got.join(', '))
  })

  it('search still answers when the BM25 index is gone since it was found', async (t) => {
    if (!bm25) return t.skip('pg_search is not installed in this database')
    await w.db.query('DROP INDEX pages_bm25')
    try {
      assert.ok((await find('louvain graph')).includes('wiki/communities'))
    } finally {
      await ensureSearchIndexes(w.db)
      forgetSearchFeatures(w.db)
    }
  })
})
