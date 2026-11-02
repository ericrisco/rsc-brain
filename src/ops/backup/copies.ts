// The copies as the web sees them (spec B7 «Copias y restauración», plan §3.4): one object per process, shared by the
// daily copy of `serve` and the routes of Admin › Backups & system, so a failure that could not be written to
// status.json (the disk that failed) is still said, and a copy by hand runs in the process while the web asks how it
// is going. Restoring from the web makes the copy of what is there first (pre-restore), as the command does.
import { join } from 'node:path'
import type { Clock } from '../../core/clock.ts'
import { AppError } from '../../core/errors.ts'
import type { Log } from '../../core/log.ts'
import { failureFields } from '../../core/log.ts'
import type { Pool } from '../../db/db.ts'
import {
  type BackupInfo,
  backup,
  backupName,
  backupRunning,
  type CopyMemory,
  copyMemory,
  type FileOps,
  keptCopy,
  LOCK,
  liveWarning,
  readStatus,
  type Status,
} from './backup.ts'
import { keyId } from './format.ts'
import { type RestoreResult, restore } from './restore.ts'

export type CopiesView = {
  configured: boolean
  items: Array<{
    id: string
    createdAt: string
    bytes: number
    reason: string
    keyId: string
    needsOldKey: boolean
  }>
  lastOk: Status['lastOk']
  lastFailure: Status['lastFailure']
  lastWarning: Status['lastWarning'] | null
  keyId: string | null
  schedule: { at: string; keep: number; timezone: string }
  lastUpdate: unknown
  running: boolean
}

export type Copies = {
  dir: string | null
  memory: CopyMemory
  view(): Promise<CopiesView>
  // Starts a copy by hand and answers with its id once it can start (no other copy here or in another process); it
  // runs in the process (the view says when it ends).
  start(): Promise<{ id: string }>
  find(id: string): Promise<BackupInfo | null>
  restore(
    id: string,
    o: { confirm: unknown; by: string },
  ): Promise<RestoreResult & { preRestore: string | null }>
}

const notSetUp = () =>
  new AppError(
    409,
    'backups_not_set_up',
    'This installation has no folder for its copies.',
    'Set RSC_BRAIN_BACKUPS to a folder for the copies (the installer does) and restart rsc-brain.',
  )

// A copy's id is its file name without `.rscb`; nothing else is ever a path here.
const ID = /^rsc-brain-\d{8}T\d{6}Z-(scheduled|manual|pre-update|pre-restore)$/

export function createCopies(o: {
  db: Pool
  dir: string | null
  secret: string | undefined
  clock: Clock
  log: Log
  schedule: { at: string; keep: number; timezone: string }
  memory?: CopyMemory
  // Tests: no wait before the copy that precedes a restore.
  settleMs?: number
  files?: FileOps
}): Copies {
  const memory = o.memory ?? copyMemory()
  const running = () => memory.busy !== null
  const current = o.secret ? keyId(o.secret) : null
  const c: Copies = {
    dir: o.dir,
    memory,
    async view() {
      if (!o.dir)
        return {
          configured: false,
          items: [],
          lastOk: null,
          lastFailure: memory.lastFailure,
          lastWarning: memory.lastWarning,
          keyId: current,
          schedule: o.schedule,
          lastUpdate: null,
          running: running(),
        }
      const status = await readStatus(o.dir)
      const items = await backup.list(o.dir).catch(() => [])
      // The newest good copy: status.json's, or a newer one in the folder (its status may not have been saved).
      let lastOk = status.lastOk
      const newest = items[0]
      if (newest && (!lastOk || newest.createdAt > lastOk.at))
        lastOk = { at: newest.createdAt, file: newest.file }
      const failures = [status.lastFailure, memory.lastFailure].filter((f) => f !== null)
      const failure = failures.sort((a, b) => (a.at < b.at ? 1 : -1))[0] ?? null
      // A warning retires once a later copy is made: status.json's when the folder holds a copy newer than the one
      // that wrote it; this process's when it was not about the newest copy.
      const warnings = [
        liveWarning(status.lastWarning, lastOk, status.lastOk?.at ?? null),
        liveWarning(memory.lastWarning, lastOk, memory.lastWarning?.at ?? null),
      ].filter((x) => x != null)
      return {
        configured: true,
        items: items.map((b) => ({
          id: b.id,
          createdAt: b.createdAt,
          bytes: b.bytes,
          reason: b.reason,
          keyId: b.keyId,
          needsOldKey: b.keyId !== current,
        })),
        lastOk,
        // A failure older than the last good copy is over.
        lastFailure: failure && (!lastOk || failure.at > lastOk.at) ? failure : null,
        lastWarning: warnings.sort((a, b) => (a.at < b.at ? 1 : -1))[0] ?? null,
        keyId: current,
        schedule: o.schedule,
        lastUpdate: status.lastUpdate ?? null,
        running: running(),
      }
    },
    async start() {
      const dir = o.dir
      if (!dir) throw notSetUp()
      if (memory.busy) throw backupRunning(memory.busy)
      memory.busy = 'manual'
      // The lock of the copies is taken now, on a session of its own, and the copy runs inside that same session:
      // no other process can start one between the answer and the copy (second pass of the review of PR #31).
      const at = o.clock()
      const id = backupName(at, 'manual').slice(0, -5)
      let taken: (ok: boolean) => void = () => {}
      const ready = new Promise<boolean>((r) => {
        taken = r
      })
      void o.db
        .session(async (s) => {
          const r = await s.one<{ ok: boolean }>('SELECT pg_try_advisory_lock($1) AS ok', [LOCK])
          if (!r?.ok) return taken(false)
          taken(true)
          try {
            const info = await keptCopy(o.db, memory, {
              dir,
              secret: o.secret,
              reason: 'manual',
              clock: () => at,
              files: o.files,
              held: true,
              locked: s,
            })
            if (info.warningCode) o.log.warn('backup_kept_with_warning', { code: info.warningCode })
            o.log.info('backup_done', { count: 0 })
          } finally {
            await s.query('SELECT pg_advisory_unlock($1)', [LOCK]).catch(() => {})
          }
        })
        .catch((err: unknown) => {
          taken(false)
          o.log.warn('backup_failed', failureFields(err))
        })
      if (!(await ready)) {
        memory.busy = null
        throw backupRunning()
      }
      return { id }
    },
    async find(id) {
      if (!o.dir || !ID.test(id)) return null
      return (await backup.list(o.dir)).find((b) => b.id === id) ?? null
    },
    async restore(id, r) {
      const dir = o.dir
      if (!dir) throw notSetUp()
      const found = await c.find(id)
      if (!found) throw notFound()
      if (memory.busy) throw backupRunning(memory.busy)
      memory.busy = 'restore'
      let pre: BackupInfo | null = null
      try {
        const done = await restore(o.db, {
          file: join(dir, found.file),
          key: o.secret ?? '',
          targetSecret: o.secret,
          keepKeys: false,
          clock: o.clock,
          by: r.by,
          confirm: typeof r.confirm === 'string' ? r.confirm : '',
          before: async () => {
            pre = await backup.create(o.db, {
              dir,
              secret: o.secret,
              reason: 'pre-restore',
              clock: o.clock,
              ...(o.settleMs !== undefined ? { settleMs: o.settleMs } : {}),
              ...(o.files ? { files: o.files } : {}),
            })
          },
        })
        const kept = pre as BackupInfo | null
        return { ...done, preRestore: kept ? kept.file : null }
      } finally {
        memory.busy = null
      }
    },
  }
  return c
}

export const notFound = () =>
  new AppError(
    404,
    'not_found',
    'There is no such copy here.',
    'Pick a copy from the list in Backups & system.',
  )
