// What the proposals screens read (spec B2/B6 through v1), as shared resources under `brain:<slug>:proposals`:
// a decision taken here, or a proposal.* event of the live feed, reloads them all.
import { api } from '../../api/index.ts'
import { invalidate, resource } from '../../api/resource.ts'
import type { PageState, ReviewOp } from '../../lib/proposals.ts'

export const STATUSES = [
  'pending',
  'approved',
  'partially_approved',
  'returned',
  'withdrawn',
  'superseded',
] as const
export type Status = (typeof STATUSES)[number]

export type ProposalView = {
  id: string
  title: string
  reason: string
  authorId: string
  authorName: string
  agent: string | null
  status: Status
  old: boolean
  supersedes: string | null
  supersededBy: string | null
  collected: string[]
  comment: string | null
  decidedBy: string | null
  decidedByName: string | null
  decidedAt: string | null
  lastError: string | null
  createdAt: string
}
export type InboxItem = ProposalView & { opCount: number }
export type InboxPage = {
  items: InboxItem[]
  total: number
  next: string | null
  counts?: Record<Status, number>
}
export type Review = {
  proposal: ProposalView
  fingerprint: string
  ops: ReviewOp[]
  warnings: ReviewOp['warnings']
  canDecide: boolean
}
export type Decision = {
  proposal: ProposalView
  ops: Array<{ index: number; status: string }>
  applied: Array<{ index?: number; pageId: string; address: string; revision: number }>
}
export type { PageState }

export const PAGE_SIZE = 20

const base = (slug: string) => `/b/${encodeURIComponent(slug)}/proposals`
export const inboxHref = (slug: string, status?: string) =>
  status && status !== 'pending' ? `${base(slug)}?status=${status}` : base(slug)
export const proposalHref = (slug: string, id: string) => `${base(slug)}/${encodeURIComponent(id)}`

// Pending ones oldest first: what has waited longest is reviewed first (the old ones lead). Decided ones
// newest first: the last decisions are what a person looks for.
export const orderOf = (status: Status) => (status === 'pending' ? 'oldest' : 'newest')

export const inboxResource = (slug: string, status: Status) =>
  resource(`brain:${slug}:proposals:list:${status}`, () =>
    api.call<InboxPage>('proposals', {
      path: { slug },
      query: { status, limit: PAGE_SIZE, order: orderOf(status) },
    }),
  )

export const reviewResource = (slug: string, id: string) =>
  resource(`brain:${slug}:proposals:review:${id}`, () => api.call<Review>('proposalReview', { path: { id } }))

// After a decision: the inbox, the brain's numbers, the counter of the top bar and the wiki it changed.
export function proposalsChanged(slug: string): void {
  invalidate(`brain:${slug}:proposals`)
  invalidate(`brain:${slug}:overview`)
  invalidate(`brain:${slug}:basic`)
  invalidate(`brain:${slug}:wiki`)
  invalidate('brains')
}
