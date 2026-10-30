// The logic of the journal screens (spec B6 «Journal», B1), kept free of the DOM so it is tested on its
// own: authorship in words, what a person may do with an entry (the server's can() rules, so the web
// never offers what the API refuses nor hides what it allows), what a correction is about, relations in
// words and as requests, the filters of Sessions, and draft keys.
import { T } from '../text.ts'

type Named = { id: string; name: string }

// «Claude Code of Eric», «RSC Factory (run r_x, step 3) on behalf of Eric» (spec B6 «Entry»).
export function byline(e: {
  author: Named
  onBehalf: Named | null
  client: string | null
  ref: string | null
}) {
  const ref = e.ref ? ` (${e.ref})` : ''
  if (e.onBehalf) return `${e.author.name}${ref} on behalf of ${e.onBehalf.name}`
  if (e.client === 'web') return `${e.author.name}, in the web`
  if (e.client) return `${e.client} of ${e.author.name}${ref}`
  return `${e.author.name}${ref}`
}

export type Powers = {
  correct: boolean
  forget: boolean
  schedule: boolean
  pin: boolean
  relate: boolean
  recover: boolean
  addCorrection: boolean
}

const RANK: Record<string, number> = { reader: 1, contributor: 2, curator: 3 }
const atLeast = (role: string | null, min: string) => (RANK[role ?? ''] ?? 0) >= (RANK[min] ?? 99)

// What the person signed in to the web may do with an entry (src/auth/can.ts): changing, dating and
// forgetting are for its author (contributor or more) or a curator; pinning and recovering for curators;
// relating and adding corrections for contributors or more. An archived brain is read-only.
export function entryPowers(
  e: { state: string; authorId: string },
  who: { role: string | null; me: string; archived: boolean },
): Powers {
  const open = !who.archived
  const active = open && e.state === 'active'
  const curator = atLeast(who.role, 'curator')
  const mine = e.authorId === who.me && atLeast(who.role, 'contributor')
  return {
    correct: active && (curator || mine),
    forget: active && (curator || mine),
    schedule: active && (curator || mine),
    pin: active && curator,
    relate: active && atLeast(who.role, 'contributor'),
    recover: open && e.state === 'forgotten' && curator,
    addCorrection: open && e.state !== 'purged' && atLeast(who.role, 'contributor'),
  }
}

// A correction written in the web names what it is about among its references.
export function aboutOf(refs: string[]): { page: string | null; entry: string | null; rest: string[] } {
  let page: string | null = null
  let entry: string | null = null
  const rest: string[] = []
  for (const r of refs) {
    if (page === null && r.startsWith('page:')) page = r.slice(5)
    else if (entry === null && r.startsWith('entry:')) entry = r.slice(6)
    else rest.push(r)
  }
  return { page, entry, rest }
}

export type RelationLike = {
  kind: string
  direction: 'out' | 'in'
  status: string
  other: { id: string; title: string | null; type: string; state: string }
}

// The relation from this entry's side.
export function relationWords(r: RelationLike): string {
  const j = T.journal.relation
  const base =
    r.kind === 'contradicts'
      ? r.direction === 'out'
        ? j.contradicts
        : j.contradictedBy
      : r.kind === 'supersedes'
        ? r.direction === 'out'
          ? j.supersedes
          : j.supersededBy
        : j.notRelated
  if (r.status === 'pending_person') return `${base} ${j.waits}`
  if (r.status === 'rejected') return `${base} ${j.turnedDown}`
  return base
}

// A choice in the "Relate" form, as the request: «this one is superseded by the other» swaps the two.
export type RelateChoice = 'contradicts' | 'supersedes' | 'superseded' | 'not_related'
export function relateBody(choice: RelateChoice, here: string, other: string) {
  if (choice === 'superseded') return { from: other, to: here, kind: 'supersedes' }
  return { from: here, to: other, kind: choice }
}

// A session in a line: its purpose; the session a key gets by writing without opening one has none.
export function sessionLabel(s: { purpose: string; day: string | null }): string {
  if (s.day) return T.journal.implicitSession(T.date(`${s.day}T00:00:00.000Z`))
  return s.purpose.trim() || T.journal.noPurpose
}

export const SESSION_FILTERS = [
  'status',
  'client',
  'author',
  'type',
  'ref',
  'from',
  'to',
  'uncompiled',
] as const
export type SessionFilters = Partial<Record<(typeof SESSION_FILTERS)[number], string>>

// The filters of Sessions as the query of GET /v1/brains/{slug}/sessions.
export function sessionQuery(f: SessionFilters): Record<string, string> {
  const out: Record<string, string> = {}
  for (const k of SESSION_FILTERS) {
    const v = (f[k] ?? '').trim()
    if (!v) continue
    out[k] = k === 'uncompiled' ? '1' : v
  }
  return out
}

// A later page of a list, added after what the first page holds (a fresh first page may already have it).
export function mergeById<T extends { id: string }>(first: T[], more: T[]): T[] {
  const seen = new Set(first.map((x) => x.id))
  return [...first, ...more.filter((x) => !seen.has(x.id))]
}

// The day of an instant, for a date field (UTC, as every date of the web).
export const dayOf = (iso: string | null | undefined): string => (iso ? iso.slice(0, 10) : '')

// A draft of the journal, per person, brain and thing, in hex: a name made of letters could spell a word
// the draft's guard against secrets refuses ("code"), and the form would break.
export function journalDraftKey(account: string, slug: string, what: string): string {
  let h = 0x811c9dc5
  for (const ch of `${account}\u0000${slug}\u0000${what}`) {
    h ^= ch.codePointAt(0) ?? 0
    h = Math.imul(h, 0x01000193) >>> 0
  }
  return `journal.${h.toString(16).padStart(8, '0')}`
}
