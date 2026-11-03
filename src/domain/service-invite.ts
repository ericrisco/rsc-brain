// A service account brings people into a brain it created (plan rsc-factory-brain §3.1, spec C6): the people
// who approve its work there become curators, others readers. Narrow on purpose: only with its main key,
// only when the administration let it invite, only in brains it made and is still in (any other answers as
// one that does not exist, constitution P4). It never takes a role away nor changes one. Each person is
// audited, and the brain's curators are told who came in.
import { type Role, rank } from '../auth/can.ts'
import { brainNotFound, conflict, denied, invalid } from '../core/errors.ts'
import { serviceMainKey } from './access.ts'
import { addMember } from './brains.ts'
import { type Ctx, ok } from './context.ts'
import { emailOf } from './guards.ts'
import type { Grant } from './invitations.ts'
import { sendInvitation, storeInvitation } from './invitations.ts'
import { curatorsOf, notify } from './notices.ts'

export const SERVICE_INVITE_MAX = 20
const INVITE_ROLES = ['curator', 'reader'] as const

export type ServiceInvited = { email: string; status: 'added' | 'invited' | 'already' }

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

export async function serviceInvite(ctx: Ctx, slug: string, input: { people: unknown }) {
  serviceMainKey(ctx, 'Inviting people to a brain')
  if (!ctx.who.canInvite) {
    throw denied(
      'This service account may not invite people.',
      'Ask the administration of rsc-brain to let it invite (Admin › Service accounts).',
    )
  }
  const people = peopleOf(input.people)
  const made = await ctx.db.tx(async (db) => {
    const c = { ...ctx, db }
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
    const out: Array<
      ServiceInvited & { role: Role; mail?: { token: string; grants: Grant[]; isAdmin: boolean } }
    > = []
    // Emails in sorted order: two invitations of the same people at once take their turns the same way.
    for (const p of [...people].sort((x, y) => x.email.localeCompare(y.email))) {
      const account = await db.one<{ id: string; status: string }>(
        "SELECT id, status FROM accounts WHERE email = $1 AND kind = 'person'",
        [p.email],
      )
      if (account && account.status !== 'active') {
        throw conflict(
          'email_taken',
          `${p.email} has an account that was removed.`,
          'The administration of rsc-brain can reactivate it; then invite the person again.',
        )
      }
      if (account) {
        const member = await db.one('SELECT 1 FROM memberships WHERE brain_id = $1 AND account_id = $2', [
          b.id,
          account.id,
        ])
        if (!member) await addMember(db, b.id, account.id, p.role, ctx.clock())
        out.push({ email: p.email, role: p.role, status: member ? 'already' : 'added' })
        continue
      }
      // No account: an invitation. One still open that already brings the person here is left as it is (its
      // role never lowered), under the lock storeInvitation takes too.
      await db.query("SELECT pg_advisory_xact_lock(hashtext('rsc-brain invitation ' || $1))", [p.email])
      const open = await db.one<{ grants: Grant[] }>(
        `SELECT grants FROM invitations
          WHERE email = $1 AND used_at IS NULL AND revoked_at IS NULL AND expires_at > $2`,
        [p.email, ctx.clock()],
      )
      if (open?.grants.some((g) => g.brainId === b.id)) {
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
        status: 'invited',
        ...(stored.token
          ? { mail: { token: stored.token, grants: stored.grants, isAdmin: stored.isAdmin } }
          : {}),
      })
    }
    for (const x of out)
      await ok(c, 'invitation.create', b.id, x.email, `${x.role}, ${x.status}, by a service`)
    return { brainId: b.id, out }
  })
  // Mail goes after the commit: a slow mail server never holds the invitation back.
  for (const x of made.out) {
    if (x.mail) {
      await sendInvitation(ctx.db, ctx.clock, ctx.mail, { email: x.email, by: ctx.who.name, ...x.mail })
    }
  }
  const came = made.out.filter((x) => x.status !== 'already')
  if (came.length > 0) {
    const names = came
      .sort((x, y) => rank(y.role) - rank(x.role) || x.email.localeCompare(y.email))
      .map((x) => `${x.email} (${x.role}${x.status === 'invited' ? ', invited' : ''})`)
    await notify(ctx.db, ctx.clock, ctx.mail, await curatorsOf(ctx.db, made.brainId), {
      kind: 'service.invited',
      brainId: made.brainId,
      subject: `The service account "${ctx.who.name}" brought people into "${slug}"`,
      text: `The service account "${ctx.who.name}" brought into "${slug}": ${names.join(', ')}.`,
    })
  }
  const byEmail = new Map(made.out.map((x) => [x.email, x.status]))
  return {
    invited: people.map((p) => ({
      email: p.email,
      status: byEmail.get(p.email) as ServiceInvited['status'],
    })),
  }
}
