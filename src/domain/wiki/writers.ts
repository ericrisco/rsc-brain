// The permission to write to a brain's wiki directly (spec v0.6 «Escritura directa»; constitution P5 v2.1.0): a
// curator of that brain, as a person in the web, gives it to one key; any curator takes it back, from any
// channel, and it counts from the very next request (P4). It is per key and per brain. A key here is what a
// person sees as one: a token or a service's main key, a connected app across its refreshed keys, and a short
// key writes with the permission of the main key that made it.
import { atLeast } from '../../auth/can.ts'
import { type Credential, memberRole } from '../../auth/principal.ts'
import { AppError, brainNotFound, denied, invalid, notFound } from '../../core/errors.ts'
import type { Db } from '../../db/db.ts'
import { allow, type Brain, type Ctx, inBrain, ok } from '../context.ts'

// The key whose permission a credential writes with; null for a person in the web, who edits by hand instead.
export function keyIdOf(c: Credential): string | null {
  if (c.kind === 'token' || c.kind === 'main') return c.id
  if (c.kind === 'app') return c.grantId
  if (c.kind === 'short') return c.parentId
  return null
}

const hasPermission = async (db: Db, brainId: string, c: Credential): Promise<boolean> => {
  const key = keyIdOf(c)
  if (!key) return false
  return Boolean(
    await db.one('SELECT 1 FROM wiki_writers WHERE brain_id = $1 AND key_id = $2', [brainId, key]),
  )
}

// Every write of a key to the wiki asks here first: the bar of proposing (a contributor or more through this
// key, read + write, the brain not archived), then the permission a curator gave this key. Without it, the
// answer says what is missing and how to propose instead (CA2).
export async function mayWriteWiki(ctx: Ctx, brain: Brain, role: Parameters<typeof atLeast>[0]) {
  await allow(ctx, 'wiki.propose', { role, brainStatus: brain.status }, brain.id)
  if (await hasPermission(ctx.db, brain.id, ctx.who.credential)) return
  throw new AppError(
    403,
    'wiki_write_not_allowed',
    `This key may not write to the wiki of "${brain.slug}" directly.`,
    `Propose the change instead (brain_propose, or POST /v1/brains/${brain.slug}/proposals) for a curator to approve; or ask a curator of the brain to give this key the permission to write to the wiki.`,
  )
}

export type Writer = {
  keyId: string
  kind: 'token' | 'main' | 'app'
  name: string
  last4: string | null
  owner: string
  ownerId: string
  grantedBy: string
  grantedAt: string
}

// The keys of a brain that may write to its wiki, with whose they are and who let them: for its curators.
export async function listWriters(ctx: Ctx, slug: string): Promise<Writer[]> {
  const { brain, role } = await inBrain(ctx, { slug })
  if (role !== 'curator')
    throw denied(
      'Only a curator of the brain sees which keys write to its wiki.',
      'Ask a curator of the brain.',
    )
  const rows = await ctx.db.query(
    `SELECT w.key_id, w.granted_at, g.name AS granted_by,
            coalesce(c.kind, 'app') AS kind, coalesce(c.name, o.client_name) AS name, c.last4,
            a.id AS owner_id, a.name AS owner
       FROM wiki_writers w
       JOIN accounts g ON g.id = w.granted_by
       LEFT JOIN credentials c ON c.id = w.key_id
       LEFT JOIN oauth_grants o ON o.id = w.key_id
       JOIN accounts a ON a.id = coalesce(c.account_id, o.account_id)
      WHERE w.brain_id = $1 AND (c.id IS NULL OR c.revoked_at IS NULL) AND (o.id IS NULL OR o.revoked_at IS NULL)
      ORDER BY w.granted_at, w.key_id`,
    [brain.id],
  )
  return rows.map((r) => ({
    keyId: String(r.key_id),
    kind: r.kind as Writer['kind'],
    name: String(r.name ?? ''),
    last4: r.last4 == null ? null : String(r.last4),
    owner: String(r.owner),
    ownerId: String(r.owner_id),
    grantedBy: String(r.granted_by),
    grantedAt: (r.granted_at as Date).toISOString(),
  }))
}

// A key that can be given the permission in this brain: alive, read + write, reaching the brain, and of an
// account that writes there (a contributor or a curator). Otherwise, why not.
async function keyFor(db: Db, brainId: string, keyId: string, now: Date): Promise<{ kind: string }> {
  const c = await db.one(
    `SELECT kind, account_id, perm, all_brains, brain_ids, revoked_at, expires_at FROM credentials
      WHERE id = $1 AND kind IN ('token', 'main')`,
    [keyId],
  )
  const g = c
    ? undefined
    : await db.one(
        'SELECT account_id, perm, brain_ids, revoked_at, expires_max FROM oauth_grants WHERE id = $1',
        [keyId],
      )
  const k = c ?? g
  const ended = (at: unknown) => at instanceof Date && at.getTime() <= now.getTime()
  if (!k || k.revoked_at != null || ended(c ? c.expires_at : g?.expires_max)) throw notFound('key')
  const reaches =
    c?.kind === 'main' || Boolean(k.all_brains) || ((k.brain_ids as string[]) ?? []).includes(brainId)
  if (!reaches)
    throw invalid('This key does not reach this brain.', 'Give the permission to a key made for this brain.')
  if (k.perm !== 'write')
    throw invalid('This key is read-only.', 'Give the permission to a key with read + write permission.')
  if (!atLeast(await memberRole(db, brainId, String(k.account_id)), 'contributor')) {
    throw invalid(
      'The owner of this key does not write in this brain.',
      'Make them a contributor of the brain first, or give the permission to another key.',
    )
  }
  return { kind: c ? String(c.kind) : 'app' }
}

const webOnlyGrant = (ctx: Ctx) => {
  // A person decides it, never an agent holding a curator's key (P5: «una persona dio»).
  if (ctx.who.credential.kind !== 'web')
    throw denied(
      'The permission to write to the wiki is given by a curator in the web, not by a key.',
      'Open the brain in the web, as a curator, and give it there.',
    )
}

export async function grantWriter(ctx: Ctx, slug: string, keyId: string): Promise<Writer> {
  await ctx.db.tx(async (db) => {
    const c = { ...ctx, db }
    const { brain, role } = await inBrain(c, { slug }, 'share')
    await allow(c, 'wiki.decide', { role, brainStatus: brain.status }, brain.id)
    webOnlyGrant(c)
    await keyFor(db, brain.id, keyId, ctx.clock())
    const added = await db.one(
      `INSERT INTO wiki_writers (brain_id, key_id, granted_by, granted_at) VALUES ($1, $2, $3, $4)
       ON CONFLICT (brain_id, key_id) DO NOTHING RETURNING key_id`,
      [brain.id, keyId, ctx.who.accountId, ctx.clock()],
    )
    if (added) await ok(c, 'wiki.writer.grant', brain.id, keyId)
  })
  return (await listWriters(ctx, slug)).find((x) => x.keyId === keyId) as Writer
}

export async function revokeWriter(ctx: Ctx, slug: string, keyId: string): Promise<void> {
  await ctx.db.tx(async (db) => {
    const c = { ...ctx, db }
    const { brain, role } = await inBrain(c, { slug }, 'share')
    // Taking it back only lessens what a key can do: any curator, from the web or a key of theirs.
    if (role !== 'curator')
      throw denied('Only a curator of the brain takes the permission back.', 'Ask a curator of the brain.')
    if (ctx.who.credential.perm === 'read')
      throw denied('This key is read-only.', 'Use a key with read + write permission.')
    const gone = await db.one(
      'DELETE FROM wiki_writers WHERE brain_id = $1 AND key_id = $2 RETURNING key_id',
      [brain.id, keyId],
    )
    if (!gone) throw notFound('writer')
    await ok(c, 'wiki.writer.revoke', brain.id, keyId)
  })
}

// When a person makes a token (spec v0.6 CA17 «o al crearla»): the brains, by name, where it may write to the
// wiki, each one where the person is a curator and the token reaches. Inside the token's transaction.
export async function grantOnCreate(
  ctx: Ctx,
  db: Db,
  keyId: string,
  slugs: string[],
  reach: { allBrains: boolean; brainIds: string[]; perm: 'read' | 'write' },
): Promise<void> {
  if (slugs.length > 0 && reach.perm !== 'write')
    throw invalid(
      'A read-only token cannot write to a wiki.',
      'Make it read + write, or leave out "wikiWrite".',
    )
  for (const slug of slugs) {
    const b = await db.one<{ id: string; status: string }>('SELECT id, status FROM brains WHERE slug = $1', [
      slug,
    ])
    const role = b ? await memberRole(db, b.id, ctx.who.accountId) : null
    if (!b || !role) throw brainNotFound()
    if (role !== 'curator')
      throw denied(
        `Only a curator of "${slug}" lets a key write to its wiki.`,
        'Leave that brain out of "wikiWrite".',
      )
    if (!reach.allBrains && !reach.brainIds.includes(b.id))
      throw invalid(
        `The token does not reach "${slug}".`,
        'Add the brain to the token, or leave it out of "wikiWrite".',
      )
    await db.query(
      `INSERT INTO wiki_writers (brain_id, key_id, granted_by, granted_at) VALUES ($1, $2, $3, $4)
       ON CONFLICT (brain_id, key_id) DO NOTHING`,
      [b.id, keyId, ctx.who.accountId, ctx.clock()],
    )
    await ok({ ...ctx, db }, 'wiki.writer.grant', b.id, keyId)
  }
}

// The brains, by name, where each of these keys may write to the wiki.
export async function wikiWriteOf(db: Db, keyIds: string[]): Promise<Map<string, string[]>> {
  const rows = await db.query<{ key_id: string; slug: string }>(
    `SELECT w.key_id, b.slug FROM wiki_writers w JOIN brains b ON b.id = w.brain_id
      WHERE w.key_id = ANY($1) ORDER BY b.slug`,
    [keyIds],
  )
  const out = new Map<string, string[]>()
  for (const r of rows) out.set(r.key_id, [...(out.get(r.key_id) ?? []), r.slug])
  return out
}
