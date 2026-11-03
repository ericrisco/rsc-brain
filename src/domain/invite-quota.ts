// How many invitation mails a service account may make rsc-brain send in an hour (F1-PR2 review): every mail of
// a service counts, from POST /v1/brains/{slug}/invitations and from a brain made with a first curator to invite.
// Counted in the audit (one invitation.mail per mail) while the service holds its own turn, so two requests of
// the same service never both spend the last place.
//
// One lock order for everything that touches invitations (second pass of the review): the service's turn, then
// the emails' turns in sorted order (INVITATION_LOCK), then brain rows, then invitation rows.
import { AppError } from '../core/errors.ts'
import type { Db } from '../db/db.ts'
import { type Ctx, ok } from './context.ts'

export const SERVICE_INVITES_PER_HOUR = 100
const HOUR_MS = 3_600_000

export async function serviceTurn(db: Db, accountId: string): Promise<void> {
  await db.query("SELECT pg_advisory_xact_lock(hashtext('rsc-brain service invites ' || $1))", [accountId])
}

// Past the quota the request is refused (429 invite_quota) and, thrown inside its transaction, nothing changes.
export async function checkQuota(c: Ctx, needed: number, perHour: number): Promise<void> {
  if (needed === 0) return
  const now = c.clock().getTime()
  const rows = await c.db.query<{ at: Date }>(
    `SELECT at FROM audit WHERE actor_id = $1 AND action = 'invitation.mail' AND at > $2 ORDER BY at`,
    [c.who.accountId, new Date(now - HOUR_MS)],
  )
  if (rows.length + needed <= perHour) return
  // The wait until enough of the last hour's mails are an hour old; none helps a request bigger than the quota.
  const freed = needed <= perHour ? rows[rows.length + needed - perHour - 1] : undefined
  const wait = freed ? Math.max(1, Math.ceil((freed.at.getTime() + HOUR_MS - now) / 1000)) : null
  const e = new AppError(
    429,
    'invite_quota',
    `This service account may have rsc-brain mail at most ${perHour} invitations an hour.`,
    wait === null
      ? `Invite at most ${perHour} people without an account in an hour.`
      : `Try again in ${Math.ceil(wait / 60)} minutes; people who already have an account can be added now.`,
  )
  if (wait !== null) {
    e.extra = { retryAfter: wait }
    e.headers = { 'retry-after': String(wait) }
  }
  throw e
}

// One invitation mail spent, in the audit the quota counts.
export async function spendMail(
  c: Ctx,
  brainId: string | null,
  email: string,
  detail: string,
): Promise<void> {
  await ok(c, 'invitation.mail', brainId, email, detail)
}
