// The graph of a wiki (spec B6 «Graph», plan §3.4; T032–T034). Who: any member. Job: see how the wiki's
// pages hang together and reach one of them. Done when: the person opened the page they were after, or saw
// what links to it. A canvas draws a node a page (shape by type, size by links) and a line a link (dash by
// kind); the layout is worked out, and the picture painted, in a Web Worker. Filters, focus at one or two
// hops and the inspector work the same in the list, which is never optional: everything the canvas does, the
// list does by keyboard. Above 2 000 pages the graph comes by groups, opened one by one (again by groups when
// a group is that big); the list stays whole, by pages.
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'preact/hooks'
import { useFresh } from '../../api/fresh.ts'
import { CAMERA, clampPitch } from '../../graph/camera.ts'
import { type Card, hitCard, keepInView, TILE_PAD, TILE_SCALE } from '../../graph/cards.ts'
import { FAMILIES, familyCounts, familyIndex } from '../../graph/families.ts'
import {
  areas,
  countKey,
  type Direction,
  type Filters,
  focusView,
  hit,
  hubs,
  keyOf,
  linksOf,
  type Model,
  mainCluster,
  modelOf,
  radial,
  roles,
  step,
  type View,
  visibility,
} from '../../graph/model.ts'
import type { DrawnMessage, FromWorker, ToWorker } from '../../graph/protocol.ts'
import {
  type Fact,
  GROUP_SHAPE,
  NODE_R,
  type Palette,
  PROBE_CARDS,
  Renderer,
  type Scene,
  SHAPES,
  type State,
} from '../../graph/render.ts'
import { landing } from '../../lib/landing.ts'
import { isField } from '../../lib/screen.ts'
import { PAGE_STATUSES, PAGE_TYPES } from '../../lib/wiki.ts'
import { online } from '../../session.ts'
import { T } from '../../text.ts'
import { Icon } from '../../ui/icons.tsx'
import { viewState } from '../../ui/state.ts'
import { Empty, ErrorState, Skeleton } from '../../ui/states.tsx'
import { CanvasSkeleton, KINDS, Legend } from './CanvasChrome.tsx'
import { useBrain, useFilters, WikiHead } from './common.tsx'
import { graphResource, pagesResource } from './data.ts'
import { GraphList } from './GraphList.tsx'
import { groupName, Inspector, type Target } from './Inspector.tsx'

export { groupName, KINDS, type Target }

export const graphHref = (slug: string) => `/b/${encodeURIComponent(slug)}/wiki/graph`
const SEED = 48291
const HUBS = 12
// The statuses the graph draws: the list shows the same by default.
export const DRAWN = 'current,stale,superseded'

const targetOf = (key: string): Target | null =>
  key.startsWith('p:')
    ? { kind: 'page', address: key.slice(2) }
    : key.startsWith('g:')
      ? { kind: 'group', prefix: key.slice(2) }
      : null
const areaOf = (address: string) => address.split('/', 1)[0] as string

export function WikiGraph({ slug }: { slug: string }) {
  const { brain, gate } = useBrain(slug)
  if (!brain) return gate
  return <GraphScreen slug={slug} brainName={brain.name} />
}

const KEYS = [
  'view',
  'q',
  'type',
  'status',
  'tag',
  'linkKind',
  'group',
  'loose',
  'focus',
  'hops',
  'sort',
  'inspect',
] as const

// Only values the graph and the list both understand: anything else in the address is left out of both.
function cleanFilters(v: Record<(typeof KEYS)[number], string>): Filters {
  const statuses = v.status.split(',').filter((x) => (PAGE_STATUSES as readonly string[]).includes(x))
  return {
    q: v.q.slice(0, 200),
    type: (PAGE_TYPES as readonly string[]).includes(v.type) ? v.type : '',
    status: statuses.join(','),
    tag: v.tag.slice(0, 200),
    linkKind: KINDS.includes(v.linkKind) ? v.linkKind : '',
  }
}

// How long typing in the tag filter rests before it applies.
const TAG_PAUSE_MS = 400

// The room left between what is drawn and the controls over the picture.
const BAND_GAP = 8

const coarse = () => typeof matchMedia === 'function' && matchMedia('(pointer: coarse)').matches

function GraphScreen({ slug, brainName }: { slug: string; brainName: string }) {
  const g = T.graph
  const w = T.wiki
  const f = useFilters(KEYS)
  const v = f.values
  const group = v.group
  const filters = cleanFilters(v)
  const filtering = Boolean(filters.q || filters.type || filters.status || filters.tag || filters.linkKind)
  const loose = v.loose === '1'
  const r = graphResource(slug, group, {}, loose)
  useFresh(r)
  const data = r.data.value
  const model = useMemo(() => (data ? modelOf(data) : null), [data])
  // The server's answer under the filters: by groups, how many pages each group has; in one group (or the
  // gathered pages), which pages have a link of the kind asked for (links out of a group carry no kind here).
  const counted =
    model && filtering && (model.mode === 'groups' || (filters.linkKind && (group || loose)))
      ? graphResource(slug, group, filters as Record<string, string>, loose)
      : null
  const answer = counted?.data.value
  const counts = useMemo(
    () =>
      model?.mode === 'groups' && answer
        ? new Map(answer.groups.map((x) => [countKey(x), x.count]))
        : undefined,
    [model, answer],
  )
  const countedTypes = useMemo(
    () =>
      model?.mode === 'groups' && answer
        ? new Map(answer.groups.map((x) => [countKey(x), x.types]))
        : undefined,
    [model, answer],
  )
  const matching = useMemo(
    () => (filters.linkKind && answer ? new Set(answer.nodes.map((n) => n[0])) : undefined),
    [filters.linkKind, answer],
  )
  const hops: 1 | 2 = v.hops === '2' ? 2 : 1
  const list = v.view === 'list'
  const opener = useRef<HTMLElement | null>(null)
  // Where the keyboard goes once the screen has drawn what an action changed (lib/landing.ts): never left
  // waiting, and never taking the keyboard back after a key or click of the person's own.
  const [landed] = useState(() => landing(document, '#graph-focus, #graph-place'))
  useEffect(() => () => landed.dispose(), [])
  const want = landed.want
  // Where to go back to when focus is left: the row button that set it, or the page on the canvas.
  const focusFrom = useRef<{ address: string; row: boolean } | null>(null)
  const [startKey, setStartKey] = useState<string | null>(null)

  // A page to focus on lives in a group: in a wiki drawn by groups, its group (or the gathered pages) opens.
  useEffect(() => {
    if (model?.mode === 'groups' && v.focus && !model.index.has(`p:${v.focus}`)) {
      const inside = model.items.find(
        (it) =>
          it.kind === 'group' && !it.loose && (v.focus === it.prefix || v.focus.startsWith(`${it.prefix}/`)),
      )
      if (inside?.kind === 'group') f.set({ group: inside.prefix, loose: '' })
      else if (model.items.some((it) => it.kind === 'group' && it.loose)) f.set({ loose: '1' })
    }
  }, [model, v.focus])

  const vis = useMemo(() => {
    if (!model) return null
    const base = visibility(model, filters, counts, matching)
    const at = v.focus ? model.index.get(keyOf({ kind: 'page', address: v.focus })) : undefined
    if (at === undefined) return { ...base, focus: -1, focused: null }
    const focused = focusView(model, base, at, hops)
    return { ...focused, focus: at, focused }
  }, [
    model,
    counts,
    matching,
    filters.q,
    filters.type,
    filters.status,
    filters.tag,
    filters.linkKind,
    v.focus,
    hops,
  ])

  const state = viewState({ loading: r.loading.value, data, error: r.error.value, online: online.value })
  const selected = v.inspect
  const selectedIndex = selected && model ? (model.index.get(selected) ?? -1) : -1
  const focusItem = vis && vis.focus >= 0 ? model?.items[vis.focus] : undefined
  const tags = useMemo(
    () =>
      model ? [...new Set(model.items.flatMap((it) => (it.kind === 'page' ? it.tags : [])))].sort() : [],
    [model],
  )
  const byGroups = model?.mode === 'groups'
  const total = byGroups && answer ? answer.total : (model?.total ?? 0)
  const emptyWiki = model !== null && model.total === 0 && !group && !loose && !filtering
  // The list says how many pages it has: the header says the same (Retired ones too, when asked for).
  const listQuery = {
    ...filters,
    status: filters.status || DRAWN,
    prefix: group,
    ...(loose ? { loose: '1' } : {}),
    sort: v.sort,
  }
  const listed =
    list && !v.focus && model ? pagesResource(slug, { ...listQuery, cursor: '', limit: '50' }) : null
  // The pages changed last, for the canvas's fact card: their title, address and date.
  const recent =
    !list && model?.mode === 'pages'
      ? pagesResource(slug, { status: DRAWN, sort: '-updatedAt', cursor: '', limit: '50' })
      : null
  const recentRows = recent?.data.value?.items
  // The links drawn (each line stands for one or more), for the strip over the canvas.
  const linksDrawn = useMemo(() => {
    if (!model || !vis) return 0
    let n = 0
    for (let e = 0; e < vis.edges.length; e++) if (vis.edges[e]) n += model.count[e] ?? 1
    return n
  }, [model, vis])
  // The families drawn, for the legend over the canvas.
  const families = useMemo(
    () => (model && vis && !list && model.mode !== 'too-big' ? familyCounts(model, vis.nodes) : []),
    [model, vis, list],
  )
  const facts = useMemo<Fact[]>(() => {
    if (!model) return []
    const out: Fact[] = []
    for (const row of recentRows ?? []) {
      const i = model.index.get(`p:${row.address}`)
      if (i !== undefined)
        out.push({ i, title: row.title, sub: g.factSub(row.address, T.date(row.updatedAt)) })
    }
    return out
  }, [model, recentRows])
  const listTotal = listed?.data.value?.total
  // A page to focus on that is still inside a group (by groups) is on its way: the group opens next.
  const seeking = Boolean(v.focus) && model?.mode === 'groups' && !model.index.has(`p:${v.focus}`)
  const loading =
    r.loading.value || Boolean(counted?.loading.value) || Boolean(listed?.loading.value) || seeking
  useLayoutEffect(() => landed.land(loading))

  const select = (key: string | null) => {
    if (key !== null && document.activeElement instanceof HTMLElement && !selected)
      opener.current = document.activeElement
    f.set({ inspect: key ?? '' })
  }
  // Over the canvas the inspector is a panel that folds away (plan D9): open while something is picked, or
  // when the person unfolds it to see what it offers.
  const [pinned, setPinned] = useState(false)
  const close = () => {
    setPinned(false)
    if (!selected) return
    f.set({ inspect: '' })
    opener.current?.focus()
    opener.current = null
  }
  // The inspector closes with Escape wherever the keyboard is, except in a field (Escape is the field's). Set
  // up before the browser paints the inspector, so an Escape pressed as soon as it shows is heard.
  useLayoutEffect(() => {
    if (!selected && !pinned) return
    const esc = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || e.defaultPrevented || isField(e.target as Element)) return
      e.preventDefault()
      close()
    }
    document.addEventListener('keydown', esc)
    return () => document.removeEventListener('keydown', esc)
  }, [selected, pinned])

  const focusOn = (address: string, h: 1 | 2, from?: { row: boolean }) => {
    if (from) focusFrom.current = { address, row: from.row }
    want('#graph-focus')
    // The group the page is drawn in: drawn by groups, the group it is in opens in the same step (or the
    // pages gathered at this level); outside the group open, its own area.
    let sub = group
    let gathered = loose
    if (model?.mode === 'groups' && !model.index.has(`p:${address}`)) {
      const inside = model.items.find(
        (it) =>
          it.kind === 'group' && !it.loose && (address === it.prefix || address.startsWith(`${it.prefix}/`)),
      )
      if (inside?.kind === 'group') {
        sub = inside.prefix
        gathered = false
      } else if (model.items.some((it) => it.kind === 'group' && it.loose)) gathered = true
    } else if (group && address !== group && !address.startsWith(`${group}/`)) {
      sub = areaOf(address)
      gathered = false
    }
    // A first focus, or one that moves to another group, is a step Back undoes.
    const moves = sub !== group || gathered !== loose
    f.set(
      { focus: address, hops: h === 2 ? '2' : '', group: sub, loose: gathered ? '1' : '' },
      { push: !v.focus || moves },
    )
  }
  const leaveFocus = () => {
    const back = focusFrom.current
    focusFrom.current = null
    if (back?.row) want(`[data-focus-for="${CSS.escape(back.address)}"]`)
    else {
      setStartKey(v.focus ? `p:${v.focus}` : null)
      want(list ? '#graph-place' : 'canvas.graph-canvas')
    }
    // A step of its own, so Back goes into the focus again (replacing it left Back with nothing to show).
    f.set({ focus: '', hops: '' }, { push: true })
  }
  // `asLoose`: the pages gathered at that level, not the group of that name.
  const openGroup = (prefix: string, asLoose = false) => {
    want('#graph-place')
    f.set({ group: prefix, loose: asLoose ? '1' : '', focus: '', inspect: '' }, { push: true })
  }
  const clearFilters = () => {
    want('#graph-q')
    f.set({ q: '', type: '', status: '', tag: '', linkKind: '' })
  }
  // The tag is matched whole, so it goes to the address (and the server) after a pause in typing, or at
  // once when picked from the list or left: «q4» typed never asks for «q» first.
  const [tagTyped, setTagTyped] = useState(v.tag)
  const sentTag = useRef(v.tag)
  const sendTag = (raw: string) => {
    const tag = raw.trim()
    sentTag.current = tag
    if (tag !== v.tag) f.set({ tag })
  }
  useEffect(() => {
    // Changed from elsewhere (Clear filters, Back): the box shows it.
    if (v.tag !== sentTag.current) {
      sentTag.current = v.tag
      setTagTyped(v.tag)
    }
  }, [v.tag])
  useEffect(() => {
    if (tagTyped.trim() === sentTag.current) return
    const t = setTimeout(() => sendTag(tagTyped), TAG_PAUSE_MS)
    return () => clearTimeout(t)
  }, [tagTyped])
  const setView = (to: 'graph' | 'list') => f.set({ view: to === 'list' ? 'list' : '' })

  const trail = group ? group.split('/').map((_, i, parts) => parts.slice(0, i + 1).join('/')) : []
  const focusPages = vis && vis.focus >= 0 ? vis.pages : 0
  const place =
    focusItem?.kind === 'page'
      ? g.focusPlace(focusItem.title, hops, focusPages)
      : loose
        ? g.otherPages(group)
        : group
          ? g.inGroup(group)
          : byGroups
            ? g.allGroups
            : g.allPages
  // The filters on, said in the summary so they show while folded.
  const chips = [
    filters.q ? g.chip(g.words, `“${filters.q}”`) : '',
    filters.type ? g.chip(w.type, w.types[filters.type] ?? filters.type) : '',
    filters.status
      ? g.chip(
          w.status,
          filters.status
            .split(',')
            .map((x) => w.statuses[x] ?? x)
            .join(', '),
        )
      : '',
    filters.linkKind ? g.chip(g.linkKind, g.linkKindNames[filters.linkKind] ?? filters.linkKind) : '',
    filters.tag ? g.chip(w.tag, filters.tag) : '',
  ].filter(Boolean)
  // The screen's controls: the same pieces over the canvas and above the list.
  const viewsToggle = (
    <fieldset class="toggle graph-views">
      <legend class="sr-only">{g.views}</legend>
      <button
        type="button"
        class="button quiet"
        aria-pressed={list ? 'false' : 'true'}
        onClick={() => setView('graph')}
      >
        {g.graphView}
      </button>
      <button
        type="button"
        class="button quiet"
        aria-pressed={list ? 'true' : 'false'}
        onClick={() => setView('list')}
      >
        {g.listView}
      </button>
    </fieldset>
  )
  const trailNav =
    group || loose ? (
      <nav class="graph-trail" aria-label={g.groupTrail}>
        <button type="button" class="button quiet" onClick={() => openGroup('')}>
          {g.allGroups}
        </button>
        {trail.map((p) => (
          <span key={p} class="trail-step">
            <span aria-hidden="true">›</span>{' '}
            {p === group && !loose ? (
              <span class="mono" aria-current="location">
                {p.split('/').at(-1)}
              </span>
            ) : (
              <button type="button" class="button quiet mono" onClick={() => openGroup(p)}>
                {p.split('/').at(-1)}
              </button>
            )}
          </span>
        ))}
        {loose ? (
          <span class="trail-step">
            <span aria-hidden="true">›</span> <span aria-current="location">{g.otherPages('')}</span>
          </span>
        ) : null}
      </nav>
    ) : null
  const filtersBox = emptyWiki ? null : (
    <details class="graph-filters">
      <summary>{g.filtersSummary(chips)}</summary>
      <search aria-label={g.filterSearch}>
        <form class="filters" onSubmit={(e) => e.preventDefault()}>
          <div class="field grow">
            <label for="graph-q">{g.words}</label>
            <input
              id="graph-q"
              type="search"
              value={v.q}
              aria-describedby="graph-q-hint"
              onInput={(e) => f.set({ q: (e.currentTarget as HTMLInputElement).value })}
            />
            <span id="graph-q-hint" class="hint">
              {g.wordsHint}
            </span>
          </div>
          <div class="field">
            <label for="graph-type">{w.type}</label>
            <select
              id="graph-type"
              value={filters.type}
              onChange={(e) => f.set({ type: (e.currentTarget as HTMLSelectElement).value })}
            >
              <option value="">{w.anyType}</option>
              {PAGE_TYPES.map((t) => (
                <option key={t} value={t}>
                  {w.types[t]}
                </option>
              ))}
            </select>
          </div>
          <div class="field">
            <label for="graph-status">{w.status}</label>
            <select
              id="graph-status"
              value={filters.status}
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
            <label for="graph-kind">{g.linkKind}</label>
            <select
              id="graph-kind"
              value={filters.linkKind}
              onChange={(e) => f.set({ linkKind: (e.currentTarget as HTMLSelectElement).value })}
            >
              <option value="">{g.anyLinkKind}</option>
              {KINDS.map((k) => (
                <option key={k} value={k}>
                  {g.linkKindNames[k]}
                </option>
              ))}
            </select>
          </div>
          <div class="field">
            <label for="graph-tag">{w.tag}</label>
            {/* One control everywhere: typed, with the tags the drawn pages carry offered. */}
            <input
              id="graph-tag"
              type="text"
              list="graph-tags"
              value={tagTyped}
              aria-describedby="graph-tag-hint"
              onInput={(e) => setTagTyped((e.currentTarget as HTMLInputElement).value)}
              onChange={(e) => sendTag((e.currentTarget as HTMLInputElement).value)}
            />
            <datalist id="graph-tags">
              {tags.map((t) => (
                <option key={t} value={t} />
              ))}
            </datalist>
            <span id="graph-tag-hint" class="hint">
              {g.tagHint}
            </span>
          </div>
          {filtering ? (
            <div class="actions">
              <button type="button" class="button quiet" onClick={clearFilters}>
                {T.states.clearFilters}
              </button>
            </div>
          ) : null}
        </form>
      </search>
    </details>
  )
  const focusBar =
    focusItem?.kind === 'page' ? (
      <section id="graph-focus" class="graph-focus" tabIndex={-1} aria-label={g.focusBar}>
        <p>
          {g.focusOn('')}
          <strong>{focusItem.title}</strong>
        </p>
        {vis?.focused?.hiddenVia.size ? (
          <p class="meta">
            {[...vis.focused.hiddenVia]
              .map((i) => {
                const it = model?.items[i]
                return g.viaHidden(it?.kind === 'page' ? it.title : (it?.prefix ?? ''))
              })
              .join('; ')}
          </p>
        ) : null}
        <fieldset class="toggle">
          <legend class="sr-only">{g.hops}</legend>
          {([1, 2] as const).map((h) => (
            <button
              key={h}
              type="button"
              class="button quiet"
              aria-pressed={hops === h ? 'true' : 'false'}
              onClick={() => focusOn(focusItem.address, h)}
            >
              {h === 1 ? g.oneHop : g.twoHops}
            </button>
          ))}
        </fieldset>
        <button type="button" class="button quiet" onClick={leaveFocus}>
          {g.leaveFocus}
        </button>
      </section>
    ) : null
  const placeRow =
    model && !emptyWiki ? (
      <div class="graph-place-row">
        <h2 id="graph-place" class="graph-place" tabIndex={-1}>
          {place}
        </h2>
        {focusItem ? null : (
          <span class="tag">
            {byGroups
              ? g.groupsCount(
                  vis?.pages ?? total,
                  model.items.filter((it, i) => it.kind === 'group' && vis?.nodes[i]).length,
                )
              : list && listTotal !== undefined
                ? g.count(listTotal, listTotal)
                : g.count(vis?.pages ?? 0, model.pages)}
          </span>
        )}
      </div>
    ) : null
  const notes = (
    <>
      {byGroups && !list && !focusItem ? (
        <p class="graph-note">{group ? g.nested(group, model?.total ?? 0) : g.huge(model?.total ?? 0)}</p>
      ) : null}
      {loose && !focusItem ? <p class="graph-note">{g.otherPagesNote(group, model?.total ?? 0)}</p> : null}
    </>
  )
  const head = list ? (
    <>
      <WikiHead title={g.title} lead={g.lead} />
      <div class="graph-bar">
        {viewsToggle}
        {trailNav}
        {filtersBox}
      </div>
      {focusBar}
      {placeRow}
      {notes}
    </>
  ) : (
    // Over the canvas: its name and where you are at the top left, the families under it; Graph | List and
    // the filters at the top in the middle (plan canvas-ui B.2).
    <>
      {/* The strip along the top of the canvas, as a panel's head: its number, its name and what it is about,
          and how much it holds; Graph | List, the filters and the inspector's switch sit in it. */}
      <div class="graph-strip panel-head">
        <span class="panel-num" aria-hidden="true">
          01
        </span>
        <h1 class="title panel-title">{g.title}</h1>
        <span class="panel-about">
          <span aria-hidden="true">· </span>
          {g.stripAbout(brainName)}
        </span>
        {vis && model ? <span class="panel-meta">{g.stripMeta(vis.pages, linksDrawn)}</span> : null}
      </div>
      <div class="graph-left">
        <div class="graph-over">
          {placeRow}
          {trailNav}
          {notes}
          {focusBar}
        </div>
        {vis && model && model.mode !== 'too-big' && model.items.length ? (
          <Legend
            model={model}
            nodes={vis.nodes}
            edges={vis.edges}
            inFocus={vis.focus >= 0}
            counts={families}
          />
        ) : null}
      </div>
      <div class="graph-center">
        {viewsToggle}
        {filtersBox}
      </div>
      {emptyWiki ? null : (
        <button
          type="button"
          class="tool inspector-toggle"
          aria-expanded={selected || pinned ? 'true' : 'false'}
          aria-controls="graph-inspector"
          onClick={() => (selected || pinned ? close() : setPinned(true))}
        >
          <Icon name="inspector" />
          <span>{g.inspector}</span>
        </button>
      )}
    </>
  )

  const target = selected ? targetOf(selected) : null
  const inspector = (
    <Inspector
      slug={slug}
      model={model}
      target={target}
      open={list || Boolean(target) || pinned}
      inGraph={!list}
      onClose={close}
      onFocus={(a, h) => focusOn(a, h, { row: false })}
      onShow={(key) => f.set({ inspect: key })}
      onOpenGroup={openGroup}
      onGroupList={(prefix, asLoose) => {
        want('#graph-place')
        f.set({ view: 'list', group: prefix, loose: asLoose ? '1' : '', focus: '' }, { push: true })
      }}
    />
  )

  let body: preact.ComponentChildren
  if (state === 'loading')
    body = list ? (
      <div class="graph-box loading">
        <Skeleton rows={6} />
      </div>
    ) : (
      <CanvasSkeleton />
    )
  else if (state === 'error' || state === 'offline' || state === 'forbidden')
    body = r.error.value ? <ErrorState error={r.error.value} onRetry={() => void r.reload()} /> : null
  else if (!model) body = null
  else if (list)
    body = (
      <GraphList
        slug={slug}
        model={model}
        filters={filters}
        visible={vis?.nodes ?? null}
        counts={counts}
        countedTypes={countedTypes}
        query={listQuery}
        emptyWiki={emptyWiki}
        focus={vis?.focused ? { index: vis.focus, ...vis.focused } : null}
        setSort={(sort) => f.set({ sort })}
        onInspect={(t) => select(keyOf(t))}
        onFocus={(a, h) => focusOn(a, h, { row: true })}
        onOpenGroup={openGroup}
        onClear={clearFilters}
        selected={selected || null}
      />
    )
  else if (model.mode === 'too-big')
    body = (
      <Empty title={g.tooBigTitle}>
        <p>{g.tooBigLead(model.total)}</p>
        <button type="button" class="button" onClick={() => setView('list')}>
          {g.openList}
        </button>
      </Empty>
    )
  else if (model.items.length === 0)
    body = (
      <Empty title={g.emptyTitle}>
        <p>{g.emptyLead}</p>
        <button type="button" class="button" onClick={() => setView('list')}>
          {g.openList}
        </button>
      </Empty>
    )
  else if (vis && vis.shown === 0) body = <Empty title={g.emptyTitle} filtered onClear={clearFilters} />
  else if (vis)
    body = (
      <GraphCanvas
        model={model}
        nodes={vis.nodes}
        edges={vis.edges}
        shown={vis.shown}
        focus={vis.focus}
        hood={vis.focused?.hood ?? null}
        bridges={vis.focused?.bridges ?? null}
        counts={counts}
        focusSaid={focusItem?.kind === 'page' ? place : ''}
        selected={selectedIndex}
        startKey={startKey}
        onSelect={(i) => {
          const it = model.items[i]
          if (it) select(keyOf(it))
        }}
        panel={Boolean(target) || pinned}
        refit={`${group}|${loose}|${v.focus}|${hops}|${filters.q}|${filters.type}|${filters.status}|${filters.tag}|${filters.linkKind}|${counts ? 'c' : ''}`}
        brainName={brainName}
        facts={facts}
      />
    )

  const layout = (
    <div class={`graph-layout${target ? ' open' : ''}`}>
      <div class="graph-main">{body}</div>
      {emptyWiki ? null : inspector}
    </div>
  )
  // The list is a page; the graph is a canvas that fills the screen, its controls over it (plan D4).
  if (list)
    return (
      <>
        {head}
        {layout}
      </>
    )
  return (
    <div class="graph-screen panel" data-c="orange">
      {head}
      {layout}
    </div>
  )
}

function palette(): Palette {
  const css = getComputedStyle(document.documentElement)
  const v = (name: string) => css.getPropertyValue(name).trim() || '#888'
  return {
    text: v('--text'),
    muted: v('--muted'),
    accent: v('--accent'),
    danger: v('--danger'),
    ground: v('--ground'),
    edge: v('--edge'),
    dot: v('--grid-dot'),
    card: v('--node-bg'),
    cardLine: v('--node-line'),
    cardInk: v('--node-ink'),
    cardSub: v('--node-sub'),
    fam: FAMILIES.map((f) => v(`--fam-${f.colour}`)),
    famDim: FAMILIES.map((f) => v(`--fam-${f.colour}-dim`)),
    pulse: v('--pulse'),
    panelInk: v('--panel-ink'),
  }
}

// A test drives this browser: the canvas says more about its picture (the cards' words and places).
const probe = typeof navigator !== 'undefined' && navigator.webdriver === true

const narrow = () => typeof matchMedia === 'function' && matchMedia('(max-width: 1099px)').matches

// The inspector's panel over the right of a wide canvas: clamp(320px, 22vw, 420px) in app.css. On a narrow
// screen it is a sheet at the bottom instead (State.inset).
const panelWidth = (open: boolean) =>
  open && !narrow() ? Math.min(420, Math.max(320, 0.22 * window.innerWidth)) : 0

const reducedMotion = () =>
  typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches

const ARROWS: Record<string, Direction> = {
  ArrowUp: 'up',
  ArrowDown: 'down',
  ArrowLeft: 'left',
  ArrowRight: 'right',
}

// The words on the canvas for each item: a page's title; a group's name, and its pages on a second line
// (after a line break).
function labelsOf(model: Model, counts: Map<string, number> | undefined): string[] {
  return model.items.map((it) => {
    if (it.kind === 'page') return it.title
    const n = counts?.get(countKey(it)) ?? it.count
    const name = it.loose ? T.graph.otherPages(it.prefix) : (it.prefix.split('/').at(-1) as string)
    return `${name}\n${T.graph.groupPages(n)}`
  })
}

function sceneOf(model: Model, labels: string[], brainName: string): Scene {
  return {
    fam: familyIndex(model),
    famNames: FAMILIES.map((f) => (T.wiki.typesPlural[f.type] ?? f.type).toLowerCase()),
    hub: brainName.trim() ? { initial: brainName.trim().slice(0, 1).toUpperCase(), name: brainName } : null,
    n: model.items.length,
    pages: model.pages,
    byGroups: model.mode === 'groups',
    shape: new Uint8Array(
      model.items.map((it) =>
        it.kind === 'group' ? GROUP_SHAPE : Math.max(0, (SHAPES as readonly string[]).indexOf(it.type)),
      ),
    ),
    superseded: new Uint8Array(
      model.items.map((it) => (it.kind === 'page' && it.status === 'superseded' ? 1 : 0)),
    ),
    count: new Uint32Array(model.items.map((it) => (it.kind === 'group' ? it.count : 0))),
    degree: model.degree,
    edges: model.edges,
    kind: model.kind,
    links: model.count,
    kinds: model.kinds,
    labels,
    role: roles(model),
  }
}

function GraphCanvas({
  model,
  nodes,
  edges,
  shown,
  focus,
  hood,
  bridges,
  counts,
  focusSaid,
  selected,
  startKey,
  onSelect,
  panel,
  refit,
  brainName,
  facts,
}: {
  model: Model
  nodes: Uint8Array
  edges: Uint8Array
  shown: number
  focus: number
  hood: Map<number, number> | null
  bridges: [number, number][] | null
  counts: Map<string, number> | undefined
  // What the live region says when focus changes ("" out of focus).
  focusSaid: string
  selected: number
  startKey: string | null
  onSelect: (i: number) => void
  // The inspector's panel is open over the right of the canvas: Fit leaves it free.
  panel: boolean
  // Changes when what is drawn changes: the view fits it again.
  refit: string
  // The brain, in the middle of the cloud; the pages the fact card shows while it turns.
  brainName: string
  facts: Fact[]
}) {
  const g = T.graph
  const canvas = useRef<HTMLCanvasElement>(null)
  const box = useRef<HTMLDivElement>(null)
  const worker = useRef<Worker | null>(null)
  // Without OffscreenCanvas the page paints, with the same painter.
  const local = useRef<{ renderer: Renderer; ctx: CanvasRenderingContext2D } | null>(null)
  const layoutId = useRef(0)
  const positions = useRef<Float32Array | null>(null)
  // The cards of the last picture of this layout: what the pointer is on is found in them first.
  const cards = useRef<Card[]>([])
  const hits = useRef<Card[]>([])
  const [ready, setReady] = useState(false)
  const [active, setActiveState] = useState(-1)
  // Where the keyboard is, also kept at once: a key pressed before the screen draws again (a fast typist,
  // a busy machine) walks on from there, not from where the last drawing left it.
  const activeNow = useRef(-1)
  const setActive = (i: number) => {
    activeNow.current = i
    setActiveState(i)
  }
  const [said, setSaid] = useState('')
  const view = useRef<View>({ scale: 1, tx: 0, ty: 0 })
  // Once the person pans or zooms, the view stays theirs until what is drawn changes.
  const auto = useRef(true)
  const hover = useRef(-1)
  const size = useRef({ w: 0, h: 0 })
  const frame = useRef(0)
  const draws = useRef(0)
  const painted = useRef(0)
  const seq = useRef(0)
  const frames = useRef(0)
  const settled = useRef(false)
  const marked = useRef({ ready: false, settled: false })
  const dpr = useRef(typeof window === 'undefined' ? 1 : window.devicePixelRatio || 1)
  // How much of the canvas a phone's inspector covers: the picture fits in the rest.
  const inset = useRef(0)
  // The zoom buttons over the top of the picture: what they cover, from the canvas top (they wrap when narrow).
  // Read from an observer (never asked for in the middle of a task, CA6): 8 px from the top, then its height.
  const tools = useRef<HTMLDivElement>(null)
  const band = useRef<{ top: number; bottom: number; blocked: number[] }>({ top: 0, bottom: 0, blocked: [] })
  // Measures the controls over the canvas again (they move when the panel opens).
  const measureBands = useRef<() => void>(() => {})
  // The cloud's camera as the last picture drew it, and the one the person set by dragging (sent once per seq).
  const camera = useRef({ yaw: CAMERA.yaw0, pitch: CAMERA.pitch0 })
  const turned = useRef<{ yaw: number; pitch: number; seq: number } | null>(null)
  // The cloud turns at rest: a touch (pointer, wheel, keys, the keyboard on the canvas) stops it, and it turns
  // again after CAMERA.restMs without one. Never with reduced motion, never while the tab is hidden.
  const touched = useRef(false)
  const restTimer = useRef(0)
  const zoomedIn = useRef(false)
  const labels = useMemo(() => labelsOf(model, counts), [model, counts])
  const hubList = useMemo(() => hubs(model, nodes, HUBS), [model, nodes])
  const role = useMemo(() => roles(model), [model])
  // Fit: in focus, every ring; otherwise the main cluster and the row of pages without links (never a few far
  // off pages shrinking the rest).
  const fitMask = useMemo(() => {
    if (focus >= 0) return nodes
    const m = mainCluster(model, nodes, edges)
    for (let i = 0; i < m.length; i++) if (nodes[i] && role[i] === 1) m[i] = 1
    return m
  }, [model, nodes, edges, focus, role])
  const orphans = useMemo(() => {
    let n = 0
    for (let i = 0; i < model.pages; i++) if (nodes[i] && role[i] === 1) n += 1
    return n
  }, [model, nodes, role])
  const bridgePairs = useMemo(() => (bridges?.length ? new Uint32Array(bridges.flat()) : null), [bridges])
  const rings = useMemo(
    () => (hood && focus >= 0 ? radial(model, hood, model.items.length) : null),
    [model, hood, focus],
  )
  const hop = useMemo(() => {
    if (!hood) return null
    const h = new Int8Array(model.items.length).fill(-1)
    for (const [i, d] of hood) h[i] = d
    return h
  }, [model, hood])
  const latest = useRef({
    nodes,
    edges,
    focus,
    selected,
    active,
    rings,
    hop,
    hubList,
    fitMask,
    bridgePairs,
    orphans,
    panel,
    facts,
  })
  latest.current = {
    nodes,
    edges,
    focus,
    selected,
    active,
    rings,
    hop,
    hubList,
    fitMask,
    bridgePairs,
    orphans,
    panel,
    facts,
  }
  const shownXY = () => latest.current.rings ?? positions.current

  const post = (m: ToWorker, transfer: Transferable[] = []) => {
    const l = local.current
    if (l) {
      if (m.type === 'scene') l.renderer.setScene(m.scene)
      else if (m.type === 'labels') l.renderer.setLabels(m.labels)
      else if (m.type === 'facts') l.renderer.setFacts(m.facts)
      else if (m.type === 'state') {
        l.renderer.state = m.state
        paintHere()
      }
      if (m.type !== 'layout') return
    }
    worker.current?.postMessage(m, transfer)
  }
  const drawn = (d: DrawnMessage) => {
    const c = canvas.current
    // A picture of an older layout (a group left a moment ago) says nothing about this one.
    if (d.id !== layoutId.current) return
    view.current = d.view
    camera.current = { yaw: d.yaw, pitch: d.pitch }
    zoomedIn.current = d.view.scale >= TILE_SCALE
    // The flat projection the picture was drawn with: what the pointer and the arrow keys work on.
    if (d.xy) positions.current = d.xy
    cards.current = d.cards
    // What the pointer can pick: the cards first, then the names written beside points.
    hits.current = d.labels.length ? [...d.cards, ...d.labels] : d.cards
    draws.current += 1
    // The painter's time for this layout, up to its settled picture (CA5 reads it: CDP cannot slow a worker).
    if (!marked.current.settled) painted.current += d.ms
    if (!c) return
    c.dataset.draws = String(draws.current)
    // The last state sent and the one this picture shows: equal once the picture is up to date.
    c.dataset.drawnSeq = String(d.seq)
    c.dataset.cards = String(d.cards.length)
    c.dataset.labels = String(d.labels.length)
    c.dataset.dots = String(d.dots)
    // The cloud as drawn (tests read it): its turn, whether it turns, its families' pills, its hub, the light
    // on its lines and the page on its fact card.
    c.dataset.yaw = ((d.yaw * 180) / Math.PI).toFixed(1)
    c.dataset.spinning = String(d.spinning)
    c.dataset.families = d.families.join(',')
    if (d.hub) c.dataset.hub = `${d.hub[0]},${d.hub[1]}`
    else delete c.dataset.hub
    c.dataset.pulses = String(d.pulses)
    c.dataset.fact = String(d.fact)
    // The fact card's words, for a test driving the browser only.
    if (probe) {
      const fact = latest.current.facts.find((x) => x.i === d.fact)
      if (fact) c.dataset.factCard = `${fact.title} — ${fact.sub}`
      else delete c.dataset.factCard
    }
    // Each picture's painting time while it turns (the timing test reads it).
    const pictures = d.pictures
    if (d.spinning && pictures > 0) c.dataset.frameMs = (d.ms / pictures).toFixed(2)
    // The first cards with their size and words, for a test driving the browser only (closing review C5).
    if (probe)
      c.dataset.cardList = JSON.stringify(
        d.cards
          .slice(0, PROBE_CARDS)
          .map((k, n) => ({ x: k.x, y: k.y, w: k.w, h: k.h, title: d.titles[n] ?? '' })),
      )
    if (d.active) c.dataset.active = `${d.active[0]},${d.active[1]}`
    else delete c.dataset.active
    // Where the page's own copy of the projection puts that page: the pointer works on it (review R2).
    const here = shownXY()
    const ai = latest.current.active
    if (probe && here && ai >= 0 && here.length > 2 * ai + 1) {
      const v = view.current
      const hx = Math.round((here[2 * ai] as number) * v.scale + v.tx)
      const hy = Math.round((here[2 * ai + 1] as number) * v.scale + v.ty)
      c.dataset.activeHere = `${hx},${hy}`
    } else delete c.dataset.activeHere
    // Where the cards of the keyboard's page and of the picked one are (tests read them).
    const ac = d.cards.find((k) => k.i === latest.current.active)
    if (ac) c.dataset.activeCard = `${ac.x},${ac.y},${ac.w},${ac.h}`
    else delete c.dataset.activeCard
    const sc = d.cards.find((k) => k.i === latest.current.selected)
    if (sc) c.dataset.selectedCard = `${sc.x},${sc.y},${sc.w},${sc.h}`
    else delete c.dataset.selectedCard
    if (!marked.current.ready) {
      marked.current.ready = true
      performance.mark('graph:ready')
    }
    if (d.settled && !marked.current.settled) {
      marked.current.settled = true
      c.dataset.paintMs = painted.current.toFixed(1)
      performance.mark('graph:settled')
      c.dataset.settled = 'true'
    }
  }
  const paintHere = () => {
    if (frame.current) return
    frame.current = requestAnimationFrame(() => {
      frame.current = 0
      const l = local.current
      const c = canvas.current
      const st = l?.renderer.state
      if (!l || !c || !st) return
      c.width = Math.round(st.width * st.dpr)
      c.height = Math.round(st.height * st.dpr)
      const d = l.renderer.paint(l.ctx)
      if (d) {
        drawn({ ...d, type: 'drawn', id: layoutId.current, settled: settled.current, pictures: 1 })
        if (d.animating) paintHere()
      }
    })
  }
  // Whether the cloud turns and light travels: motion allowed, the tab seen; and, to turn, nobody touching it,
  // nothing picked, no focus, the keyboard elsewhere.
  const motion = () => {
    const moving = !reducedMotion() && document.visibilityState !== 'hidden'
    const s = latest.current
    const still =
      touched.current ||
      s.selected >= 0 ||
      s.focus >= 0 ||
      hover.current >= 0 ||
      drag.current !== null ||
      document.activeElement === canvas.current
    return { spin: moving && !still, pulses: moving }
  }
  // A touch: the cloud stops now and turns again after a rest.
  const touch = () => {
    clearTimeout(restTimer.current)
    const was = touched.current
    touched.current = true
    restTimer.current = window.setTimeout(() => {
      touched.current = false
      sendState()
    }, CAMERA.restMs)
    if (!was) sendState()
  }
  const sendState = () => {
    const s = latest.current
    seq.current += 1
    if (canvas.current) canvas.current.dataset.sentSeq = String(seq.current)
    const { w, h } = size.current
    const state: State = {
      width: w,
      height: h,
      dpr: dpr.current,
      palette: palette(),
      nodes: s.nodes,
      edges: s.edges,
      fit: s.fitMask,
      autoFit: auto.current,
      view: view.current,
      active: s.active,
      selected: s.selected,
      focus: s.focus,
      hover: hover.current,
      hop: s.hop,
      xy: s.rings,
      hubs: s.hubList,
      bridges: s.bridgePairs,
      orphanLabel: s.orphans && s.focus < 0 ? T.graph.orphans(s.orphans) : '',
      inset: inset.current,
      right: panelWidth(latest.current.panel),
      seq: seq.current,
      probe,
      top: band.current.top,
      bottom: band.current.bottom,
      blocked: band.current.blocked,
      ...motion(),
      camera: turned.current,
    }
    post({ type: 'state', state })
  }

  useEffect(() => {
    const c = canvas.current
    if (!c) return
    const wk = new Worker(new URL('../../graph/worker.ts', import.meta.url), { type: 'module' })
    worker.current = wk
    wk.onmessage = (e: MessageEvent<FromWorker>) => {
      const m = e.data
      if (m.type === 'drawn') return drawn(m)
      if (m.id !== layoutId.current) return
      frames.current += 1
      c.dataset.frames = String(frames.current)
      if (m.done) {
        settled.current = true
        if (m.ms !== undefined) c.dataset.layoutMs = String(Math.round(m.ms))
      }
      setReady(true)
      const l = local.current
      if (l) {
        l.renderer.layout = m.xyz
        paintHere()
      }
    }
    // The canvas goes to the worker when the browser allows it; the page then never paints.
    if (typeof c.transferControlToOffscreen === 'function') {
      const off = c.transferControlToOffscreen()
      wk.postMessage({ type: 'canvas', canvas: off } satisfies ToWorker, [off])
    } else {
      const ctx = c.getContext('2d')
      if (ctx) local.current = { renderer: new Renderer(), ctx }
    }
    return () => {
      wk.terminate()
      cancelAnimationFrame(frame.current)
    }
  }, [])

  // A new scene and layout for each new set of items.
  useEffect(() => {
    layoutId.current += 1
    positions.current = null
    cards.current = []
    hits.current = []
    settled.current = false
    frames.current = 0
    marked.current.settled = false
    painted.current = 0
    auto.current = true
    setReady(false)
    setActive(-1)
    const c = canvas.current
    if (c) {
      delete c.dataset.settled
      c.dataset.frames = '0'
    }
    post({ type: 'scene', scene: sceneOf(model, labels, brainName) })
    const role = roles(model)
    const area = areas(model)
    const family = Int32Array.from(familyIndex(model))
    const message: ToWorker = {
      type: 'layout',
      id: layoutId.current,
      n: model.items.length,
      edges: model.edges.slice(),
      weights: model.weights.slice(),
      area,
      role,
      family,
      seed: SEED,
      reducedMotion: reducedMotion(),
    }
    post(message)
    sendState()
  }, [model])
  useEffect(() => post({ type: 'labels', labels }), [labels])
  useEffect(() => post({ type: 'facts', facts }), [facts, model])
  // The tab hidden: nothing moves; seen again: it moves as before. The rest timer goes with the screen.
  useEffect(() => {
    const seen = () => sendState()
    document.addEventListener('visibilitychange', seen)
    return () => {
      document.removeEventListener('visibilitychange', seen)
      clearTimeout(restTimer.current)
    }
  }, [])

  // The size of the box, and a new picture when it changes. Read from the observer only: it reports after the
  // browser's own layout, so asking for the size never forces a layout in the middle of a task (CA6).
  useEffect(() => {
    const el = box.current
    if (!el) return
    const measure = (entries: ResizeObserverEntry[]) => {
      const rect = entries[entries.length - 1]?.contentRect
      if (!rect || (rect.width === size.current.w && rect.height === size.current.h)) return
      size.current = { w: rect.width, h: rect.height }
      sendState()
    }
    const ro = new ResizeObserver(measure)
    ro.observe(el)
    // The bands kept free: under the controls over the top of the picture, over those at its bottom (the
    // zoom tools; on a narrow screen Graph | List too).
    const t = tools.current
    const screen = el.closest('.graph-screen')
    const controls = [
      t,
      ...['.graph-strip', '.graph-over', '.graph-center'].map(
        (q) => screen?.querySelector<HTMLElement>(q) ?? null,
      ),
    ]
    // No card is drawn under any control over the canvas, the legend and the panel's switch included
    // (closing review): their boxes, from the canvas's corner.
    const others = ['.graph-legend', '.inspector-toggle', '.graph-families'].map(
      (q) => screen?.querySelector<HTMLElement>(q) ?? null,
    )
    const bands = () => {
      const r = el.getBoundingClientRect()
      let top = 0
      let bottom = 0
      for (const x of controls) {
        const b = x?.getBoundingClientRect()
        if (!b?.height) continue
        if (b.top + b.bottom < r.top + r.bottom) top = Math.max(top, Math.ceil(b.bottom - r.top) + BAND_GAP)
        else bottom = Math.max(bottom, Math.ceil(r.bottom - b.top) + BAND_GAP)
      }
      const blocked: number[] = []
      for (const x of [...controls, ...others]) {
        const b = x?.getBoundingClientRect()
        if (b?.width && b.height)
          blocked.push(
            b.left - r.left - BAND_GAP / 2,
            b.top - r.top - BAND_GAP / 2,
            b.width + BAND_GAP,
            b.height + BAND_GAP,
          )
      }
      const same =
        top === band.current.top &&
        bottom === band.current.bottom &&
        blocked.join() === band.current.blocked.join()
      if (same) return
      band.current = { top, bottom, blocked }
      sendState()
    }
    measureBands.current = bands
    const tro = new ResizeObserver(bands)
    // The box too: a new size of the window moves the controls at its bottom.
    for (const x of [el, ...controls, ...others]) if (x) tro.observe(x)
    return () => {
      ro.disconnect()
      tro.disconnect()
    }
  }, [])

  // The pixel ratio changes when the window moves to another screen or the page is zoomed: paint sharp again.
  useEffect(() => {
    let mq: MediaQueryList | null = null
    const watch = () => {
      dpr.current = window.devicePixelRatio || 1
      mq?.removeEventListener('change', changed)
      mq = typeof matchMedia === 'function' ? matchMedia(`(resolution: ${dpr.current}dppx)`) : null
      mq?.addEventListener('change', changed)
    }
    const changed = () => {
      watch()
      sendState()
    }
    watch()
    return () => mq?.removeEventListener('change', changed)
  }, [])

  // The live region says where focus is now, never a page from before.
  useEffect(() => {
    setSaid(focusSaid)
    if (focusSaid) setActive(-1)
  }, [focusSaid])

  // On a narrow screen the inspector rises from the bottom over the picture: the picture fits above it (and
  // follows the sheet as it grows), and a page picked under it is moved above it.
  useLayoutEffect(() => {
    const sheet = selected >= 0 && narrow() ? document.querySelector('.graph-inspector:not(.empty)') : null
    const c = canvas.current
    if (!sheet || !c) {
      if (inset.current) {
        inset.current = 0
        sendState()
      }
      return
    }
    const place = () => {
      const top = sheet.getBoundingClientRect().top
      const rect = c.getBoundingClientRect()
      inset.current = Math.max(0, Math.min(rect.height, rect.bottom - top))
      const x = shownXY()
      if (!auto.current && x) {
        const v = view.current
        const sx = (x[2 * selected] as number) * v.scale + v.tx
        const sy = (x[2 * selected + 1] as number) * v.scale + v.ty
        const bottom = rect.height - inset.current
        if (sy < 24 || sy > bottom - 24 || sx < 24 || sx > rect.width - 24)
          view.current = { ...v, tx: v.tx + (rect.width / 2 - sx), ty: v.ty + (bottom / 2 - sy) }
      }
      sendState()
    }
    place()
    const ro = new ResizeObserver(place)
    ro.observe(sheet)
    return () => ro.disconnect()
  }, [selected, focus, ready])

  useEffect(() => {
    auto.current = true
  }, [refit])
  // Opening or folding the panel never moves a settled picture (D9): the view stays as it is drawn; Fit then
  // fits it in what the panel leaves.
  const panelOnce = useRef(panel)
  useEffect(() => {
    const toggled = panelOnce.current !== panel
    panelOnce.current = panel
    if (toggled && settled.current) auto.current = false
    // The panel's switch moves with the panel: where no card goes moves too.
    if (toggled) requestAnimationFrame(() => measureBands.current())
    // A page picked is brought into the part the panel leaves, whether or not Fit was on (review A4).
    const moved = panel && bringIntoView(latest.current.selected, true)
    if (toggled || moved) sendState()
  }, [panel, selected])
  useEffect(sendState, [nodes, edges, focus, selected, active, refit, rings, hubList, bridgePairs, orphans])

  // The wheel zooms around the pointer; it must be able to stop the page from scrolling.
  useEffect(() => {
    const c = canvas.current
    if (!c) return
    const wheel = (e: WheelEvent) => {
      e.preventDefault()
      touch()
      const rect = c.getBoundingClientRect()
      zoom(Math.exp(-e.deltaY * 0.002), e.clientX - rect.left, e.clientY - rect.top)
    }
    c.addEventListener('wheel', wheel, { passive: false })
    return () => c.removeEventListener('wheel', wheel)
  }, [])

  const zoom = (k: number, cx = size.current.w / 2, cy = size.current.h / 2) => {
    const v = view.current
    const scale = Math.min(12, Math.max(0.02, v.scale * k))
    const real = scale / v.scale
    view.current = { scale, tx: cx - (cx - v.tx) * real, ty: cy - (cy - v.ty) * real }
    auto.current = false
    sendState()
  }
  const fitAll = () => {
    auto.current = true
    sendState()
  }
  const toWorld = (sx: number, sy: number) => {
    const v = view.current
    return [(sx - v.tx) / v.scale, (sy - v.ty) / v.scale] as const
  }
  const reach = () => (NODE_R * 2 + 6) / view.current.scale
  const describe = (i: number) => {
    const it = model.items[i]
    if (!it) return ''
    return it.kind === 'group'
      ? g.onGroup(groupName(it), counts?.get(countKey(it)) ?? it.count)
      : g.onPage(
          it.title,
          T.wiki.types[it.type] ?? it.type,
          T.wiki.statuses[it.status] ?? it.status,
          linksOf(model, i).length,
        )
  }
  const moveTo = (i: number) => {
    setActive(i)
    setSaid(describe(i))
    const x = shownXY()
    if (!x) return
    if (bringIntoView(i, true)) sendState()
  }
  // Keeps item i, and its card, in the part of the canvas the panel and the controls leave (review A1, R2-4):
  // when it sticks out, the view moves by that much only. `always`: even while Fit is on.
  const bringIntoView = (i: number, always: boolean) => {
    const x = shownXY()
    if (!x || i < 0 || (!always && auto.current)) return false
    const v = view.current
    const sx = (x[2 * i] as number) * v.scale + v.tx
    const sy = (x[2 * i + 1] as number) * v.scale + v.ty
    const { w, h } = size.current
    const card = cards.current.find((c) => c.i === i)
    const move = keepInView({
      sx,
      sy,
      hw: card ? card.w / 2 : TILE_PAD,
      hh: card ? card.h / 2 : 48,
      left: 0,
      top: band.current.top,
      right: w - panelWidth(latest.current.panel),
      bottom: h - Math.max(band.current.bottom, inset.current),
    })
    if (!move) return false
    view.current = { ...v, tx: v.tx + move.dx, ty: v.ty + move.dy }
    auto.current = false
    return true
  }
  // Where the keyboard starts: what is selected, the page in focus, where it was, or the biggest hub.
  const start = () => {
    const s = latest.current
    if (s.selected >= 0 && s.nodes[s.selected]) return s.selected
    if (s.focus >= 0) return s.focus
    const back = startKey ? (model.index.get(startKey) ?? -1) : -1
    if (back >= 0 && s.nodes[back]) return back
    if (s.hubList.length) return s.hubList[0] as number
    const x = shownXY()
    if (!x) return -1
    const [cx, cy] = toWorld(size.current.w / 2, size.current.h / 2)
    return hit(x, s.nodes, cx, cy, Number.POSITIVE_INFINITY)
  }

  const onKey = (e: KeyboardEvent) => {
    touch()
    const x = shownXY()
    if (!x) return
    const now = activeNow.current
    const here = now >= 0 && nodes[now] ? now : -1
    const dir = ARROWS[e.key]
    if (dir) {
      e.preventDefault()
      moveTo(here >= 0 ? step(model, x, nodes, here, dir) : start())
      return
    }
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault()
      // Only what is drawn opens: a page hidden by a filter meanwhile is not the one under the keyboard.
      const i = here >= 0 ? here : start()
      if (i >= 0 && nodes[i]) {
        setActive(i)
        onSelect(i)
        setSaid(g.inspectorOpen)
      }
      return
    }
    if (e.key === 'Home') {
      e.preventDefault()
      const first = nodes.indexOf(1)
      if (first >= 0) moveTo(first)
      return
    }
    if (e.key === '+' || e.key === '=') zoom(1.25)
    else if (e.key === '-') zoom(0.8)
    else if (e.key === '0') fitAll()
  }

  // A drag turns the cloud (yaw, and pitch within limits); with Shift, or on a flat picture (the tiles, the
  // rings of a focus), it moves the picture.
  const drag = useRef<{
    x: number
    y: number
    tx: number
    ty: number
    yaw: number
    pitch: number
    pan: boolean
    moved: boolean
  } | null>(null)
  const onPointerDown = (e: PointerEvent) => {
    if (e.button !== 0) return
    touch()
    drag.current = {
      x: e.clientX,
      y: e.clientY,
      tx: view.current.tx,
      ty: view.current.ty,
      ...camera.current,
      pan: e.shiftKey || zoomedIn.current || latest.current.rings !== null,
      moved: false,
    }
    ;(e.currentTarget as HTMLElement).setPointerCapture(e.pointerId)
  }
  const at = (e: PointerEvent) => {
    const x = shownXY()
    const c = canvas.current
    if (!x || !c) return -1
    const rect = c.getBoundingClientRect()
    const sx = e.clientX - rect.left
    const sy = e.clientY - rect.top
    const onCard = hitCard(hits.current, sx, sy)
    if (onCard >= 0 && latest.current.nodes[onCard]) return onCard
    const [wx, wy] = toWorld(sx, sy)
    return hit(x, latest.current.nodes, wx, wy, reach())
  }
  const onPointerMove = (e: PointerEvent) => {
    touch()
    const d = drag.current
    if (d) {
      const dx = e.clientX - d.x
      const dy = e.clientY - d.y
      if (!d.moved && Math.hypot(dx, dy) < 4) return
      d.moved = true
      if (d.pan) {
        view.current = { ...view.current, tx: d.tx + dx, ty: d.ty + dy }
        auto.current = false
      } else
        turned.current = {
          yaw: d.yaw - dx * 0.008,
          pitch: clampPitch(d.pitch + dy * 0.006),
          seq: (turned.current?.seq ?? 0) + 1,
        }
      sendState()
      return
    }
    const i = at(e)
    if (i !== hover.current) {
      hover.current = i
      const c = canvas.current
      if (c) {
        if (i >= 0) c.dataset.hover = ''
        else delete c.dataset.hover
      }
      sendState()
    }
  }
  const onPointerUp = (e: PointerEvent) => {
    const d = drag.current
    drag.current = null
    if (!d || d.moved) return
    const i = at(e)
    if (i >= 0) {
      setActive(i)
      onSelect(i)
    }
  }

  return (
    <section class="graph-section" aria-label={g.graphView}>
      <div class="graph-stage">
        <div class="graph-box" ref={box} data-scroll-x>
          <div class="graph-tools" ref={tools}>
            <button
              type="button"
              class="tool"
              onClick={fitAll}
              aria-label={g.fitAll}
              title={`${g.fitAll} (0)`}
              aria-keyshortcuts="0"
            >
              <Icon name="fit" />
            </button>
            <button
              type="button"
              class="tool"
              onClick={() => zoom(1.25)}
              aria-label={g.zoomIn}
              title={`${g.zoomIn} (+)`}
              aria-keyshortcuts="+"
            >
              <Icon name="zoomIn" />
            </button>
            <button
              type="button"
              class="tool"
              onClick={() => zoom(0.8)}
              aria-label={g.zoomOut}
              title={`${g.zoomOut} (−)`}
              aria-keyshortcuts="-"
            >
              <Icon name="zoomOut" />
            </button>
          </div>
          {/* biome-ignore lint/a11y/noInteractiveElementToNoninteractiveRole: "application" makes a screen reader hand the arrow keys to the canvas, which walks the graph with them */}
          <canvas
            ref={canvas}
            class="graph-canvas"
            tabIndex={0}
            role="application"
            aria-roledescription={g.canvasRole}
            aria-label={g.canvasLabel(shown)}
            aria-describedby="graph-help"
            data-items={shown}
            onKeyDown={onKey}
            onFocus={() => {
              touch()
              if (activeNow.current < 0) {
                const i = start()
                if (i >= 0) {
                  setActive(i)
                  setSaid(describe(i))
                }
              }
            }}
            onPointerDown={onPointerDown}
            onPointerMove={onPointerMove}
            onPointerUp={onPointerUp}
            onPointerLeave={() => {
              touch()
              if (hover.current >= 0) {
                hover.current = -1
                sendState()
              }
            }}
            onBlur={touch}
          />
          {ready ? null : <CanvasSkeleton wait />}
        </div>
      </div>
      <p id="graph-help" class="hint">
        {coarse() ? g.touchHelp : g.canvasHelp}
      </p>
      <p class="sr-only" aria-live="polite">
        {said}
      </p>
    </section>
  )
}
