// Forward-only migrations: every `NNNN_name.sql` in the migrations folder runs once, in order, inside
// its own transaction, under an advisory lock so two processes never migrate at the same time. A
// database that already has a migration this code does not know is from a newer release: refuse.
import { readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
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

export async function migrationFiles(dir: string): Promise<string[]> {
  const names = (await readdir(dir)).filter((f) => NAME.test(f))
  return names.sort()
}

export async function migrate(db: Db, dir: string = MIGRATIONS_DIR): Promise<string[]> {
  const files = await migrationFiles(dir)
  const ids = files.map((f) => f.slice(0, -4))
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
    for (const [i, file] of files.entries()) {
      const id = ids[i] as string
      if (done.has(id)) continue
      await tx.query(await readFile(join(dir, file), 'utf8'))
      await tx.query('INSERT INTO schema_migrations (id) VALUES ($1)', [id])
      applied.push(id)
    }
    return applied
  })
}
