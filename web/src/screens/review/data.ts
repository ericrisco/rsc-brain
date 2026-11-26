// What «Review later» reads (spec learning-memory A2 through v1), as shared resources under `brain:<slug>:review`:
// a Keep or an Undo here, or a wiki.changed event of the live feed, reloads them.
import { api } from '../../api/index.ts'
import { invalidate, resource } from '../../api/resource.ts'

export const STATES = ['pending_review', 'kept', 'undone', 'all'] as const
export type State = (typeof STATES)[number]

export type Change = {
  id: string
  at: string
  actor: { id: string; name: string }
  keyName: string | null
  ref: string | null
  proposalId: string | null
  title: string
  parts: number
  state: 'pending_review' | 'kept' | 'undone' | 'partly_undone'
  decidedBy: string | null
  decidedAt: string | null
  pages?: Array<{ address: string; op: string | null }>
  comment?: string | null
  correction?: string | null
}
export type ChangePage = { items: Change[]; total: number; next: string | null }
export type Part = {
  part: number
  op: string | null
  address: string
  revisionBefore: number | null
  revisionAfter: number
  created: boolean
  dependsOn: number[]
  diff: string
  state: 'applied' | 'undone'
  operation?: {
    op: string
    reason: string | null
    kind?: string
    to?: string
    from?: string
    status?: string
  } | null
}
export type ChangeDetail = { change: Change; parts: Part[] }
export type UndoAnswer =
  | {
      change: Change
      undone: Array<{ address: string; revision: number }>
      discarded: number[]
      correction?: string
      overwritten?: Array<{ address: string; revisions: number[]; editedBy: string[]; leftAsIs?: string[] }>
    }
  | { alreadyUndone: true }
export type Conflict = {
  pages: Array<{
    address: string
    changeRevision: number
    currentRevision: number
    editedBy?: string
    editedAt?: string
    differs?: string[]
    links?: Array<{ from: string; kind: string; now: 'added' | 'removed' }>
  }>
  addresses?: Array<{ address: string; heldBy: string }>
}

export const PAGE_SIZE = 20

const base = (slug: string) => `/b/${encodeURIComponent(slug)}/review-later`
export const reviewHref = (slug: string, state?: string) =>
  state && state !== 'pending_review' ? `${base(slug)}?state=${state}` : base(slug)
export const changeHref = (slug: string, id: string) => `${base(slug)}/${encodeURIComponent(id)}`

// «Since» of the tray, as the server takes it: a date and time.
export const SINCE = ['all', 'today', '7d'] as const
export type Since = (typeof SINCE)[number]
export function sinceOf(s: Since, now = new Date()): string | undefined {
  if (s === 'today') return new Date(now.getFullYear(), now.getMonth(), now.getDate()).toISOString()
  if (s === '7d') return new Date(now.getTime() - 7 * 86_400_000).toISOString()
  return undefined
}

export const changesResource = (slug: string, state: State, since: Since = 'all') =>
  resource(`brain:${slug}:review:list:${state}:${since}`, () => {
    const from = sinceOf(since)
    return api.call<ChangePage>('changes', {
      path: { slug },
      query: { state, limit: PAGE_SIZE, ...(from ? { since: from } : {}) },
    })
  })
export const changeResource = (slug: string, id: string) =>
  resource(`brain:${slug}:review:one:${id}`, () => api.call<ChangeDetail>('change', { path: { id } }))

// After a Keep or an Undo: the tray, the change, the brain's numbers and the pages it touched read again.
export function reviewed(slug: string): void {
  invalidate(`brain:${slug}:review`)
  invalidate('brains')
  invalidate(`brain:${slug}:wiki`)
  invalidate(`brain:${slug}:proposals`)
}

// The parts an undo of `chosen` must take along: a part that stays may not need one that goes, so whatever needs a
// chosen part (directly or through others) goes too (the server refuses otherwise: missing_dependencies).
export function withNeeders(parts: Part[], chosen: number[]): number[] {
  const out = new Set(chosen)
  let grew = true
  while (grew) {
    grew = false
    for (const p of parts) {
      if (p.state !== 'applied' || out.has(p.part)) continue
      if (p.dependsOn.some((d) => out.has(d))) {
        out.add(p.part)
        grew = true
      }
    }
  }
  return [...out].sort((a, b) => a - b)
}
