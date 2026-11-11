// Spec v0.6 «Búsqueda»: pg_search and pgvector are optional. With pg_search installed, migrating makes the BM25
// index of pages and of entries; without it, nothing is made and search keeps its own ranking. Running it again
// does nothing, and an extension added later gets its indexes on the next migration.
import assert from 'node:assert/strict'
import { after, before, describe, it } from 'node:test'
import { ensureSearchIndexes, forgetSearchFeatures, searchFeatures } from '../../src/db/extensions.ts'
import { migrate } from '../../src/db/migrate.ts'
import { freshDatabase, skipPg, TEST_SEARCH, type TestDb } from '../helpers/pg.ts'

describe('optional search extensions', { skip: skipPg }, () => {
  let t: TestDb
  let has: { pg_search: boolean; vector: boolean }
  before(async () => {
    t = await freshDatabase()
    await migrate(t.db)
    const rows = await t.db.query<{ extname: string }>('SELECT extname FROM pg_extension')
    const names = new Set(rows.map((r) => r.extname))
    has = { pg_search: names.has('pg_search'), vector: names.has('vector') }
  })
  after(async () => t.drop())

  it('makes the BM25 indexes exactly when pg_search is installed', async () => {
    const idx = await t.db.one<{ p: string | null; e: string | null }>(
      "SELECT to_regclass('pages_bm25')::text AS p, to_regclass('entries_bm25')::text AS e",
    )
    assert.equal(Boolean(idx?.p), has.pg_search)
    assert.equal(Boolean(idx?.e), has.pg_search)
    // A second time there is nothing to do.
    assert.deepEqual(await ensureSearchIndexes(t.db), [])
  })

  it('says what search can use', async () => {
    forgetSearchFeatures(t.db)
    const f = await searchFeatures(t.db)
    assert.equal(f.bm25, has.pg_search)
    assert.equal(f.vector, has.vector && TEST_SEARCH !== 'bm25')
  })

  it('an index dropped is made again by the next migration', { skip: false }, async (c) => {
    if (!has.pg_search) return c.skip('pg_search is not installed in this database')
    await t.db.query('DROP INDEX pages_bm25')
    await migrate(t.db)
    const idx = await t.db.one<{ p: string | null }>("SELECT to_regclass('pages_bm25')::text AS p")
    assert.ok(idx?.p)
  })
})
