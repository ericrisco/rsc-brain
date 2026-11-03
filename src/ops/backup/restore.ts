// Restoring a copy (spec B7 «Copias y restauración», CA9, CA20, CA7; plan §3.3, risks 3 and 9). A restore replaces
// everything, in one transaction: it drops what is there, migrates to exactly the migrations the copy was made at,
// loads every table, puts every sequence back where it stood, migrates the rest, seals what was sealed again with the
// key of this installation, ends maintenance and, unless the rollback of an update asks to keep them, moves the epoch
// so no key, session or connection of the copy works again, and ends every invitation and link to set a password that
// was still pending in it (a key or a link revoked after the copy does not come back, and an installation restored from
// another shares none with it).
//
// Rows go in as they are read, a batch at a time (a table is never held whole in memory), with their own values. A row
// may point to one in a later batch or a later table, so while loading every link between tables is checked at the
// end instead of per statement (made deferrable inside the transaction); before anything else runs, every link is
// checked and put back exactly as its migration made it.
//
// Nothing is committed before the last frame of the copy is read and every check holds: the first two sections are
// the row counts and the sequences, the tables come once each in the order the header names them, and each holds as
// many rows as counted. A copy cut, changed or made with another key leaves the database exactly as it was.
import { basename } from 'node:path'
import { noVault } from '../../auth/vault.ts'
import type { Clock } from '../../core/clock.ts'
import { AppError } from '../../core/errors.ts'
import { VERSION } from '../../core/version.ts'
import type { Db, Pool } from '../../db/db.ts'
import { MIGRATIONS_DIR, migrate } from '../../db/migrate.ts'
import { audit } from '../../domain/audit.ts'
import { bumpKeyEpoch } from '../../domain/installation.ts'
import { maintenance } from '../../domain/maintenance.ts'
import { type ResealCount, resealAll } from '../key.ts'
import { LOCK as BACKUP_LOCK, backupRunning, knownMigrations } from './backup.ts'
import {
  corruptCopy,
  keyId,
  openBackup,
  readSections,
  type SectionEvent,
  strongKey,
  weakKey,
} from './format.ts'
import { BACKUP_TABLES } from './tables.ts'

// Parameters per INSERT stay well under PostgreSQL's 65 535; a batch also stays under a few megabytes of text (a row
// of a meaning vector is some 15 kB).
const MAX_PARAMS = 30_000
const MAX_ROWS = 1000
const MAX_BATCH_CHARS = 4 * 1024 * 1024

export type RestoreOptions = {
  file: string
  // The key the copy was made with.
  key: string
  // The key of this installation (RSC_BRAIN_SECRET): what was sealed is sealed again with it.
  targetSecret: string | undefined
  // Only the rollback of an update: keys and sessions keep working, no epoch move, no audit line (spec C13).
  keepKeys: boolean
  clock: Clock
  // Who restores (the web); null or absent from the command line.
  by?: string | null
  // When given, the name of this installation, or of the copy when this one has none yet (a new installation).
  confirm?: string
  // Runs once every check passed, under maintenance, before anything is replaced: the copy of what is there now.
  before?: () => Promise<void>
  // Only the checks (key, version, the copy itself, the name, --keep-keys): nothing is changed (the launcher asks
  // before it stops the service).
  check?: boolean
}

export type RestoreResult = {
  copyAt: string
  restoredAt: string
  epoch: number
  resealed: ResealCount
  // Invitations and links to set a password the copy held pending, ended because the epoch moved.
  ended: { invitations: number; resets: number }
}

export const newerCopy = (release: string) => {
  const e = new AppError(
    409,
    'newer_copy',
    `This copy was made by rsc-brain ${release}, which is newer than this one (${VERSION}).`,
    `Restore it with rsc-brain ${release} or newer.`,
  )
  e.extra = { needs: release }
  return e
}

const confirmMismatch = (expected: string) =>
  new AppError(
    400,
    'confirm_mismatch',
    'The name given to confirm does not match this installation. Nothing was changed.',
    `Confirm with the name of this installation, exactly: "${expected}".`,
  )

const keepKeysRefused = () =>
  new AppError(
    400,
    'keep_keys_refused',
    'Keys are kept only when rolling back an update: with the copy this installation made before it, with its own key.',
    'Restore without --keep-keys (every key and session then ends), or pick the pre-update copy of this installation.',
  )

const notRscBrain = () =>
  new AppError(
    409,
    'not_rsc_brain_database',
    'This database holds tables that are not rsc-brain’s, so a restore will not replace them.',
    'Point RSC_BRAIN_DATABASE_URL at the database of rsc-brain (one it owns alone), then restore again.',
  )

const restoreFailed = (code: unknown) =>
  new AppError(
    500,
    'restore_failed',
    `The restore failed${typeof code === 'string' && /^[0-9A-Z]{5}$/.test(code) ? ` (database error ${code})` : ''}. Nothing was changed.`,
    'Restore again; if it fails again, keep the copy and look at the log of the service.',
  )

// Reads the events of a copy one by one, with one put back (a table's rows end where the next table begins).
function puller(it: AsyncIterator<SectionEvent>) {
  let back: SectionEvent | null = null
  return {
    async next(): Promise<SectionEvent | null> {
      if (back) {
        const b = back
        back = null
        return b
      }
      const r = await it.next()
      return r.done ? null : r.value
    },
    putBack(ev: SectionEvent) {
      back = ev
    },
  }
}
type Pull = ReturnType<typeof puller>

async function rowsOf(pull: Pull): Promise<Array<Array<string | null>>> {
  const rows: Array<Array<string | null>> = []
  for (;;) {
    const ev = await pull.next()
    if (ev === null) return rows
    if (ev.kind === 'table') {
      pull.putBack(ev)
      return rows
    }
    rows.push(ev.values)
  }
}

// A section the copy must have, here: its name and columns exactly.
async function section(pull: Pull, table: string, columns: string[]): Promise<Array<Array<string | null>>> {
  const ev = await pull.next()
  if (ev?.kind !== 'table' || ev.table !== table || ev.columns.join(',') !== columns.join(','))
    throw corruptCopy()
  return rowsOf(pull)
}

const COPIED = new Set(BACKUP_TABLES.map((t) => t.name))
const COUNT = /^\d{1,15}$/
const SEQ_VALUE = /^-?\d{1,19}$/

type Present = {
  tables: string[]
  name: string | null
  // The maintenance as it was (to put it back if the restore fails); null when this schema has none.
  maintenance: { until: Date | null; reason: string | null } | null
}

async function present(db: Db): Promise<Present> {
  const tables = (
    await db.query<{ t: string }>("SELECT tablename AS t FROM pg_tables WHERE schemaname = 'public'")
  ).map((r) => r.t)
  if (!tables.includes('installation')) return { tables, name: null, maintenance: null }
  const cols = (
    await db.query<{ c: string }>(
      "SELECT column_name AS c FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'installation'",
    )
  ).map((r) => r.c)
  const withMaintenance = cols.includes('maintenance_until') && cols.includes('maintenance_reason')
  const row = await db.one<{ name: string; until?: Date | null; reason?: string | null }>(
    `SELECT name${withMaintenance ? ', maintenance_until AS until, maintenance_reason AS reason' : ''}
       FROM installation WHERE id = 1`,
  )
  return {
    tables,
    name: row?.name ?? null,
    maintenance: withMaintenance ? { until: row?.until ?? null, reason: row?.reason ?? null } : null,
  }
}

// Everything of the schema that is not an extension's: tables, views, sequences, routines and types. What is left
// after it is checked to be nothing.
async function dropAll(tx: Db): Promise<void> {
  const notExt = (cls: string, oid: string) =>
    `NOT EXISTS (SELECT 1 FROM pg_depend d WHERE d.classid = '${cls}'::regclass AND d.objid = ${oid} AND d.deptype = 'e')`
  const rels = await tx.query<{ name: string; kind: string }>(
    `SELECT c.oid::regclass::text AS name, c.relkind::text AS kind FROM pg_class c
       JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p', 'v', 'm', 'S', 'f') AND ${notExt('pg_class', 'c.oid')}`,
  )
  const drop = async (what: string, kinds: string[]) => {
    const names = rels.filter((r) => kinds.includes(r.kind)).map((r) => r.name)
    if (names.length) await tx.query(`DROP ${what} IF EXISTS ${names.join(', ')} CASCADE`)
  }
  await drop('VIEW', ['v'])
  await drop('MATERIALIZED VIEW', ['m'])
  await drop('FOREIGN TABLE', ['f'])
  await drop('TABLE', ['r', 'p'])
  await drop('SEQUENCE', ['S'])
  for (const { sig } of await tx.query<{ sig: string }>(
    `SELECT p.oid::regprocedure::text AS sig FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
      WHERE n.nspname = 'public' AND p.prokind IN ('f', 'p') AND ${notExt('pg_proc', 'p.oid')}`,
  ))
    await tx.query(`DROP ROUTINE IF EXISTS ${sig} CASCADE`)
  for (const { name, kind } of await tx.query<{ name: string; kind: string }>(
    `SELECT t.oid::regtype::text AS name, t.typtype::text AS kind FROM pg_type t
       JOIN pg_namespace n ON n.oid = t.typnamespace
       LEFT JOIN pg_class c ON c.oid = t.typrelid
      WHERE n.nspname = 'public' AND (t.typtype IN ('e', 'd', 'r', 'm') OR (t.typtype = 'c' AND c.relkind = 'c'))
        AND ${notExt('pg_type', 't.oid')}`,
  ))
    await tx.query(`DROP ${kind === 'd' ? 'DOMAIN' : 'TYPE'} IF EXISTS ${name} CASCADE`)
  const left = await tx.one<{ n: number }>(
    `SELECT (SELECT count(*) FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
              WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p', 'v', 'm', 'S', 'f') AND ${notExt('pg_class', 'c.oid')})
          + (SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
              WHERE n.nspname = 'public' AND ${notExt('pg_proc', 'p.oid')})::int AS n`,
  )
  if (Number(left?.n) !== 0) throw new Error('The schema could not be emptied.')
}

const quote = (id: string) => `"${id}"`

// Every link between tables (foreign key) is checked per statement; a copy's rows come in batches, a child before its
// parent at times. While loading, the links that are not deferrable become deferrable and deferred (the list comes
// from the database, so a link a later migration adds is covered); `links.check` then checks all of them and puts each
// back exactly as it was. All of it inside the restore's transaction: a failure rolls the changes back too.
type Link = { table: string; name: string }
async function deferLinks(tx: Db): Promise<Link[]> {
  const fixed = await tx.query<Link>(
    `SELECT conrelid::regclass::text AS table, conname::text AS name FROM pg_constraint
      WHERE contype = 'f' AND connamespace = 'public'::regnamespace AND NOT condeferrable ORDER BY 1, 2`,
  )
  for (const l of fixed)
    await tx.query(`ALTER TABLE ${l.table} ALTER CONSTRAINT ${quote(l.name)} DEFERRABLE INITIALLY DEFERRED`)
  await tx.query('SET CONSTRAINTS ALL DEFERRED')
  return fixed
}

const dangling = () =>
  new AppError(
    422,
    'corrupt_copy',
    'This copy holds rows that point to rows it does not hold, so it cannot be restored. Nothing was changed.',
    'Use another copy from the list (rsc-brain backups list).',
  )

async function checkLinks(tx: Db, fixed: Link[]): Promise<void> {
  try {
    await tx.query('SET CONSTRAINTS ALL IMMEDIATE')
  } catch (err) {
    if ((err as { code?: unknown }).code === '23503') throw dangling()
    throw err
  }
  for (const l of fixed)
    await tx.query(`ALTER TABLE ${l.table} ALTER CONSTRAINT ${quote(l.name)} NOT DEFERRABLE`)
}

// One table, as its rows are read: in batches, never the whole table at once. Says how many rows there were; stops
// at once when there are more than counted.
async function loadTable(
  tx: Db,
  pull: Pull,
  table: string,
  columns: string[],
  count: number,
): Promise<number> {
  if (new Set(columns).size !== columns.length || columns.length === 0) throw corruptCopy()
  const per = Math.max(1, Math.min(MAX_ROWS, Math.floor(MAX_PARAMS / columns.length)))
  const head = `INSERT INTO ${quote(table)} (${columns.map(quote).join(', ')}) OVERRIDING SYSTEM VALUE VALUES `
  let batch: Array<Array<string | null>> = []
  let chars = 0
  let n = 0
  const flush = async () => {
    if (batch.length === 0) return
    const params: Array<string | null> = []
    const tuples = batch.map((r) => {
      const at = params.length
      params.push(...r)
      return `(${r.map((_, j) => `$${at + j + 1}`).join(', ')})`
    })
    batch = []
    chars = 0
    await tx.query(head + tuples.join(', '), params)
  }
  for (;;) {
    const ev = await pull.next()
    if (ev === null) break
    if (ev.kind === 'table') {
      pull.putBack(ev)
      break
    }
    n += 1
    if (n > count) throw corruptCopy()
    const r = ev.values
    batch.push(r)
    for (const v of r) chars += v === null ? 1 : v.length
    if (batch.length >= per || chars >= MAX_BATCH_CHARS) await flush()
  }
  await flush()
  return n
}

export async function restore(db: Pool, o: RestoreOptions): Promise<RestoreResult> {
  if (!o.targetSecret) throw noVault()
  if (!strongKey(o.targetSecret)) throw weakKey()
  const targetSecret = o.targetSecret
  // A copy made with another key is refused here, before anything else, with the id of the key it needs.
  const opened = await openBackup(o.file, o.key)
  const it = readSections(opened)[Symbol.asyncIterator]()
  try {
    const h = opened.header
    if (new Set(h.migrations).size !== h.migrations.length) throw corruptCopy()
    const known = await knownMigrations()
    if (h.migrations.some((m) => !known.includes(m))) throw newerCopy(h.release)
    if (
      h.tables.length === 0 ||
      new Set(h.tables).size !== h.tables.length ||
      // Only tables copies hold: never one copies leave out (single-use codes, receipts, brakes).
      h.tables.some((t) => !COPIED.has(t))
    )
      throw corruptCopy()
    const pull = puller(it)
    // The first two sections, read before anything is done (reading them authenticates the header): how many rows
    // each table holds, the same tables in the same order as the header, and where each sequence stood.
    const countRows = await section(pull, '_tables', ['name', 'rows'])
    if (countRows.map((r) => r[0]).join('\n') !== h.tables.join('\n')) throw corruptCopy()
    const counts = new Map<string, number>()
    for (const [name, n] of countRows) {
      if (typeof n !== 'string' || !COUNT.test(n)) throw corruptCopy()
      counts.set(String(name), Number(n))
    }
    const sequences = await section(pull, '_sequences', ['name', 'last_value', 'is_called'])
    const seqNames = new Set<string>()
    for (const [name, value, called] of sequences) {
      if (
        typeof name !== 'string' ||
        seqNames.has(name) ||
        typeof value !== 'string' ||
        !SEQ_VALUE.test(value) ||
        (called !== 't' && called !== 'f')
      )
        throw corruptCopy()
      seqNames.add(name)
    }

    const now = await present(db)
    // The database is rsc-brain's alone (plan §3.3): tables without the migrations of rsc-brain are someone else's.
    if (now.tables.length > 0 && !now.tables.includes('schema_migrations')) throw notRscBrain()
    if (o.confirm !== undefined) {
      const expected = now.name || h.installation.name
      if (o.confirm !== expected) throw confirmMismatch(expected)
    }
    // Keeping keys is the rollback of an update only: the copy this installation made before it, with its key.
    if (
      o.keepKeys &&
      !(
        h.reason === 'pre-update' &&
        h.keyId === keyId(targetSecret) &&
        (now.name ?? '') === h.installation.name
      )
    )
      throw keepKeysRefused()
    if (o.check)
      return {
        copyAt: h.createdAt,
        restoredAt: '',
        epoch: 0,
        resealed: { resealed: 0, already: 0, notResealed: 0 },
        ended: { invitations: 0, resets: 0 },
      }
    // Under maintenance from here (writes refused with a clear answer), put back as it was if anything fails.
    if (now.maintenance) await maintenance.on(db, o.clock(), { reason: 'restore' })
    try {
      await o.before?.()
      return await db.tx(async (tx) => {
        const free = await tx.one<{ ok: boolean }>('SELECT pg_try_advisory_xact_lock($1) AS ok', [
          BACKUP_LOCK,
        ])
        if (!free?.ok) throw backupRunning()
        for (const s of [
          "SET LOCAL TimeZone = 'UTC'",
          "SET LOCAL DateStyle = 'ISO, YMD'",
          "SET LOCAL IntervalStyle = 'postgres'",
        ])
          await tx.query(s)
        await dropAll(tx)
        await migrate(tx, MIGRATIONS_DIR, { until: h.migrations })
        // The schema at the copy's migrations: its tables and sequences are exactly what the copy holds.
        const tables = new Set(
          (
            await tx.query<{ t: string }>("SELECT tablename AS t FROM pg_tables WHERE schemaname = 'public'")
          ).map((r) => r.t),
        )
        if (h.tables.some((t) => !tables.has(t))) throw corruptCopy()
        const inSchema = (
          await tx.query<{ n: string }>(
            "SELECT sequencename AS n FROM pg_sequences WHERE schemaname = 'public' ORDER BY 1",
          )
        ).map((r) => r.n)
        if (inSchema.join('\n') !== [...seqNames].sort().join('\n')) throw corruptCopy()
        // What the migrations themselves put in (the one row of the installation, of the settings) gives way to
        // the copy's rows.
        const filled = (
          await tx.query<{ t: string }>(
            h.tables
              .map((t) => `SELECT '${t}' AS t WHERE EXISTS (SELECT 1 FROM ${quote(t)})`)
              .join(' UNION ALL '),
          )
        ).map((r) => quote(r.t))
        if (filled.length) await tx.query(`TRUNCATE ${filled.join(', ')} CASCADE`)
        const fixed = await deferLinks(tx)
        for (const table of h.tables) {
          const ev = await pull.next()
          if (ev?.kind !== 'table' || ev.table !== table) throw corruptCopy()
          const n = await loadTable(tx, pull, table, ev.columns, counts.get(table) ?? 0)
          if (n !== counts.get(table)) throw corruptCopy()
        }
        // Nothing after the last table, and the end of the text: the last frame is read and authenticated.
        if ((await pull.next()) !== null) throw corruptCopy()
        // Every link checked now, and put back as its migration made it, before anything else runs.
        await checkLinks(tx, fixed)
        for (const [name, value, called] of sequences)
          await tx.query('SELECT setval(format($1, $2::text)::regclass, $3::bigint, $4::boolean)', [
            '%I',
            name,
            value,
            called === 't',
          ])
        await migrate(tx, MIGRATIONS_DIR)
        await tx.query(
          'UPDATE installation SET maintenance_until = NULL, maintenance_reason = NULL WHERE id = 1',
        )
        const resealed =
          o.key === targetSecret
            ? { resealed: 0, already: 0, notResealed: 0 }
            : await resealAll(tx, o.key, targetSecret)
        const restoredAt = o.clock()
        let epoch: number
        const ended = { invitations: 0, resets: 0 }
        if (o.keepKeys) {
          epoch = Number(
            (await tx.one<{ e: number }>('SELECT key_epoch AS e FROM installation WHERE id = 1'))?.e,
          )
        } else {
          epoch = await bumpKeyEpoch(tx)
          // Links that are not keys but open the door: an invitation and a link to set a password are ended too.
          ended.invitations = (
            await tx.query(
              'UPDATE invitations SET revoked_at = $1 WHERE used_at IS NULL AND revoked_at IS NULL RETURNING id',
              [restoredAt],
            )
          ).length
          ended.resets = (
            await tx.query(
              'UPDATE password_resets SET used_at = $1 WHERE used_at IS NULL RETURNING token_hash',
              [restoredAt],
            )
          ).length
          await audit(tx, {
            at: restoredAt,
            actorId: o.by ?? null,
            credentialId: null,
            action: 'installation.restore',
            outcome: 'ok',
            detail:
              `copy of ${h.createdAt} (${basename(o.file)})${o.by ? '' : ', from the command line'}; ended ` +
              `${ended.invitations} pending invitation(s) and ${ended.resets} password link(s)`,
          })
        }
        return { copyAt: h.createdAt, restoredAt: restoredAt.toISOString(), epoch, resealed, ended }
      })
    } catch (err) {
      if (now.maintenance) {
        await db
          .query('UPDATE installation SET maintenance_until = $1, maintenance_reason = $2 WHERE id = 1', [
            now.maintenance.until,
            now.maintenance.reason,
          ])
          .catch(() => {})
      }
      throw err instanceof AppError ? err : restoreFailed((err as { code?: unknown } | null)?.code)
    }
  } finally {
    await opened.close()
  }
}
