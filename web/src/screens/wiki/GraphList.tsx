// The list beside the graph (spec B6 «Graph»: «alternativa en lista, obligatoria»; T033). Every page of the
// wiki with its type, status and links in and out, sorted by any column and filtered as the graph is, by
// pages of 50 (G9: the list stays whole whatever the size of the wiki). What the graph does, it does by
// keyboard: inspect, open the page, focus at one or two hops (a table of the page and its neighbours), and,
// in a wiki drawn by groups, a table of the groups to open one by one.
import { useState } from 'preact/hooks'
import { type Filters, keyOf, linksOf, type Model } from '../../graph/model.ts'
import { T } from '../../text.ts'
import { Empty, ErrorState, Skeleton } from '../../ui/states.tsx'
import { pageHref, StatusTag } from './common.tsx'
import { type PageRow, pagesResource } from './data.ts'
import type { Target } from './Graph.tsx'

const PER = 50
const COLUMNS = ['title', 'address', 'type', 'status', 'in', 'out', 'updatedAt'] as const
type Column = (typeof COLUMNS)[number]

export function GraphList({
  slug,
  model,
  filters,
  group,
  sort,
  focus,
  setSort,
  onInspect,
  onFocus,
  onOpenGroup,
  selected,
}: {
  slug: string
  model: Model
  filters: Filters
  group: string
  sort: string
  focus: { index: number; hood: Map<number, number> } | null
  setSort: (sort: string) => void
  onInspect: (t: Target) => void
  onFocus: (address: string, hops: 1 | 2) => void
  onOpenGroup: (prefix: string) => void
  selected: string | null
}) {
  return (
    <div class="graph-list">
      {model.mode === 'groups' && !group ? (
        <GroupsTable
          model={model}
          type={filters.type}
          onInspect={onInspect}
          onOpenGroup={onOpenGroup}
          selected={selected}
        />
      ) : null}
      {focus ? (
        <FocusTable
          slug={slug}
          model={model}
          focus={focus}
          onInspect={onInspect}
          onFocus={onFocus}
          selected={selected}
        />
      ) : (
        <PagesTable
          slug={slug}
          filters={filters}
          group={group}
          sort={sort}
          setSort={setSort}
          onInspect={onInspect}
          onFocus={onFocus}
          selected={selected}
        />
      )}
    </div>
  )
}

function GroupsTable({
  model,
  type,
  onInspect,
  onOpenGroup,
  selected,
}: {
  model: Model
  type: string
  onInspect: (t: Target) => void
  onOpenGroup: (prefix: string) => void
  selected: string | null
}) {
  const g = T.graph
  const rows = model.items.flatMap((it, i) =>
    it.kind === 'group' && (!type || (it.types[type] ?? 0) > 0) ? [{ it, i }] : [],
  )
  return (
    <div class="table-wrap" data-scroll-x>
      <table class="data-table">
        <caption>{g.groupsTable}</caption>
        <thead>
          <tr>
            <th scope="col">{g.col.group}</th>
            <th scope="col" class="num">
              {g.col.pages}
            </th>
            <th scope="col">{g.col.types}</th>
            <th scope="col" class="num">
              {g.col.links}
            </th>
            <th scope="col">{g.col.actions}</th>
          </tr>
        </thead>
        <tbody>
          {rows.map(({ it, i }) => {
            const links = linksOf(model, i).reduce((n, l) => n + l.count, 0)
            return (
              <tr key={it.prefix} aria-current={selected === keyOf(it) ? 'true' : undefined}>
                <th scope="row" class="mono">
                  {it.prefix}
                </th>
                <td class="num">{it.count.toLocaleString('en-US')}</td>
                <td>
                  {Object.entries(it.types)
                    .map(([t, n]) => `${T.wiki.typesPlural[t] ?? t} ${n}`)
                    .join(', ')}
                </td>
                <td class="num">{links.toLocaleString('en-US')}</td>
                <td class="row-actions">
                  <button
                    type="button"
                    class="button quiet small"
                    aria-label={g.openGroupName(it.prefix)}
                    onClick={() => onOpenGroup(it.prefix)}
                  >
                    {g.openGroup}
                  </button>
                  <button
                    type="button"
                    class="button quiet small"
                    aria-label={g.inspectName(it.prefix)}
                    onClick={() => onInspect({ kind: 'group', prefix: it.prefix })}
                  >
                    {g.inspect}
                  </button>
                </td>
              </tr>
            )
          })}
        </tbody>
      </table>
    </div>
  )
}

function FocusTable({
  slug,
  model,
  focus,
  onInspect,
  onFocus,
  selected,
}: {
  slug: string
  model: Model
  focus: { index: number; hood: Map<number, number> }
  onInspect: (t: Target) => void
  onFocus: (address: string, hops: 1 | 2) => void
  selected: string | null
}) {
  const g = T.graph
  const centre = model.items[focus.index]
  if (centre?.kind !== 'page') return null
  // How each neighbour is linked with the page in focus (one hop), by kind and way.
  const direct = new Map<number, string[]>()
  for (const l of linksOf(model, focus.index))
    direct.set(l.index, [
      ...(direct.get(l.index) ?? []),
      `${g.linkKinds[l.kind ?? 'group'] ?? l.kind} (${g.way[l.way]})`,
    ])
  const rows = [...focus.hood].sort((a, b) => a[1] - b[1] || a[0] - b[0])
  return (
    <div class="table-wrap" data-scroll-x>
      <table class="data-table">
        <caption>{g.focusTable(centre.title)}</caption>
        <thead>
          <tr>
            <th scope="col">{g.col.title}</th>
            <th scope="col">{g.col.address}</th>
            <th scope="col">{g.col.type}</th>
            <th scope="col">{g.col.status}</th>
            <th scope="col" class="num">
              {g.col.hops}
            </th>
            <th scope="col">{g.col.link}</th>
            <th scope="col">{g.col.actions}</th>
          </tr>
        </thead>
        <tbody>
          {rows.map(([i, hops]) => {
            const it = model.items[i]
            if (!it) return null
            if (it.kind === 'group')
              return (
                <tr key={`g:${it.prefix}`}>
                  <th scope="row" class="mono">
                    {it.prefix}
                  </th>
                  <td>—</td>
                  <td>{g.col.group}</td>
                  <td>—</td>
                  <td class="num">{hops}</td>
                  <td>{direct.get(i)?.join(', ') ?? '—'}</td>
                  <td class="row-actions">
                    <button
                      type="button"
                      class="button quiet small"
                      aria-label={g.inspectName(it.prefix)}
                      onClick={() => onInspect({ kind: 'group', prefix: it.prefix })}
                    >
                      {g.inspect}
                    </button>
                  </td>
                </tr>
              )
            return (
              <tr key={it.address} aria-current={selected === keyOf(it) ? 'true' : undefined}>
                <th scope="row">
                  <a href={pageHref(slug, it.address)}>{it.title}</a>
                </th>
                <td class="mono">{it.address}</td>
                <td>{T.wiki.types[it.type] ?? it.type}</td>
                <td>
                  <StatusTag status={it.status} />
                </td>
                <td class="num">{g.hop(hops)}</td>
                <td>{hops === 0 ? '—' : (direct.get(i)?.join(', ') ?? '—')}</td>
                <td class="row-actions">
                  <button
                    type="button"
                    class="button quiet small"
                    aria-label={g.inspectName(it.title)}
                    onClick={() => onInspect({ kind: 'page', address: it.address })}
                  >
                    {g.inspect}
                  </button>
                  {hops > 0 ? (
                    <button
                      type="button"
                      class="button quiet small"
                      aria-label={g.focusName(it.title)}
                      onClick={() => onFocus(it.address, 1)}
                    >
                      {g.focus1}
                    </button>
                  ) : null}
                </td>
              </tr>
            )
          })}
        </tbody>
      </table>
    </div>
  )
}

function PagesTable({
  slug,
  filters,
  group,
  sort,
  setSort,
  onInspect,
  onFocus,
  selected,
}: {
  slug: string
  filters: Filters
  group: string
  sort: string
  setSort: (sort: string) => void
  onInspect: (t: Target) => void
  onFocus: (address: string, hops: 1 | 2) => void
  selected: string | null
}) {
  const g = T.graph
  const query = { ...filters, prefix: group, sort }
  const qkey = JSON.stringify(query)
  // The cursors of the pages already passed, to go back; a new query starts again from the first page.
  const [kept, setKept] = useState<{ key: string; cursors: string[] }>({ key: qkey, cursors: [] })
  const trail = kept.key === qkey ? kept.cursors : []
  const setTrail = (cursors: string[]) => setKept({ key: qkey, cursors })
  const cursor = trail.at(-1) ?? ''
  const r = pagesResource(slug, { ...query, cursor, limit: String(PER) })
  const data = r.data.value
  const column = (sort.replace(/^-/, '') || 'address') as Column
  const desc = sort.startsWith('-')
  const header = (c: Column) => {
    const on = column === c
    const dir = on ? (desc ? 'descending' : 'ascending') : undefined
    const nextDir: 'ascending' | 'descending' = on && !desc ? 'descending' : 'ascending'
    // The address column is the order when nothing else is asked for.
    const value = nextDir === 'descending' ? `-${c}` : c === 'address' ? '' : c
    return (
      <th scope="col" aria-sort={dir} class={c === 'in' || c === 'out' ? 'num' : undefined}>
        <button
          type="button"
          class="sort"
          aria-label={g.sortBy(g.col[c], nextDir)}
          onClick={() => setSort(value)}
        >
          {g.col[c]}
          <span aria-hidden="true" class="sort-mark">
            {on ? (desc ? '↓' : '↑') : ''}
          </span>
        </button>
      </th>
    )
  }
  const from = trail.length * PER
  return (
    <>
      <div class="table-wrap" data-scroll-x>
        <table class="data-table" aria-busy={r.loading.value ? 'true' : undefined}>
          <caption>
            {g.pagesTable}
            {data ? (
              <span class="meta">
                {' '}
                · {data.total ? g.range(from + 1, from + data.items.length, data.total) : g.count(0, 0)}
              </span>
            ) : null}
          </caption>
          <thead>
            <tr>
              {COLUMNS.map((c) => header(c))}
              <th scope="col">{g.col.actions}</th>
            </tr>
          </thead>
          <tbody>
            {data?.items.map((p: PageRow) => (
              <tr key={p.address} aria-current={selected === `p:${p.address}` ? 'true' : undefined}>
                <th scope="row">
                  <a href={pageHref(slug, p.address)}>{p.title}</a>
                </th>
                <td class="mono">{p.address}</td>
                <td>{T.wiki.types[p.type] ?? p.type}</td>
                <td>
                  <StatusTag status={p.status} />
                </td>
                <td class="num">{p.in}</td>
                <td class="num">{p.out}</td>
                <td class="nowrap">{p.updatedAt.slice(0, 10)}</td>
                <td class="row-actions">
                  <button
                    type="button"
                    class="button quiet small"
                    aria-label={g.inspectName(p.title)}
                    onClick={() => onInspect({ kind: 'page', address: p.address })}
                  >
                    {g.inspect}
                  </button>
                  {p.status !== 'retired' ? (
                    <button
                      type="button"
                      class="button quiet small"
                      aria-label={g.focusName(p.title)}
                      onClick={() => onFocus(p.address, 1)}
                    >
                      {g.focus1}
                    </button>
                  ) : null}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {!data && r.loading.value ? <Skeleton rows={5} /> : null}
      {!data && r.error.value ? <ErrorState error={r.error.value} onRetry={() => void r.reload()} /> : null}
      {data && data.items.length === 0 ? <Empty title={g.noRows} /> : null}
      {data && (trail.length > 0 || data.next) ? (
        <nav class="pager" aria-label={g.pagesTable}>
          <button
            type="button"
            class="button quiet"
            disabled={trail.length === 0}
            onClick={() => setTrail(trail.slice(0, -1))}
          >
            {g.previous}
          </button>
          <span class="meta">{g.range(from + 1, from + data.items.length, data.total)}</span>
          <button
            type="button"
            class="button quiet"
            disabled={!data.next}
            onClick={() => data.next && setTrail([...trail, data.next])}
          >
            {g.next}
          </button>
        </nav>
      ) : null}
    </>
  )
}
