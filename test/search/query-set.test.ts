// Spec v0.6 «How it proves it»: a fixed set of searches with the order each must give, kept in the repository
// (test/fixtures/search-queries.json). With pg_search the first results are checked; on every database the
// order found is written out (node --test diagnostics), so a run shows how the ranking compares.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { after, before, describe, it } from 'node:test'
import { forgetSearchFeatures, searchFeatures } from '../../src/db/extensions.ts'
import { skipPg } from '../helpers/pg.ts'
import { type World, world } from '../helpers/world.ts'

type Fixture = {
  pages: { address: string; title: string; summary: string; body: string }[]
  queries: { q: string; first: string[]; why: string }[]
}
const SET = JSON.parse(
  readFileSync(new URL('../fixtures/search-queries.json', import.meta.url), 'utf8'),
) as Fixture

describe('the fixed set of searches (v0.6)', { skip: skipPg }, () => {
  let w: World
  let eric: { id: string; key: string }
  let bm25 = false

  before(async () => {
    w = await world()
    eric = await w.person('Eric')
    await w.call(eric.key, 'POST', '/v1/brains', { slug: 'set', purpose: 'The fixed set.' })
    const web = await w.web(eric.id)
    for (const p of SET.pages) {
      const r = await w.callWeb(web, 'POST', '/v1/brains/set/wiki/changes', {
        op: 'create',
        type: 'topic',
        ...p,
      })
      assert.equal(r.status, 201, r.text)
      // In the order of the file, each newer than the last.
      w.advance(60_000)
    }
    forgetSearchFeatures(w.db)
    bm25 = (await searchFeatures(w.db)).bm25
  })
  after(async () => w.close())

  for (const x of SET.queries) {
    it(`"${x.q}": ${x.why}`, async (t) => {
      const r = await w.call(eric.key, 'GET', `/v1/search?brains=set&in=pages&q=${encodeURIComponent(x.q)}`)
      assert.equal(r.status, 200, r.text)
      const got = (r.body.items as { address: string }[]).map((h) => h.address)
      t.diagnostic(`${bm25 ? 'bm25' : 'words'} | ${x.q} | ${got.slice(0, 3).join(', ')}`)
      if (bm25) assert.deepEqual(got.slice(0, x.first.length), x.first, got.join(', '))
      else assert.ok(got.length > 0)
    })
  }
})
