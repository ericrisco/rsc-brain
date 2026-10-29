// Who is calling, worked out again on every request from the key alone, so a revocation, a removal or
// a role change counts from the very next request (constitution P4).

import { unauthorized } from '../core/errors.ts'
import type { Db, Row } from '../db/db.ts'
import type { Actor, CredentialKind, Role } from './can.ts'
import { minRole } from './can.ts'
import { hashSecret, KEY_PREFIX } from './secrets.ts'

export type Credential = {
  id: string
  kind: CredentialKind
  perm: 'read' | 'write'
  allBrains: boolean
  brainIds: string[]
  writeBrainId: string | null
  readBrainIds: string[]
  ref: string | null
  agent: string | null
  onBehalfId: string | null
  parentId: string | null
}

export type Principal = {
  accountId: string
  kind: 'person' | 'service'
  name: string
  email: string | null
  isAdmin: boolean
  canCreateBrains: boolean
  canInvite: boolean
  credential: Credential
}

export const actorOf = (p: Principal): Actor => ({
  kind: p.kind,
  isAdmin: p.isAdmin,
  canCreateBrains: p.canCreateBrains,
  credential: { kind: p.credential.kind, perm: p.credential.perm },
})

const NO_KEY = () =>
  unauthorized(
    'unauthorized',
    'Missing or unknown key.',
    'Send "Authorization: Bearer <key>" with a key of this installation.',
  )
const ENDED = (why: 'expired' | 'revoked', base: string) =>
  unauthorized(
    `key_${why}`,
    `This key has ${why === 'expired' ? 'expired' : 'been revoked'}.`,
    `Create a new key (a person: in your profile, ${base}/profile/tokens; a service: ask the administration).`,
  )
const REMOVED = () =>
  unauthorized(
    'account_removed',
    'The account behind this key is no longer active.',
    'Ask the administration of this installation to reactivate it.',
  )

const ended = (r: Row, now: Date): 'expired' | 'revoked' | null => {
  if (r.revoked_at != null) return 'revoked'
  if (r.expires_at != null && (r.expires_at as Date).getTime() <= now.getTime()) return 'expired'
  return null
}

export const CONNECTION_IDLE_DAYS = 90

export function connectionEnded(
  g: { g_revoked_at?: unknown; g_last_used_at?: unknown; g_expires_max?: unknown },
  now: Date,
): boolean {
  if (g.g_revoked_at != null || g.g_last_used_at == null || g.g_expires_max == null) return true
  const idle = now.getTime() - (g.g_last_used_at as Date).getTime() > CONNECTION_IDLE_DAYS * 86_400_000
  return idle || (g.g_expires_max as Date).getTime() <= now.getTime()
}

export const SIGN_IN_AGAIN = () =>
  unauthorized(
    'connection_ended',
    'This connection ended: it was revoked, unused for 90 days, or is a year old.',
    'Sign in again from your agent: it will open the consent page.',
  )

// A web session ends after this many days without use (spec B4).
export const WEB_SESSION_DAYS = 14

// The web session travels in this cookie (HttpOnly, set by the sign-in of B4).
export const SESSION_COOKIE = 'rscb_session'

export function sessionCookie(header: string | undefined): string | null {
  if (!header) return null
  for (const part of header.split(';')) {
    const [k, ...v] = part.trim().split('=')
    if (k === SESSION_COOKIE) {
      const secret = v.join('=')
      return secret.startsWith(KEY_PREFIX) ? secret : null
    }
  }
  return null
}

export function bearer(header: string | undefined): string | null {
  if (!header) return null
  const m = /^Bearer\s+(\S+)$/i.exec(header.trim())
  const key = m?.[1]
  return key?.startsWith(KEY_PREFIX) ? key : null
}

// `channel`: how the secret arrived. A web session only counts as a cookie, and a key only as a bearer
// header, so an agent holding a key cannot pass for a person in the web, nor a stolen cookie for a key.
export async function resolveKey(
  db: Db,
  secret: string | null,
  now: Date,
  channel: 'bearer' | 'cookie' = 'bearer',
  conn?: { userAgent: string },
): Promise<Principal> {
  if (!secret) throw NO_KEY()
  const r = await db.one(
    `SELECT c.*, a.kind AS a_kind, a.name AS a_name, a.email, a.is_admin, a.can_create_brains, a.can_invite,
            a.status, p.revoked_at AS p_revoked_at, p.expires_at AS p_expires_at, i.key_epoch, i.public_url,
            g.revoked_at AS g_revoked_at, g.last_used_at AS g_last_used_at, g.expires_max AS g_expires_max
       FROM credentials c JOIN accounts a ON a.id = c.account_id
       LEFT JOIN credentials p ON p.id = c.parent_id
       LEFT JOIN oauth_grants g ON g.id = c.grant_id
       CROSS JOIN installation i
      WHERE c.secret_hash = $1`,
    [hashSecret(secret)],
  )
  if (!r) throw NO_KEY()
  // A key of an earlier epoch (before a copy was restored) never works again (spec B4 CA33).
  if (Number(r.epoch) !== Number(r.key_epoch)) {
    throw unauthorized(
      'key_invalidated',
      'This key is from before the installation was restored, so it no longer works.',
      'Create a new key (a person: in your profile; a service: ask the administration).',
    )
  }
  const why =
    ended(r, now) ??
    (r.parent_id != null ? ended({ revoked_at: r.p_revoked_at, expires_at: r.p_expires_at }, now) : null)
  if (why) throw ENDED(why, r.public_url == null ? '' : String(r.public_url))
  // The key of a connection lives while its connection does (spec B4 «Vida de una conexión»).
  if (r.kind === 'app' && connectionEnded(r, now)) throw SIGN_IN_AGAIN()
  if (r.status !== 'active') throw REMOVED()
  if ((r.kind === 'web') !== (channel === 'cookie')) {
    throw unauthorized(
      'wrong_channel',
      r.kind === 'web'
        ? 'A web session works only in the web.'
        : 'Keys are sent as "Authorization: Bearer <key>".',
      r.kind === 'web'
        ? 'Use a personal token for agents and programs.'
        : 'Send the key in the Authorization header.',
    )
  }
  // Last use and client, at most once a minute; a web session lives 14 days from its last use, and a
  // connection is in use while its key is.
  if (r.kind === 'app') {
    await db.query(
      "UPDATE oauth_grants SET last_used_at = $2 WHERE id = $1 AND last_used_at < $2::timestamptz - interval '60 seconds'",
      [r.grant_id, now],
    )
  }
  await db.query(
    `UPDATE credentials SET last_used_at = $2, last_client = coalesce($3, last_client),
            expires_at = CASE WHEN kind = 'web' THEN $2::timestamptz + make_interval(days => $4) ELSE expires_at END
      WHERE id = $1 AND (last_used_at IS NULL OR last_used_at < $2::timestamptz - interval '60 seconds')`,
    [r.id, now, conn?.userAgent || null, WEB_SESSION_DAYS],
  )
  return {
    accountId: String(r.account_id),
    kind: r.a_kind as 'person' | 'service',
    name: String(r.a_name),
    email: r.email == null ? null : String(r.email),
    // What the administration may do travels only with the person in the web or a personal token that
    // reaches all their brains with read + write. A connected app, a narrowed token or a service key
    // never carries it, whatever the account is (a connection consented to one brain stays in it).
    isAdmin:
      Boolean(r.is_admin) &&
      (r.kind === 'web' || (r.kind === 'token' && Boolean(r.all_brains) && r.perm === 'write')),
    canCreateBrains: Boolean(r.can_create_brains) && r.kind !== 'app',
    canInvite: Boolean(r.can_invite),
    credential: {
      id: String(r.id),
      kind: r.kind as CredentialKind,
      perm: r.perm as 'read' | 'write',
      allBrains: Boolean(r.all_brains),
      brainIds: (r.brain_ids as string[]) ?? [],
      writeBrainId: r.write_brain_id == null ? null : String(r.write_brain_id),
      readBrainIds: (r.read_brain_ids as string[]) ?? [],
      ref: r.ref == null ? null : String(r.ref),
      agent: r.agent == null ? null : String(r.agent),
      onBehalfId: r.on_behalf_id == null ? null : String(r.on_behalf_id),
      parentId: r.parent_id == null ? null : String(r.parent_id),
    },
  }
}

export async function memberRole(db: Db, brainId: string, accountId: string): Promise<Role | null> {
  const r = await db.one<{ role: Role; status: string }>(
    `SELECT m.role, a.status FROM memberships m JOIN accounts a ON a.id = m.account_id
      WHERE m.brain_id = $1 AND m.account_id = $2`,
    [brainId, accountId],
  )
  return r && r.status === 'active' ? r.role : null
}

// The role the caller has in a brain through this key: the membership, narrowed by what the key
// allows. A short key reads its read-only brains only while the person it speaks for can read them
// too (no reading a brain through a service that the launcher could not read: pack rule 5).
export async function roleIn(db: Db, p: Principal, brainId: string): Promise<Role | null> {
  const c = p.credential
  const member = await memberRole(db, brainId, p.accountId)
  // A web session is the person in the web: their membership, as it is.
  if (c.kind === 'web') return member
  if (c.kind === 'token' || c.kind === 'app') {
    if (!c.allBrains && !c.brainIds.includes(brainId)) return null
    return c.perm === 'read' ? minRole(member, 'reader') : member
  }
  // A service account is never curator (spec B4); its keys are capped at contributor whatever happens
  // to its membership row.
  if (c.kind === 'main') return minRole(member, 'contributor')
  if (brainId === c.writeBrainId) return minRole(member, c.perm === 'read' ? 'reader' : 'contributor')
  if (c.readBrainIds.includes(brainId) && c.onBehalfId) {
    const theirs = await memberRole(db, brainId, c.onBehalfId)
    return member && theirs ? 'reader' : null
  }
  return null
}
