// The list beside the graph (spec B6 «Graph»: «alternativa en lista, obligatoria»; T033). The pages of the wiki
// with their type, status and links in and out, sorted by any column and filtered exactly as the graph is (by
// default the pages the graph draws: retired ones only with the Retired status), by pages of 50 (G9: the list
// stays whole whatever the size of the wiki). What the graph does, it does by keyboard: inspect, open the page,
// focus at one or two hops (a table of the page and its neighbours, under the same filters), and, in a wiki
// drawn by groups, a table of the groups to open one by one.
import type { ComponentChildren } from 'preact'
import { useState } from 'preact/hooks'
import { countKey, type Filters, keyOf, linksOf, type Model } from '../../graph/model.ts'
import { T } from '../../text.ts'
import { Empty, ErrorState, Skeleton } from '../../ui/states.tsx'
import { pageHref, StatusTag } from './common.tsx'
import { type PageRow, pagesResource } from './data.ts'
import { groupName, type Target } from './Graph.tsx'

const PER = 50
const COLUMNS = ['title', 'address', 'type', 'status', 'in', 'out', 'updatedAt'] as const
type Column = (typeof COLUMNS)[number]

export function GraphList({
  slug,
  model,
  filters,
  visible,
  counts,
  countedTypes,
  query,
  emptyWiki,
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
  visible: Uint8Array | null
  counts: Map<string, number> | undefined
  countedTypes: Map<string, Record<string, number>> | undefined
  // The list's query, the one the header counts with: filters, statuses drawn by default, group, sort.
  query: Record<string, string>
  emptyWiki: boolean
  focus: {
    index: number
    hood: Map<number, number>
    via: Map<number, number>
    nodes: Uint8Array
  } | null
  setSort: (sort: string) => void
  onInspect: (t: Target) => void
  onFocus: (address: string, hops: 1 | 2) => void
  onOpenGroup: (prefix: string, loose?: boolean) => void
  selected: string | null
}) {
  const g = T.graph
  if (emptyWiki)
    return (
      <Empty title={g.noPagesYet}>
        <p>
          {g.emptyListLead} <a href={`/b/${encodeURIComponent(slug)}/proposals`}>{g.proposals}</a>.
        </p>
      </Empty>
    )
  return (
    <div class="graph-list">
      {model.mode === 'groups' ? (
        <GroupsTable
          model={model}
          counts={counts}
          countedTypes={countedTypes}
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
          visible={visible}
          onInspect={onInspect}
          onFocus={onFocus}
          selected={selected}
        />
      ) : (
        <PagesTable
          slug={slug}
          filters={filters}
          query={query}
          setSort={setSort}
          onInspect={onInspect}
          onFocus={onFocus}
          selected={selected}
        />
      )}
    </div>
  )
}

// The buttons of a row: one Tab stop; the arrow keys (and Home, End) move between them.
function RowActions({ label, children }: { label: string; children: ComponentChildren }) {
  const onKeyDown = (e: KeyboardEvent) => {
    if (!['ArrowRight', 'ArrowLeft', 'Home', 'End'].includes(e.key)) return
    const buttons = [...(e.currentTarget as HTMLElement).querySelectorAll('button')]
    const at = buttons.indexOf(document.activeElement as HTMLButtonElement)
    if (at < 0 || buttons.length < 2) return
    e.preventDefault()
    const last = buttons.length - 1
    const next =
      e.key === 'Home'
        ? 0
        : e.key === 'End'
          ? last
          : (at + (e.key === 'ArrowRight' ? 1 : -1) + buttons.length) % buttons.length
    buttons[next]?.focus()
  }
  return (
    <div role="toolbar" aria-label={label} class="row-actions" onKeyDown={onKeyDown}>
      {children}
    </div>
  )
}

function GroupsTable({
  model,
  counts,
  countedTypes,
  onInspect,
  onOpenGroup,
  selected,
}: {
  model: Model
  counts: Map<string, number> | undefined
  countedTypes: Map<string, Record<string, number>> | undefined
  onInspect: (t: Target) => void
  onOpenGroup: (prefix: string, loose?: boolean) => void
  selected: string | null
}) {
  const g = T.graph
  const rows = model.items.flatMap((it, i) => {
    if (it.kind !== 'group') return []
    const n = counts ? (counts.get(countKey(it)) ?? 0) : it.count
    // Under a filter, the types the server counted under it.
    const types = countedTypes ? (countedTypes.get(countKey(it)) ?? {}) : it.types
    return n > 0 ? [{ it, i, n, types }] : []
  })
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
          {rows.map(({ it, i, n, types }) => {
            const links = linksOf(model, i).reduce((s, l) => s + l.count, 0)
            const name = groupName(it, n)
            return (
              <tr key={countKey(it)} aria-current={selected === keyOf(it) ? 'true' : undefined}>
                <th scope="row" class={it.loose ? undefined : 'mono'}>
                  {name}
                </th>
                <td class="num">{n.toLocaleString('en-US')}</td>
                <td>
                  {Object.entries(types)
                    .map(([t, c]) => `${T.wiki.typesPlural[t] ?? t} ${c}`)
                    .join(', ')}
                </td>
                <td class="num">{links.toLocaleString('en-US')}</td>
                <td>
                  <RowActions label={g.rowActions(name)}>
                    <button
                      type="button"
                      class="button small"
                      aria-label={g.openGroupName(name)}
                      onClick={() => onOpenGroup(it.prefix, it.loose === true)}
                    >
                      {g.openGroup}
                    </button>
                    <button
                      type="button"
                      class="button quiet small"
                      tabIndex={-1}
                      aria-label={g.inspectName(name)}
                      onClick={() => onInspect({ kind: 'group', prefix: it.prefix })}
                    >
                      {g.inspect}
                    </button>
                  </RowActions>
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
  visible,
  onInspect,
  onFocus,
  selected,
}: {
  slug: string
  model: Model
  focus: { index: number; hood: Map<number, number>; via: Map<number, number>; nodes: Uint8Array }
  visible: Uint8Array | null
  onInspect: (t: Target) => void
  onFocus: (address: string, hops: 1 | 2) => void
  selected: string | null
}) {
  const g = T.graph
  const centre = model.items[focus.index]
  if (centre?.kind !== 'page') return null
  const name = (i: number) => {
    const it = model.items[i]
    return it?.kind === 'page' ? it.title : (it?.prefix ?? '')
  }
  // How each neighbour is linked with the page in focus: "Caching → mentions → Research overview".
  const direct = new Map<number, string[]>()
  for (const l of linksOf(model, focus.index)) {
    const kind = g.linkKinds[l.kind ?? 'group'] ?? l.kind
    const line =
      l.way === 'in'
        ? `${name(l.index)} ${g.arrow} ${kind} ${g.arrow} ${centre.title}`
        : `${centre.title} ${g.arrow} ${kind} ${g.arrow} ${name(l.index)}`
    direct.set(l.index, [...(direct.get(l.index) ?? []), line])
  }
  // A two-hop row says the neighbour it comes through (and when a filter hides that one).
  const through = (i: number) => {
    const by = focus.via.get(i)
    if (by === undefined) return '—'
    return focus.nodes[by] ? g.via(name(by)) : g.viaHidden(name(by))
  }
  // The same filters as the graph: a neighbour they hide is not listed either.
  const rows = [...focus.hood]
    .filter(([i]) => i === focus.index || !visible || visible[i])
    .sort((a, b) => a[1] - b[1] || a[0] - b[0])
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
                  <td>{direct.get(i)?.join('; ') ?? through(i)}</td>
                  <td>
                    <RowActions label={g.rowActions(groupName(it))}>
                      <button
                        type="button"
                        class="button quiet small"
                        aria-label={g.inspectName(groupName(it))}
                        onClick={() => onInspect({ kind: 'group', prefix: it.prefix })}
                      >
                        {g.inspect}
                      </button>
                    </RowActions>
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
                <td>{hops === 0 ? '—' : (direct.get(i)?.join('; ') ?? through(i))}</td>
                <td>
                  <RowActions label={g.rowActions(it.title)}>
                    <button
                      type="button"
                      class="button quiet small"
                      aria-label={g.inspectName(it.title)}
                      onClick={() => onInspect({ kind: 'page', address: it.address })}
                    >
                      {g.inspect}
                    </button>
                    {hops > 0 && (model.degree[i] as number) > 0 ? (
                      <button
                        type="button"
                        class="button small"
                        tabIndex={-1}
                        data-focus-for={it.address}
                        aria-label={g.focusName(it.title)}
                        onClick={() => onFocus(it.address, 1)}
                      >
                        {g.focus1}
                      </button>
                    ) : null}
                  </RowActions>
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
  query,
  setSort,
  onInspect,
  onFocus,
  selected,
}: {
  slug: string
  filters: Filters
  // The pages the graph draws, unless a status says otherwise (Retired shows the retired ones).
  query: Record<string, string>
  setSort: (sort: string) => void
  onInspect: (t: Target) => void
  onFocus: (address: string, hops: 1 | 2) => void
  selected: string | null
}) {
  const g = T.graph
  const sort = query.sort ?? ''
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
  const filtering = Boolean(filters.q || filters.type || filters.status || filters.tag || filters.linkKind)
  const paged = Boolean(data && (trail.length > 0 || data.next))
  return (
    <>
      {paged ? (
        <button
          type="button"
          class="skip-link"
          onClick={() => document.getElementById('graph-pager')?.focus()}
        >
          {g.skipToPager}
        </button>
      ) : null}
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
                <td>
                  <RowActions label={g.rowActions(p.title)}>
                    <button
                      type="button"
                      class="button quiet small"
                      aria-label={g.inspectName(p.title)}
                      onClick={() => onInspect({ kind: 'page', address: p.address })}
                    >
                      {g.inspect}
                    </button>
                    {p.status !== 'retired' && p.in + p.out > 0 ? (
                      <button
                        type="button"
                        class="button small"
                        tabIndex={-1}
                        data-focus-for={p.address}
                        aria-label={g.focusName(p.title)}
                        onClick={() => onFocus(p.address, 1)}
                      >
                        {g.focus1}
                      </button>
                    ) : null}
                  </RowActions>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {!data && r.loading.value ? <Skeleton rows={5} /> : null}
      {!data && r.error.value ? <ErrorState error={r.error.value} onRetry={() => void r.reload()} /> : null}
      {data && data.items.length === 0 ? <Empty title={filtering ? g.noRows : g.noPagesYet} /> : null}
      {paged && data ? (
        <nav class="pager" id="graph-pager" tabIndex={-1} aria-label={g.pager}>
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
