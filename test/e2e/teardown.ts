// Drops the database of the e2e server after the run (Playwright global teardown), so a stopped server
// leaves nothing behind on the PostgreSQL in RSC_BRAIN_PG_URL.
import { existsSync, readFileSync, rmSync } from 'node:fs'
import pg from 'pg'

export const DB_FILE = new URL('../../test-results/e2e-database', import.meta.url).pathname

export default async function teardown(): Promise<void> {
  if (!existsSync(DB_FILE) || !process.env.RSC_BRAIN_PG_URL) return
  const name = readFileSync(DB_FILE, 'utf8').trim()
  if (!/^brain_t_[0-9a-f]+$/.test(name)) return
  const c = new pg.Client({ connectionString: process.env.RSC_BRAIN_PG_URL })
  await c.connect()
  try {
    await c.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`)
  } finally {
    await c.end()
  }
  rmSync(DB_FILE, { force: true })
}
