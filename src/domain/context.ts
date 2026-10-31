// What every domain operation receives: the database (or the open transaction), the clock and who is
// calling. Brain-scoped operations go through `inBrain`, which loads the brain, works out the role
// through the key, and answers "not found" for anyone without access (constitution P4).
import { type Action, can, type Facts, type Role } from '../auth/can.ts'
import { actorOf, type Principal, roleIn } from '../auth/principal.ts'
import type { Clock } from '../core/clock.ts'
import { brainNotFound, denied } from '../core/errors.ts'
import type { Db } from '../db/db.ts'
import type { Outbox } from '../mail/mail.ts'
import type { Providers } from '../meaning/providers.ts'
import { audit } from './audit.ts'

// root: the pool, outside any transaction. Denials are audited through it so a rollback cannot erase
// them (the refusal is thrown, which rolls the transaction back).
// tz: the installation's time zone, which decides the day of a key's implicit session (spec B1).
// meaning: the providers of meaning configured for this installation (spec B3); none in most tests.
// mail: how to send mail (spec B4); without it nothing is sent.
export type Ctx = {
  db: Db
  clock: Clock
  who: Principal
  root?: Db
  tz?: string
  meaning?: Providers
  mail?: Outbox
}

export type Brain = {
  id: string
  slug: string
  name: string
  description: string
  purpose: string
  status: 'active' | 'archived'
  pendingCuratorEmail: string | null
  createdAt: string
  updatedAt: string
}

export const brainOf = (r: Record<string, unknown>): Brain => ({
  id: String(r.id),
  slug: String(r.slug),
  name: String(r.name),
  description: String(r.description),
  purpose: String(r.purpose),
  status: r.status as Brain['status'],
  pendingCuratorEmail: r.pending_curator_email == null ? null : String(r.pending_curator_email),
  createdAt: (r.created_at as Date).toISOString(),
  updatedAt: (r.updated_at as Date).toISOString(),
})

export type InBrain = { brain: Brain; role: Role }

// Loads a brain the caller can read. `lock`: 'share' for writes inside the brain (a concurrent archive
// waits for them), 'update' for changing the brain row itself (two of those queue instead of
// deadlocking on a shared lock).
export async function inBrain(
  ctx: Ctx,
  ref: { slug?: string; id?: string },
  lock: 'share' | 'update' | null = null,
): Promise<InBrain> {
  const clause = lock === 'share' ? ' FOR SHARE' : lock === 'update' ? ' FOR UPDATE' : ''
  const row = await ctx.db.one(`SELECT * FROM brains WHERE ${ref.id ? 'id' : 'slug'} = $1${clause}`, [
    ref.id ?? ref.slug,
  ])
  if (!row) throw brainNotFound()
  const role = await roleIn(ctx.db, ctx.who, String(row.id))
  if (!role) throw brainNotFound()
  return { brain: brainOf(row), role }
}

// Asks `can` and, on a refusal, writes the denial to the audit trail and throws it.
export async function allow(ctx: Ctx, action: Action, facts: Facts, brainId?: string): Promise<void> {
  const d = can(actorOf(ctx.who), action, facts)
  if (d.ok) return
  // "Ask a curator" says who they are (spec B4: every denial says whom to ask).
  let how = d.howToProceed
  if (brainId && how.startsWith('Ask a curator of the brain')) {
    const names = await ctx.db.query(
      `SELECT a.name FROM memberships m JOIN accounts a ON a.id = m.account_id
        WHERE m.brain_id = $1 AND m.role = 'curator' AND a.status = 'active' ORDER BY lower(a.name) LIMIT 3`,
      [brainId],
    )
    if (names.length) {
      how = how.replace(
        'Ask a curator of the brain',
        `Ask a curator of the brain (${names.map((n) => n.name).join(', ')})`,
      )
    }
  }
  await audit(ctx.root ?? ctx.db, {
    at: ctx.clock(),
    actorId: ctx.who.accountId,
    credentialId: ctx.who.credential.id,
    action,
    brainId: brainId ?? null,
    outcome: 'denied',
    detail: d.reason,
  })
  throw denied(d.reason, how)
}

export async function ok(ctx: Ctx, action: string, brainId: string | null, target?: string, detail?: string) {
  await audit(ctx.db, {
    at: ctx.clock(),
    actorId: ctx.who.accountId,
    credentialId: ctx.who.credential.id,
    action,
    brainId,
    target: target ?? null,
    outcome: 'ok',
    detail: detail ?? '',
  })
}

// A person's own gesture: the person signed in to the web. Every key — a token, a connection, a service
// key — is an agent's (spec B1: corrections are changed and settled by a person, in the web).
export const personInWeb = (ctx: Ctx): boolean =>
  ctx.who.kind === 'person' && ctx.who.credential.kind === 'web'
