// Forward-only migrations: every `NNNN_name.sql` in the migrations folder, and every step written in code
// below (what SQL cannot do, like redacting with the product's own rules), runs once, in order of its number,
// inside its own transaction, under an advisory lock so two processes never migrate at the same time. A
// database that already has a migration this code does not know is from a newer release: refuse.
import { readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { redact } from '../privacy/redact.ts'
import type { Db } from './db.ts'

const LOCK = 7_310_420_001 // any constant shared by every migrator of this product
const NAME = /^\d{4}_[a-z0-9_]+\.sql$/

export const MIGRATIONS_DIR = new URL('../../migrations/', import.meta.url).pathname

export class NewerDatabaseError extends Error {
  readonly unknown: string[]
  constructor(unknown: string[]) {
    super(
      `This database was migrated by a newer release (${unknown.join(', ')}). Install that release or newer.`,
    )
    this.unknown = unknown
  }
}

// Steps in code, numbered among the SQL files.
export type Step = { id: string; run: (db: Db) => Promise<void> }

// Review of PR23 (S1): key names and agents, app names and the clients stored from them were kept as given,
// and one may carry a pasted secret. They are redacted with the same rules as everything stored; what is
// written from now on is redacted on the way in.
async function redactStoredClients(db: Db): Promise<void> {
  const columns: Array<[string, string, number]> = [
    ['credentials', 'name', 80],
    ['credentials', 'agent', 80],
    ['credentials', 'last_client', 200],
    ['oauth_grants', 'client_name', 200],
    ['events', 'client', 200],
    ['sessions', 'client', 200],
    ['entries', 'client', 200],
  ]
  for (const [table, column, max] of columns) {
    const rows = await db.query<{ k: string; v: string }>(
      `SELECT ctid::text AS k, ${column} AS v FROM ${table} WHERE ${column} IS NOT NULL`,
    )
    for (const r of rows) {
      const clean = redact(r.v).text.slice(0, max)
      if (clean !== r.v)
        await db.query(`UPDATE ${table} SET ${column} = $2 WHERE ctid = $1::tid`, [r.k, clean])
    }
  }
}

export const STEPS: Step[] = [{ id: '0018_redact_clients', run: redactStoredClients }]

export async function migrationFiles(dir: string): Promise<string[]> {
  const names = (await readdir(dir)).filter((f) => NAME.test(f))
  return names.sort()
}

export async function migrate(db: Db, dir: string = MIGRATIONS_DIR): Promise<string[]> {
  const files = await migrationFiles(dir)
  const all: Step[] = [
    ...files.map((f) => ({
      id: f.slice(0, -4),
      run: async (tx: Db) => void (await tx.query(await readFile(join(dir, f), 'utf8'))),
    })),
    // Steps in code belong to this product's migrations only (a test folder of SQL files has none).
    ...(dir === MIGRATIONS_DIR ? STEPS : []),
  ].sort((a, b) => (a.id < b.id ? -1 : 1))
  const ids = all.map((x) => x.id)
  return db.tx(async (tx) => {
    await tx.query('SELECT pg_advisory_xact_lock($1)', [LOCK])
    await tx.query(
      'CREATE TABLE IF NOT EXISTS schema_migrations (id text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())',
    )
    const done = new Set(
      (await tx.query<{ id: string }>('SELECT id FROM schema_migrations')).map((r) => r.id),
    )
    const unknown = [...done].filter((id) => !ids.includes(id)).sort()
    if (unknown.length > 0) throw new NewerDatabaseError(unknown)
    const applied: string[] = []
    for (const step of all) {
      if (done.has(step.id)) continue
      await step.run(tx)
      await tx.query('INSERT INTO schema_migrations (id) VALUES ($1)', [step.id])
      applied.push(step.id)
    }
    return applied
  })
}
