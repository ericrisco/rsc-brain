// What a service account may ask about the people it works for (plan rsc-factory-brain §3.1, spec C21):
// which role a person has in brains the service belongs to. It answers what a short key "on behalf of"
// that person would find out by being used, without minting one. A brain the service is not in is left
// out, as if it did not exist (constitution P4).
import { minRole, type Role } from '../auth/can.ts'
import { memberRole } from '../auth/principal.ts'
import { AppError, invalid } from '../core/errors.ts'
import type { Ctx } from './context.ts'
import { ok } from './context.ts'

export const ACCESS_MAX_BRAINS = 50

export type AccessAnswer = {
  person: { found: boolean }
  brains: Array<{ slug: string; serviceRole: Role; personRole: Role | null }>
}

// The calls only a service makes for the people it serves (POST /v1/access, its invitations) take its main
// key: not a short key handed to an agent, nor a person's key or web session.
export function serviceMainKey(ctx: Ctx, what: string): void {
  if (ctx.who.kind === 'service' && ctx.who.credential.kind === 'main') return
  throw new AppError(
    403,
    'key_not_allowed',
    `${what} takes the main key of a service account.`,
    'Call it with the main key of the service account (rsc-brain › Admin › Service accounts).',
  )
}

// The active person behind an account id or an email (any case, spaces around it ignored); null otherwise.
export async function personOf(ctx: Ctx, given: string): Promise<string | null> {
  const v = given.trim()
  const r = await ctx.db.one<{ id: string }>(
    `SELECT id FROM accounts WHERE (id = $1 OR email = lower($1)) AND kind = 'person' AND status = 'active'`,
    [v],
  )
  return r?.id ?? null
}

export async function checkAccess(
  ctx: Ctx,
  input: { person: unknown; brains: unknown },
): Promise<AccessAnswer> {
  serviceMainKey(ctx, 'Asking what a person may read')
  const person = typeof input.person === 'string' ? input.person.trim() : ''
  if (!person || person.length > 200) {
    throw invalid('"person" is the email or account id of a person (1 to 200 characters).', 'Fix "person".')
  }
  const asked = input.brains
  if (
    !Array.isArray(asked) ||
    asked.length < 1 ||
    asked.length > ACCESS_MAX_BRAINS ||
    asked.some((s) => typeof s !== 'string' || s.length < 1 || s.length > 64)
  ) {
    throw invalid(
      `"brains" is a list of 1 to ${ACCESS_MAX_BRAINS} brain names (slugs).`,
      'Send "brains" as ["…", "…"].',
    )
  }
  const slugs = [...new Set(asked as string[])]
  const personId = await personOf(ctx, person)
  const rows = await ctx.db.query<{ id: string; slug: string }>(
    'SELECT id, slug FROM brains WHERE slug = ANY($1)',
    [slugs],
  )
  const bySlug = new Map(rows.map((r) => [String(r.slug), String(r.id)]))
  const brains: AccessAnswer['brains'] = []
  for (const slug of slugs) {
    const id = bySlug.get(slug)
    if (!id) continue
    // A service account is never curator: its keys reach contributor at most (principal.ts roleIn).
    const serviceRole = minRole(await memberRole(ctx.db, id, ctx.who.accountId), 'contributor')
    if (!serviceRole) continue
    brains.push({ slug, serviceRole, personRole: personId ? await memberRole(ctx.db, id, personId) : null })
  }
  // Who was asked about and how many brains answered; never the names of brains out of the service's reach.
  await ok(
    ctx,
    'access.check',
    null,
    personId ?? person.toLowerCase().slice(0, 200),
    `${brains.length} brains`,
  )
  return { person: { found: personId !== null }, brains }
}
