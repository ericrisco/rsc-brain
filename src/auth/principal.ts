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
const ENDED = (why: 'expired' | 'revoked') =>
  unauthorized(
    `key_${why}`,
    `This key has ${why === 'expired' ? 'expired' : 'been revoked'}.`,
    'Create a new key (a person: in your profile; a service: ask the administration).',
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

export function bearer(header: string | undefined): string | null {
  if (!header) return null
  const m = /^Bearer\s+(\S+)$/i.exec(header.trim())
  const key = m?.[1]
  return key?.startsWith(KEY_PREFIX) ? key : null
}

export async function resolveKey(db: Db, secret: string | null, now: Date): Promise<Principal> {
  if (!secret) throw NO_KEY()
  const r = await db.one(
    `SELECT c.*, a.kind AS a_kind, a.name AS a_name, a.email, a.is_admin, a.can_create_brains, a.can_invite,
            a.status, p.revoked_at AS p_revoked_at, p.expires_at AS p_expires_at
       FROM credentials c JOIN accounts a ON a.id = c.account_id
       LEFT JOIN credentials p ON p.id = c.parent_id
      WHERE c.secret_hash = $1`,
    [hashSecret(secret)],
  )
  if (!r) throw NO_KEY()
  const why =
    ended(r, now) ??
    (r.parent_id != null ? ended({ revoked_at: r.p_revoked_at, expires_at: r.p_expires_at }, now) : null)
  if (why) throw ENDED(why)
  if (r.status !== 'active') throw REMOVED()
  await db.query(
    `UPDATE credentials SET last_used_at = $2
      WHERE id = $1 AND (last_used_at IS NULL OR last_used_at < $2::timestamptz - interval '60 seconds')`,
    [r.id, now],
  )
  return {
    accountId: String(r.account_id),
    kind: r.a_kind as 'person' | 'service',
    name: String(r.a_name),
    email: r.email == null ? null : String(r.email),
    isAdmin: Boolean(r.is_admin),
    canCreateBrains: Boolean(r.can_create_brains),
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
  if (c.kind === 'token') {
    if (!c.allBrains && !c.brainIds.includes(brainId)) return null
    return c.perm === 'read' ? minRole(member, 'reader') : member
  }
  if (c.kind === 'main') return member
  if (brainId === c.writeBrainId) return c.perm === 'read' ? minRole(member, 'reader') : member
  if (c.readBrainIds.includes(brainId) && c.onBehalfId) {
    const theirs = await memberRole(db, brainId, c.onBehalfId)
    return member && theirs ? 'reader' : null
  }
  return null
}
