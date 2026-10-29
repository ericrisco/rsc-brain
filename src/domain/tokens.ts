// Personal tokens (spec B4 «Tokens personales»): made in the profile, in the web. A name, brains (a list,
// or all of mine including later ones), read or read + write, and 30, 90 or 365 days. Seen once; after
// that only its last 4 characters, its last use and its client. A token never does more than the
// person's current role, checked on every request.
import { memberRole } from '../auth/principal.ts'
import { brainNotFound, invalid, notFound } from '../core/errors.ts'
import { type Ctx, ok } from './context.ts'
import { inWeb } from './guards.ts'
import { mintPersonToken } from './keys.ts'
import { EXPIRY_NOTICE_DAYS } from './notices.ts'

export const TOKEN_DAYS = [30, 90, 365] as const
export const ALL_BRAINS_NOTE =
  'This token reaches every brain you are a member of, including brains you join later.'

export async function createToken(
  ctx: Ctx,
  input: { name: unknown; perm: unknown; brains?: unknown; allBrains?: unknown; days?: unknown },
) {
  inWeb(ctx, 'Creating a token')
  if (ctx.who.kind !== 'person') throw invalid('Tokens belong to people.', 'Use a main key for a service.')
  const name = typeof input.name === 'string' ? input.name.trim() : ''
  if (!name || name.length > 80) {
    throw invalid('A token needs a name of 1 to 80 characters.', 'Such as "Claude Code laptop".')
  }
  if (input.perm !== 'read' && input.perm !== 'write') {
    throw invalid('"perm" is "read", or "write" (read + write).', 'Choose one.')
  }
  const days = input.days ?? 90
  if (!TOKEN_DAYS.includes(days as (typeof TOKEN_DAYS)[number])) {
    throw invalid('A token lasts 30, 90 or 365 days.', 'Choose one of the three (90 by default).')
  }
  const all = input.allBrains === true
  const slugs = input.brains
  if (all === (slugs !== undefined && slugs !== null)) {
    throw invalid(
      'Choose the brains of the token: "brains" (a list) or "allBrains": true.',
      'Send one of the two.',
    )
  }
  const brainIds: string[] = []
  if (!all) {
    if (
      !Array.isArray(slugs) ||
      slugs.length === 0 ||
      slugs.length > 100 ||
      slugs.some((s) => typeof s !== 'string')
    ) {
      throw invalid('"brains" is a list of 1 to 100 brain names.', 'Send ["slug", …].')
    }
    for (const slug of slugs as string[]) {
      const b = await ctx.db.one<{ id: string }>('SELECT id FROM brains WHERE slug = $1', [slug])
      if (!b || !(await memberRole(ctx.db, b.id, ctx.who.accountId))) throw brainNotFound()
      if (!brainIds.includes(b.id)) brainIds.push(b.id)
    }
  }
  const k = await mintPersonToken(ctx.db, ctx.clock, {
    accountId: ctx.who.accountId,
    name,
    perm: input.perm,
    ...(all ? { allBrains: true } : { brainIds }),
    days: days as number,
  })
  await ok(
    ctx,
    'token.create',
    null,
    k.id,
    `${name}, ${input.perm}, ${all ? 'all brains' : `${brainIds.length} brain(s)`}`,
  )
  return {
    token: { id: k.id, secret: k.secret, last4: k.secret.slice(-4), expiresAt: k.expiresAt },
    message: 'Copy it now: Brain shows it only this once.',
    ...(all ? { note: ALL_BRAINS_NOTE } : {}),
  }
}

export async function listTokens(ctx: Ctx) {
  inWeb(ctx, 'Seeing your tokens')
  const now = ctx.clock()
  const rows = await ctx.db.query(
    `SELECT c.*, (SELECT coalesce(array_agg(b.slug ORDER BY b.slug), '{}') FROM brains b WHERE b.id = ANY(c.brain_ids)) AS slugs
       FROM credentials c
      WHERE c.account_id = $1 AND c.kind = 'token' AND c.revoked_at IS NULL AND c.expires_at > $2
      ORDER BY c.created_at DESC`,
    [ctx.who.accountId, now],
  )
  const soon = now.getTime() + EXPIRY_NOTICE_DAYS * 86_400_000
  return rows.map((k) => ({
    id: String(k.id),
    name: String(k.name),
    last4: String(k.last4),
    perm: String(k.perm),
    allBrains: Boolean(k.all_brains),
    brains: k.all_brains ? null : (k.slugs as string[]),
    createdAt: (k.created_at as Date).toISOString(),
    expiresAt: (k.expires_at as Date).toISOString(),
    expiresSoon: (k.expires_at as Date).getTime() <= soon,
    lastUsedAt: k.last_used_at == null ? null : (k.last_used_at as Date).toISOString(),
    lastClient: k.last_client == null ? null : String(k.last_client),
  }))
}

export async function revokeToken(ctx: Ctx, id: string) {
  inWeb(ctx, 'Revoking a token')
  const r = await ctx.db.one(
    `UPDATE credentials SET revoked_at = $3 WHERE id = $1 AND account_id = $2 AND kind = 'token'
      AND revoked_at IS NULL RETURNING id`,
    [id, ctx.who.accountId, ctx.clock()],
  )
  if (!r) throw notFound('token')
  await ok(ctx, 'token.revoke', null, id)
}
