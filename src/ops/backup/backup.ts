// Copies of the whole installation (spec B7 «Copias y restauración»; plan §3.3). A copy is one snapshot of
// every table (REPEATABLE READ, READ ONLY), written in the .rscb format (format.ts) to `<name>.part` and renamed
// only once it is whole and on disk, so a copy that failed halfway (a full disk) never shows in the list. Two
// copies never run at once. Whether the last one went well lives next to the copies (status.json), not in the
// database, so a restore does not erase it.

import { randomBytes } from 'node:crypto'
import { mkdir, open, readdir, readFile, rename, rm, stat, unlink } from 'node:fs/promises'
import { join } from 'node:path'
import { noVault } from '../../auth/vault.ts'
import type { Clock } from '../../core/clock.ts'
import { AppError } from '../../core/errors.ts'
import { failureFields, type Log } from '../../core/log.ts'
import { VERSION } from '../../core/version.ts'
import type { Db, Pool } from '../../db/db.ts'
import { MIGRATIONS_DIR, migrationFiles, STEPS } from '../../db/migrate.ts'
import { LOOKS } from '../../domain/events.ts'
import { maintenance } from '../../domain/maintenance.ts'
import { EXPORT_APP_NAME } from '../export/export.ts'
import {
  BACKUP_REASONS,
  type BackupReason,
  encodeRow,
  keyId,
  readHeader,
  sectionEnd,
  sectionHead,
  strongKey,
  weakKey,
  writeBackup,
  writeFully,
} from './format.ts'
import { BACKUP_TABLES } from './tables.ts'

// One copy at a time, across every process on this database; a restore takes it too (no copy while it runs).
export const LOCK = 7_310_420_003
const BATCH = 1000
// A copy before an update waits this long after maintenance is on, then for every transaction that began
// before that to end: a write that read the installation row just before maintenance went on may still be on
// its way to commit, and must be in the copy (decisions, B7 PR27 §5).
export const PRE_UPDATE_SETTLE_MS = 5000
const PRE_UPDATE_MAX_WAIT_MS = 60_000

export type BackupInfo = {
  id: string
  file: string
  bytes: number
  keyId: string
  createdAt: string
  reason: BackupReason
  // Set when the copy is whole and kept but something after it was not done (its status, the folder on disk).
  warning?: string
  warningCode?: Warning['code']
  // With a warning: whether this copy's status.json was written (so the warning is already recorded).
  statusSaved?: boolean
}

export const FAILURE_CATEGORIES = [
  'disk_full',
  'no_permission',
  'no_installation_secret',
  'weak_installation_key',
  'database',
  'busy',
  'failed',
] as const
export type FailureCategory = (typeof FAILURE_CATEGORIES)[number]

export const WARNING_CODES = ['fsync_failed', 'status_not_saved', 'disk_full', 'no_permission'] as const
export type Warning = { at: string; code: (typeof WARNING_CODES)[number] }

export type Status = {
  lastOk: { at: string; file: string } | null
  lastFailure: { at: string; category: FailureCategory } | null
  // A copy kept whole whose folder could not be flushed, or whose status could not be saved then (recorded by
  // the next status written); the web shows it with its date.
  lastWarning?: Warning | null
  // Written by an update (plan §3.9); a copy keeps it as it is.
  lastUpdate?: unknown
  keyId: string | null
}

// Where the bytes go: files on disk. Tests put a full disk, short writes, a slow disk or a failing rename in its
// place. `write` is the raw call: it may take only part of the buffer (writeFully loops).
export type Sink = {
  write(b: Buffer, offset: number, length: number): Promise<{ bytesWritten: number }>
  sync(): Promise<void>
  close(): Promise<void>
}
export type FileOps = {
  // The `.part` of a copy, and the temporary file of status.json: always new files (never over another file,
  // never through a link planted at that name), readable by the owner only.
  open(path: string): Promise<Sink>
  status(path: string): Promise<Sink>
  size(path: string): Promise<number>
  rename(from: string, to: string): Promise<void>
  syncDir(dir: string): Promise<void>
}
async function newFile(path: string): Promise<Sink> {
  const fh = await open(path, 'wx', 0o600)
  return {
    write: (b, offset, length) => fh.write(b, offset, length),
    sync: () => fh.sync(),
    close: () => fh.close(),
  }
}
const diskFiles: FileOps = {
  open: newFile,
  status: newFile,
  size: async (path) => (await stat(path)).size,
  rename: (from, to) => rename(from, to),
  async syncDir(dir) {
    const d = await open(dir, 'r')
    try {
      await d.sync()
    } finally {
      await d.close()
    }
  },
}

const NAME = /^rsc-brain-(\d{8}T\d{6}Z)-(scheduled|manual|pre-update|pre-restore)\.rscb$/
// A copy being written: its name, then the pid and a random part of the process writing it (an older release wrote
// `.rscb.part` alone). Only one older than PART_STALE_MS is swept: no copy takes an hour to write here, so a younger
// one may still be some process's work.
const PART = /^rsc-brain-\d{8}T\d{6}Z-[a-z-]+\.rscb(\.\d+\.[0-9a-f]{16})?\.part$/
const PART_STALE_MS = 3600_000
// A copy dated more than this ahead of the clock is not taken as the last one (a wrong clock, or a planted file).
const FUTURE_MS = 5 * 60_000

// rsc-brain-<UTC yyyymmddThhmmssZ>-<reason>.rscb (plan §0).
export function backupName(at: Date, reason: BackupReason): string {
  const s = at
    .toISOString()
    .replace(/[-:]/g, '')
    .replace(/\.\d{3}Z$/, 'Z')
  return `rsc-brain-${s}-${reason}.rscb`
}

const STATUS = 'status.json'

export async function readStatus(dir: string): Promise<Status> {
  try {
    const s = JSON.parse(await readFile(join(dir, STATUS), 'utf8')) as Partial<Status>
    return {
      lastOk: s.lastOk ?? null,
      lastFailure: s.lastFailure ?? null,
      ...(s.lastWarning ? { lastWarning: s.lastWarning } : {}),
      ...(s.lastUpdate === undefined ? {} : { lastUpdate: s.lastUpdate }),
      keyId: s.keyId ?? null,
    }
  } catch {
    return { lastOk: null, lastFailure: null, keyId: null }
  }
}

// Written whole or not at all: a new temporary file of this writer only (pid and random, never over an existing
// file or link), renamed over status.json; owner only. A failure keeps the last good copy right: if a copy was
// kept but its status could not be saved, the next status written takes it from the folder.
async function writeStatus(
  dir: string,
  patch: Partial<Status>,
  now: Date,
  files: FileOps = diskFiles,
): Promise<void> {
  const next = { ...(await readStatus(dir)), ...patch }
  if (patch.lastOk === undefined) {
    const newest = (await list(dir)).find((b) => Date.parse(b.createdAt) <= now.getTime() + FUTURE_MS)
    if (newest && (!next.lastOk || newest.createdAt > next.lastOk.at))
      next.lastOk = { at: newest.createdAt, file: newest.file }
  }
  const tmp = join(dir, `${STATUS}.${process.pid}.${randomBytes(8).toString('hex')}.tmp`)
  try {
    const sink = await files.status(tmp)
    try {
      await writeFully((b, o, l) => sink.write(b, o, l), Buffer.from(`${JSON.stringify(next, null, 2)}\n`))
      await sink.sync()
    } finally {
      await sink.close()
    }
    await rename(tmp, join(dir, STATUS))
  } catch (err) {
    await rm(tmp, { force: true }).catch(() => {})
    throw err
  }
}

// What the launcher says about the last update (plan §3.9): written into status.json, everything else there kept.
// The log of a failed one is the service's last lines: never the installation key or a database password, and only
// its end (what says why), at most LAST_UPDATE_LOG_MAX characters.
export type LastUpdate = { ok: boolean; from: string; to: string; at: string; log?: string }
export const LAST_UPDATE_LOG_MAX = 4000
export async function recordUpdate(
  dir: string,
  u: { ok: boolean; from: string; to: string; log?: string },
  now: Date,
  secrets: string[] = [],
): Promise<LastUpdate> {
  const lastUpdate: LastUpdate = { ok: u.ok, from: u.from, to: u.to, at: now.toISOString() }
  if (u.log !== undefined) {
    let log = u.log
    for (const s of secrets) if (s) log = log.split(s).join('[redacted]')
    // Any password in a connection URL, whoever's it is.
    log = log.replace(/(\b[a-z][a-z0-9+.-]*:\/\/[^:/@\s]*:)[^@\s]*@/gi, '$1[redacted]@').trimEnd()
    if (log.length > LAST_UPDATE_LOG_MAX) log = `…${log.slice(log.length - LAST_UPDATE_LOG_MAX + 1)}`
    lastUpdate.log = log
  }
  await writeStatus(dir, { lastUpdate }, now)
  return lastUpdate
}

const categories = new WeakMap<object, FailureCategory>()

export function failureCategory(err: unknown): FailureCategory {
  const known = err !== null && typeof err === 'object' ? categories.get(err) : undefined
  if (known) return known
  if (err instanceof AppError && err.code === 'no_installation_secret') return 'no_installation_secret'
  if (err instanceof AppError && err.code === 'weak_installation_key') return 'weak_installation_key'
  const code = (err as { code?: unknown } | null)?.code
  // ESHORT: the file on disk is shorter than what was written to it (bytes lost on a full disk).
  if (code === 'ENOSPC' || code === 'EDQUOT' || code === 'ESHORT') return 'disk_full'
  if (code === 'EACCES' || code === 'EPERM' || code === 'EROFS') return 'no_permission'
  if (err instanceof AppError && err.code === 'writes_in_progress') return 'busy'
  // A PostgreSQL error carries a five-character SQLSTATE.
  if (typeof code === 'string' && /^[0-9A-Z]{5}$/.test(code)) return 'database'
  return 'failed'
}

function failure(cat: FailureCategory, err: unknown): AppError {
  if (err instanceof AppError) return err
  if (cat === 'disk_full')
    return new AppError(
      507,
      'disk_full',
      'The copy did not fit: the disk of the copies is full. No copy was kept.',
      'Free space in the folder of the copies (RSC_BRAIN_BACKUPS), or keep fewer (RSC_BRAIN_BACKUP_KEEP), then make a copy again.',
    )
  if (cat === 'no_permission')
    return new AppError(
      500,
      'backup_failed',
      'rsc-brain cannot write in the folder of the copies.',
      'Let the user that runs rsc-brain write in RSC_BRAIN_BACKUPS, then make a copy again.',
    )
  return new AppError(
    500,
    'backup_failed',
    'The copy failed. No copy was kept.',
    'Make a copy again; if it fails again, look at the log of the service for the code of the failure.',
  )
}

const BUSY_WORDS: Record<string, string> = {
  scheduled: ' (the daily one)',
  manual: ' (one made by hand)',
  'pre-update': ' (the one before an update)',
  'pre-restore': ' (the one before a restore)',
  restore: ': a restore is running',
}
export const backupRunning = (what?: string) =>
  new AppError(
    409,
    'backup_running',
    `A copy is being made right now${what ? (BUSY_WORDS[what] ?? '') : ''}.`,
    'Try again when it ends (rsc-brain backups list shows it when it is done).',
  )

// A copy before an update or a restore: maintenance must be on, and every write that began before it must have ended
// (a write accepted just before must be in the copy, not lost with what the update or the restore replaces).
async function settle(db: Db, clock: Clock, settleMs: number, why: 'update' | 'restore'): Promise<void> {
  if (!(await maintenance.current(db, clock()))) {
    throw new AppError(
      409,
      'not_in_maintenance',
      `A copy before ${why === 'update' ? 'an update' : 'a restore'} is made while writes are refused, and maintenance is off.`,
      `Run rsc-brain maintenance on --reason ${why} first.`,
    )
  }
  await new Promise((r) => setTimeout(r, settleMs))
  const mark = await db.one<{ t: Date }>('SELECT clock_timestamp() AS t')
  const started = Date.now()
  for (;;) {
    const open = await db.one<{ n: number }>(
      `SELECT count(*)::int AS n FROM pg_stat_activity
        WHERE datname = current_database() AND pid <> pg_backend_pid() AND backend_type = 'client backend'
          AND xact_start IS NOT NULL AND xact_start < $1
          -- An export's snapshot only reads (READ ONLY): nothing of it can be lost (B7 PR31 second pass).
          AND application_name IS DISTINCT FROM $2`,
      [mark?.t, EXPORT_APP_NAME],
    )
    if (!open?.n) return
    if (Date.now() - started > PRE_UPDATE_MAX_WAIT_MS) {
      throw new AppError(
        409,
        'writes_in_progress',
        'Writes that began before maintenance are still running after a minute.',
        'Try the update again in a few minutes.',
      )
    }
    await new Promise((r) => setTimeout(r, 100))
  }
}

// What a restore loses: the last write of anything a copy holds, from every table of BACKUP_TABLES with a
// created_at, updated_at or at column (the catalogue drives it, so a new table counts by itself), except what any
// restore ends anyway or what reads write (second pass of the review of PR #31):
// - NOT_LOST tables: keys, connections and sessions (a restore ends every one), reset links (ended), the cache of
//   client documents, the trail of reads, the log of mail sent, and meaning vectors (computed again);
// - events that are reads (searches, pages read) and audit lines of reading, operating or signing in
//   (READ_ONLY_ACTIONS), and refusals.
export const NOT_LOST = new Set([
  'oauth_clients',
  'oauth_grants',
  'oauth_used_refresh',
  'credentials',
  'password_resets',
  'trail',
  'mail_log',
  'meaning_vectors',
  'meaning_failures',
])
export const READ_ONLY_ACTIONS = [
  'backup.create',
  'backup.download',
  'installation_key.download',
  'installation_key.setup',
  'installation.restore',
  'audit.export',
  'brain.export',
  'auth.signin',
  'auth.signout',
  'auth.signout_everywhere',
  'auth.failed',
  'auth.reset_requested',
]
const STAMPS = ['created_at', 'updated_at', 'at']
export async function lastWrite(db: Db): Promise<string | null> {
  const parts: string[] = []
  for (const t of BACKUP_TABLES) {
    if (NOT_LOST.has(t.name)) continue
    const where =
      t.name === 'audit'
        ? " WHERE outcome = 'ok' AND action <> ALL($1::text[])"
        : t.name === 'events'
          ? ' WHERE kind <> ALL($2::text[])'
          : ''
    for (const c of STAMPS)
      if (t.columns.includes(c)) parts.push(`(SELECT max("${c}") FROM "${t.name}"${where})`)
  }
  const last = await db.one<{ at: Date | null }>(`SELECT greatest(${parts.join(', ')}) AS at`, [
    READ_ONLY_ACTIONS,
    [...LOOKS],
  ])
  return last?.at ? last.at.toISOString() : null
}

// Every migration of this release, SQL files and steps in code, sorted.
export async function knownMigrations(): Promise<string[]> {
  return [
    ...(await migrationFiles(MIGRATIONS_DIR)).map((f) => f.slice(0, -4)),
    ...STEPS.map((s) => s.id),
  ].sort()
}

export type SequenceState = { name: string; lastValue: string; isCalled: boolean }

// The text of a copy: first the row count of every table and where every sequence stands (inside the encryption:
// the readable header says nothing of how much there is), then every table in load order. A sequence is written
// as setval takes it back: its last value and whether it was ever called (one never called hands out that value
// first).
async function* tableRows(
  tx: Db,
  counts: Map<string, number>,
  sequences: SequenceState[],
): AsyncGenerator<Buffer> {
  yield Buffer.from(
    sectionHead('_tables', ['name', 'rows']) +
      BACKUP_TABLES.map((t) => encodeRow([t.name, String(counts.get(t.name) ?? 0)])).join('') +
      sectionEnd +
      sectionHead('_sequences', ['name', 'last_value', 'is_called']) +
      sequences.map((q) => encodeRow([q.name, q.lastValue, q.isCalled ? 't' : 'f'])).join('') +
      sectionEnd,
    'utf8',
  )
  for (const t of BACKUP_TABLES) {
    yield Buffer.from(sectionHead(t.name, t.columns), 'utf8')
    const cols = t.columns.map((c, i) => `"${c}"::text AS c${i}`).join(', ')
    const order = t.order.map((c) => `"${c}"`).join(', ')
    await tx.query(
      `DECLARE backup_rows NO SCROLL CURSOR FOR SELECT ${cols} FROM "${t.name}" ORDER BY ${order}`,
    )
    let n = 0
    for (;;) {
      const rows = await tx.query<Record<string, string | null>>(`FETCH ${BATCH} FROM backup_rows`)
      if (rows.length === 0) break
      n += rows.length
      yield Buffer.from(
        rows.map((r) => encodeRow(t.columns.map((_, i) => r[`c${i}`] ?? null))).join(''),
        'utf8',
      )
    }
    await tx.query('CLOSE backup_rows')
    // The same snapshot counted them: a difference is a fault of this code, never a copy to keep.
    if (n !== counts.get(t.name)) throw new Error(`The rows of ${t.name} changed inside the snapshot.`)
    yield Buffer.from(sectionEnd, 'utf8')
  }
}

async function create(
  db: Pool,
  o: {
    dir: string
    secret: string | undefined
    reason: BackupReason
    clock: Clock
    settleMs?: number
    files?: FileOps
    // A warning of an earlier copy whose status could not be saved: written with this copy's status.
    carryWarning?: Warning
    // A session holding the lock of the copies, taken by the caller, which also lets it go.
    locked?: Db
  },
): Promise<BackupInfo> {
  const at = o.clock()
  const files = o.files ?? diskFiles
  const fail = async (err: unknown): Promise<never> => {
    const cat = failureCategory(err)
    await writeStatus(
      o.dir,
      {
        lastFailure: { at: at.toISOString(), category: cat },
        ...(o.secret && cat !== 'weak_installation_key' ? { keyId: keyId(o.secret) } : {}),
        ...(o.carryWarning ? { lastWarning: o.carryWarning } : {}),
      },
      at,
      files,
    ).catch(() => {})
    const out = failure(cat, err)
    // Its category travels with it: the memory of the process records it (status.json may not have taken it).
    categories.set(out, cat)
    throw out
  }
  if (!BACKUP_REASONS.includes(o.reason)) throw new Error(`Unknown reason for a copy: ${o.reason}`)
  await mkdir(o.dir, { recursive: true, mode: 0o700 })
  if (!o.secret) return fail(noVault())
  if (!strongKey(o.secret)) return fail(weakKey())
  const secret = o.secret
  // One copy at a time, from the sweep to its status: a session-level lock on a connection of its own, held across
  // the snapshot transaction, the size check, the rename and the status. It ends with that connection if the
  // process dies.
  const run = async (session: Db): Promise<BackupInfo> => {
    const db = session
    try {
      if (o.reason === 'pre-update' || o.reason === 'pre-restore')
        await settle(
          db,
          o.clock,
          o.settleMs ?? PRE_UPDATE_SETTLE_MS,
          o.reason === 'pre-update' ? 'update' : 'restore',
        )
    } catch (err) {
      if (err instanceof AppError && err.code === 'not_in_maintenance') throw err
      return fail(err)
    }
    const file = backupName(at, o.reason)
    const path = join(o.dir, file)
    const part = `${path}.${process.pid}.${randomBytes(8).toString('hex')}.part`
    let sink: Sink | null = null
    let written: { bytes: number; keyId: string; createdAt: string }
    // 1. The whole copy into `.part`, on disk, and checked to be all there: the snapshot and the lock end here.
    try {
      written = await db.tx(async (tx) => {
        await tx.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY')
        // Same text whatever the server's settings: UTC times, hex bytes, exact floats.
        for (const s of [
          "SET LOCAL TimeZone = 'UTC'",
          "SET LOCAL DateStyle = 'ISO, YMD'",
          "SET LOCAL IntervalStyle = 'postgres'",
          "SET LOCAL bytea_output = 'hex'",
          'SET LOCAL extra_float_digits = 1',
        ])
          await tx.query(s)
        const applied = (await tx.query<{ id: string }>('SELECT id FROM schema_migrations ORDER BY id')).map(
          (r) => r.id,
        )
        if (applied.join(',') !== (await knownMigrations()).join(',')) {
          throw new AppError(
            409,
            'schema_mismatch',
            `The database is not at the schema of this release (${VERSION}).`,
            'Run rsc-brain migrate with this release, or make the copy with the release that migrated the database.',
          )
        }
        // Under the lock no other copy of this database is writing: what a copy that died (over an hour ago) left
        // behind goes.
        for (const f of await readdir(o.dir)) {
          if (!PART.test(f)) continue
          const old = await stat(join(o.dir, f)).then(
            (st) => Date.now() - st.mtimeMs > PART_STALE_MS,
            () => false,
          )
          if (old) await unlink(join(o.dir, f)).catch(() => {})
        }
        if (
          await stat(path).then(
            () => true,
            () => false,
          )
        )
          throw new AppError(
            409,
            'backup_exists',
            'A copy with this name exists already.',
            'Try again in a second.',
          )
        const inst = await tx.one<{ id: number; name: string }>(
          'SELECT id, name FROM installation WHERE id = 1',
        )
        const countRows = await tx.query<{ t: string; n: number }>(
          BACKUP_TABLES.map((t) => `SELECT '${t.name}' AS t, count(*)::int AS n FROM "${t.name}"`).join(
            ' UNION ALL ',
          ),
        )
        const counts = new Map(countRows.map((r) => [r.t, r.n]))
        const sequences: SequenceState[] = []
        for (const { name } of await tx.query<{ name: string }>(
          "SELECT sequencename AS name FROM pg_sequences WHERE schemaname = 'public' ORDER BY sequencename",
        )) {
          const q = await tx.one<{ v: string; c: boolean }>(
            `SELECT last_value::text AS v, is_called AS c FROM "${name}"`,
          )
          sequences.push({ name, lastValue: q?.v ?? '1', isCalled: q?.c === true })
        }
        const last = await lastWrite(tx)
        sink = await files.open(part)
        const out = sink
        const { bytes, header } = await writeBackup(
          (b) => writeFully((x, off, len) => out.write(x, off, len), b),
          {
            release: VERSION,
            migrations: applied,
            createdAt: at.toISOString(),
            installation: { id: inst?.id ?? 1, name: inst?.name ?? '' },
            reason: o.reason,
            tables: BACKUP_TABLES.map((t) => t.name),
            lastWriteAt: last,
          },
          tableRows(tx, counts, sequences),
          secret,
        )
        await out.sync()
        await out.close()
        sink = null
        // What the disk holds is what was written, byte for byte, or it is no copy (review of PR #29).
        if ((await files.size(part)) !== bytes)
          throw Object.assign(new Error('The copy on disk is shorter than what was written.'), {
            code: 'ESHORT',
          })
        return { bytes, keyId: header.keyId, createdAt: header.createdAt }
      })
    } catch (err) {
      if (sink) await (sink as Sink).close().catch(() => {})
      await rm(part, { force: true }).catch(() => {})
      if (err instanceof AppError && err.code === 'backup_exists') throw err
      return fail(err)
    }
    // 2. Into place. A rename that fails leaves no copy; from here on the copy is whole and kept, whatever else fails.
    try {
      await files.rename(part, path)
    } catch (err) {
      await rm(part, { force: true }).catch(() => {})
      return fail(err)
    }
    const info: BackupInfo = {
      id: file.slice(0, -5),
      file,
      bytes: written.bytes,
      keyId: written.keyId,
      createdAt: written.createdAt,
      reason: o.reason,
    }
    const notes: string[] = []
    let warning: Warning | null = null
    try {
      await files.syncDir(o.dir)
    } catch (err) {
      warning = { at: info.createdAt, code: 'fsync_failed' }
      notes.push(
        `the folder could not be flushed to disk (${String((err as { code?: unknown }).code ?? 'error')})`,
      )
    }
    const recorded = warning ?? o.carryWarning
    try {
      await writeStatus(
        o.dir,
        {
          lastOk: { at: info.createdAt, file },
          lastFailure: null,
          keyId: info.keyId,
          // A copy with nothing to say clears what an earlier one said (review of PR #31).
          lastWarning: recorded ?? null,
        },
        at,
        files,
      )
    } catch (err) {
      const cat = failureCategory(err)
      warning = {
        at: info.createdAt,
        code: cat === 'disk_full' || cat === 'no_permission' ? cat : 'status_not_saved',
      }
      notes.push(
        `the status of the copies was not saved (${String((err as { code?: unknown }).code ?? 'error')}), so the web may not show it as the last copy`,
      )
    }
    if (warning) {
      info.warning = `The copy is kept, but ${notes.join(', and ')}. Check the disk of the copies.`
      info.warningCode = warning.code
      info.statusSaved = notes.length === 1 && warning.code === 'fsync_failed'
    }
    return info
  }
  // The caller took the lock on this session already (the web, before it answers): the copy runs inside it.
  if (o.locked) return run(o.locked)
  return db.session(async (session) => {
    const locked = await session.one<{ ok: boolean }>('SELECT pg_try_advisory_lock($1) AS ok', [LOCK])
    if (!locked?.ok) throw backupRunning()
    try {
      return await run(session)
    } finally {
      await session.query('SELECT pg_advisory_unlock($1)', [LOCK]).catch(() => {})
    }
  })
}

// The copies in the folder, newest first, read from their headers only. A `.part`, a file of another name and a
// file whose header does not read are not copies.
async function list(dir: string): Promise<BackupInfo[]> {
  let names: string[]
  try {
    names = await readdir(dir)
  } catch (err) {
    if ((err as { code?: string }).code === 'ENOENT') return []
    throw err
  }
  const out: BackupInfo[] = []
  for (const file of names) {
    if (!NAME.test(file)) continue
    const path = join(dir, file)
    try {
      const h = await readHeader(path)
      out.push({
        id: file.slice(0, -5),
        file,
        bytes: (await stat(path)).size,
        keyId: h.keyId,
        createdAt: h.createdAt,
        reason: h.reason,
      })
    } catch {}
  }
  return out.sort((a, b) =>
    a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : a.file < b.file ? 1 : -1,
  )
}

// Keeps the newest `keep` scheduled copies (at least one) and removes the older scheduled ones. Copies made by
// hand, before an update or before a restore are never removed here, nor a file whose header does not read.
async function prune(dir: string, keep: number): Promise<string[]> {
  const scheduled = (await list(dir)).filter((b) => b.reason === 'scheduled')
  const removed: string[] = []
  for (const b of scheduled.slice(Math.max(1, Math.floor(keep)))) {
    await unlink(join(dir, b.file))
    removed.push(b.file)
  }
  return removed
}

// When the newest daily copy in the folder was made (null for none), never one dated ahead of the clock.
async function lastScheduledAt(dir: string, now: Date): Promise<Date | null> {
  const b = (await list(dir)).find(
    (x) => x.reason === 'scheduled' && Date.parse(x.createdAt) <= now.getTime() + FUTURE_MS,
  )
  return b ? new Date(b.createdAt) : null
}

export const backup = { create, list, prune, diskFiles, lastScheduledAt }

// What this process knows of the copies beyond status.json: the last failure (status.json may be on the disk that
// failed) and a warning not yet written there. The web merges it with status.json (copies.ts).
// `busy`: the copy (or restore) this process is making now, by its reason: one source for the daily copy and the
// web, so a copy by hand during the daily one is refused at once and says which (review of PR #31).
export type CopyMemory = {
  lastFailure: Status['lastFailure']
  lastWarning: Warning | null
  busy: BackupReason | 'restore' | null
}
export const copyMemory = (): CopyMemory => ({ lastFailure: null, lastWarning: null, busy: null })

// A warning is said while what recorded it is the last word: a copy made later (even one whose status was not saved)
// outdates it.
export function liveWarning(
  w: Warning | null | undefined,
  lastOk: Status['lastOk'],
  since: string | null,
): Warning | null {
  if (!w) return null
  if (lastOk && since !== null && lastOk.at > since) return null
  return w
}

// One copy, as `serve` makes them (daily) and the web (by hand): a failure and a warning are kept in `memory` too.
export async function keptCopy(
  db: Pool,
  memory: CopyMemory,
  o: {
    dir: string
    secret: string | undefined
    reason: BackupReason
    clock: Clock
    files?: FileOps | undefined
    // The caller marked `memory.busy` already (the web, which answers only once it knows the copy can start).
    held?: boolean
    // The session that holds the lock of the copies for it (the web).
    locked?: Db
  },
): Promise<BackupInfo> {
  if (!o.held) {
    if (memory.busy) throw backupRunning(memory.busy)
    memory.busy = o.reason
  }
  try {
    const info = await create(db, {
      dir: o.dir,
      secret: o.secret,
      reason: o.reason,
      clock: o.clock,
      ...(o.files ? { files: o.files } : {}),
      ...(memory.lastWarning ? { carryWarning: memory.lastWarning } : {}),
      ...(o.locked ? { locked: o.locked } : {}),
    })
    memory.lastFailure = null
    memory.lastWarning =
      info.warningCode && !info.statusSaved ? { at: info.createdAt, code: info.warningCode } : null
    return info
  } catch (err) {
    if (!(err instanceof AppError && err.code === 'backup_running'))
      memory.lastFailure = { at: o.clock().toISOString(), category: failureCategory(err) }
    throw err
  } finally {
    memory.busy = null
  }
}

// The daily copy of `serve`: a scheduled copy, then the scheduled ones beyond `keep` removed. It never throws: a
// failure is in status.json (the web shows it) and in the log, with its code only. A copy kept with a warning is
// said in the log; when its status could not be saved, the warning is kept here and written with the next status.
// It answers 'busy' when another copy is running, so the scheduler can try again.
export type BackupJob = (() => Promise<'busy' | undefined>) & { files?: FileOps | undefined }
export function backupJob(
  db: Pool,
  o: {
    dir: string
    secret: string | undefined
    keep: number
    clock: Clock
    log: Log
    files?: FileOps
    memory?: CopyMemory
  },
): BackupJob {
  const memory = o.memory ?? copyMemory()
  const job: BackupJob = async () => {
    const t0 = Date.now()
    try {
      const info = await keptCopy(db, memory, {
        dir: o.dir,
        secret: o.secret,
        reason: 'scheduled',
        clock: o.clock,
        files: job.files,
      })
      if (info.warningCode) o.log.warn('backup_kept_with_warning', { code: info.warningCode })
      const removed = await prune(o.dir, o.keep)
      o.log.info('backup_done', { ms: Date.now() - t0, count: removed.length })
    } catch (err) {
      o.log.warn('backup_failed', failureFields(err))
      if (err instanceof AppError && err.code === 'backup_running') return 'busy'
    }
    return undefined
  }
  job.files = o.files
  return job
}
