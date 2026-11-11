// Real-PostgreSQL tests: each caller gets its own fresh database on the server in RSC_BRAIN_PG_URL,
// dropped when it is done. Without that variable the PostgreSQL tests are skipped (as in CI).
import { randomBytes } from 'node:crypto'
import pg from 'pg'
import { openPool, type Pool } from '../../src/db/db.ts'
import { limitSearchFeatures } from '../../src/db/extensions.ts'

export const PG_URL = process.env.RSC_BRAIN_PG_URL
export const skipPg = !PG_URL

// Spec v0.6: the same tests run on three databases. RSC_BRAIN_PG_EXTENSIONS lists the optional extensions each
// fresh database gets ("none", "pg_search", "pg_search,vector"), created as the superuser of the tests the way an
// administrator would; unset, a database is whatever the server's template gives. RSC_BRAIN_TEST_SEARCH=bm25
// tells the app not to use pgvector even when it is there (pg_search 0.26 cannot be installed without it).
export const PG_EXTENSIONS = process.env.RSC_BRAIN_PG_EXTENSIONS
export const TEST_SEARCH = process.env.RSC_BRAIN_TEST_SEARCH

export type TestDb = { url: string; db: Pool; drop(): Promise<void> }

function withDatabase(url: string, name: string): string {
  const u = new URL(url)
  u.pathname = `/${name}`
  return u.toString()
}

export async function freshDatabase(): Promise<TestDb> {
  if (!PG_URL) throw new Error('RSC_BRAIN_PG_URL is not set')
  const name = `brain_t_${randomBytes(6).toString('hex')}`
  const admin = new pg.Client({ connectionString: PG_URL })
  await admin.connect()
  try {
    await admin.query(`CREATE DATABASE ${name}${PG_EXTENSIONS ? ' TEMPLATE template0' : ''}`)
  } finally {
    await admin.end()
  }
  const url = withDatabase(PG_URL, name)
  const wanted = (PG_EXTENSIONS ?? '').split(',').filter((x) => x && x !== 'none')
  if (wanted.length) {
    const c = new pg.Client({ connectionString: url })
    await c.connect()
    try {
      for (const x of wanted) await c.query(`CREATE EXTENSION IF NOT EXISTS ${x} CASCADE`)
    } finally {
      await c.end()
    }
  }
  // Small: the test files run side by side (one per processor), each with its own pool, and together they
  // must stay well under PostgreSQL's max_connections (100 by default), with room for anything else.
  const db = openPool(url, { max: 4 })
  if (TEST_SEARCH === 'bm25') limitSearchFeatures(db, { vector: false })
  return {
    url,
    db,
    async drop() {
      await db.close()
      const a = new pg.Client({ connectionString: PG_URL })
      await a.connect()
      try {
        await a.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`)
      } finally {
        await a.end()
      }
    },
  }
}
