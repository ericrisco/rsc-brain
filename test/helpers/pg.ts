// Real-PostgreSQL tests: each caller gets its own fresh database on the server in RSC_BRAIN_PG_URL,
// dropped when it is done. Without that variable the PostgreSQL tests are skipped (as in CI).
import { randomBytes } from 'node:crypto'
import pg from 'pg'
import { openPool, type Pool } from '../../src/db/db.ts'

export const PG_URL = process.env.RSC_BRAIN_PG_URL
export const skipPg = !PG_URL

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
    await admin.query(`CREATE DATABASE ${name}`)
  } finally {
    await admin.end()
  }
  const url = withDatabase(PG_URL, name)
  const db = openPool(url, { max: 25 })
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
