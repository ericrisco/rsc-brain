// What every domain operation receives: the database (or the open transaction), the clock and who is
// calling. Brain-scoped operations go through `inBrain`, which loads the brain, works out the role
// through the key, and answers "not found" for anyone without access (constitution P4).
import { type Action, can, type Facts, type Role } from '../auth/can.ts'
import { actorOf, type Principal, roleIn } from '../auth/principal.ts'
import type { Clock } from '../core/clock.ts'
import { brainNotFound, denied } from '../core/errors.ts'
import type { Db } from '../db/db.ts'
import { audit } from './audit.ts'

export type Ctx = { db: Db; clock: Clock; who: Principal }

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

// Loads a brain the caller can read. `lock` takes a row lock so a concurrent archive cannot slip
// between the check and the write.
export async function inBrain(ctx: Ctx, ref: { slug?: string; id?: string }, lock = false): Promise<InBrain> {
  const row = await ctx.db.one(
    `SELECT * FROM brains WHERE ${ref.id ? 'id' : 'slug'} = $1${lock ? ' FOR SHARE' : ''}`,
    [ref.id ?? ref.slug],
  )
  if (!row) throw brainNotFound()
  const role = await roleIn(ctx.db, ctx.who, String(row.id))
  if (!role) throw brainNotFound()
  return { brain: brainOf(row), role }
}

// Asks `can` and, on a refusal, writes the denial to the audit trail and throws it.
export async function allow(ctx: Ctx, action: Action, facts: Facts, brainId?: string): Promise<void> {
  const d = can(actorOf(ctx.who), action, facts)
  if (d.ok) return
  await audit(ctx.db, {
    at: ctx.clock(),
    actorId: ctx.who.accountId,
    credentialId: ctx.who.credential.id,
    action,
    brainId: brainId ?? null,
    outcome: 'denied',
    detail: d.reason,
  })
  throw denied(d.reason, d.howToProceed)
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
