// The administration (spec B4 «Roles y miembros», «Cuentas de servicio», «Avisos por email»): people
// and service accounts, removing and reactivating, the brains of the installation (without their
// content), joining one as a member, the settings and the mail.
import type { Role } from '../auth/can.ts'
import { memberRole } from '../auth/principal.ts'
import { noVault } from '../auth/vault.ts'
import { AppError, brainNotFound, conflict, invalid, notFound } from '../core/errors.ts'
import type { Row } from '../db/db.ts'
import { type MailSettings, mailSettings, sealPassword, send, storeMail } from '../mail/mail.ts'
import { createAccount } from './accounts.ts'
import { addMember } from './brains.ts'
import { type Ctx, ok } from './context.ts'
import { joinAsAdmin } from './curation.ts'
import { adminOnly, EMAIL, emailOf } from './guards.ts'
import { DEFAULT_RATE_LIMIT, installation, MAX_RATE_LIMIT } from './installation.ts'
import { type Minted, mintMainKey } from './keys.ts'
import { curatorsOf, notify } from './notices.ts'

export const MAIN_KEYS_AT_ONCE = 2

export async function listAccounts(ctx: Ctx) {
  adminOnly(ctx)
  const rows = await ctx.db.query(
    `SELECT a.*, (SELECT max(last_used_at) FROM credentials c WHERE c.account_id = a.id) AS last_seen,
            (SELECT count(*)::int FROM credentials c WHERE c.account_id = a.id AND c.kind = 'main' AND c.revoked_at IS NULL) AS main_keys,
            (SELECT count(*)::int FROM memberships m WHERE m.account_id = a.id) AS brains
       FROM accounts a ORDER BY a.kind, lower(a.name)`,
  )
  return rows.map((a) => ({
    id: String(a.id),
    kind: a.kind as 'person' | 'service',
    name: String(a.name),
    email: a.email == null ? null : String(a.email),
    isAdmin: Boolean(a.is_admin),
    canCreateBrains: Boolean(a.can_create_brains),
    canInvite: Boolean(a.can_invite),
    status: a.status === 'active' ? 'active' : 'removed',
    secondFactor: a.totp_secret != null,
    brains: Number(a.brains),
    ...(a.kind === 'service' ? { mainKeys: Number(a.main_keys) } : {}),
    lastSeenAt: a.last_seen == null ? null : (a.last_seen as Date).toISOString(),
    createdAt: (a.created_at as Date).toISOString(),
  }))
}

// Changes to who administers take turns, so two administrators demoting each other cannot both pass
// the "another administrator remains" check.
const adminTurn = (db: Ctx['db']) =>
  db.query("SELECT pg_advisory_xact_lock(hashtext('rsc-brain administrators'))")

async function otherAdmins(db: Ctx['db'], id: string): Promise<number> {
  const r = await db.one<{ n: number }>(
    "SELECT count(*)::int AS n FROM accounts WHERE is_admin AND status = 'active' AND id <> $1",
    [id],
  )
  return r?.n ?? 0
}

const lastAdmin = () =>
  conflict(
    'last_admin',
    'This is the last administrator of the installation.',
    'Make another person an administrator first.',
  )

export async function updateAccount(
  ctx: Ctx,
  id: string,
  input: { isAdmin?: unknown; canCreateBrains?: unknown; canInvite?: unknown },
) {
  adminOnly(ctx)
  for (const k of ['isAdmin', 'canCreateBrains', 'canInvite'] as const) {
    if (input[k] !== undefined && typeof input[k] !== 'boolean') {
      throw invalid(`"${k}" is true or false.`, `Fix "${k}".`)
    }
  }
  return ctx.db.tx(async (db) => {
    await adminTurn(db)
    const a = await db.one<Row>('SELECT * FROM accounts WHERE id = $1 FOR UPDATE', [id])
    if (!a) throw notFound('account')
    if (a.kind === 'service' && input.isAdmin === true) {
      throw invalid('A service account cannot be an administrator.', 'Choose a person.')
    }
    if (a.kind === 'person' && input.canInvite !== undefined) {
      throw invalid(
        '"canInvite" is for service accounts (naming a first curator by email).',
        'For people, the administration invites; curators can be allowed in the settings.',
      )
    }
    if (a.is_admin && input.isAdmin === false && (await otherAdmins(db, id)) === 0) throw lastAdmin()
    const next = {
      isAdmin: input.isAdmin === undefined ? Boolean(a.is_admin) : (input.isAdmin as boolean),
      canCreateBrains:
        input.canCreateBrains === undefined
          ? Boolean(a.can_create_brains)
          : (input.canCreateBrains as boolean),
      canInvite: input.canInvite === undefined ? Boolean(a.can_invite) : (input.canInvite as boolean),
    }
    await db.query(
      'UPDATE accounts SET is_admin = $2, can_create_brains = $3, can_invite = $4 WHERE id = $1',
      [id, next.isAdmin, next.canCreateBrains, next.canInvite],
    )
    await ok(
      { ...ctx, db },
      'account.update',
      null,
      id,
      `admin ${next.isAdmin}, create brains ${next.canCreateBrains}, invite ${next.canInvite}`,
    )
    return { id, ...next }
  })
}

// Removing a person or a service account closes its sessions and revokes its tokens, connections and
// keys at once (and the short keys its main keys minted). What it wrote stays, signed with its name and
// «former member». Brains it was the last curator of are named, so the administration names another.
export async function removeAccount(ctx: Ctx, id: string) {
  adminOnly(ctx)
  if (id === ctx.who.accountId) {
    throw invalid('You cannot remove your own account.', 'Ask another administrator.')
  }
  return ctx.db.tx(async (db) => {
    await adminTurn(db)
    // The brains it curates are locked like a member change locks them, so a curator leaving at the
    // same moment is seen, and a brain left without a curator is reported.
    await db.query(
      `SELECT b.id FROM brains b JOIN memberships m ON m.brain_id = b.id
        WHERE m.account_id = $1 AND m.role = 'curator' ORDER BY b.id FOR UPDATE OF b`,
      [id],
    )
    const a = await db.one<Row>('SELECT * FROM accounts WHERE id = $1 FOR UPDATE', [id])
    if (!a) throw notFound('account')
    if (a.status === 'removed') return { removed: true, keysRevoked: 0, brainsWithoutCurator: [] }
    if (a.is_admin && (await otherAdmins(db, id)) === 0) throw lastAdmin()
    const now = ctx.clock()
    await db.query("UPDATE accounts SET status = 'removed', removed_at = $2 WHERE id = $1", [id, now])
    const keys = await db.query(
      `UPDATE credentials SET revoked_at = $2
        WHERE revoked_at IS NULL AND (account_id = $1 OR parent_id IN (SELECT id FROM credentials WHERE account_id = $1))
        RETURNING id`,
      [id, now],
    )
    // Its connections end too.
    await db.query('UPDATE oauth_grants SET revoked_at = $2 WHERE account_id = $1 AND revoked_at IS NULL', [
      id,
      now,
    ])
    const orphan = await db.query(
      `SELECT b.slug FROM brains b JOIN memberships m ON m.brain_id = b.id AND m.account_id = $1 AND m.role = 'curator'
        WHERE NOT EXISTS (SELECT 1 FROM memberships o JOIN accounts x ON x.id = o.account_id
                           WHERE o.brain_id = b.id AND o.role = 'curator' AND x.status = 'active')
        ORDER BY b.slug`,
      [id],
    )
    await ok({ ...ctx, db }, 'account.remove', null, id, `${keys.length} key(s) revoked`)
    return {
      removed: true,
      keysRevoked: keys.length,
      brainsWithoutCurator: orphan.map((r) => String(r.slug)),
    }
  })
}

// Reactivating gives the account back its memberships; its old keys stay revoked.
export async function restoreAccount(ctx: Ctx, id: string) {
  adminOnly(ctx)
  const r = await ctx.db.one(
    "UPDATE accounts SET status = 'active', removed_at = NULL WHERE id = $1 RETURNING id",
    [id],
  )
  if (!r) throw notFound('account')
  await ok(ctx, 'account.restore', null, id)
  return { restored: true }
}

// The brains of the installation, as the administration manages them: names, status, curators and a
// pending curator. Never their content.
export async function adminBrains(ctx: Ctx) {
  adminOnly(ctx)
  const rows = await ctx.db.query(
    `SELECT b.id, b.slug, b.name, b.status, b.pending_curator_email,
            (SELECT count(*)::int FROM memberships m WHERE m.brain_id = b.id) AS members,
            (SELECT coalesce(json_agg(json_build_object('id', a.id, 'name', a.name) ORDER BY a.name), '[]')
               FROM memberships m JOIN accounts a ON a.id = m.account_id
              WHERE m.brain_id = b.id AND m.role = 'curator' AND a.status = 'active') AS curators,
            (SELECT i.id FROM invitations i WHERE i.email = b.pending_curator_email AND i.used_at IS NULL AND i.revoked_at IS NULL
              LIMIT 1) AS invitation_id
       FROM brains b ORDER BY b.slug`,
  )
  const out = []
  for (const b of rows) {
    out.push({
      slug: String(b.slug),
      name: String(b.name),
      status: String(b.status),
      members: Number(b.members),
      curators: b.curators as Array<{ id: string; name: string }>,
      pendingCurator:
        b.pending_curator_email == null
          ? null
          : {
              email: String(b.pending_curator_email),
              invitationId: b.invitation_id == null ? null : String(b.invitation_id),
            },
      youAreMember: (await memberRole(ctx.db, String(b.id), ctx.who.accountId)) !== null,
    })
  }
  return out
}

// The administration joins a brain as a reader, to read it; the audit and the brain's curators see it.
export async function joinBrain(ctx: Ctx, slug: string) {
  adminOnly(ctx)
  const b = await ctx.db.one<{ id: string }>('SELECT id FROM brains WHERE slug = $1', [slug])
  if (!b) throw brainNotFound()
  const joined = await ctx.db.tx((db) => joinAsAdmin({ ...ctx, db }, b.id, 'joined from the administration'))
  if (joined) {
    await notify(ctx.db, ctx.clock, ctx.mail, await curatorsOf(ctx.db, b.id), {
      kind: 'admin.joined',
      brainId: b.id,
      subject: `The administration joined "${slug}"`,
      text: `${ctx.who.name} (administration) joined "${slug}" as a reader.`,
    })
  }
  return { joined, role: (await memberRole(ctx.db, b.id, ctx.who.accountId)) as Role }
}

export async function getSettings(ctx: Ctx) {
  adminOnly(ctx)
  const i = await installation(ctx.db)
  return { name: i.name, publicUrl: i.publicUrl, curatorsInvite: i.curatorsInvite, rateLimit: i.rateLimit }
}

// rateLimit: the requests per minute each key may make (spec B5).
export async function updateSettings(
  ctx: Ctx,
  input: { name?: unknown; curatorsInvite?: unknown; rateLimit?: unknown },
) {
  adminOnly(ctx)
  if (input.curatorsInvite !== undefined && typeof input.curatorsInvite !== 'boolean') {
    throw invalid('"curatorsInvite" is true or false.', 'Fix "curatorsInvite".')
  }
  const limit = input.rateLimit
  if (
    limit !== undefined &&
    (typeof limit !== 'number' || !Number.isInteger(limit) || limit < 1 || limit > MAX_RATE_LIMIT)
  ) {
    throw invalid(
      `"rateLimit" is the requests per minute of each key: a whole number from 1 to ${MAX_RATE_LIMIT}.`,
      `Fix "rateLimit" (the default is ${DEFAULT_RATE_LIMIT}).`,
    )
  }
  if (limit !== undefined) {
    await ctx.db.query('UPDATE installation SET rate_limit = $1 WHERE id = 1', [limit])
  }
  if (input.name !== undefined) {
    const n = typeof input.name === 'string' ? input.name.trim() : ''
    if (!n || n.length > 80) throw invalid('The installation name has 1 to 80 characters.', 'Shorten it.')
    await ctx.db.query('UPDATE installation SET name = $1 WHERE id = 1', [n])
  }
  if (input.curatorsInvite !== undefined) {
    await ctx.db.query('UPDATE installation SET curators_invite = $1 WHERE id = 1', [input.curatorsInvite])
  }
  await ok(ctx, 'settings.update', null, 'installation', JSON.stringify(input).slice(0, 300))
  return getSettings(ctx)
}

// Service accounts: a name, brains with at most the contributor role, whether it may create brains and
// name a first curator by email. Its main key is shown once.
export async function createService(
  ctx: Ctx,
  input: { name: unknown; canCreateBrains?: unknown; canInvite?: unknown; brains?: unknown },
): Promise<{ id: string; key: Minted }> {
  adminOnly(ctx)
  const name = typeof input.name === 'string' ? input.name : ''
  const brains = Array.isArray(input.brains) ? input.brains : input.brains == null ? [] : null
  if (!brains || brains.length > 100)
    throw invalid('"brains" is a list of {"slug", "role"}.', 'Fix the list.')
  const made = await ctx.db.tx(async (db) => {
    const id = await createAccount(db, ctx.clock, {
      kind: 'service',
      name,
      canCreateBrains: input.canCreateBrains === true,
      canInvite: input.canInvite === true,
    })
    const added: Array<{ brainId: string; slug: string; role: Role }> = []
    for (const g of brains) {
      const slug = (g as { slug?: unknown })?.slug
      const role = (g as { role?: unknown })?.role
      if (typeof slug !== 'string' || (role !== 'contributor' && role !== 'reader')) {
        throw invalid(
          'A service account joins a brain as contributor or reader, never curator.',
          'Give each brain a "slug" and a "role" of contributor or reader.',
        )
      }
      const b = await db.one<{ id: string }>('SELECT id FROM brains WHERE slug = $1', [slug])
      if (!b) throw brainNotFound()
      await addMember(db, b.id, id, role, ctx.clock())
      await ok({ ...ctx, db }, 'member.add', b.id, id, `none -> ${role}, by the administration`)
      added.push({ brainId: b.id, slug, role })
    }
    const key = await mintMainKey(db, ctx.clock, { accountId: id, name: 'main' })
    await ok({ ...ctx, db }, 'service.create', null, id, name.trim())
    await ok({ ...ctx, db }, 'key.main.create', null, key.id, id)
    return { id, key, added, name: name.trim() }
  })
  for (const a of made.added) {
    await notify(ctx.db, ctx.clock, ctx.mail, await curatorsOf(ctx.db, a.brainId), {
      kind: 'service.added',
      brainId: a.brainId,
      subject: `A service account joined "${a.slug}"`,
      text: `The administration (${ctx.who.name}) added the service account "${made.name}" to "${a.slug}" as ${a.role}.`,
    })
  }
  return { id: made.id, key: made.key }
}

// A second main key, to rotate without a cut: make the new one, move the program to it, revoke the old.
export async function newMainKey(ctx: Ctx, serviceId: string, name: unknown): Promise<Minted> {
  adminOnly(ctx)
  const n = typeof name === 'string' && name.trim() ? name.trim() : 'main'
  if (n.length > 80) throw invalid('A key name has at most 80 characters.', 'Shorten it.')
  return ctx.db.tx(async (db) => {
    const a = await db.one<Row>("SELECT * FROM accounts WHERE id = $1 AND kind = 'service' FOR UPDATE", [
      serviceId,
    ])
    if (!a) throw notFound('service account')
    if (a.status !== 'active') throw invalid('This service account was removed.', 'Reactivate it first.')
    const open = await db.one<{ n: number }>(
      "SELECT count(*)::int AS n FROM credentials WHERE account_id = $1 AND kind = 'main' AND revoked_at IS NULL",
      [serviceId],
    )
    if ((open?.n ?? 0) >= MAIN_KEYS_AT_ONCE) {
      throw conflict(
        'too_many_main_keys',
        `A service account has at most ${MAIN_KEYS_AT_ONCE} main keys at once.`,
        'Revoke the old key once the program uses the new one, then make another.',
      )
    }
    const key = await mintMainKey(db, ctx.clock, { accountId: serviceId, name: n })
    await ok({ ...ctx, db }, 'key.main.create', null, key.id, serviceId)
    return key
  })
}

// The keys of an account, as the administration sees them: never the secret, its last 4 characters.
export async function accountKeys(ctx: Ctx, accountId: string) {
  adminOnly(ctx)
  const a = await ctx.db.one('SELECT id FROM accounts WHERE id = $1', [accountId])
  if (!a) throw notFound('account')
  const rows = await ctx.db.query(
    `SELECT c.*, (SELECT count(*)::int FROM credentials s WHERE s.parent_id = c.id AND s.revoked_at IS NULL AND s.expires_at > $2) AS live_short
       FROM credentials c WHERE c.account_id = $1 AND c.kind IN ('token', 'main')
      ORDER BY c.created_at DESC LIMIT 200`,
    [accountId, ctx.clock()],
  )
  return rows.map((k) => keyView(k, ctx.clock()))
}

export function keyView(k: Row, now: Date) {
  const ended =
    k.revoked_at != null
      ? 'revoked'
      : k.expires_at != null && (k.expires_at as Date).getTime() <= now.getTime()
        ? 'expired'
        : null
  return {
    id: String(k.id),
    kind: String(k.kind),
    name: String(k.name),
    last4: String(k.last4),
    perm: String(k.perm),
    createdAt: (k.created_at as Date).toISOString(),
    expiresAt: k.expires_at == null ? null : (k.expires_at as Date).toISOString(),
    lastUsedAt: k.last_used_at == null ? null : (k.last_used_at as Date).toISOString(),
    lastClient: k.last_client == null ? null : String(k.last_client),
    status: ended ?? 'active',
    ...(k.kind === 'main' ? { liveShortKeys: Number(k.live_short ?? 0) } : {}),
  }
}

// Mail: the account that sends. The password is sealed with the installation secret, and never shown.
export async function getMail(ctx: Ctx) {
  adminOnly(ctx)
  const s = await mailSettings(ctx.db)
  const log = await ctx.db.query(
    'SELECT at, to_addr, kind, status, error FROM mail_log ORDER BY at DESC, id DESC LIMIT 50',
  )
  return {
    configured: s !== null,
    settings: s
      ? {
          host: s.host,
          port: s.port,
          secure: s.secure,
          user: s.user,
          hasPassword: s.password !== null,
          from: s.from,
        }
      : null,
    recent: log.map((l) => ({
      at: (l.at as Date).toISOString(),
      to: String(l.to_addr),
      kind: String(l.kind),
      status: String(l.status),
      error: String(l.error) || null,
    })),
  }
}

export async function setMail(
  ctx: Ctx,
  input: {
    host?: unknown
    port?: unknown
    secure?: unknown
    user?: unknown
    password?: unknown
    fromName?: unknown
    fromAddress?: unknown
  },
) {
  adminOnly(ctx)
  const host = typeof input.host === 'string' ? input.host.trim() : ''
  if (!host || host.length > 253 || /[\s/]/.test(host)) {
    throw invalid('"host" is the name of the mail server.', 'Such as smtp.example.com.')
  }
  const port = input.port ?? 587
  if (typeof port !== 'number' || !Number.isInteger(port) || port < 1 || port > 65535) {
    throw invalid('"port" is a number from 1 to 65535.', 'Usually 587, or 465 with "secure".')
  }
  if (input.secure !== undefined && typeof input.secure !== 'boolean') {
    throw invalid('"secure" is true or false.', 'True for port 465.')
  }
  const user = input.user == null || input.user === '' ? null : input.user
  if (user !== null && (typeof user !== 'string' || user.length > 320)) {
    throw invalid('"user" is the account name on the mail server.', 'Fix "user".')
  }
  const fromAddress = emailOf(input.fromAddress)
  if (!fromAddress)
    throw invalid('"fromAddress" is the email mail is sent from.', 'Such as brain@example.com.')
  const fromName = typeof input.fromName === 'string' ? input.fromName.trim().slice(0, 80) : ''
  const before = await mailSettings(ctx.db)
  let password: string | null = before?.password ?? null
  if (input.password !== undefined) {
    if (input.password === null || input.password === '') password = null
    else if (typeof input.password !== 'string' || input.password.length > 500) {
      throw invalid('"password" is text.', 'Fix "password".')
    } else {
      if (!ctx.mail?.secret) throw noVault()
      password = sealPassword(ctx.mail.secret, input.password)
    }
  }
  const s: MailSettings = {
    host,
    port,
    secure: input.secure === true,
    user: user as string | null,
    password,
    from: { name: fromName || (await installation(ctx.db)).name || 'RSC Brain', address: fromAddress },
  }
  await storeMail(ctx.db, s)
  await ok(ctx, 'settings.mail', null, 'mail', `${host}:${port} from ${fromAddress}`)
  return getMail(ctx)
}

export async function deleteMail(ctx: Ctx) {
  adminOnly(ctx)
  await storeMail(ctx.db, null)
  await ok(ctx, 'settings.mail', null, 'mail', 'removed')
  return getMail(ctx)
}

// A test mail to the administrator who asks, to check the settings.
export async function testMail(ctx: Ctx, to?: unknown) {
  adminOnly(ctx)
  const addr = to === undefined ? ctx.who.email : emailOf(to)
  if (!addr || !EMAIL.test(addr)) throw invalid('"to" is an email.', 'Leave it out to use yours.')
  const name = (await installation(ctx.db)).name || 'RSC Brain'
  const r = await send(ctx.db, ctx.clock, ctx.mail, 'test', {
    to: addr,
    subject: `Test mail from ${name}`,
    text: `This is a test mail from ${name}. Mail works.`,
  })
  if (!r.sent && r.error === 'Mail is not set up.') {
    throw new AppError(409, 'mail_not_set_up', 'Mail is not set up.', 'Save the mail settings first.')
  }
  return r
}
