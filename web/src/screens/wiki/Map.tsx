// The map of a wiki (spec B6 «Wiki › Map», B2 «Mapa»; T017). Who: any member. Job: see what the wiki holds
// and open a page. Done when: the person opens the page they want. The map lists every page by type and
// first part of its address, with its summary and, when it is not current, its status in words (review
// of PR19: a stale or retired page must be findable too); filters by status (all by default), type, tag
// and words live in the address. With many pages each group shows a few and opens whole.
import { useState } from 'preact/hooks'
import { useFresh } from '../../api/fresh.ts'
import { filterMap, type MapGroup, mapTags, mapTypes, PAGE_STATUSES, PAGE_TYPES } from '../../lib/wiki.ts'
import { online } from '../../session.ts'
import { T } from '../../text.ts'
import { colourAt, PanelHead } from '../../ui/Panel.tsx'
import { viewState } from '../../ui/state.ts'
import { Empty, ErrorState, Skeleton } from '../../ui/states.tsx'
import { pageHref, StatusTag, useBrain, useFilters, WikiHead } from './common.tsx'
import { mapResource } from './data.ts'

const FEW = 12

function Group({ slug, group }: { slug: string; group: MapGroup }) {
  const [all, setAll] = useState(false)
  const shown = all ? group.pages : group.pages.slice(0, FEW)
  const id = `area-${group.type}-${group.area}`
  return (
    // Not a region of its own: a page of many areas would be a page of many landmarks.
    <div class="map-group" data-group={id}>
      <h3 id={id} class="mono area">
        {group.area}
      </h3>
      <ul class="list map-pages">
        {shown.map((p) => (
          <li key={p.address}>
            <p class="list-title">
              <a href={pageHref(slug, p.address)}>{p.title}</a>
              {p.status && p.status !== 'current' ? (
                <>
                  {' '}
                  <StatusTag status={p.status} />
                </>
              ) : null}
            </p>
            <p class="meta mono">{p.address}</p>
            {p.summary ? <p class="summary">{p.summary}</p> : null}
          </li>
        ))}
      </ul>
      {group.pages.length > FEW ? (
        <button
          type="button"
          class="button quiet"
          aria-expanded={all ? 'true' : 'false'}
          onClick={() => setAll(!all)}
        >
          {all ? T.wiki.showFewer : T.wiki.showAll(group.pages.length)}
        </button>
      ) : null}
    </div>
  )
}

export function WikiMap({ slug }: { slug: string }) {
  const { brain, gate } = useBrain(slug)
  const r = mapResource(slug)
  useFresh(r)
  const f = useFilters(['q', 'status', 'type', 'tag'] as const)
  if (!brain) return gate
  const w = T.wiki
  const data = r.data.value
  const groups = data ? filterMap(data.groups, f.values) : []
  const state = viewState({
    loading: r.loading.value,
    data,
    error: r.error.value,
    online: online.value,
    isEmpty: (d) => d.count === 0 || groups.length === 0,
    filtered: Boolean(data?.count) && f.active,
  })
  const byType = PAGE_TYPES.map((t) => ({ type: t, groups: groups.filter((g) => g.type === t) })).filter(
    (x) => x.groups.length,
  )
  const count = groups.reduce((n, g) => n + g.pages.length, 0)
  return (
    <>
      <WikiHead title={w.map} lead={data?.intro || w.noIntro}>
        {data?.count ? <span class="tag">{w.pages(f.active ? count : data.count)}</span> : null}
      </WikiHead>
      {data?.count ? (
        <search aria-label={w.filters}>
          <form class="filters" onSubmit={(e) => e.preventDefault()}>
            <div class="field grow">
              <label for="map-q">{w.filterText}</label>
              <input
                id="map-q"
                type="search"
                value={f.values.q}
                aria-describedby="map-q-hint"
                onInput={(e) => f.set({ q: (e.currentTarget as HTMLInputElement).value })}
              />
              <span id="map-q-hint" class="hint">
                {w.filterTextHint}
              </span>
            </div>
            <div class="field">
              <label for="map-status">{w.status}</label>
              <select
                id="map-status"
                value={f.values.status}
                onChange={(e) => f.set({ status: (e.currentTarget as HTMLSelectElement).value })}
              >
                <option value="">{w.anyStatus}</option>
                {PAGE_STATUSES.map((t) => (
                  <option key={t} value={t}>
                    {w.statuses[t]}
                  </option>
                ))}
              </select>
            </div>
            <div class="field">
              <label for="map-type">{w.type}</label>
              <select
                id="map-type"
                value={f.values.type}
                onChange={(e) => f.set({ type: (e.currentTarget as HTMLSelectElement).value })}
              >
                <option value="">{w.anyType}</option>
                {mapTypes(data.groups).map((t) => (
                  <option key={t} value={t}>
                    {w.types[t] ?? t}
                  </option>
                ))}
              </select>
            </div>
            {/* No tag in this wiki: no tag filter (it could only offer «All tags»). */}
            {mapTags(data.groups).length ? (
              <div class="field">
                <label for="map-tag">{w.tag}</label>
                <select
                  id="map-tag"
                  value={f.values.tag}
                  onChange={(e) => f.set({ tag: (e.currentTarget as HTMLSelectElement).value })}
                >
                  <option value="">{w.anyTag}</option>
                  {mapTags(data.groups).map((t) => (
                    <option key={t} value={t}>
                      {t}
                    </option>
                  ))}
                </select>
              </div>
            ) : null}
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
        <Empty title={w.emptyTitle}>
          <p>{w.emptyLead}</p>
        </Empty>
      ) : state === 'filtered-empty' ? (
        <Empty title={w.emptyTitle} filtered onClear={f.clear} />
      ) : (
        <div class="map">
          {byType.map((x, k) => (
            <section
              key={x.type}
              class="map-type panel pad"
              data-c={colourAt(k)}
              aria-labelledby={`type-${x.type}`}
            >
              <PanelHead
                n={k + 1}
                id={`type-${x.type}`}
                title={w.typesPlural[x.type] ?? x.type}
                meta={w.pages(x.groups.reduce((t, g) => t + g.pages.length, 0))}
              />
              <div class="map-groups">
                {x.groups.map((g) => (
                  <Group key={`${g.type}/${g.area}`} slug={slug} group={g} />
                ))}
              </div>
            </section>
          ))}
        </div>
      )}
    </>
  )
}
