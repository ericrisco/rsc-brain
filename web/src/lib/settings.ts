// A brain's settings and the administration of people and service accounts (spec B6 «Settings de un
// cerebro», «Admin»; PR25a): what each row may offer, what a save sends, and how numbers read. Who may
// do what is the server's (B4); this only decides what the screen offers and how it says why not.

// The server's own reading of a repository address (src/domain/repos.ts), so the screen shows what a link
// will match before it is sent: host (with an unusual port) and path, lowercase, without ".git".
// A test checks both read every address the same way.
const USUAL: Record<string, string> = {
  ssh: '22',
  'git+ssh': '22',
  'ssh+git': '22',
  https: '443',
  http: '80',
  git: '9418',
}
export function repoKey(v: unknown): string | null {
  if (typeof v !== 'string') return null
  let s = v.trim()
  if (!s || s.length > 500) return null
  let scheme = 'ssh'
  const scp = /^[^/@\s]+@([^:/\s]+):(?!\/)(.+)$/.exec(s)
  if (scp) s = `${scp[1]}/${scp[2]}`
  else {
    scheme = /^([a-z][a-z0-9+.-]*):\/\//i.exec(s)?.[1]?.toLowerCase() ?? 'https'
    s = s.replace(/^[a-z][a-z0-9+.-]*:\/\//i, '')
    s = s.replace(/^[^/@]*@/, '')
  }
  s = s
    .replace(/:(\d+)(?=\/)/, (_, port: string) => (port === USUAL[scheme] ? '' : `:${port}`))
    .replace(/[?#].*$/, '')
    .replace(/\/+$/, '')
    .replace(/\.git$/i, '')
    .replace(/\/+/g, '/')
    .toLowerCase()
  if (!/^[a-z0-9.-]+(:\d+)?\/\S+$/.test(s) || s.length > 300 || s.includes('..')) return null
  return s
}

export const ROLES = ['reader', 'contributor', 'curator'] as const

export type Member = { accountId: string; kind: string; name: string; email: string | null; role: string }
export type MemberRow = Member & {
  you: boolean
  // The only curator: a brain always keeps one (B4), so its role and its place cannot change.
  lastCurator: boolean
  // The roles it may be given: a service account is never a curator.
  roles: string[]
}

export function memberRows(members: readonly Member[], me: string): MemberRow[] {
  const curators = members.filter((m) => m.role === 'curator').length
  return members.map((m) => ({
    ...m,
    you: m.accountId === me,
    lastCurator: m.role === 'curator' && curators === 1,
    roles: m.kind === 'service' ? ['reader', 'contributor'] : [...ROLES],
  }))
}

// The health thresholds, with the ranges the server accepts (src/domain/wiki/direct.ts).
export const THRESHOLDS = {
  staleDays: { min: 1, max: 3650 },
  longChars: { min: 1000, max: 100_000 },
  maintenanceEvery: { min: 1, max: 1000 },
} as const
export type ThresholdName = keyof typeof THRESHOLDS

export function thresholdProblems(v: Record<ThresholdName, string>): Partial<Record<ThresholdName, string>> {
  const out: Partial<Record<ThresholdName, string>> = {}
  for (const k of Object.keys(THRESHOLDS) as ThresholdName[]) {
    const { min, max } = THRESHOLDS[k]
    const t = v[k].trim()
    const n = /^\d+$/.test(t) ? Number(t) : Number.NaN
    if (!(n >= min && n <= max)) out[k] = `A whole number from ${min} to ${max}.`
  }
  return out
}

export type ProfileOfSettings = {
  guide: string
  guideDefault: string
  customGuide: boolean
  usageNote: string
  usageNoteDefault: string
  revision: string
}

// What a save of the texts sends: always the revision read (so a save on settings someone changed since
// is refused, not lost), the guide as null when it is the default (empty, or the default text itself), so
// the brain follows the default as it improves, and the usage note trimmed.
export function savedSettings(
  read: ProfileOfSettings,
  edit: { guide?: string; usageNote?: string },
): { revision: string; guide?: string | null; usageNote?: string } {
  const out: { revision: string; guide?: string | null; usageNote?: string } = { revision: read.revision }
  if (edit.guide !== undefined) {
    const g = edit.guide.trim()
    out.guide = !g || g === read.guideDefault.trim() ? null : g
  }
  if (edit.usageNote !== undefined) out.usageNote = edit.usageNote.trim()
  return out
}

export type AdminAccount = {
  id: string
  kind: string
  name: string
  email: string | null
  isAdmin: boolean
  canCreateBrains: boolean
  status: string
  brains: number
  roles: Array<{ slug: string; name: string; role: string }>
  lastSeenAt: string | null
  createdAt: string
  mainKeys?: number
}
export type PersonRow = AdminAccount & {
  // The only active administrator: the installation always keeps one (B4).
  lastAdmin: boolean
}

const byStatusThenName = (a: AdminAccount, b: AdminAccount) =>
  Number(a.status !== 'active') - Number(b.status !== 'active') ||
  a.name.localeCompare(b.name, 'en', { sensitivity: 'base' })

export function peopleRows(accounts: readonly AdminAccount[]): PersonRow[] {
  const people = accounts.filter((a) => a.kind === 'person')
  const admins = people.filter((a) => a.isAdmin && a.status === 'active').length
  return [...people]
    .sort(byStatusThenName)
    .map((a) => ({ ...a, lastAdmin: a.isAdmin && a.status === 'active' && admins === 1 }))
}

export function serviceRows(accounts: readonly AdminAccount[]): AdminAccount[] {
  return accounts.filter((a) => a.kind === 'service').sort(byStatusThenName)
}

export function rolesLabel(roles: AdminAccount['roles']): string {
  if (!roles.length) return 'No brains yet'
  return roles.map((r) => `${r.name} (${r.role})`).join(' · ')
}

// How many short keys of a main key work now, and the references they carry (at most five named).
export function refsLabel(live: number, refs: readonly string[]): string {
  if (!live) return 'No short keys live'
  const head = `${live} short ${live === 1 ? 'key' : 'keys'} live`
  if (!refs.length) return head
  const shown = refs.slice(0, 5).join(', ')
  return refs.length > 5 ? `${head}: ${shown} and ${refs.length - 5} more` : `${head}: ${shown}`
}
