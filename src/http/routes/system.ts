// The health of the service for the administration (spec B6 «Admin › Backups & system», plan G14): the
// version, when this process started, the database and its last migration, meaning search and how far it
// got, the open event streams, and mail; and (spec B7 «Salud y registros») the free disk where the copies go,
// the size of the database, and the maintenance under way; the copies (last good one, last failure or warning), the
// id of the installation key and the release, with a newer one when there is (B7 PR30).
import { statfs } from 'node:fs/promises'
import { VERSION } from '../../core/version.ts'
import { adminOnly } from '../../domain/guards.ts'
import { maintenance } from '../../domain/maintenance.ts'
import { meaningProgress, meaningSettings } from '../../domain/meaning.ts'
import { mailConfigured } from '../../mail/mail.ts'
import { readStatus } from '../../ops/backup/backup.ts'
import { keyId } from '../../ops/backup/format.ts'
import { releaseView } from '../../ops/releases.ts'
import { type Route, route } from '../router.ts'
import { backupsOfSystem } from './backups.ts'
import { ctxOf } from './brains.ts'

// Free bytes where the copies go; null when no folder is set or it cannot be read.
async function freeBytes(dir: string | null): Promise<number | null> {
  if (!dir) return null
  try {
    const s = await statfs(dir)
    return Number(s.bavail) * Number(s.bsize)
  } catch {
    return null
  }
}

// The last update the launcher recorded (what a copy of «Last update» holds): only its outcome, the two versions and
// when; never its log.
async function lastUpdate(dir: string | null) {
  if (!dir) return null
  const u = (await readStatus(dir)).lastUpdate
  if (typeof u !== 'object' || u === null) return null
  const { ok, from, to, at } = u as Record<string, unknown>
  if (typeof ok !== 'boolean' || typeof from !== 'string' || typeof to !== 'string' || typeof at !== 'string')
    return null
  return { ok, from, to, at }
}

export const systemRoutes: Route[] = [
  route('GET /v1/admin/system', async (r) => {
    adminOnly(ctxOf(r))
    const migration = await r.db.one<{ id: string }>(
      'SELECT id FROM schema_migrations ORDER BY id DESC LIMIT 1',
    )
    const m = await meaningSettings(r.db)
    const m2 = await maintenance.current(r.db, r.clock())
    const failed = await r.db.one<{ at: Date }>(
      "SELECT at FROM mail_log WHERE status = 'failed' ORDER BY at DESC, id DESC LIMIT 1",
    )
    return {
      body: {
        version: VERSION,
        startedAt: r.startedAt.toISOString(),
        database: { ok: true, migration: migration?.id ?? null },
        meaning: {
          enabled: m.enabled,
          provider: m.enabled ? m.provider : null,
          progress: m.enabled ? await meaningProgress(r.db, m) : null,
        },
        streams: r.hub.streams(),
        mail: {
          configured: await mailConfigured(r.db),
          lastFailureAt: failed ? failed.at.toISOString() : null,
        },
        disk: {
          backupsFree: await freeBytes(r.backups),
          databaseBytes: Number(
            (await r.db.one<{ n: string }>('SELECT pg_database_size(current_database()) AS n'))?.n ?? 0,
          ),
        },
        maintenance: m2 ? { until: m2.until.toISOString(), reason: m2.reason } : null,
        backups: await backupsOfSystem(r),
        keyId: r.secret ? keyId(r.secret) : null,
        release: releaseView(r.releases?.state() ?? null, VERSION),
        update: { ...r.updates.state(), last: await lastUpdate(r.backups) },
      },
    }
  }),
]
