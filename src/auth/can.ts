// The one place that decides who may do what in a brain. Every route asks here; nothing else grants
// access. Pure: it receives the facts (role already narrowed by the key, ownership, brain status).
export const ROLES = ['reader', 'contributor', 'curator'] as const
export type Role = (typeof ROLES)[number]
export type CredentialKind = 'token' | 'main' | 'short'

export const rank = (r: Role | null): number => (r === null ? 0 : ROLES.indexOf(r) + 1)
export const atLeast = (r: Role | null, min: Role): boolean => rank(r) >= rank(min)
export const minRole = (a: Role | null, b: Role | null): Role | null => (rank(a) <= rank(b) ? a : b)

export type Actor = {
  kind: 'person' | 'service'
  isAdmin: boolean
  canCreateBrains: boolean
  credential: { kind: CredentialKind; perm: 'read' | 'write' }
}

export type Action =
  | 'brain.create'
  | 'brain.read'
  | 'brain.archive'
  | 'brain.delete'
  | 'journal.write'
  | 'entry.edit'
  | 'entry.forget'
  | 'entry.pin'
  | 'entry.purge'
  | 'relation.write'
  | 'correction.relay'
  | 'key.short'

export type Facts = {
  role?: Role | null // the actor's role in the brain, already narrowed by its key
  brainStatus?: 'active' | 'archived'
  isOwner?: boolean // the actor wrote the entry
  onBehalfRole?: Role | null // correction.relay: the role of the person the service speaks for
}

export type Decision = { ok: true } | { ok: false; reason: string; howToProceed: string }

const OK: Decision = { ok: true }
const no = (reason: string, howToProceed: string): Decision => ({ ok: false, reason, howToProceed })

const READ_ONLY = no(
  'This key is read-only.',
  'Use a key with read + write permission, or create one in your profile.',
)
const ARCHIVED = no(
  'This brain is archived, so it is read-only.',
  'A curator of the brain can unarchive it (POST /v1/brains/:slug/unarchive).',
)

function needRole(role: Role | null | undefined, min: Role): Decision {
  if (atLeast(role ?? null, min)) return OK
  return no(
    `This needs the ${min} role in the brain; you are ${role ?? 'not a member'}.`,
    `Ask a curator of the brain for the ${min} role.`,
  )
}

export function can(actor: Actor, action: Action, f: Facts = {}): Decision {
  const writes = action !== 'brain.read'
  if (writes && actor.credential.perm === 'read') return READ_ONLY
  switch (action) {
    case 'brain.read':
      return needRole(f.role, 'reader')
    case 'brain.create':
      if (actor.credential.kind === 'short') {
        return no('A short key cannot create brains.', 'Use the main key of the service account.')
      }
      if (actor.isAdmin || actor.canCreateBrains) return OK
      return no(
        'You are not allowed to create brains.',
        'Ask the administration of this installation for the "can create brains" permission.',
      )
    case 'brain.archive':
      return needRole(f.role, 'curator')
    case 'brain.delete':
      if (actor.isAdmin && actor.kind === 'person') return OK
      return no('Only the administration can delete a brain.', 'Ask the administration of this installation.')
    case 'journal.write':
    case 'relation.write': {
      const r = needRole(f.role, 'contributor')
      if (!r.ok) return r
      return f.brainStatus === 'archived' ? ARCHIVED : OK
    }
    case 'entry.edit':
    case 'entry.forget': {
      if (f.brainStatus === 'archived') return ARCHIVED
      if (atLeast(f.role ?? null, 'curator')) return OK
      if (f.isOwner && atLeast(f.role ?? null, 'contributor')) return OK
      return no(
        'Only the author of an entry or a curator of the brain can change it.',
        'Ask a curator of the brain, or write a new entry.',
      )
    }
    case 'entry.pin': {
      const r = needRole(f.role, 'curator')
      if (!r.ok) return r
      return f.brainStatus === 'archived' ? ARCHIVED : OK
    }
    case 'entry.purge':
      if (actor.isAdmin && actor.kind === 'person') return OK
      return no('Only the administration can purge.', 'Ask the administration, or forget the entry instead.')
    case 'correction.relay': {
      if (actor.kind !== 'service' || actor.credential.kind !== 'main') {
        return no(
          'Agents cannot write corrections; only people can.',
          'Save it as a "learning" or "preference" entry instead.',
        )
      }
      const r = needRole(f.role, 'contributor')
      if (!r.ok) return r
      if (f.brainStatus === 'archived') return ARCHIVED
      if (!atLeast(f.onBehalfRole ?? null, 'contributor')) {
        return no(
          'A correction must speak for a person who is a contributor or curator of the brain.',
          'Relay it on behalf of a member with that role, or ask a curator to add that person.',
        )
      }
      return OK
    }
    case 'key.short':
      if (actor.kind === 'service' && actor.credential.kind === 'main') return OK
      return no('Only a service account can mint short keys, with its main key.', 'Use the main key.')
  }
}
