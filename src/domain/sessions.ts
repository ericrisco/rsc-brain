// Sessions group the work of a client in a brain (spec B1 «Sesiones»). A client is the key it writes
// with. Without an open session, entries go to the key's implicit session for the day; a service
// can open the session of one of its short keys, and what that key writes lands there.
import { type Principal, roleIn } from '../auth/principal.ts'
import { conflict, invalid, notFound } from '../core/errors.ts'
import { newId } from '../core/ids.ts'
import type { Db, Row } from '../db/db.ts'
import { redact } from '../privacy/redact.ts'
import { allow, type Ctx, inBrain } from './context.ts'
import { emit } from './events.ts'

export const IDLE_MS = 24 * 60 * 60 * 1000

export type Session = {
  id: string
  brainId: string
  accountId: string
  credentialId: string
  bound: boolean
  purpose: string
  ref: string | null
  status: 'open' | 'closed' | 'closed_no_summary'
  summaryEntryId: string | null
  openedAt: string
  lastActivityAt: string
  closedAt: string | null
}

export const sessionOf = (r: Row): Session => ({
  id: String(r.id),
  brainId: String(r.brain_id),
  accountId: String(r.account_id),
  credentialId: String(r.credential_id),
  bound: Boolean(r.bound),
  purpose: String(r.purpose),
  ref: r.ref == null ? null : String(r.ref),
  status: r.status as Session['status'],
  summaryEntryId: r.summary_entry_id == null ? null : String(r.summary_entry_id),
  openedAt: (r.opened_at as Date).toISOString(),
  lastActivityAt: (r.last_activity_at as Date).toISOString(),
  closedAt: r.closed_at == null ? null : (r.closed_at as Date).toISOString(),
})

export function dayIn(tz: string, at: Date): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: tz,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(at)
}

// Sessions with no activity for 24 hours close themselves, without a summary. Whoever follows the
// brain learns it (an event by the installation itself, with no account or key).
export async function closeIdle(db: Db, now: Date): Promise<number> {
  return db.tx(async (tx) => {
    const rows = await tx.query(
      `UPDATE sessions SET status = 'closed_no_summary', closed_at = $1
        WHERE status = 'open' AND last_activity_at <= $1::timestamptz - interval '24 hours'
        RETURNING id, brain_id`,
      [now],
    )
    for (const r of rows) {
      await emit(
        tx,
        { clock: () => now, who: null },
        {
          brainId: String(r.brain_id),
          kind: 'session.closed',
          targetId: String(r.id),
          label: 'idle for 24 hours',
        },
      )
    }
    return rows.length
  })
}

// Who may close or write into a session: the key that owns it, another key of the same person, or
// the service account that minted the short key it is bound to.
async function owns(db: Db, who: Principal, s: Row): Promise<boolean> {
  if (s.credential_id === who.credential.id) return true
  if (s.account_id !== who.accountId) return false
  if (who.kind === 'person') return true
  // A service: its main key manages the sessions of the short keys it minted.
  if (who.credential.kind !== 'main') return false
  const k = await db.one('SELECT parent_id FROM credentials WHERE id = $1', [s.credential_id])
  return k?.parent_id === who.credential.id || s.credential_id === who.credential.id
}

export async function openSession(
  ctx: Ctx,
  slug: string,
  o: { purpose?: string; ref?: string; forKey?: string },
): Promise<Session> {
  // Everything stored is redacted first (pack rule 1), session purpose and reference included.
  const purpose = redact((o.purpose ?? '').trim()).text
  if (purpose.length > 500) throw invalid('The purpose is longer than 500 characters.', 'Shorten it.')
  const ref = o.ref?.trim() ? redact(o.ref.trim()).text : null
  if (ref && ref.length > 200) throw invalid('The reference is longer than 200 characters.', 'Shorten it.')
  return ctx.db.tx(async (db) => {
    const c = { ...ctx, db }
    const { brain, role } = await inBrain(c, { slug }, 'share')
    await allow(c, 'journal.write', { role, brainStatus: brain.status }, brain.id)
    let credentialId = ctx.who.credential.id
    let bound = false
    let sessionRef = ref
    if (o.forKey) {
      // A service opens the session of one of its short keys; the key's own reference wins. The key row
      // is locked so two openings at once give one session and one 409, never a unique-index 500.
      const k = await db.one(
        `SELECT id, ref, write_brain_id FROM credentials
          WHERE id = $1 AND kind = 'short' AND parent_id = $2 AND revoked_at IS NULL FOR UPDATE`,
        [o.forKey, ctx.who.credential.id],
      )
      if (!k || ctx.who.credential.kind !== 'main') throw notFound('short key')
      if (k.write_brain_id !== brain.id) {
        throw invalid(
          'That short key writes in another brain.',
          'Open the session in the brain the key writes to.',
        )
      }
      const open = await db.one(
        "SELECT id FROM sessions WHERE credential_id = $1 AND bound AND status = 'open'",
        [k.id],
      )
      if (open)
        throw conflict('session_open', 'That key already has an open session.', `Use session ${open.id}.`)
      credentialId = String(k.id)
      bound = true
      sessionRef = k.ref == null ? null : String(k.ref)
    } else if (ctx.who.credential.kind === 'short') {
      sessionRef = ctx.who.credential.ref
    }
    const now = ctx.clock()
    const row = await db.one(
      `INSERT INTO sessions (id, brain_id, account_id, credential_id, bound, purpose, ref, opened_at, last_activity_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $8) RETURNING *`,
      [newId('ses'), brain.id, ctx.who.accountId, credentialId, bound, purpose, sessionRef, now],
    )
    const s = sessionOf(row as Row)
    await emit(db, c, { brainId: brain.id, kind: 'session.opened', targetId: s.id, label: purpose || null })
    return s
  })
}

// The session an entry goes to: the one named (if the caller may write there), else the open session
// bound to this key, else the key's implicit session for today.
export async function sessionFor(db: Db, ctx: Ctx, brainId: string, sessionId?: string): Promise<string> {
  const now = ctx.clock()
  if (sessionId) {
    const s = await db.one('SELECT * FROM sessions WHERE id = $1 FOR UPDATE', [sessionId])
    if (!s || s.brain_id !== brainId || !(await owns(db, ctx.who, s))) throw notFound('session')
    if (s.status !== 'open') {
      throw conflict('session_closed', 'That session is closed.', 'Open a new session, or write without one.')
    }
    return String(s.id)
  }
  // Locked, so a summary, an end or the idle sweep closing it meanwhile makes this write move on to the
  // implicit session instead of landing in a closed one.
  const own = await db.one(
    `SELECT id FROM sessions WHERE credential_id = $1 AND brain_id = $2 AND status = 'open' AND day IS NULL
      ORDER BY opened_at DESC, id DESC LIMIT 1 FOR UPDATE`,
    [ctx.who.credential.id, brainId],
  )
  if (own) return String(own.id)
  const day = dayIn(ctx.tz ?? 'UTC', now)
  const ref = ctx.who.credential.kind === 'short' ? ctx.who.credential.ref : null
  const row = await db.one(
    `INSERT INTO sessions (id, brain_id, account_id, credential_id, purpose, ref, day, opened_at, last_activity_at)
     VALUES ($1, $2, $3, $4, 'implicit', $5, $6, $7, $7)
     ON CONFLICT (credential_id, brain_id, day) WHERE day IS NOT NULL AND status = 'open'
     DO UPDATE SET last_activity_at = EXCLUDED.last_activity_at RETURNING id`,
    [newId('ses'), brainId, ctx.who.accountId, ctx.who.credential.id, ref, day, now],
  )
  return String(row?.id)
}

export async function touch(db: Db, sessionId: string, at: Date): Promise<void> {
  await db.query('UPDATE sessions SET last_activity_at = $2 WHERE id = $1', [sessionId, at])
}

export async function loadSession(ctx: Ctx, id: string): Promise<{ session: Session; row: Row }> {
  const row = await ctx.db.one('SELECT * FROM sessions WHERE id = $1', [id])
  if (!row) throw notFound('session')
  await inBrain(ctx, { id: String(row.brain_id) }).catch(() => {
    throw notFound('session')
  })
  return { session: sessionOf(row), row }
}

// Closing without a summary: the owner of the session, or the service that opened it for a key.
export async function endSession(ctx: Ctx, id: string): Promise<Session> {
  return ctx.db.tx(async (db) => {
    const c = { ...ctx, db }
    const s = await db.one('SELECT * FROM sessions WHERE id = $1 FOR UPDATE', [id])
    if (!s || !(await owns(db, ctx.who, s))) throw notFound('session')
    const { brain, role } = await inBrain(c, { id: String(s.brain_id) }).catch(() => {
      throw notFound('session')
    })
    await allow(c, 'journal.write', { role, brainStatus: brain.status }, brain.id)
    if (s.status !== 'open') return sessionOf(s)
    const row = await db.one(
      "UPDATE sessions SET status = 'closed_no_summary', closed_at = $2 WHERE id = $1 RETURNING *",
      [id, ctx.clock()],
    )
    await emit(db, c, {
      brainId: String(s.brain_id),
      kind: 'session.closed',
      targetId: id,
      label: 'without summary',
    })
    return sessionOf(row as Row)
  })
}

export { owns as ownsSession }

// The open sessions behind the asking key, with the brain each is in (spec B5, the reminder at the end
// of an agent's session: is there work without a summary?). A person's key sees all of that person's
// open sessions: an agent connected with the standard sign-in writes with its own connection key, and
// the reminder runs with a token. A service's key sees only its own (its agents work for others). Only
// brains the key can still see count.
export async function openSessionsOfKey(ctx: Ctx): Promise<Array<Session & { brain: string }>> {
  await closeIdle(ctx.db, ctx.clock())
  const person = ctx.who.kind === 'person'
  const rows = await ctx.db.query(
    `SELECT s.*, b.slug FROM sessions s JOIN brains b ON b.id = s.brain_id
      WHERE ${person ? 's.account_id = $1' : 's.credential_id = $1'} AND s.status = 'open'
      ORDER BY s.opened_at DESC, s.id DESC LIMIT 50`,
    [person ? ctx.who.accountId : ctx.who.credential.id],
  )
  const out: Array<Session & { brain: string }> = []
  for (const r of rows) {
    if (await roleIn(ctx.db, ctx.who, String(r.brain_id)))
      out.push({ ...sessionOf(r), brain: String(r.slug) })
  }
  return out
}
