// What the wiki screens read (spec B2 through v1), as shared resources: a change to the wiki (an edit, the
// live feed's wiki.changed) reloads everything under `brain:<slug>:wiki`.
import { api } from '../../api/index.ts'
import { invalidate, resource } from '../../api/resource.ts'
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
export type SourceView =
  | { entryId: string; title: string | null; state: 'active' | 'forgotten' | 'purged' }
  | { url: string; title: string | null }
export type Reading = {
  page: WikiPage
  redirectedFrom?: string
  notice?: string
  links: { out: LinkView[]; in: LinkView[] }
  sources: SourceView[]
}
export type RevisionSummary = {
  revision: number
  address: string
  title: string
  status: string
  kind: string
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

export const mapResource = (slug: string) =>
  resource(key(slug, 'map'), () =>
    api.call<{ intro: string; groups: MapGroup[]; count: number }>('wikiMap', { path: { slug } }),
  )

export const pageResource = (slug: string, address: string) =>
  resource(key(slug, `page:${address}`), () => api.call<Reading>('page', { path: { slug, address } }))

export const historyResource = (slug: string, address: string) =>
  resource(key(slug, `history:${address}`), () =>
    api.call<{ history: RevisionSummary[] }>('page', { path: { slug, address }, query: { history: 1 } }),
  )

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
