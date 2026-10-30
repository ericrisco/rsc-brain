// Invitations (spec B4 «Invitar»): the administration (or a curator, when the installation allows it)
// invites emails to brains with a role each. The link works once and for 72 hours; it goes by mail, and
// the administration can always copy it (no mail set up, or a failed send). Only its hash is kept.
import { atLeast, ROLES, type Role } from '../auth/can.ts'
import { checkPassword, hashPassword } from '../auth/password.ts'
import { memberRole } from '../auth/principal.ts'
import { hashSecret, newSecret } from '../auth/secrets.ts'
import type { Clock } from '../core/clock.ts'
import { AppError, brainNotFound, conflict, invalid, notFound } from '../core/errors.ts'
import { newId } from '../core/ids.ts'
import type { Db, Row } from '../db/db.ts'
import { type Outbox, send } from '../mail/mail.ts'
import { createAccount } from './accounts.ts'
import { audit } from './audit.ts'
import { addMember } from './brains.ts'
import { type Ctx, ok } from './context.ts'
import { emailOf, inWeb } from './guards.ts'
import { type ConnFacts, installation, requireSecure } from './installation.ts'
import { mintWebSession } from './keys.ts'

export const INVITE_HOURS = 72
export const MAX_EMAILS = 50

export type Grant = { brainId: string; role: Role }

export type Invited = {
  id: string
  email: string
  link: string
  expiresAt: string
  mailed: boolean
  mailError: string | null
}

const linkOf = async (db: Db, token: string) =>
  `${(await installation(db)).publicUrl ?? ''}/invite#token=${token}`

async function brainNames(db: Db, grants: Grant[]): Promise<Map<string, { slug: string; name: string }>> {
  const rows = await db.query('SELECT id, slug, name FROM brains WHERE id = ANY($1)', [
    grants.map((g) => g.brainId),
  ])
  return new Map(rows.map((r) => [String(r.id), { slug: String(r.slug), name: String(r.name) }]))
}

async function mailInvitation(
  db: Db,
  clock: Clock,
  outbox: Outbox | undefined,
  o: { email: string; link: string; by: string; grants: Grant[]; isAdmin: boolean },
): Promise<{ sent: boolean; error: string | null }> {
  const inst = (await installation(db)).name || 'RSC Brain'
  const names = await brainNames(db, o.grants)
  const lines = o.grants
    .map((g) => names.get(g.brainId))
    .map((b, i) => (b ? `- ${b.name} (${o.grants[i]?.role})` : null))
    .filter(Boolean)
  return send(db, clock, outbox, 'invitation', {
    to: o.email,
    subject: `${o.by} invited you to ${inst}`,
    text: [
      `${o.by} invited you to ${inst}, a shared memory for people and their AI agents.`,
      '',
      ...(lines.length ? ['You will join:', ...lines, ''] : []),
      ...(o.isAdmin ? ['You will also administer the installation.', ''] : []),
      'Open this link to choose your name and password. It works once, for 72 hours:',
      o.link,
      '',
      'If you did not expect this, ignore this mail.',
    ].join('\n'),
  })
}

// Stores one invitation. Invitations to one email take turns (callers lock emails in sorted order).
// Who stores it decides what happens when the email already has one that was never used:
// - a curator never touches it (409): its link, and whatever it grants, stay with whoever made it;
// - the administration adds these grants to an open one, takes it over and makes its link again (the
//   old link stops working). An expired one is closed, and a new one is made;
// - a service naming a first curator adds the grant to an open one, keeping its link (nothing new is
//   mailed, and the link stays with whoever has it); an expired one is closed, and a new one is made.
// A closed expired invitation passes on the first-curator places of brains still waiting for this
// email, never the administrator rights.
export async function storeInvitation(
  db: Db,
  clock: Clock,
  o: {
    email: string
    grants: Grant[]
    isAdmin?: boolean
    canCreateBrains?: boolean
    by: string
    as: 'admin' | 'service' | 'curator'
  },
): Promise<{ id: string; token: string | null; expiresAt: Date; grants: Grant[]; isAdmin: boolean }> {
  const now = clock()
  const token = newSecret()
  const expiresAt = new Date(now.getTime() + INVITE_HOURS * 3_600_000)
  await db.query("SELECT pg_advisory_xact_lock(hashtext('rsc-brain invitation ' || $1))", [o.email])
  const unused = await db.one<Row>(
    'SELECT * FROM invitations WHERE email = $1 AND used_at IS NULL AND revoked_at IS NULL FOR UPDATE',
    [o.email],
  )
  if (unused && o.as === 'curator') {
    throw conflict(
      'invitation_open',
      `${o.email} already has an invitation that was not used yet.`,
      'Once the person is in, add them to your brain; or ask the administration.',
    )
  }
  const merge = (base: Grant[]) => {
    const grants = [...base]
    for (const g of o.grants) {
      const i = grants.findIndex((x) => x.brainId === g.brainId)
      if (i < 0) grants.push(g)
      else grants[i] = g
    }
    return grants
  }
  let carried: Grant[] = []
  if (unused && (unused.expires_at as Date).getTime() <= now.getTime()) {
    await db.query('UPDATE invitations SET revoked_at = $2 WHERE id = $1', [unused.id, now])
    const waiting = await db.query('SELECT id FROM brains WHERE pending_curator_email = $1', [o.email])
    const ids = new Set(waiting.map((b) => String(b.id)))
    carried = (unused.grants as Grant[]).filter((g) => g.role === 'curator' && ids.has(g.brainId))
  } else if (unused) {
    const grants = merge(unused.grants as Grant[])
    if (o.as === 'service') {
      await db.query('UPDATE invitations SET grants = $2 WHERE id = $1', [unused.id, JSON.stringify(grants)])
      return {
        id: String(unused.id),
        token: null,
        expiresAt: unused.expires_at as Date,
        grants,
        isAdmin: Boolean(unused.is_admin),
      }
    }
    const isAdmin = Boolean(unused.is_admin) || Boolean(o.isAdmin)
    await db.query(
      `UPDATE invitations SET grants = $2, is_admin = $3, can_create_brains = can_create_brains OR $4,
              token_hash = $5, expires_at = $6, invited_by = $7 WHERE id = $1`,
      [
        unused.id,
        JSON.stringify(grants),
        isAdmin,
        Boolean(o.canCreateBrains),
        hashSecret(token),
        expiresAt,
        o.by,
      ],
    )
    return { id: String(unused.id), token, expiresAt, grants, isAdmin }
  }
  const grants = merge(carried)
  const id = newId('inv')
  await db.query(
    `INSERT INTO invitations (id, email, token_hash, grants, is_admin, can_create_brains, invited_by, created_at, expires_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
    [
      id,
      o.email,
      hashSecret(token),
      JSON.stringify(grants),
      Boolean(o.isAdmin),
      Boolean(o.canCreateBrains),
      o.by,
      now,
      expiresAt,
    ],
  )
  return { id, token, expiresAt, grants, isAdmin: Boolean(o.isAdmin) }
}

// Sends the mail of an invitation already stored; used when a service account names a curator by email.
export async function sendInvitation(
  db: Db,
  clock: Clock,
  outbox: Outbox | undefined,
  o: { email: string; token: string; by: string; grants: Grant[]; isAdmin: boolean },
) {
  const link = await linkOf(db, o.token)
  return { link, ...(await mailInvitation(db, clock, outbox, { ...o, link })) }
}

export type InviteInput = {
  emails: unknown
  brains?: unknown // [{ slug, role }]
  isAdmin?: unknown
  canCreateBrains?: unknown
}

function grantsOf(v: unknown): Array<{ slug: string; role: Role }> {
  if (v === undefined || v === null) return []
  if (!Array.isArray(v) || v.length > 100) {
    throw invalid('"brains" is a list of {"slug", "role"}.', 'Send at most 100 brains.')
  }
  return v.map((g) => {
    const slug = (g as { slug?: unknown })?.slug
    const role = (g as { role?: unknown })?.role
    if (typeof slug !== 'string' || !ROLES.includes(role as Role)) {
      throw invalid(
        'Each brain of an invitation has a "slug" and a "role" (curator, contributor or reader).',
        'Fix the list of brains.',
      )
    }
    return { slug, role: role as Role }
  })
}

// Who may invite: the administration, anyone and anywhere; a curator, when the installation allows it,
// only to brains they curate, and never as an administrator or with the right to create brains.
export async function invite(ctx: Ctx, input: InviteInput): Promise<Invited[]> {
  inWeb(ctx, 'Inviting people')
  const raw = Array.isArray(input.emails) ? input.emails : [input.emails]
  if (raw.length === 0 || raw.length > MAX_EMAILS) {
    throw invalid(`Invite 1 to ${MAX_EMAILS} emails at a time.`, 'Send "emails" as a list.')
  }
  const emails: string[] = []
  for (const v of raw) {
    const e = emailOf(v)
    if (!e)
      throw invalid(
        `"${String(v).slice(0, 80)}" is not an email.`,
        'Give plain emails such as ana@example.com.',
      )
    if (!emails.includes(e)) emails.push(e)
  }
  // Sorted, so two invitations of the same emails at once take their turns in the same order.
  emails.sort()
  const isAdmin = input.isAdmin === true
  const canCreateBrains = input.canCreateBrains === true
  const asked = grantsOf(input.brains)
  const admin = ctx.who.isAdmin && ctx.who.kind === 'person'
  const made = await ctx.db.tx(async (db) => {
    if (!admin) {
      const inst = await installation(db)
      if (!inst.curatorsInvite || ctx.who.kind !== 'person') {
        throw new AppError(
          403,
          'forbidden',
          'Only the administration invites new people to this installation.',
          'Ask the administration, or add someone who already has an account to your brain.',
        )
      }
      if (isAdmin || canCreateBrains || asked.length === 0) {
        throw new AppError(
          403,
          'forbidden',
          'A curator invites people only to the brains they curate, with a role there.',
          'Choose brains you curate; the administration gives wider permissions.',
        )
      }
    }
    const grants: Grant[] = []
    for (const g of asked) {
      const b = await db.one<{ id: string }>('SELECT id FROM brains WHERE slug = $1', [g.slug])
      if (!b) throw brainNotFound()
      if (!admin && !atLeast(await memberRole(db, b.id, ctx.who.accountId), 'curator')) throw brainNotFound()
      if (!grants.some((x) => x.brainId === b.id)) grants.push({ brainId: b.id, role: g.role })
    }
    const out: Array<{ email: string; stored: Awaited<ReturnType<typeof storeInvitation>> }> = []
    for (const email of emails) {
      const has = await db.one<{ status: string }>('SELECT status FROM accounts WHERE email = $1', [email])
      if (has) {
        throw conflict(
          'email_taken',
          `${email} already has an account${has.status === 'removed' ? ' (removed)' : ''}.`,
          has.status === 'removed'
            ? 'The administration can reactivate it, then add it to brains.'
            : 'Add that person to the brain as a member instead.',
        )
      }
      const stored = await storeInvitation(db, ctx.clock, {
        email,
        grants,
        isAdmin,
        canCreateBrains,
        by: ctx.who.accountId,
        as: admin ? 'admin' : 'curator',
      })
      out.push({ email, stored })
      await ok({ ...ctx, db }, 'invitation.create', null, email, describe(grants, isAdmin))
    }
    return out
  })
  // Mail goes after the commit: a slow mail server never holds the invitation back.
  const result: Invited[] = []
  for (const { email, stored } of made) {
    // The administration and curators always get a fresh link.
    if (!stored.token) continue
    const sent = await sendInvitation(ctx.db, ctx.clock, ctx.mail, {
      email,
      token: stored.token,
      by: ctx.who.name,
      grants: stored.grants,
      isAdmin: stored.isAdmin,
    })
    result.push({
      id: stored.id,
      email,
      link: sent.link,
      expiresAt: stored.expiresAt.toISOString(),
      mailed: sent.sent,
      mailError: sent.error,
    })
  }
  return result
}

const describe = (grants: Grant[], isAdmin: boolean) =>
  [...grants.map((g) => `${g.role} of ${g.brainId}`), ...(isAdmin ? ['administrator'] : [])].join(', ')

export type InvitationListed = {
  id: string
  email: string
  status: 'pending' | 'expired' | 'used' | 'revoked'
  brains: Array<{ slug: string; role: Role }>
  isAdmin: boolean
  invitedBy: string
  createdAt: string
  expiresAt: string
}

// The administration sees every invitation; a curator who may invite sees the ones they sent.
export async function listInvitations(ctx: Ctx): Promise<InvitationListed[]> {
  inWeb(ctx, 'Managing invitations')
  const admin = ctx.who.isAdmin && ctx.who.kind === 'person'
  const rows = await ctx.db.query(
    `SELECT i.*, a.name AS by_name FROM invitations i JOIN accounts a ON a.id = i.invited_by
      WHERE ($1 OR i.invited_by = $2) ORDER BY i.created_at DESC LIMIT 500`,
    [admin, ctx.who.accountId],
  )
  const now = ctx.clock().getTime()
  const out: InvitationListed[] = []
  for (const r of rows) {
    if (!(await inReach(ctx, ctx.db, r))) continue
    const grants = r.grants as Grant[]
    const names = await brainNames(ctx.db, grants)
    out.push({
      id: String(r.id),
      email: String(r.email),
      status:
        r.used_at != null
          ? 'used'
          : r.revoked_at != null
            ? 'revoked'
            : (r.expires_at as Date).getTime() <= now
              ? 'expired'
              : 'pending',
      brains: grants.flatMap((g) => {
        const b = names.get(g.brainId)
        return b ? [{ slug: b.slug, role: g.role }] : []
      }),
      isAdmin: Boolean(r.is_admin),
      invitedBy: String(r.by_name),
      createdAt: (r.created_at as Date).toISOString(),
      expiresAt: (r.expires_at as Date).toISOString(),
    })
  }
  return out
}

// A curator reaches an invitation only while it is still one they could make today: theirs, no
// administrator nor brain-creating rights, and only brains they curate now.
async function inReach(ctx: Ctx, db: Db, r: Row): Promise<boolean> {
  if (ctx.who.isAdmin && ctx.who.kind === 'person') return true
  if (r.invited_by !== ctx.who.accountId || r.is_admin || r.can_create_brains) return false
  for (const g of r.grants as Grant[]) {
    if (!atLeast(await memberRole(db, g.brainId, ctx.who.accountId), 'curator')) return false
  }
  return true
}

async function mine(ctx: Ctx, db: Db, id: string, resend: boolean): Promise<Row> {
  const r = await db.one<Row>('SELECT * FROM invitations WHERE id = $1 FOR UPDATE', [id])
  if (!r || !(await inReach(ctx, db, r))) throw notFound('invitation')
  if (resend && !(ctx.who.isAdmin && ctx.who.kind === 'person') && !(await installation(db)).curatorsInvite) {
    throw new AppError(
      403,
      'forbidden',
      'Curators may no longer invite in this installation.',
      'Ask the administration to resend or withdraw it.',
    )
  }
  return r
}

// A new link (the old one stops working) for 72 more hours, sent again.
export async function resendInvitation(ctx: Ctx, id: string): Promise<Invited> {
  inWeb(ctx, 'Managing invitations')
  const token = newSecret()
  const now = ctx.clock()
  const expiresAt = new Date(now.getTime() + INVITE_HOURS * 3_600_000)
  const r = await ctx.db.tx(async (db) => {
    const r = await mine(ctx, db, id, true)
    if (r.used_at != null || r.revoked_at != null) {
      throw conflict(
        'invitation_closed',
        'This invitation was already used or withdrawn.',
        'Invite the email again if it still needs access.',
      )
    }
    await db.query('UPDATE invitations SET token_hash = $2, expires_at = $3 WHERE id = $1', [
      id,
      hashSecret(token),
      expiresAt,
    ])
    await ok({ ...ctx, db }, 'invitation.resend', null, String(r.email))
    return r
  })
  const sent = await sendInvitation(ctx.db, ctx.clock, ctx.mail, {
    email: String(r.email),
    token,
    by: ctx.who.name,
    grants: r.grants as Grant[],
    isAdmin: Boolean(r.is_admin),
  })
  return {
    id,
    email: String(r.email),
    link: sent.link,
    expiresAt: expiresAt.toISOString(),
    mailed: sent.sent,
    mailError: sent.error,
  }
}

export async function revokeInvitation(ctx: Ctx, id: string): Promise<void> {
  inWeb(ctx, 'Managing invitations')
  await ctx.db.tx(async (db) => {
    const r = await mine(ctx, db, id, false)
    if (r.used_at != null) {
      throw conflict(
        'invitation_closed',
        'This invitation was already used.',
        'Remove the person, or change their roles.',
      )
    }
    if (r.revoked_at != null) return
    await db.query('UPDATE invitations SET revoked_at = $2 WHERE id = $1', [id, ctx.clock()])
    // A brain waiting for this person as its first curator no longer waits.
    await db.query('UPDATE brains SET pending_curator_email = NULL WHERE pending_curator_email = $1', [
      r.email,
    ])
    await ok({ ...ctx, db }, 'invitation.revoke', null, String(r.email))
  })
}

const badInvitation = () =>
  new AppError(
    400,
    'invitation_invalid',
    'This invitation link is not valid: it expired, was already used, or was withdrawn.',
    'Ask an administrator to send a new one.',
  )

// What the invitation page shows before the person accepts.
export async function lookInvitation(db: Db, clock: Clock, token: unknown) {
  if (typeof token !== 'string' || !token) throw badInvitation()
  const r = await db.one<Row>(
    'SELECT * FROM invitations WHERE token_hash = $1 AND used_at IS NULL AND revoked_at IS NULL AND expires_at > $2',
    [hashSecret(token), clock()],
  )
  if (!r) throw badInvitation()
  const grants = r.grants as Grant[]
  const names = await brainNames(db, grants)
  return {
    email: String(r.email),
    installation: (await installation(db)).name,
    brains: grants.flatMap((g) => {
      const b = names.get(g.brainId)
      return b ? [{ slug: b.slug, name: b.name, role: g.role }] : []
    }),
    isAdmin: Boolean(r.is_admin),
    expiresAt: (r.expires_at as Date).toISOString(),
  }
}

// The person accepts: an account with their name and password, the roles they were given, and a web
// session. The link works once.
export async function acceptInvitation(
  db: Db,
  clock: Clock,
  conn: ConnFacts,
  input: { token: unknown; name: unknown; password: unknown },
) {
  requireSecure(conn)
  if (typeof input.token !== 'string' || !input.token) throw badInvitation()
  const name = typeof input.name === 'string' ? input.name.trim() : ''
  if (!name || name.length > 80)
    throw invalid('Your name has 1 to 80 characters.', 'Type the name others will see.')
  const password = checkPassword(input.password)
  const hash = await hashPassword(password)
  const now = clock()
  const out = await db.tx(async (tx) => {
    const r = await tx.one<Row>(
      'SELECT * FROM invitations WHERE token_hash = $1 AND used_at IS NULL AND revoked_at IS NULL AND expires_at > $2 FOR UPDATE',
      [hashSecret(input.token as string), now],
    )
    if (!r) throw badInvitation()
    const email = String(r.email)
    const id = await createAccount(tx, clock, {
      kind: 'person',
      name,
      email,
      isAdmin: Boolean(r.is_admin),
      canCreateBrains: Boolean(r.can_create_brains),
    })
    await tx.query('UPDATE accounts SET password_hash = $2 WHERE id = $1', [id, hash])
    const grants = r.grants as Grant[]
    const alive = await brainNames(tx, grants)
    for (const g of grants) {
      if (!alive.has(g.brainId)) continue
      await addMember(tx, g.brainId, id, g.role, now)
      if (g.role === 'curator') {
        await tx.query(
          'UPDATE brains SET pending_curator_email = NULL WHERE id = $1 AND pending_curator_email = $2',
          [g.brainId, email],
        )
      }
    }
    await tx.query('UPDATE invitations SET used_at = $2, account_id = $3 WHERE id = $1', [r.id, now, id])
    for (const g of grants) {
      if (!alive.has(g.brainId)) continue
      await audit(tx, {
        at: now,
        actorId: id,
        credentialId: null,
        action: 'member.join',
        brainId: g.brainId,
        target: id,
        outcome: 'ok',
        detail: `${g.role}, by invitation`,
      })
    }
    await audit(tx, {
      at: now,
      actorId: id,
      credentialId: null,
      action: 'invitation.accept',
      target: email,
      outcome: 'ok',
      detail: `from ${conn.ip}`,
    })
    // What the person joined, for the welcome of the web.
    const brains = grants.flatMap((g) => {
      const b = alive.get(g.brainId)
      return b ? [{ slug: b.slug, name: b.name, role: g.role }] : []
    })
    return { id, email, isAdmin: Boolean(r.is_admin), brains }
  })
  const s = await mintWebSession(db, clock, { accountId: out.id })
  return {
    session: s.secret,
    account: { id: out.id, name, email: out.email, isAdmin: out.isAdmin },
    brains: out.brains,
  }
}
