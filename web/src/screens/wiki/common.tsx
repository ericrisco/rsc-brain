// What the wiki screens share: the brain they are in (and the person's role there), the status and type
// of a page in words, the filters kept in the address (they survive a reload, DESIGN.md «Layout»), and a
// region that announces what an action did.
import type { ComponentChildren } from 'preact'
import { useLocation } from 'preact-iso'
import { pageHref } from '../../lib/markdown.ts'
import { online } from '../../session.ts'
import { T } from '../../text.ts'
import { viewState, writeBlocked } from '../../ui/state.ts'
import { ErrorState, Skeleton } from '../../ui/states.tsx'
import { type BrainOne, brainResource } from '../Brain.tsx'

export { pageHref }
export const mapHref = (slug: string) => `/b/${encodeURIComponent(slug)}/wiki`
export const decisionsHref = (slug: string) => `${mapHref(slug)}/decisions`
export const logHref = (slug: string) => `${mapHref(slug)}/log`

// The brain a wiki screen is in; until it is known, its loading or refusal is the screen.
export function useBrain(slug: string): { brain: BrainOne | undefined; gate: ComponentChildren | null } {
  const r = brainResource(slug)
  const brain = r.data.value?.brain
  const state = viewState({
    loading: r.loading.value,
    data: r.data.value,
    error: r.error.value,
    online: online.value,
  })
  if (brain) return { brain, gate: null }
  if (state === 'loading' || !r.error.value) return { brain, gate: <Skeleton rows={3} /> }
  return { brain, gate: <ErrorState error={r.error.value} onRetry={() => void r.reload()} /> }
}

export const isCurator = (b: BrainOne | undefined) => b?.role === 'curator' && b.status !== 'archived'

// Why a change cannot be sent now (offline, or one already on its way), or null.
export const blockedNow = (pending: boolean) => writeBlocked({ online: online.value, pending })

export function StatusTag({ status }: { status: string }) {
  const word = T.wiki.statuses[status] ?? status
  return <span class={`tag status-${status}${status === 'current' ? '' : ' warn'}`}>{word}</span>
}

export function TypeTag({ type }: { type: string }) {
  return <span class="tag">{T.wiki.types[type] ?? type}</span>
}

// The filters of a screen, read from and written to its address (replacing the history entry).
export function useFilters<K extends string>(keys: readonly K[]) {
  const { path, query, route } = useLocation()
  const values = Object.fromEntries(keys.map((k) => [k, query[k] ?? ''])) as Record<K, string>
  const set = (next: Partial<Record<K, string>>) => {
    const q = new URLSearchParams()
    for (const [k, v] of Object.entries({ ...query, ...next }) as [string, string][]) if (v) q.set(k, v)
    const qs = q.toString()
    route(qs ? `${path}?${qs}` : path, true)
  }
  const active = keys.some((k) => values[k])
  const clear = () => set(Object.fromEntries(keys.map((k) => [k, ''])) as Partial<Record<K, string>>)
  return { values, set, active, clear }
}

// What the last action did, said to a screen reader too.
export function Said({ text, tone = 'ok' }: { text: string | null; tone?: 'ok' | 'error' }) {
  return (
    <p class={`said ${tone}`} role={tone === 'ok' ? 'status' : 'alert'}>
      {text}
    </p>
  )
}

export function WikiHead({
  title,
  lead,
  children,
}: {
  title: string
  lead?: ComponentChildren
  children?: ComponentChildren
}) {
  return (
    <>
      <div class="title-row start">
        <h1 class="title">{title}</h1>
        {children}
      </div>
      {lead ? <p class="lead">{lead}</p> : null}
    </>
  )
}
