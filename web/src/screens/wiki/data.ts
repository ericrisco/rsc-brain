// What the wiki screens read (spec B2 through v1), as shared resources: a change to the wiki (an edit, the
// live feed's wiki.changed) reloads everything under `brain:<slug>:wiki`.
import { api } from '../../api/index.ts'
import { invalidate, resource } from '../../api/resource.ts'
import type { Answer } from '../../graph/model.ts'
import type { MentionState } from '../../lib/markdown.ts'
import type { MapGroup, Source } from '../../lib/wiki.ts'

export type WikiPage = {
  id: string
  address: string
  type: string
  title: string
  summary: string
  body: string
  tags: string[]
  status: string
  supersededBy: string | null
  revision: number
  createdAt: string
  updatedAt: string
}
export type LinkView = {
  kind: string
  address: string
  pageId: string | null
  title: string | null
  state: MentionState
}
export type LastChange = { revision: number; authorId: string; authorName: string; at: string }
export type SourceView =
  | { entryId: string; title: string | null; state: 'active' | 'forgotten' | 'purged' }
  | { url: string; title: string | null }
export type PageCorrection = {
  id: string
  title: string
  appliesTo: string | null
  author: { id: string; name: string }
  createdAt: string
}
export type Reading = {
  page: WikiPage
  redirectedFrom?: string
  notice?: string
  links: { out: LinkView[]; in: LinkView[] }
  sources: SourceView[]
  lastChange?: LastChange | null
  // The corrections in force about it («Something wrong here?»).
  corrections?: PageCorrection[]
  // Its revisions, read with the page (one read of the page per visit, not two).
  history?: RevisionSummary[]
}
export type RevisionSummary = {
  revision: number
  address: string
  title: string
  status: string
  kind: string
  change?: string
  restoredFrom?: number | null
  reason?: string | null
  authorId: string
  authorName: string
  createdAt: string
}
export type FullRevision = RevisionSummary & {
  type: string
  summary: string
  body: string
  tags: string[]
  sources: Source[]
  links: { kind: string; to: string }[]
}
export type Decision = {
  address: string
  title: string
  summary: string
  status: string
  createdAt: string
  updatedAt: string
}
export type LogLine = {
  id: string
  at: string
  actorId: string
  actorName: string
  kind: string
  proposalId: string | null
  summary: string
  reason?: string | null
  pages: string[]
}
export type Listing<T> = { items: T[]; next: string | null; total: number }
export type TrailLine = {
  id: number
  at: string
  kind: string
  account: { id: string; name: string }
  credential: { kind: string; name: string }
}
export type Entry = {
  id: string
  type: string
  title: string
  content: string
  tags: string[]
  state: string
  createdAt: string
}
export type Changed = {
  revised: { pageId: string; address: string; revision: number }[]
  page: Reading | null
}

const key = (slug: string, rest: string) => `brain:${slug}:wiki:${rest}`

// Every page whatever its status (the web's map filters by status; B2's map lists current pages only).
export const mapResource = (slug: string) =>
  resource(key(slug, 'map'), () =>
    api.call<{ intro: string; groups: MapGroup[]; count: number }>('wikiMap', {
      path: { slug },
      query: { status: 'all' },
    }),
  )

// The page with its history: one request, so one visit is one read in «Who read this».
export const pageResource = (slug: string, address: string) =>
  resource(key(slug, `page:${address}`), () =>
    api.call<Reading>('page', { path: { slug, address }, query: { include: 'history' } }),
  )

// The page as a change left it, at once (its history follows when the page is read again).
export function pageChanged(slug: string, reading: Reading): void {
  const r = pageResource(slug, reading.page.address)
  r.data.value = { ...reading, history: r.data.value?.history ?? [] }
}

export const compareResource = (slug: string, address: string, a: number, b: number) =>
  resource(key(slug, `compare:${address}:${a},${b}`), () =>
    api.call<{ a: FullRevision; b: FullRevision }>('page', {
      path: { slug, address },
      query: { compare: `${a},${b}` },
    }),
  )

export const readersResource = (slug: string, address: string) =>
  resource(key(slug, `readers:${address}`), () =>
    api.call<{ items: TrailLine[]; older?: { reads: number; contexts: number; searches: number } }>('trail', {
      path: { slug },
      query: { page: address, limit: 50 },
    }),
  )

export const decisionsResource = (slug: string) =>
  resource(key(slug, 'decisions'), () =>
    api.call<{ decisions: Decision[] }>('wikiDecisions', { path: { slug } }),
  )

export const entryResource = (id: string) =>
  resource(`entry:${id}`, () => api.call<{ entry: Entry }>('entry', { path: { id } }))

// After a change by hand: everything of this wiki is asked again.
export const wikiChanged = (slug: string) => {
  invalidate(`brain:${slug}:wiki`)
  invalidate(`brain:${slug}:overview`)
}

// The graph, whole or one group (G10); with filters, the counts of a graph drawn by groups.
// `loose`: the pages gathered at the level of `group` (the top without one).
export const graphResource = (
  slug: string,
  group: string,
  filters: Record<string, string> = {},
  loose = false,
) => {
  const f = Object.fromEntries(Object.entries(filters).filter(([, v]) => v))
  return resource(key(slug, `graph:${group}:${loose ? 'loose:' : ''}${JSON.stringify(f)}`), () =>
    api.call<Answer>('wikiGraph', {
      path: { slug },
      query: { prefix: group || undefined, ...(loose ? { loose: '1' } : {}), ...f },
    }),
  )
}

// A page as the inspector of the graph shows it: summary and links (no history).
export const peekResource = (slug: string, address: string) =>
  resource(key(slug, `peek:${address}`), () => api.call<Reading>('page', { path: { slug, address } }))

export type PageRow = {
  address: string
  title: string
  type: string
  status: string
  tags: string[]
  in: number
  out: number
  updatedAt: string
}

// The full list beside the graph (G9), by pages, filtered and sorted.
export const pagesResource = (slug: string, query: Record<string, string>) => {
  const q = Object.fromEntries(Object.entries(query).filter(([, v]) => v))
  return resource(key(slug, `pages:${JSON.stringify(q)}`), () =>
    api.call<Listing<PageRow>>('wikiPages', { path: { slug }, query: q }),
  )
}
