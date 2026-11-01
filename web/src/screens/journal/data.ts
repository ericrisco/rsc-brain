// What the journal screens read (spec B1/B6 through v1), as shared resources under `brain:<slug>:journal`:
// a change made here, or an entry.* / session.* event of the live feed, reloads them all.
import { api } from '../../api/index.ts'
import { invalidate, resource } from '../../api/resource.ts'

type Named = { id: string; name: string }

export type SessionView = {
  id: string
  purpose: string
  ref: string | null
  status: string
  day: string | null
  client: string | null
  author: Named
  entries: number
  // Its entries forgotten since (not in `entries`).
  forgotten: number
  summary: string | null
  summaryEntryId: string | null
  openedAt: string
  lastActivityAt: string
  closedAt: string | null
}
export type SessionList = {
  items: SessionView[]
  total: number
  next: string | null
  liveFrom: string
  facets?: { clients: string[]; authors: Named[] }
}
export type EntryPlain = {
  id: string
  sessionId: string
  type: string
  topic: string | null
  title: string
  content: string
  appliesTo: string | null
  tags: string[]
  refs: string[]
  authorId: string
  ref: string | null
  revision: number
  repeatCount: number
  pinned: boolean
  reviewAfter: string | null
  expiresAt: string | null
  state: string
  supersededBy: string | null
  createdAt: string
  updatedAt: string
}
export type EntryRead = EntryPlain & {
  author: Named
  onBehalf: Named | null
  client: string | null
  forgotten: { by: Named; reason: string; at: string } | null
}
export type Relation = {
  id: string
  kind: string
  status: string
  direction: 'out' | 'in'
  other: { id: string; title: string | null; type: string; state: string }
  reason: string | null
  by: Named
  createdAt: string
}
export type Revision = {
  revision: number
  type: string
  title: string
  content: string
  authorId: string
  authorName: string
  createdAt: string
}
// With its client and author, so it is named as everywhere else (lib/journal.ts, sessionLabel).
export type SessionRef = {
  id: string
  purpose: string
  day: string | null
  client: string | null
  author: { id: string; name: string }
}
export type EntryReading = {
  entry: EntryRead
  session: SessionRef
  relations: Relation[]
  history?: Revision[]
}
// An entry in a session's list: whether an open conflict is about it.
export type EntryListed = EntryPlain & { conflict: boolean }
export type ConflictSide = EntryRead & { session: SessionRef }
export type Conflict = {
  relation: { id: string; fromId: string; toId: string; kind: string; status: string; reason: string }
  from: ConflictSide
  to: ConflictSide
  why: string
}
export type Listing<T> = { items: T[]; total: number; next: string | null }
export type Member = { accountId: string; name: string; role: string }

const key = (slug: string, rest: string) => `brain:${slug}:journal:${rest}`

export const sessionsResource = (slug: string, query: Record<string, string>) => {
  const qs = new URLSearchParams(query).toString()
  return resource(key(slug, `sessions?${qs}`), () =>
    api.call<SessionList>('sessions', { path: { slug }, query: { ...query, limit: 50 } }),
  )
}

export const sessionResource = (slug: string, id: string) =>
  resource(key(slug, `session:${id}`), () => api.call<{ session: SessionView }>('session', { path: { id } }))

// One visit to an entry is one read (with its history and relations in the same request).
export const entryResource = (slug: string, id: string) =>
  resource(key(slug, `entry:${id}`), () =>
    api.call<EntryReading>('entry', { path: { id }, query: { history: 1 } }),
  )

export const conflictsResource = (slug: string) =>
  resource(key(slug, 'conflicts'), () =>
    api.call<{ conflicts: Conflict[]; total: number; next: string | null }>('conflicts', {
      path: { slug },
      query: { limit: 10 },
    }),
  )

export const forgottenResource = (slug: string) =>
  resource(key(slug, 'forgotten'), () =>
    api.call<Listing<EntryRead>>('forgotten', { path: { slug }, query: { limit: 50 } }),
  )

export const toReviewResource = (slug: string) =>
  resource(key(slug, 'to-review'), () =>
    api.call<Listing<EntryRead>>('toReview', { path: { slug }, query: { limit: 50 } }),
  )

// Who the curators are, to say whom to ask (spec B6 «Sin permiso»: por qué y a quién pedirlo).
export const membersResource = (slug: string) =>
  resource(`brain:${slug}:members`, () => api.call<{ members: Member[] }>('members', { path: { slug } }))

export function curatorNames(slug: string): string {
  const m = membersResource(slug).data.value?.members ?? []
  return m
    .filter((x) => x.role === 'curator')
    .slice(0, 3)
    .map((x) => x.name)
    .join(', ')
}

// After a change made here: the journal of the brain, its overview and its numbers are asked again.
export function journalChanged(slug: string): void {
  invalidate(`brain:${slug}:journal`)
  invalidate(`brain:${slug}:overview`)
  // A wiki page lists the corrections about it: one added, forgotten or superseded changes that list.
  invalidate(`brain:${slug}:wiki:page:`)
  // Its numbers (the count of conflicts beside «Conflicts»).
  invalidate(`brain:${slug}:basic`)
  invalidate('brains')
}
