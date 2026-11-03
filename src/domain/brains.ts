// Brains: create, list, read, archive, delete; and the memberships that give access to them (spec B1
// «Cerebros»; the full membership management is spec B4).
import type { Role } from '../auth/can.ts'
import { roleIn } from '../auth/principal.ts'
import { brainNotFound, conflict, invalid } from '../core/errors.ts'
import { newId } from '../core/ids.ts'
import type { Db } from '../db/db.ts'
import { accountByEmail } from './accounts.ts'
import { allow, type Brain, brainOf, type Ctx, inBrain, ok } from './context.ts'
import { inWeb } from './guards.ts'
import { INVITATION_LOCK, sendInvitation, storeInvitation } from './invitations.ts'
import { checkQuota, SERVICE_INVITES_PER_HOUR, serviceTurn, spendMail } from './invite-quota.ts'

const SLUG = /^[a-z0-9]+(-[a-z0-9]+)*$/
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

export type NewBrain = {
  slug: string
  name: string
  description?: string
  purpose?: string
  // A service account must name the first curator: an existing account id or email, or (when it may
  // invite) the email of someone without an account yet, who stays as the pending curator.
  firstCurator?: string
}

function text(v: string | undefined, max: number, field: string): string {
  const s = (v ?? '').trim()
  if (s.length > max) throw invalid(`The ${field} is longer than ${max} characters.`, `Shorten the ${field}.`)
  return s
}

export async function addMember(
  db: Db,
  brainId: string,
  accountId: string,
  role: Role,
  at: Date,
): Promise<void> {
  if (role === 'curator') {
    const a = await db.one<{ kind: string }>('SELECT kind FROM accounts WHERE id = $1', [accountId])
    if (a?.kind === 'service') {
      throw invalid('A service account is never a curator.', 'Give it the contributor or reader role.')
    }
  }
  await db.query(
    `INSERT INTO memberships (brain_id, account_id, role, created_at) VALUES ($1, $2, $3, $4)
     ON CONFLICT (brain_id, account_id) DO UPDATE SET role = EXCLUDED.role`,
    [brainId, accountId, role, at],
  )
}

// A person joins a brain with a role, or rises to it; never lowered (spec C6: a service never takes a role
// away). One statement, so a role given at the same time by someone else is never overwritten with a lower
// one: the row it conflicts with is re-read under its lock, and only a higher role replaces it.
const RANK_SQL = (r: string) => `array_position(ARRAY['reader', 'contributor', 'curator'], ${r})`
export async function raiseMember(
  db: Db,
  brainId: string,
  accountId: string,
  role: Role,
  at: Date,
): Promise<'added' | 'raised' | 'already'> {
  const r = await db.one<{ added: boolean }>(
    `INSERT INTO memberships (brain_id, account_id, role, created_at) VALUES ($1, $2, $3, $4)
     ON CONFLICT (brain_id, account_id) DO UPDATE SET role = EXCLUDED.role
       WHERE ${RANK_SQL('memberships.role')} < ${RANK_SQL('EXCLUDED.role')}
     RETURNING (xmax = 0) AS added`,
    [brainId, accountId, role, at],
  )
  return !r ? 'already' : r.added ? 'added' : 'raised'
}

export async function createBrain(
  ctx: Ctx,
  input: NewBrain,
  perHour: number = SERVICE_INVITES_PER_HOUR,
): Promise<Brain> {
  await allow(ctx, 'brain.create', {})
  const slug = (input.slug ?? '').trim()
  if (!SLUG.test(slug) || slug.length < 2 || slug.length > 64) {
    throw invalid(
      'A brain name (slug) is 2 to 64 lowercase letters, digits and single hyphens.',
      'Use something like "youtube-channel".',
    )
  }
  const name = text(input.name, 80, 'name') || slug
  const description = text(input.description, 2000, 'description')
  const purpose = text(input.purpose, 1000, 'purpose')
  const now = ctx.clock()
  const named = ctx.who.kind === 'service' ? input.firstCurator?.trim() : undefined
  const made = await ctx.db.tx(async (db) => {
    // The lock order of every invitation (invite-quota.ts): the service's turn, the email's, then rows.
    if (named?.includes('@')) {
      await serviceTurn(db, ctx.who.accountId)
      await db.query(INVITATION_LOCK, [named.toLowerCase()])
    }
    const id = newId('brn')
    let curatorId: string | null = null
    let pendingEmail: string | null = null
    if (ctx.who.kind === 'service') {
      if (!named) {
        throw invalid(
          'A service account must name the first curator of a brain it creates.',
          'Pass "firstCurator": the email of a person who will curate it.',
        )
      }
      const found = named.includes('@')
        ? await accountByEmail(db, named)
        : await db.one<{ id: string; status: string }>(
            "SELECT id, status FROM accounts WHERE id = $1 AND kind = 'person'",
            [named],
          )
      if (found && found.status === 'active') curatorId = found.id
      else if (EMAIL.test(named) && !found && ctx.who.canInvite) pendingEmail = named.toLowerCase()
      else {
        throw invalid(
          'The first curator must be an active person account.',
          ctx.who.canInvite
            ? 'Name an existing person, or an email to invite.'
            : 'Name an existing person (this service account may not invite).',
        )
      }
    }
    // Someone else's open invitation for the first curator: refused before anything is written (fourth pass).
    // A takeover would need a mail sent after the commit, and a brain made and then undone raced with whatever
    // used it meanwhile. Under the email's turn, so the answer holds until the commit.
    if (pendingEmail) {
      const open = await db.one<{ invited_by: string }>(
        `SELECT invited_by FROM invitations
          WHERE email = $1 AND used_at IS NULL AND revoked_at IS NULL AND expires_at > $2`,
        [pendingEmail, now],
      )
      if (open && open.invited_by !== ctx.who.accountId) {
        throw conflict(
          'invitation_pending_elsewhere',
          `${pendingEmail} has an open rsc-brain invitation from someone else.`,
          'Ask an administrator of rsc-brain to resend or withdraw that invitation, then create the brain again, or name another first curator.',
        )
      }
    }
    try {
      await db.query(
        `INSERT INTO brains (id, slug, name, description, purpose, pending_curator_email, created_by, created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $8)`,
        [id, slug, name, description, purpose, pendingEmail, ctx.who.accountId, now],
      )
    } catch (err) {
      if ((err as { code?: string }).code === '23505') {
        throw conflict('brain_exists', `A brain named "${slug}" already exists.`, 'Choose another name.')
      }
      throw err
    }
    if (ctx.who.kind === 'person') await addMember(db, id, ctx.who.accountId, 'curator', now)
    else {
      await addMember(db, id, ctx.who.accountId, 'contributor', now)
      if (curatorId) await addMember(db, id, curatorId, 'curator', now)
    }
    await ok({ ...ctx, db }, 'brain.create', id, slug)
    // The pending curator gets an invitation to curate this brain (spec B4 CA31).
    const invitation = pendingEmail
      ? await storeInvitation(db, ctx.clock, {
          email: pendingEmail,
          grants: [{ brainId: id, role: 'curator' }],
          by: ctx.who.accountId,
          as: 'service',
        })
      : null
    if (invitation) await ok({ ...ctx, db }, 'invitation.create', id, pendingEmail ?? '', 'first curator')
    // Its mail spends the service's quota (429 invite_quota: nothing is made).
    if (invitation?.token && pendingEmail) {
      await checkQuota({ ...ctx, db }, 1, perHour)
      await spendMail({ ...ctx, db }, id, pendingEmail, 'first curator, by a service')
    }
    const row = await db.one('SELECT * FROM brains WHERE id = $1', [id])
    return { brain: brainOf(row as Record<string, unknown>), invitation, pendingEmail }
  })
  // A new invitation is mailed; one this service made just gains the brain (its link stays).
  if (made.invitation?.token && made.pendingEmail) {
    await sendInvitation(ctx.db, ctx.clock, ctx.mail, {
      email: made.pendingEmail,
      token: made.invitation.token,
      by: ctx.who.name,
      grants: made.invitation.grants,
      isAdmin: made.invitation.isAdmin,
    })
  }
  return made.brain
}

// createdByYou: the account behind this key created the brain (a program that lost the reply to its creation
// adopts only a brain it made itself: plan rsc-factory-brain, T010).
export type BrainListed = Brain & { role: Role; createdByYou: boolean }

export async function listBrains(ctx: Ctx): Promise<BrainListed[]> {
  const rows = await ctx.db.query(
    `SELECT b.* FROM brains b JOIN memberships m ON m.brain_id = b.id
      WHERE m.account_id = $1 ORDER BY b.slug`,
    [ctx.who.accountId],
  )
  // roleIn narrows each membership through the key: a token's scope, a short key's brains.
  const out: BrainListed[] = []
  for (const r of rows) {
    const role = await roleIn(ctx.db, ctx.who, String(r.id))
    if (role) out.push({ ...brainOf(r), role, createdByYou: r.created_by === ctx.who.accountId })
  }
  return out
}

export async function getBrain(ctx: Ctx, slug: string): Promise<BrainListed> {
  const { brain, role } = await inBrain(ctx, { slug })
  const made = await ctx.db.one<{ created_by: string | null }>(
    'SELECT created_by FROM brains WHERE id = $1',
    [brain.id],
  )
  return { ...brain, role, createdByYou: made?.created_by === ctx.who.accountId }
}

export async function setArchived(ctx: Ctx, slug: string, archived: boolean): Promise<Brain> {
  return ctx.db.tx(async (db) => {
    const c = { ...ctx, db }
    const { brain, role } = await inBrain(c, { slug }, 'update')
    await allow(c, 'brain.archive', { role }, brain.id)
    const row = await db.one('UPDATE brains SET status = $2, updated_at = $3 WHERE id = $1 RETURNING *', [
      brain.id,
      archived ? 'archived' : 'active',
      ctx.clock(),
    ])
    await ok(c, archived ? 'brain.archive' : 'brain.unarchive', brain.id, slug)
    return brainOf(row as Record<string, unknown>)
  })
}

// Only the administration deletes, typing the brain's name. The administration does not need to be
// a member to delete; exporting first (spec B7) does need it.
// Deleting is done in the web, signed in as a person: an administrator's token cannot.
export async function deleteBrain(ctx: Ctx, slug: string, confirm: string): Promise<void> {
  inWeb(ctx, 'Deleting a brain')
  await allow(ctx, 'brain.delete', {})
  await ctx.db.tx(async (db) => {
    const row = await db.one<{ id: string }>('SELECT id FROM brains WHERE slug = $1 FOR UPDATE', [slug])
    if (!row) throw brainNotFound()
    if (confirm !== slug) {
      throw invalid('To delete a brain, type its name to confirm.', `Send {"confirm": "${slug}"}.`)
    }
    // Short keys writing to this brain are revoked, not erased: a running agent learns its key was
    // revoked, and the audit keeps pointing at a key that exists.
    await db.query(
      "UPDATE credentials SET revoked_at = coalesce(revoked_at, $2) WHERE kind = 'short' AND write_brain_id = $1",
      [row.id, ctx.clock()],
    )
    await db.query('DELETE FROM brains WHERE id = $1', [row.id])
    await ok({ ...ctx, db }, 'brain.delete', row.id, slug)
  })
}
