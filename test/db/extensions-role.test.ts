// Spec v0.6 «Búsqueda» as it runs in production: the extensions created by a superuser, rsc-brain connected as a
// plain role that owns its database. Migrating makes the BM25 indexes then, with no grant beyond what creating the
// extensions gives; and when making them fails (here an event trigger of the superuser refuses them, as an
// unexpected failure would), the migrations still commit, the failure is logged, and search keeps its own ranking —
// pg_search is optional (review of feat/v06, finding 2).
import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { after, before, describe, it } from 'node:test'
import pg from 'pg'
import { makeLog } from '../../src/core/log.ts'
import { openPool, type Pool } from '../../src/db/db.ts'
import { searchFeatures } from '../../src/db/extensions.ts'
import { migrate } from '../../src/db/migrate.ts'
import { knownMigrations } from '../../src/ops/backup/backup.ts'
import { PG_URL, skipPg } from '../helpers/pg.ts'

const tag = randomBytes(4).toString('hex')

async function asAdmin<T>(db: string, fn: (c: pg.Client) => Promise<T>): Promise<T> {
  const u = new URL(PG_URL as string)
  u.pathname = `/${db}`
  const c = new pg.Client({ connectionString: u.toString() })
  await c.connect()
  try {
    return await fn(c)
  } finally {
    await c.end()
  }
}

describe('a plain app role, extensions made by a superuser (v0.6)', { skip: skipPg }, () => {
  let available = false
  const made: string[] = []

  // A database owned by a new role that is no superuser, with the extensions made in it by the superuser of the
  // tests; `refuse`: creating a BM25 index fails there. Returns a pool connected as that role.
  async function appDatabase(refuse: boolean): Promise<Pool> {
    const n = `rscb_app_${tag}_${made.length}`
    made.push(n)
    await asAdmin('postgres', async (c) => {
      await c.query(`CREATE ROLE ${n} LOGIN PASSWORD '${n}' NOSUPERUSER NOCREATEDB NOCREATEROLE`)
      await c.query(`CREATE DATABASE ${n} OWNER ${n} TEMPLATE template0`)
    })
    await asAdmin(n, async (c) => {
      await c.query('CREATE EXTENSION IF NOT EXISTS pg_search CASCADE')
      if (refuse) {
        await c.query(`CREATE FUNCTION refuse_bm25() RETURNS event_trigger LANGUAGE plpgsql AS $$
          BEGIN
            IF EXISTS (SELECT 1 FROM pg_event_trigger_ddl_commands() WHERE object_identity LIKE '%_bm25') THEN
              RAISE EXCEPTION 'no BM25 index here' USING ERRCODE = '42501';
            END IF;
          END $$`)
        await c.query(
          "CREATE EVENT TRIGGER refuse_bm25 ON ddl_command_end WHEN TAG IN ('CREATE INDEX') EXECUTE FUNCTION refuse_bm25()",
        )
      }
    })
    const u = new URL(PG_URL as string)
    u.username = n
    u.password = n
    u.pathname = `/${n}`
    return openPool(u.toString(), { max: 2 })
  }

  before(async () => {
    available = await asAdmin('postgres', async (c) =>
      Boolean((await c.query("SELECT 1 FROM pg_available_extensions WHERE name = 'pg_search'")).rowCount),
    )
  })
  after(async () => {
    await asAdmin('postgres', async (c) => {
      for (const n of made) {
        await c.query(`DROP DATABASE IF EXISTS ${n} WITH (FORCE)`)
        await c.query(`DROP ROLE IF EXISTS ${n}`)
      }
    })
  })

  it('the BM25 indexes are made by the app role itself', async (t) => {
    if (!available) return t.skip('pg_search is not available on this server')
    const db = await appDatabase(false)
    try {
      await migrate(db)
      const idx = await db.one<{ p: string | null; e: string | null }>(
        "SELECT to_regclass('pages_bm25')::text AS p, to_regclass('entries_bm25')::text AS e",
      )
      assert.ok(idx?.p && idx?.e)
      assert.equal((await searchFeatures(db)).bm25, true)
    } finally {
      await db.close()
    }
  })

  it('when they cannot be made: the migrations commit, the failure is logged, search uses its own ranking', async (t) => {
    if (!available) return t.skip('pg_search is not available on this server')
    const db = await appDatabase(true)
    const lines: string[] = []
    try {
      await migrate(db, undefined, { log: makeLog((l) => lines.push(l)) })
      const ids = (await db.query<{ id: string }>('SELECT id FROM schema_migrations ORDER BY id')).map(
        (r) => r.id,
      )
      assert.deepEqual(ids, await knownMigrations())
      assert.equal((await db.one("SELECT to_regclass('pages_bm25')::text AS p"))?.p, null)
      assert.ok(
        lines.some((l) => /"event":"search_index_failed"/.test(l) && /"code":"42501"/.test(l)),
        lines.join('\n'),
      )
      assert.equal((await searchFeatures(db)).bm25, false)
    } finally {
      await db.close()
    }
  })
})
