// Home, the first version (spec B6 «Home: mis cerebros»; the cards with their numbers arrive with G7 in
// PR18): the brains of the person, their role, and what each is for. Empty: who can give access.
import { api } from '../api/index.ts'
import { resource } from '../api/resource.ts'
import { online } from '../session.ts'
import { T } from '../text.ts'
import { viewState } from '../ui/state.ts'
import { Empty, ErrorState, Skeleton } from '../ui/states.tsx'

export type BrainRow = { slug: string; name: string; purpose: string; status: string; role: string }

export const brainsResource = () =>
  resource<{ brains: BrainRow[] }>('brains', () => api.call<{ brains: BrainRow[] }>('brains'))

export function Home() {
  const r = brainsResource()
  const data = r.data.value
  const state = viewState({
    loading: r.loading.value,
    data,
    error: r.error.value,
    online: online.value,
    isEmpty: (d) => d.brains.length === 0,
  })
  return (
    <>
      <div class="title-row">
        <h1 class="title">{T.home.title}</h1>
        {data?.brains.length ? <span class="meta">{T.home.count(data.brains.length)}</span> : null}
      </div>
      {state === 'loading' ? <Skeleton rows={3} /> : null}
      {state === 'error' || state === 'offline' || state === 'forbidden' ? (
        r.error.value ? (
          <ErrorState error={r.error.value} onRetry={() => void r.reload()} />
        ) : null
      ) : null}
      {state === 'empty' ? (
        <Empty title={T.home.emptyTitle}>
          <p>{T.home.emptyLead}</p>
        </Empty>
      ) : null}
      {state === 'ready' && data ? (
        <section aria-label={T.home.title}>
          <div class="rows-head" aria-hidden="true">
            <span>Brain</span>
            <span>{T.brain.purpose}</span>
            <span>{T.home.role}</span>
          </div>
          <ul class="rows">
            {data.brains.map((b) => (
              <li key={b.slug}>
                <a class="name" href={`/b/${encodeURIComponent(b.slug)}`}>
                  {b.name}
                </a>
                <span class="purpose">{b.purpose || <span class="muted">{T.brain.noPurpose}</span>}</span>
                <span class="role">
                  {b.role}
                  {b.status === 'archived' ? ` · ${T.home.archived}` : ''}
                </span>
              </li>
            ))}
          </ul>
        </section>
      ) : null}
    </>
  )
}
