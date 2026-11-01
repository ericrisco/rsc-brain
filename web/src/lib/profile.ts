// Profile as a person reads it (spec B6 «Profile»): what a token reaches and may do, when it was last
// used and by what, the form of a new token checked before it is sent, the email notices by brain, and
// the key of the second factor in groups people can type.
import { T } from '../text.ts'
import { ago, clientLabel } from './brains.ts'

export function brainsLabel(t: { allBrains: boolean; brains: string[] | null }): string {
  if (t.allBrains) return 'All your brains, and the ones you join later'
  return (t.brains ?? []).join(', ')
}

export function permLabel(perm: string): string {
  return perm === 'read' ? 'Read' : 'Read and write'
}

export function lastUseLabel(
  t: { lastUsedAt: string | null; lastClient: string | null },
  now: Date = new Date(),
): string {
  if (!t.lastUsedAt) return 'Never used'
  const when = ago(t.lastUsedAt, now) ?? ''
  const by = clientLabel(t.lastClient)
  return by ? `Used ${when} by ${by}` : `Used ${when}`
}

export const TOKEN_DAYS = [30, 90, 365] as const

export type TokenForm = {
  name: string
  perm: 'read' | 'write'
  days: number
  // all: every brain of mine, including later ones; some: the ones chosen.
  scope: 'all' | 'some'
  brains: string[]
}

export type TokenBody = { name: string; perm: 'read' | 'write'; days: number } & (
  | { allBrains: true }
  | { brains: string[] }
)

// What to send, or what to fix first (by field), in the server's own rules (B4: 1 to 80 characters).
export function tokenRequest(f: TokenForm): {
  body: TokenBody | null
  problems: { name?: string; brains?: string }
} {
  const name = f.name.trim()
  const problems: { name?: string; brains?: string } = {}
  if (!name) problems.name = 'Enter a name.'
  else if (name.length > 80) problems.name = 'Shorten the name to 80 characters or fewer.'
  if (f.scope === 'some' && f.brains.length === 0)
    problems.brains = 'Choose at least one brain, or all of them.'
  if (problems.name || problems.brains) return { body: null, problems }
  const base = { name, perm: f.perm, days: f.days }
  return {
    body: f.scope === 'all' ? { ...base, allBrains: true } : { ...base, brains: [...f.brains] },
    problems,
  }
}

type BrainNotice = { slug: string; name: string; role: string; notifyProposals: boolean; status: string }

// Only a curator gets the notices of new proposals (B4), so only a curator can choose them.
export function notifyRows(brains: readonly BrainNotice[]) {
  return brains.map((b) => ({ slug: b.slug, name: b.name, on: b.notifyProposals, can: b.role === 'curator' }))
}

export function groupKey(secret: string): string {
  return (secret.match(/.{1,4}/g) ?? []).join(' ')
}

// After a new password: what still works, so the person can stop it too. Expired tokens and ended apps no
// longer work, so they are not counted; when the lists could not be read again, the change is still said.
export function passwordChanged(
  tokens: readonly { expired: boolean }[] | undefined,
  apps: readonly { ended: boolean }[] | undefined,
): string {
  if (!tokens || !apps) return T.profile.changedPlain
  return T.profile.changed(tokens.filter((t) => !t.expired).length, apps.filter((a) => !a.ended).length)
}
