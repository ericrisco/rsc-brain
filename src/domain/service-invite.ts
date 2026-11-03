// A service account brings people into a brain it created (plan rsc-factory-brain §3.1, spec C6): the people
// who approve its work there become curators, others readers. Narrow on purpose: only with its main key,
// only when the administration let it invite, only in brains it made and is still in (any other answers as
// one that does not exist, constitution P4). It never takes a role away nor lowers one; it may raise one
// (CA6b: an approver must curate). Each person is audited, and the brain's curators are told who came in or
// rose. A removed account, or someone else's invitation that cannot be taken over, is refused for that person
// alone. Its invitation mails have an hourly quota (invite-quota.ts).
import { type Role, rank } from '../auth/can.ts'
import { brainNotFound, denied, invalid } from '../core/errors.ts'
import { serviceMainKey } from './access.ts'
import { raiseMember } from './brains.ts'
import { type Ctx, ok } from './context.ts'
import { emailOf } from './guards.ts'
import type { Grant, Takeover } from './invitations.ts'
import { INVITATION_LOCK, sendInvitation, storeInvitation, takeOver } from './invitations.ts'
import { checkQuota, SERVICE_INVITES_PER_HOUR, serviceTurn, spendMail } from './invite-quota.ts'
import { curatorsOf, notify } from './notices.ts'

export const SERVICE_INVITE_MAX = 20
const INVITE_ROLES = ['curator', 'reader'] as const

// added: now a member with that role; invited: an invitation to the brain is open; raised: a member, or an
// open invitation, with a lower role now has this one (never lowered); already: nothing changed; refused: not
// done for this person (reason account_removed: their account was removed), the others go ahead.
export const INVITE_STATUSES = ['added', 'invited', 'raised', 'already', 'refused'] as const
export type InviteStatus = (typeof INVITE_STATUSES)[number]
// Why a person was refused: account_removed (their account was removed); invitation_pending_elsewhere (someone
// else's open invitation could not be taken over: no mail, or the new link could not be mailed).
export type RefusedReason = 'account_removed' | 'invitation_pending_elsewhere'
export type ServiceInvited = { email: string; status: InviteStatus; reason?: RefusedReason }

function peopleOf(v: unknown): Array<{ email: string; role: Role }> {
  if (!Array.isArray(v) || v.length < 1 || v.length > SERVICE_INVITE_MAX) {
    throw invalid(
      `"people" is a list of 1 to ${SERVICE_INVITE_MAX} people: [{"email", "role"}].`,
      `Send at most ${SERVICE_INVITE_MAX} at a time.`,
    )
  }
  const out: Array<{ email: string; role: Role }> = []
  for (const p of v) {
    const email = emailOf((p as { email?: unknown } | null)?.email)
    const role = (p as { role?: unknown } | null)?.role
    if (!email || !(INVITE_ROLES as readonly unknown[]).includes(role)) {
      throw invalid(
        'Each person has an "email" and a "role": curator or reader.',
        'Fix the list of people (a service invites as curator or reader only).',
      )
    }
    if (out.some((x) => x.email === email)) {
      throw invalid(`${email} is in the list twice.`, 'Name each person once, with one role.')
    }
    out.push({ email, role: role as Role })
  }
  return out
}

export async function serviceInvite(
  ctx: Ctx,
  slug: string,
  input: { people: unknown },
  perHour: number = SERVICE_INVITES_PER_HOUR,
) {
  serviceMainKey(ctx, 'Inviting people to a brain')
  if (!ctx.who.canInvite) {
    throw denied(
      'This service account may not invite people.',
      'Ask the administration of rsc-brain to let it invite (Admin › Service accounts).',
    )
  }
  const people = peopleOf(input.people)
  // Emails in sorted order: two invitations of the same people at once take their turns the same way.
  const sorted = [...people].sort((x, y) => x.email.localeCompare(y.email))
  type Out = ServiceInvited & {
    role: Role
    mail?: { token: string; grants: Grant[]; isAdmin: boolean; id: string; expiresAt: Date }
    takeover?: Takeover
  }
  const made = await ctx.db.tx(async (db) => {
    const c = { ...ctx, db }
    // One lock order for everyone (invite-quota.ts): the service's turn, the emails' turns, then rows. An
    // acceptance holds an email's turn while it updates a brain row; taking the brain row first deadlocked.
    await serviceTurn(db, ctx.who.accountId)
    for (const p of sorted) await db.query(INVITATION_LOCK, [p.email])
    const b = await db.one<{ id: string; created_by: string | null }>(
      'SELECT id, created_by FROM brains WHERE slug = $1 FOR SHARE',
      [slug],
    )
    const inIt = b
      ? await db.one('SELECT 1 FROM memberships WHERE brain_id = $1 AND account_id = $2', [
          b.id,
          ctx.who.accountId,
        ])
      : undefined
    if (!b || b.created_by !== ctx.who.accountId || !inIt) throw brainNotFound()
    const out: Out[] = []
    for (const p of sorted) {
      const account = await db.one<{ id: string; status: string }>(
        "SELECT id, status FROM accounts WHERE email = $1 AND kind = 'person'",
        [p.email],
      )
      if (account && account.status !== 'active') {
        out.push({ email: p.email, role: p.role, status: 'refused', reason: 'account_removed' })
        continue
      }
      if (account) {
        const status = await raiseMember(db, b.id, account.id, p.role, ctx.clock())
        out.push({ email: p.email, role: p.role, status })
        continue
      }
      // No account: an invitation. One of this service, still open, that brings the person here with this role
      // or a higher one is left as it is; a lower one is raised (CA6b). Someone else's is taken over, whatever it
      // grants, so a link someone else holds never gains this brain (second pass).
      const open = await db.one<{ grants: Grant[]; invited_by: string }>(
        `SELECT grants, invited_by FROM invitations
          WHERE email = $1 AND used_at IS NULL AND revoked_at IS NULL AND expires_at > $2`,
        [p.email, ctx.clock()],
      )
      const had = open?.grants.find((g) => g.brainId === b.id)
      if (open?.invited_by === ctx.who.accountId && had && rank(had.role) >= rank(p.role)) {
        out.push({ email: p.email, role: p.role, status: 'already' })
        continue
      }
      const stored = await storeInvitation(db, ctx.clock, {
        email: p.email,
        grants: [{ brainId: b.id, role: p.role }],
        by: ctx.who.accountId,
        as: 'service',
      })
      out.push({
        email: p.email,
        role: p.role,
        status: had && rank(had.role) < rank(p.role) ? 'raised' : 'invited',
        ...(stored.token
          ? {
              mail: {
                token: stored.token,
                grants: stored.grants,
                isAdmin: stored.isAdmin,
                id: stored.id,
                expiresAt: stored.expiresAt,
              },
            }
          : {}),
        ...(stored.takeover ? { takeover: stored.takeover } : {}),
      })
    }
    await checkQuota(c, out.filter((x) => x.mail).length, perHour)
    for (const x of out) {
      const what = x.reason ? `${x.status} (${x.reason.replaceAll('_', ' ')})` : x.status
      await ok(
        c,
        'invitation.create',
        b.id,
        x.email,
        `${x.role}, ${what}${x.takeover ? ', takeover' : ''}, by a service`,
      )
      if (x.mail) await spendMail(c, b.id, x.email, 'by a service')
    }
    return { brainId: b.id, out }
  })
  // Mail goes after the commit: a slow mail server never holds the invitation back. A takeover is finished only
  // once its mail went out; otherwise that person is refused and the other invitation is left as it was.
  for (const x of made.out) {
    if (!x.mail) continue
    if (x.takeover) {
      const taken = await takeOver(ctx, made.brainId, { email: x.email, ...x.mail, ...x.takeover })
      if (!taken) Object.assign(x, { status: 'refused', reason: 'invitation_pending_elsewhere' })
    } else {
      await sendInvitation(ctx.db, ctx.clock, ctx.mail, { email: x.email, by: ctx.who.name, ...x.mail })
    }
  }
  const came = made.out.filter((x) => x.status !== 'already' && x.status !== 'refused')
  if (came.length > 0) {
    const names = came
      .sort((x, y) => rank(y.role) - rank(x.role) || x.email.localeCompare(y.email))
      .map((x) => `${x.email} (${x.role}${x.status === 'added' ? '' : `, ${x.status}`})`)
    await notify(ctx.db, ctx.clock, ctx.mail, await curatorsOf(ctx.db, made.brainId), {
      kind: 'service.invited',
      brainId: made.brainId,
      subject: `The service account "${ctx.who.name}" brought people into "${slug}"`,
      text: `The service account "${ctx.who.name}" brought into "${slug}": ${names.join(', ')}.`,
    })
  }
  const byEmail = new Map(made.out.map((x) => [x.email, x]))
  return {
    invited: people.map((p): ServiceInvited => {
      const x = byEmail.get(p.email) as ServiceInvited
      return { email: p.email, status: x.status, ...(x.reason ? { reason: x.reason } : {}) }
    }),
  }
}
