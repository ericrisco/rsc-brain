// The copies, the installation key and the release from the web (spec B7 «Copias y restauración», plan §3.4). Only
// the administration, only signed in to the web: a key of an agent or a program never lists, makes, downloads or
// restores a copy, and never gets the installation key (403 web_only). The key and a restore ask for the password
// again (and the code, with a second factor). The key of the first-time setup is given once, to whoever ran it,
// within the hour after.
import { join } from 'node:path'
import { noVault } from '../../auth/vault.ts'
import { AppError } from '../../core/errors.ts'
import { audit } from '../../domain/audit.ts'
import { adminOnly, inWeb } from '../../domain/guards.ts'
import { reauth } from '../../domain/login.ts'
import { applyStored } from '../../meaning/stored.ts'
import { lastWrite, liveWarning, readStatus } from '../../ops/backup/backup.ts'
import { notFound } from '../../ops/backup/copies.ts'
import { keyId, readHeader } from '../../ops/backup/format.ts'
import { obj } from '../input.ts'
import { type Req, type Route, route } from '../router.ts'
import { ctxOf } from './brains.ts'

// How long after the first-time setup its key is still given (the wizard is one sitting).
export const SETUP_KEY_WINDOW_MS = 3600_000

const copiesOf = (r: Req) => {
  if (!r.copies) {
    throw new AppError(
      409,
      'backups_not_set_up',
      'This installation has no folder for its copies.',
      'Set RSC_BRAIN_BACKUPS to a folder for the copies (the installer does) and restart rsc-brain.',
    )
  }
  return r.copies
}

const by = (r: Req) => ({ actorId: r.who.accountId, credentialId: r.who.credential.id })

const setupKeyGone = () =>
  new AppError(
    404,
    'not_found',
    'The installation key is shown once, right after the first-time setup, to whoever ran it.',
    'Download it again in Admin › Backups & system, typing your password.',
  )

export const backupRoutes: Route[] = [
  route('GET /v1/admin/backups', async (r) => {
    adminOnly(ctxOf(r))
    if (r.copies) return { body: await r.copies.view() }
    return {
      body: {
        configured: false,
        items: [],
        lastOk: null,
        lastFailure: null,
        lastWarning: null,
        keyId: r.secret ? keyId(r.secret) : null,
        schedule: { at: '03:00', keep: 14, timezone: r.tz },
        lastUpdate: null,
        running: false,
      },
    }
  }),
  route('POST /v1/admin/backups', async (r) => {
    adminOnly(ctxOf(r))
    const copies = copiesOf(r)
    const { id } = await copies.start()
    await audit(r.db, { at: r.clock(), ...by(r), action: 'backup.create', outcome: 'ok', detail: id })
    return { status: 202, body: { id } }
  }),
  {
    ...route('GET /v1/admin/backups/:id/download', async (r) => {
      adminOnly(ctxOf(r))
      const copies = copiesOf(r)
      const found = await copies.find(r.params.id as string)
      if (!found || !copies.dir) throw notFound()
      await audit(r.db, {
        at: r.clock(),
        ...by(r),
        action: 'backup.download',
        outcome: 'ok',
        detail: found.file,
      })
      return {
        body: null,
        file: { path: join(copies.dir, found.file), bytes: found.bytes, name: found.file },
      }
    }),
    // It writes its audit line: refused during maintenance, like the audit's download.
    maintenance: 'writes' as const,
  },
  route('GET /v1/admin/backups/:id/impact', async (r) => {
    adminOnly(ctxOf(r))
    const copies = copiesOf(r)
    const found = await copies.find(r.params.id as string)
    if (!found || !copies.dir) throw notFound()
    const h = await readHeader(join(copies.dir, found.file))
    const now = await lastWrite(r.db)
    return {
      body: {
        copyAt: h.createdAt,
        copyLastWriteAt: h.lastWriteAt,
        lastWriteAt: now,
        // Something was written after the copy: a restore loses it.
        // Data written after the copy was made: a restore loses it (audit lines are not counted).
        lostWrites: now !== null && now > h.createdAt,
      },
    }
  }),
  route('POST /v1/admin/backups/:id/restore', async (r) => {
    const ctx = ctxOf(r)
    adminOnly(ctx)
    const copies = copiesOf(r)
    const b = obj(r.body)
    await reauth(ctx, r.conn, r.secret, b, 'Restoring a copy')
    const done = await copies.restore(r.params.id as string, { confirm: b.confirm, by: r.who.accountId })
    // The process follows what came back: the settings of meaning search, and the live feed numbered anew. Every
    // key ended with the restore (this session too), so open streams close at their next check.
    if (r.meaning) await applyStored(r.db, r.meaning, r.secret).catch(() => {})
    r.hub.reset()
    return {
      body: {
        copyAt: done.copyAt,
        restoredAt: done.restoredAt,
        preRestore: done.preRestore,
        ended: done.ended,
      },
    }
  }),
  route('POST /v1/admin/installation-key', async (r) => {
    const ctx = ctxOf(r)
    adminOnly(ctx)
    await reauth(ctx, r.conn, r.secret, obj(r.body), 'Downloading the installation key')
    if (!r.secret) throw noVault()
    await audit(r.db, { at: r.clock(), ...by(r), action: 'installation_key.download', outcome: 'ok' })
    return { body: { key: r.secret, keyId: keyId(r.secret) }, headers: { 'cache-control': 'no-store' } }
  }),
  // A POST, so it passes the check of the web's own header: a page elsewhere cannot ask for it (review of PR #31).
  route('POST /v1/setup/key', async (r) => {
    inWeb(ctxOf(r), 'The installation key')
    const secret = r.secret
    if (!secret) throw noVault()
    const now = r.clock()
    const given = await r.db.tx(async (tx) => {
      const inst = await tx.one<{ at: Date | null }>(
        'SELECT setup_done_at AS at FROM installation WHERE id = 1 FOR UPDATE',
      )
      if (!inst?.at || now.getTime() - inst.at.getTime() > SETUP_KEY_WINDOW_MS) return false
      // Whoever ran the setup from the web, and only once.
      const setup = await tx.one<{ actor: string | null }>(
        "SELECT actor_id AS actor FROM audit WHERE action = 'installation.setup' AND detail LIKE 'web%' ORDER BY at DESC, id DESC LIMIT 1",
      )
      if (!setup || setup.actor !== r.who.accountId) return false
      if (await tx.one("SELECT 1 FROM audit WHERE action = 'installation_key.setup' LIMIT 1")) return false
      await audit(tx, { at: now, ...by(r), action: 'installation_key.setup', outcome: 'ok' })
      return true
    })
    if (!given) throw setupKeyGone()
    return { body: { key: secret, keyId: keyId(secret) }, headers: { 'cache-control': 'no-store' } }
  }),
]

// What GET /v1/admin/system says of the copies, read the same way as the list.
export async function backupsOfSystem(r: Req) {
  if (r.copies) {
    const v = await r.copies.view()
    return { lastOk: v.lastOk, lastFailure: v.lastFailure, lastWarning: v.lastWarning ?? null }
  }
  if (!r.backups) return { lastOk: null, lastFailure: null, lastWarning: null }
  const s = await readStatus(r.backups)
  return {
    lastOk: s.lastOk,
    lastFailure: s.lastFailure,
    lastWarning: liveWarning(s.lastWarning, s.lastOk, s.lastOk?.at ?? null),
  }
}
