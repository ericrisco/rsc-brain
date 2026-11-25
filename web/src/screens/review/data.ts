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
}
export type ChangeDetail = { change: Change; parts: Part[] }
export type UndoAnswer =
  | {
      change: Change
      undone: Array<{ address: string; revision: number }>
      discarded: number[]
      correction?: string
    }
  | { alreadyUndone: true }
export type Conflict = {
  pages: Array<{ address: string; changeRevision: number; currentRevision: number }>
  addresses?: Array<{ address: string; heldBy: string }>
}

export const PAGE_SIZE = 20

const base = (slug: string) => `/b/${encodeURIComponent(slug)}/review-later`
export const reviewHref = (slug: string, state?: string) =>
  state && state !== 'pending_review' ? `${base(slug)}?state=${state}` : base(slug)
export const changeHref = (slug: string, id: string) => `${base(slug)}/${encodeURIComponent(id)}`

export const changesResource = (slug: string, state: State) =>
  resource(`brain:${slug}:review:list:${state}`, () =>
    api.call<ChangePage>('changes', { path: { slug }, query: { state, limit: PAGE_SIZE } }),
  )
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
