// The decisions of a wiki (spec B6 «Wiki › Decisions», B2 «Decisiones»; T020). Who: any member. Job: find
// what was decided and whether it still holds. Done when: the person opens the decision. Newest first,
// with its status in words; filters by status and words live in the address.
import { useFresh } from '../../api/fresh.ts'
import { filterDecisions, PAGE_STATUSES } from '../../lib/wiki.ts'
import { online } from '../../session.ts'
import { T } from '../../text.ts'
import { viewState } from '../../ui/state.ts'
import { Empty, ErrorState, Skeleton } from '../../ui/states.tsx'
import { pageHref, StatusTag, useBrain, useFilters, WikiHead } from './common.tsx'
import { decisionsResource } from './data.ts'

export function WikiDecisions({ slug }: { slug: string }) {
  const { brain, gate } = useBrain(slug)
  const r = decisionsResource(slug)
  useFresh(r)
  const f = useFilters(['q', 'status'] as const)
  if (!brain) return gate
  const w = T.wiki
  const all = r.data.value?.decisions
  const shown = all ? filterDecisions(all, f.values) : []
  const state = viewState({
    loading: r.loading.value,
    data: all,
    error: r.error.value,
    online: online.value,
    isEmpty: (d) => d.length === 0 || shown.length === 0,
    filtered: Boolean(all?.length) && f.active,
  })
  return (
    <>
      <WikiHead title={w.decisionsTitle} lead={w.decisionsLead}>
        {all?.length ? <span class="tag">{w.decisions(f.active ? shown.length : all.length)}</span> : null}
      </WikiHead>
      {all?.length ? (
        <search aria-label={w.filters}>
          <form class="filters" onSubmit={(e) => e.preventDefault()}>
            <div class="field grow">
              <label for="dec-q">{w.filterText}</label>
              <input
                id="dec-q"
                type="search"
                value={f.values.q}
                onInput={(e) => f.set({ q: (e.currentTarget as HTMLInputElement).value })}
              />
            </div>
            <div class="field">
              <label for="dec-status">{w.status}</label>
              <select
                id="dec-status"
                value={f.values.status}
                onChange={(e) => f.set({ status: (e.currentTarget as HTMLSelectElement).value })}
              >
                <option value="">{w.anyStatus}</option>
                {PAGE_STATUSES.filter((s) => s !== 'retired').map((s) => (
                  <option key={s} value={s}>
                    {w.statuses[s]}
                  </option>
                ))}
              </select>
            </div>
          </form>
        </search>
      ) : null}
      {state === 'loading' ? (
        <Skeleton rows={4} />
      ) : state === 'error' || state === 'offline' || state === 'forbidden' ? (
        r.error.value ? (
          <ErrorState error={r.error.value} onRetry={() => void r.reload()} />
        ) : null
      ) : state === 'empty' ? (
        <Empty title={w.noDecisionsTitle}>
          <p>{w.noDecisionsLead}</p>
        </Empty>
      ) : state === 'filtered-empty' ? (
        <Empty title={w.noDecisionsTitle} filtered onClear={f.clear} />
      ) : (
        <ul class="list" aria-label={w.decisionsTitle}>
          {shown.map((d) => (
            <li key={d.address}>
              <p class="list-title">
                <a href={pageHref(slug, d.address)}>{d.title}</a> <StatusTag status={d.status} />
              </p>
              {d.summary ? <p class="summary">{d.summary}</p> : null}
              <p class="meta">
                <span class="mono">{d.address}</span> · {w.decided(T.date(d.createdAt))}
              </p>
            </li>
          ))}
        </ul>
      )}
    </>
  )
}
