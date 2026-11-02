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
import type { Db } from '../../db/db.ts'
import { MIGRATIONS_DIR, migrationFiles, STEPS } from '../../db/migrate.ts'
import { maintenance } from '../../domain/maintenance.ts'
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

const LOCK = 7_310_420_003 // one copy at a time, across every process on this database
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

export type Status = {
  lastOk: { at: string; file: string } | null
  lastFailure: { at: string; category: FailureCategory } | null
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
const PART = /^rsc-brain-\d{8}T\d{6}Z-[a-z-]+\.rscb\.part$/

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
async function writeStatus(dir: string, patch: Partial<Status>, files: FileOps = diskFiles): Promise<void> {
  const next = { ...(await readStatus(dir)), ...patch }
  if (patch.lastOk === undefined) {
    const newest = (await list(dir))[0]
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

function category(err: unknown): FailureCategory {
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

const backupRunning = () =>
  new AppError(
    409,
    'backup_running',
    'A copy is being made right now.',
    'Wait for it to finish (rsc-brain backups list shows it when it is done), then try again.',
  )

// A copy before an update: maintenance must be on, and every write that began before it must have ended.
async function settle(db: Db, clock: Clock, settleMs: number): Promise<void> {
  if (!(await maintenance.current(db, clock()))) {
    throw new AppError(
      409,
      'not_in_maintenance',
      'A copy before an update is made while writes are refused, and maintenance is off.',
      'Run rsc-brain maintenance on --reason update first.',
    )
  }
  await new Promise((r) => setTimeout(r, settleMs))
  const mark = await db.one<{ t: Date }>('SELECT clock_timestamp() AS t')
  const started = Date.now()
  for (;;) {
    const open = await db.one<{ n: number }>(
      `SELECT count(*)::int AS n FROM pg_stat_activity
        WHERE datname = current_database() AND pid <> pg_backend_pid() AND backend_type = 'client backend'
          AND xact_start IS NOT NULL AND xact_start < $1`,
      [mark?.t],
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

async function knownMigrations(): Promise<string[]> {
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
  db: Db,
  o: {
    dir: string
    secret: string | undefined
    reason: BackupReason
    clock: Clock
    settleMs?: number
    files?: FileOps
  },
): Promise<BackupInfo> {
  const at = o.clock()
  const files = o.files ?? diskFiles
  const fail = async (err: unknown): Promise<never> => {
    const cat = category(err)
    await writeStatus(
      o.dir,
      {
        lastFailure: { at: at.toISOString(), category: cat },
        ...(o.secret && cat !== 'weak_installation_key' ? { keyId: keyId(o.secret) } : {}),
      },
      files,
    ).catch(() => {})
    throw failure(cat, err)
  }
  if (!BACKUP_REASONS.includes(o.reason)) throw new Error(`Unknown reason for a copy: ${o.reason}`)
  await mkdir(o.dir, { recursive: true, mode: 0o700 })
  if (!o.secret) return fail(noVault())
  if (!strongKey(o.secret)) return fail(weakKey())
  const secret = o.secret
  try {
    if (o.reason === 'pre-update') await settle(db, o.clock, o.settleMs ?? PRE_UPDATE_SETTLE_MS)
  } catch (err) {
    if (err instanceof AppError && err.code === 'not_in_maintenance') throw err
    return fail(err)
  }
  const file = backupName(at, o.reason)
  const path = join(o.dir, file)
  const part = `${path}.part`
  let sink: Sink | null = null
  let written: { bytes: number; keyId: string; createdAt: string }
  // 1. The whole copy into `.part`, on disk, and checked to be all there: the snapshot and the lock end here.
  try {
    written = await db.tx(async (tx) => {
      await tx.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY')
      const locked = await tx.one<{ ok: boolean }>('SELECT pg_try_advisory_xact_lock($1) AS ok', [LOCK])
      if (!locked?.ok) throw backupRunning()
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
      // Under the lock no other copy is writing: what a copy that died left behind goes.
      for (const f of await readdir(o.dir)) if (PART.test(f)) await unlink(join(o.dir, f)).catch(() => {})
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
      const last = await tx.one<{ at: Date | null }>(
        `SELECT greatest((SELECT max(at) FROM events), (SELECT max(at) FROM audit), (SELECT max(at) FROM wiki_log),
                         (SELECT max(updated_at) FROM entries), (SELECT max(updated_at) FROM pages)) AS at`,
      )
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
          lastWriteAt: last?.at ? last.at.toISOString() : null,
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
    if (err instanceof AppError && ['backup_running', 'backup_exists'].includes(err.code)) throw err
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
  try {
    await files.syncDir(o.dir)
  } catch (err) {
    notes.push(
      `the folder could not be flushed to disk (${String((err as { code?: unknown }).code ?? 'error')})`,
    )
  }
  try {
    await writeStatus(
      o.dir,
      { lastOk: { at: info.createdAt, file }, lastFailure: null, keyId: info.keyId },
      files,
    )
  } catch (err) {
    notes.push(
      `the status of the copies was not saved (${String((err as { code?: unknown }).code ?? 'error')}), so the web may not show it as the last copy`,
    )
  }
  if (notes.length > 0)
    info.warning = `The copy is kept, but ${notes.join(', and ')}. Check the disk of the copies.`
  return info
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

export const backup = { create, list, prune, diskFiles }

// The daily copy of `serve`: a scheduled copy, then the scheduled ones beyond `keep` removed. It never throws: a
// failure is in status.json (the web shows it) and in the log, with its code only.
export function backupJob(
  db: Db,
  o: { dir: string; secret: string | undefined; keep: number; clock: Clock; log: Log },
): () => Promise<void> {
  return async () => {
    const t0 = Date.now()
    try {
      await create(db, { dir: o.dir, secret: o.secret, reason: 'scheduled', clock: o.clock })
      const removed = await prune(o.dir, o.keep)
      o.log.info('backup_done', { ms: Date.now() - t0, count: removed.length })
    } catch (err) {
      o.log.warn('backup_failed', failureFields(err))
    }
  }
}
