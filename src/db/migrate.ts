// Forward-only migrations: every `NNNN_name.sql` in the migrations folder, and every step written in code
// below (what SQL cannot do, like redacting with the product's own rules), runs once, in order of its number,
// inside its own transaction, under an advisory lock so two processes never migrate at the same time. A
// database that already has a migration this code does not know is from a newer release: refuse.
import { readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { mayHoldSecret, redact } from '../privacy/redact.ts'
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
// On a large installation it never holds a table in memory: SQL picks only the rows that may hold a secret,
// a thousand at a time in key order, and each change is written by
// key. It runs inside the migrator's one transaction, so an upgrade applies it whole or not at all; memory
// stays at one batch whatever the size of the table.
export const REDACT_BATCH = 1000
const STORED_CLIENTS: Array<{ table: string; key: string; start: string; column: string; max: number }> = [
  { table: 'credentials', key: 'id', start: '', column: 'name', max: 80 },
  { table: 'credentials', key: 'id', start: '', column: 'agent', max: 80 },
  { table: 'credentials', key: 'id', start: '', column: 'last_client', max: 200 },
  { table: 'oauth_clients', key: 'client_id', start: '', column: 'name', max: 120 },
  { table: 'oauth_grants', key: 'id', start: '', column: 'client_name', max: 200 },
  { table: 'events', key: 'id', start: '0', column: 'client', max: 200 },
  { table: 'sessions', key: 'id', start: '', column: 'client', max: 200 },
  { table: 'entries', key: 'id', start: '', column: 'client', max: 200 },
]

async function redactStoredClients(db: Db): Promise<void> {
  for (const { table, key, start, column, max } of STORED_CLIENTS) {
    let after = start
    for (;;) {
      const rows = await db.query<{ k: string; v: string }>(
        `SELECT ${key}::text AS k, ${column} AS v FROM ${table}
          WHERE ${key} > $1 AND ${column} IS NOT NULL AND ${mayHoldSecret(column)}
          ORDER BY ${key} LIMIT ${REDACT_BATCH}`,
        [after],
      )
      for (const r of rows) {
        const clean = redact(r.v).text.slice(0, max)
        if (clean !== r.v)
          await db.query(`UPDATE ${table} SET ${column} = $2 WHERE ${key} = $1`, [r.k, clean])
      }
      if (rows.length < REDACT_BATCH) break
      after = String(rows[rows.length - 1]?.k)
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
