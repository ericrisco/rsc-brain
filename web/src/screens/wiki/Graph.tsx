// The graph of a wiki (spec B6 «Graph», plan §3.4; T032–T034). Who: any member. Job: see how the wiki's
// pages hang together and reach one of them. Done when: the person opened the page they were after, or saw
// what links to it. A canvas draws a node a page (shape by type, size by links) and a line a link (dash by
// kind); the layout is worked out, and the picture painted, in a Web Worker. Filters, focus at one or two
// hops and the inspector work the same in the list, which is never optional: everything the canvas does, the
// list does by keyboard. Above 2 000 pages the graph comes by groups, opened one by one (again by groups when
// a group is that big); the list stays whole, by pages.
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'preact/hooks'
import { useFresh } from '../../api/fresh.ts'
import {
  areas,
  type Direction,
  type Filters,
  hit,
  hubs,
  keyOf,
  linksOf,
  type Model,
  mainCluster,
  modelOf,
  neighbourhood,
  radial,
  roles,
  step,
  type View,
  visibility,
} from '../../graph/model.ts'
import type { FromWorker, ToWorker } from '../../graph/protocol.ts'
import {
  GROUP_SHAPE,
  LINE,
  NODE_R,
  type Palette,
  Renderer,
  type Scene,
  SHAPES,
  type State,
  shape,
} from '../../graph/render.ts'
import { isField } from '../../lib/screen.ts'
import { PAGE_STATUSES, PAGE_TYPES } from '../../lib/wiki.ts'
import { online } from '../../session.ts'
import { T } from '../../text.ts'
import { viewState } from '../../ui/state.ts'
import { Empty, ErrorState, Skeleton } from '../../ui/states.tsx'
import { pageHref, StatusTag, TypeTag, useBrain, useFilters, WikiHead } from './common.tsx'
import { graphResource, peekResource } from './data.ts'
import { GraphList } from './GraphList.tsx'

export const graphHref = (slug: string) => `/b/${encodeURIComponent(slug)}/wiki/graph`
export const KINDS = [
  'mentions',
  'related',
  'depends-on',
  'contradicts',
  'supersedes',
  'part-of',
  'example-of',
]
const SEED = 48291
const HUBS = 12
// The statuses the graph draws: the list shows the same by default.
export const DRAWN = 'current,stale,superseded'

export type Target = { kind: 'page'; address: string } | { kind: 'group'; prefix: string }
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
  return <GraphScreen slug={slug} />
}

const KEYS = [
  'view',
  'q',
  'type',
  'status',
  'tag',
  'linkKind',
  'group',
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

const wideScreen = () => typeof matchMedia === 'function' && matchMedia('(min-width: 768px)').matches
const coarse = () => typeof matchMedia === 'function' && matchMedia('(pointer: coarse)').matches

function GraphScreen({ slug }: { slug: string }) {
  const g = T.graph
  const w = T.wiki
  const f = useFilters(KEYS)
  const v = f.values
  const group = v.group
  const filters = cleanFilters(v)
  const filtering = Boolean(filters.q || filters.type || filters.status || filters.tag || filters.linkKind)
  const active = [filters.q, filters.type, filters.status, filters.tag, filters.linkKind].filter(
    Boolean,
  ).length
  const r = graphResource(slug, group)
  useFresh(r)
  const data = r.data.value
  const model = useMemo(() => (data ? modelOf(data) : null), [data])
  // By groups, the server counts the pages each group has under the filters.
  const counted =
    model?.mode === 'groups' && filtering
      ? graphResource(slug, group, filters as Record<string, string>)
      : null
  const counts = useMemo(
    () =>
      counted?.data.value ? new Map(counted.data.value.groups.map((x) => [x.prefix, x.count])) : undefined,
    [counted?.data.value],
  )
  const hops: 1 | 2 = v.hops === '2' ? 2 : 1
  const list = v.view === 'list'
  const opener = useRef<HTMLElement | null>(null)
  // Where the keyboard goes once the screen has drawn what an action changed.
  const pending = useRef<string | null>(null)
  // Where to go back to when focus is left: the row button that set it, or the page on the canvas.
  const focusFrom = useRef<{ address: string; row: boolean } | null>(null)
  const [startKey, setStartKey] = useState<string | null>(null)
  const [filtersOpen] = useState(wideScreen)

  // A page to focus on lives in a group: in a wiki drawn by groups, its group opens first.
  useEffect(() => {
    if (model?.mode === 'groups' && v.focus) {
      const inside = model.items.find(
        (it) => it.kind === 'group' && (v.focus === it.prefix || v.focus.startsWith(`${it.prefix}/`)),
      )
      if (inside?.kind === 'group') f.set({ group: inside.prefix })
    }
  }, [model, v.focus])

  const vis = useMemo(() => {
    if (!model) return null
    const base = visibility(model, filters, counts)
    const at = v.focus ? model.index.get(keyOf({ kind: 'page', address: v.focus })) : undefined
    if (at === undefined) return { ...base, focus: -1, hood: null as Map<number, number> | null }
    const hood = neighbourhood(model, at, hops)
    const nodes = new Uint8Array(base.nodes.length)
    let shown = 0
    let pages = 0
    for (const [i] of hood) {
      // The page in focus always shows; its neighbours as the filters say.
      nodes[i] = i === at ? 1 : (base.nodes[i] as number)
      shown += nodes[i] as number
      if (i < model.pages) pages += nodes[i] as number
    }
    const edges = new Uint8Array(base.edges.length)
    for (let e = 0; e < edges.length; e++)
      edges[e] =
        base.edges[e] && nodes[model.edges[2 * e] as number] && nodes[model.edges[2 * e + 1] as number]
          ? 1
          : 0
    return { ...base, nodes, edges, shown, pages, focus: at, hood }
  }, [model, counts, filters.q, filters.type, filters.status, filters.tag, filters.linkKind, v.focus, hops])

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
  const total = byGroups && counted?.data.value ? counted.data.value.total : (model?.total ?? 0)
  const emptyWiki = model !== null && model.total === 0 && !group && !filtering

  // Every render: the keyboard goes where the last action said, once that place is on screen.
  useLayoutEffect(() => {
    if (!pending.current) return
    const el = document.querySelector<HTMLElement>(pending.current)
    if (el) {
      pending.current = null
      el.focus()
    }
  })

  const select = (key: string | null) => {
    if (key !== null && document.activeElement instanceof HTMLElement && !selected)
      opener.current = document.activeElement
    f.set({ inspect: key ?? '' })
  }
  const close = () => {
    f.set({ inspect: '' })
    opener.current?.focus()
    opener.current = null
  }
  // The inspector closes with Escape wherever the keyboard is, except in a field (Escape is the field's). Set
  // up before the browser paints the inspector, so an Escape pressed as soon as it shows is heard.
  useLayoutEffect(() => {
    if (!selected) return
    const esc = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || e.defaultPrevented || isField(e.target as Element)) return
      e.preventDefault()
      close()
    }
    document.addEventListener('keydown', esc)
    return () => document.removeEventListener('keydown', esc)
  }, [selected])

  const focusOn = (address: string, h: 1 | 2, from?: { row: boolean }) => {
    if (from) focusFrom.current = { address, row: from.row }
    pending.current = '#graph-focus'
    const sub = group && address !== group && !address.startsWith(`${group}/`) ? areaOf(address) : group
    f.set({ focus: address, hops: h === 2 ? '2' : '', group: sub }, { push: !v.focus })
  }
  const leaveFocus = () => {
    const back = focusFrom.current
    focusFrom.current = null
    if (back?.row) pending.current = `[data-focus-for="${CSS.escape(back.address)}"]`
    else {
      setStartKey(v.focus ? `p:${v.focus}` : null)
      pending.current = list ? '#graph-place' : 'canvas.graph-canvas'
    }
    f.set({ focus: '', hops: '' })
  }
  const openGroup = (prefix: string) => {
    pending.current = '#graph-place'
    f.set({ group: prefix, focus: '', inspect: '' }, { push: true })
  }
  const clearFilters = () => {
    pending.current = '#graph-q'
    f.set({ q: '', type: '', status: '', tag: '', linkKind: '' })
  }
  const setView = (to: 'graph' | 'list') => f.set({ view: to === 'list' ? 'list' : '' })

  const trail = group ? group.split('/').map((_, i, parts) => parts.slice(0, i + 1).join('/')) : []
  const place = group ? g.inGroup(group) : byGroups ? g.allGroups : g.allPages
  const head = (
    <>
      <WikiHead title={list ? g.listTitle : g.title} lead={g.lead} />
      <div class="graph-bar">
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
        {group ? (
          <nav class="graph-trail" aria-label={g.groupTrail}>
            <button type="button" class="button quiet" onClick={() => openGroup('')}>
              {g.allGroups}
            </button>
            {trail.map((p) => (
              <span key={p} class="trail-step">
                <span aria-hidden="true">›</span>{' '}
                {p === group ? (
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
          </nav>
        ) : null}
      </div>
      {emptyWiki ? null : (
        <details class="graph-filters" open={filtersOpen}>
          <summary>{g.filtersOn(active)}</summary>
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
                  value={v.tag}
                  aria-describedby="graph-tag-hint"
                  onChange={(e) => f.set({ tag: (e.currentTarget as HTMLInputElement).value.trim() })}
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
      )}
      {focusItem?.kind === 'page' ? (
        <section id="graph-focus" class="graph-focus" tabIndex={-1} aria-label={g.focusBar}>
          <p>
            {g.focusOn('')}
            <strong>{focusItem.title}</strong>
          </p>
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
      ) : null}
      {model && !emptyWiki ? (
        <div class="graph-place-row">
          <h2 id="graph-place" class="graph-place" tabIndex={-1}>
            {place}
          </h2>
          <span class="tag">
            {byGroups
              ? g.groupsCount(
                  vis?.pages ?? total,
                  model.items.filter((it, i) => it.kind === 'group' && vis?.nodes[i]).length,
                )
              : g.count(vis?.pages ?? 0, model.pages)}
          </span>
        </div>
      ) : null}
      {byGroups && !list ? (
        <p class="graph-note">{group ? g.nested(group, model?.total ?? 0) : g.huge(model?.total ?? 0)}</p>
      ) : null}
    </>
  )

  const target = selected ? targetOf(selected) : null
  const inspector = (
    <Inspector
      slug={slug}
      model={model}
      target={target}
      inGraph={!list}
      onClose={close}
      onFocus={(a, h) => focusOn(a, h, { row: false })}
      onShow={(key) => f.set({ inspect: key })}
      onOpenGroup={openGroup}
      onGroupList={(prefix) => {
        pending.current = '#graph-place'
        f.set({ view: 'list', group: prefix, focus: '' }, { push: true })
      }}
    />
  )

  let body: preact.ComponentChildren
  if (state === 'loading')
    body = (
      <div class="graph-box loading">
        <Skeleton rows={6} />
      </div>
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
        group={group}
        sort={v.sort}
        emptyWiki={emptyWiki}
        focus={vis && vis.focus >= 0 ? { index: vis.focus, hood: vis.hood as Map<number, number> } : null}
        setSort={(sort) => f.set({ sort })}
        onInspect={(t) => select(keyOf(t))}
        onFocus={(a, h) => focusOn(a, h, { row: true })}
        onOpenGroup={openGroup}
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
        hood={vis.hood}
        counts={counts}
        selected={selectedIndex}
        startKey={startKey}
        onSelect={(i) => {
          const it = model.items[i]
          if (it) select(keyOf(it))
        }}
        refit={`${group}|${v.focus}|${hops}|${filters.q}|${filters.type}|${filters.status}|${filters.tag}|${filters.linkKind}|${counts ? 'c' : ''}`}
      />
    )

  return (
    <>
      {head}
      <div class={`graph-layout${target ? ' open' : ''}`}>
        <div class="graph-main">{body}</div>
        {emptyWiki ? null : inspector}
      </div>
    </>
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
    ground: v('--surface'),
  }
}

const reducedMotion = () =>
  typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches

const ARROWS: Record<string, Direction> = {
  ArrowUp: 'up',
  ArrowDown: 'down',
  ArrowLeft: 'left',
  ArrowRight: 'right',
}

// The words on the canvas for each item: a page's title, a group's last part and its pages.
function labelsOf(model: Model, counts: Map<string, number> | undefined): string[] {
  return model.items.map((it) =>
    it.kind === 'page'
      ? it.title
      : `${it.prefix.split('/').at(-1)} · ${(counts?.get(it.prefix) ?? it.count).toLocaleString('en-US')}`,
  )
}

function sceneOf(model: Model, labels: string[]): Scene {
  return {
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
  }
}

function GraphCanvas({
  model,
  nodes,
  edges,
  shown,
  focus,
  hood,
  counts,
  selected,
  startKey,
  onSelect,
  refit,
}: {
  model: Model
  nodes: Uint8Array
  edges: Uint8Array
  shown: number
  focus: number
  hood: Map<number, number> | null
  counts: Map<string, number> | undefined
  selected: number
  startKey: string | null
  onSelect: (i: number) => void
  // Changes when what is drawn changes: the view fits it again.
  refit: string
}) {
  const g = T.graph
  const canvas = useRef<HTMLCanvasElement>(null)
  const box = useRef<HTMLDivElement>(null)
  const worker = useRef<Worker | null>(null)
  // Without OffscreenCanvas the page paints, with the same painter.
  const local = useRef<{ renderer: Renderer; ctx: CanvasRenderingContext2D } | null>(null)
  const layoutId = useRef(0)
  const positions = useRef<Float32Array | null>(null)
  const [ready, setReady] = useState(false)
  const [active, setActive] = useState(-1)
  const [said, setSaid] = useState('')
  const view = useRef<View>({ scale: 1, tx: 0, ty: 0 })
  // Once the person pans or zooms, the view stays theirs until what is drawn changes.
  const auto = useRef(true)
  const hover = useRef(-1)
  const size = useRef({ w: 0, h: 0 })
  const frame = useRef(0)
  const draws = useRef(0)
  const frames = useRef(0)
  const settled = useRef(false)
  const marked = useRef({ ready: false, settled: false })
  const labels = useMemo(() => labelsOf(model, counts), [model, counts])
  const hubList = useMemo(() => hubs(model, nodes, HUBS), [model, nodes])
  const fitMask = useMemo(() => mainCluster(model, nodes, edges), [model, nodes, edges])
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
  const latest = useRef({ nodes, edges, focus, selected, active, rings, hop, hubList, fitMask })
  latest.current = { nodes, edges, focus, selected, active, rings, hop, hubList, fitMask }
  const shownXY = () => latest.current.rings ?? positions.current

  const post = (m: ToWorker, transfer: Transferable[] = []) => {
    const l = local.current
    if (l) {
      if (m.type === 'scene') l.renderer.setScene(m.scene)
      else if (m.type === 'labels') l.renderer.setLabels(m.labels)
      else if (m.type === 'state') {
        l.renderer.state = m.state
        paintHere()
      }
      if (m.type !== 'layout') return
    }
    worker.current?.postMessage(m, transfer)
  }
  const drawn = (d: { view: View; active: [number, number] | null; settled: boolean }) => {
    const c = canvas.current
    view.current = d.view
    draws.current += 1
    if (!c) return
    c.dataset.draws = String(draws.current)
    if (d.active) c.dataset.active = `${d.active[0]},${d.active[1]}`
    else delete c.dataset.active
    if (!marked.current.ready) {
      marked.current.ready = true
      performance.mark('graph:ready')
    }
    if (d.settled && !marked.current.settled) {
      marked.current.settled = true
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
      if (d) drawn({ ...d, settled: settled.current })
    })
  }
  const sendState = () => {
    const s = latest.current
    const { w, h } = size.current
    const state: State = {
      width: w,
      height: h,
      dpr: window.devicePixelRatio || 1,
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
      positions.current = m.xy
      frames.current += 1
      c.dataset.frames = String(frames.current)
      if (m.done) settled.current = true
      setReady(true)
      const l = local.current
      if (l) {
        l.renderer.layout = m.xy
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
    settled.current = false
    frames.current = 0
    marked.current.settled = false
    auto.current = true
    setReady(false)
    setActive(-1)
    const c = canvas.current
    if (c) {
      delete c.dataset.settled
      c.dataset.frames = '0'
    }
    post({ type: 'scene', scene: sceneOf(model, labels) })
    const role = roles(model)
    const area = areas(model)
    const message: ToWorker = {
      type: 'layout',
      id: layoutId.current,
      n: model.items.length,
      edges: model.edges.slice(),
      weights: model.weights.slice(),
      area,
      role,
      seed: SEED,
      reducedMotion: reducedMotion(),
    }
    post(message)
    sendState()
  }, [model])
  useEffect(() => post({ type: 'labels', labels }), [labels])

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
    return () => ro.disconnect()
  }, [])

  useEffect(() => {
    auto.current = true
  }, [refit])
  useEffect(sendState, [nodes, edges, focus, selected, active, refit, rings, hubList])

  // The wheel zooms around the pointer; it must be able to stop the page from scrolling.
  useEffect(() => {
    const c = canvas.current
    if (!c) return
    const wheel = (e: WheelEvent) => {
      e.preventDefault()
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
      ? g.onGroup(it.prefix, counts?.get(it.prefix) ?? it.count)
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
    const v = view.current
    const sx = (x[2 * i] as number) * v.scale + v.tx
    const sy = (x[2 * i + 1] as number) * v.scale + v.ty
    const { w, h } = size.current
    if (sx < 24 || sy < 24 || sx > w - 24 || sy > h - 24) {
      view.current = { ...v, tx: v.tx + (w / 2 - sx), ty: v.ty + (h / 2 - sy) }
      auto.current = false
    }
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
    const x = shownXY()
    if (!x) return
    const here = active >= 0 && nodes[active] ? active : -1
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

  const drag = useRef<{ x: number; y: number; tx: number; ty: number; moved: boolean } | null>(null)
  const onPointerDown = (e: PointerEvent) => {
    if (e.button !== 0) return
    drag.current = { x: e.clientX, y: e.clientY, tx: view.current.tx, ty: view.current.ty, moved: false }
    ;(e.currentTarget as HTMLElement).setPointerCapture(e.pointerId)
  }
  const at = (e: PointerEvent) => {
    const x = shownXY()
    const c = canvas.current
    if (!x || !c) return -1
    const rect = c.getBoundingClientRect()
    const [wx, wy] = toWorld(e.clientX - rect.left, e.clientY - rect.top)
    return hit(x, latest.current.nodes, wx, wy, reach())
  }
  const onPointerMove = (e: PointerEvent) => {
    const d = drag.current
    if (d) {
      const dx = e.clientX - d.x
      const dy = e.clientY - d.y
      if (!d.moved && Math.hypot(dx, dy) < 4) return
      d.moved = true
      view.current = { ...view.current, tx: d.tx + dx, ty: d.ty + dy }
      auto.current = false
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
      <div class="graph-tools">
        <button type="button" class="button quiet" onClick={() => zoom(1.25)} aria-keyshortcuts="+">
          {g.zoomIn}
        </button>
        <button type="button" class="button quiet" onClick={() => zoom(0.8)} aria-keyshortcuts="-">
          {g.zoomOut}
        </button>
        <button type="button" class="button quiet" onClick={fitAll} aria-keyshortcuts="0">
          {g.fitAll}
        </button>
      </div>
      <div class="graph-stage">
        <div class="graph-box" ref={box} data-scroll-x>
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
              if (active < 0) {
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
              if (hover.current >= 0) {
                hover.current = -1
                sendState()
              }
            }}
          />
          {ready ? null : (
            <div class="graph-wait">
              <Skeleton rows={2} />
            </div>
          )}
        </div>
        <Legend />
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

function Legend() {
  const g = T.graph
  return (
    <details class="graph-legend" open>
      <summary>{g.legend}</summary>
      <div class="legend-cols">
        <div>
          <p class="section-title">{g.shapes}</p>
          <ul class="plain">
            {SHAPES.map((t) => (
              <li key={t}>
                <ShapeIcon type={t} />
                {T.wiki.types[t]}
              </li>
            ))}
          </ul>
        </div>
        <div>
          <p class="section-title">{g.lines}</p>
          <ul class="plain">
            {[...KINDS, 'group'].map((k) => {
              const line = LINE[k] ?? (LINE.related as (typeof LINE)[string])
              return (
                <li key={k}>
                  <svg
                    width="40"
                    height="12"
                    aria-hidden="true"
                    class={`legend-line${k === 'contradicts' ? ' danger' : k === 'group' ? ' group' : ''}`}
                  >
                    <line
                      x1="2"
                      y1="6"
                      x2={line.arrow ? 30 : 38}
                      y2="6"
                      stroke-width={k === 'group' ? 3 : line.width}
                      stroke-dasharray={line.dash.join(' ') || undefined}
                      stroke-linecap="round"
                    />
                    {line.arrow ? <polygon points="38,6 31,2.5 31,9.5" /> : null}
                  </svg>
                  {g.linkKindNames[k]}
                </li>
              )
            })}
          </ul>
        </div>
        <div>
          <p class="section-title">{g.marks}</p>
          <ul class="plain">
            <li>{g.dimmed}</li>
            <li>{g.bigger}</li>
            <li>{g.ringOne}</li>
            <li>{g.ringTwo}</li>
          </ul>
          <p class="meta">{g.arrows}</p>
        </div>
      </div>
    </details>
  )
}

// The shape of a page type as a small picture (the same path the canvas draws), as SVG.
function ShapeIcon({ type }: { type: string }) {
  const d = useMemo(() => {
    const parts: string[] = []
    const rec = {
      moveTo: (x: number, y: number) => parts.push(`M${x.toFixed(2)} ${y.toFixed(2)}`),
      lineTo: (x: number, y: number) => parts.push(`L${x.toFixed(2)} ${y.toFixed(2)}`),
      closePath: () => parts.push('Z'),
      rect: (x: number, y: number, w: number, h: number) => parts.push(`M${x} ${y}h${w}v${h}h${-w}Z`),
      arc: (cx: number, cy: number, r: number, _a: number, _b: number, ccw?: boolean) =>
        parts.push(
          `M${cx + r} ${cy}A${r} ${r} 0 1 ${ccw ? 0 : 1} ${cx - r} ${cy}A${r} ${r} 0 1 ${ccw ? 0 : 1} ${cx + r} ${cy}`,
        ),
    }
    shape(rec as unknown as Path2D, type, 8, 8, 5)
    return parts.join('')
  }, [type])
  return (
    <svg class="legend-shape" width="16" height="16" viewBox="0 0 16 16" aria-hidden="true">
      <path d={d} fill-rule="evenodd" />
    </svg>
  )
}

// What the person picked: a page (its summary, status, links and the way to it) or a group (its pages by
// type and the groups it links with). The same panel serves the graph and the list; on a wide screen it is
// always there, so opening it never moves the picture; on a narrow one it rises from the bottom.
function Inspector({
  slug,
  model,
  target,
  inGraph,
  onClose,
  onFocus,
  onShow,
  onOpenGroup,
  onGroupList,
}: {
  slug: string
  model: Model | null
  target: Target | null
  inGraph: boolean
  onClose: () => void
  onFocus: (address: string, hops: 1 | 2) => void
  onShow: (key: string) => void
  onOpenGroup: (prefix: string) => void
  onGroupList: (prefix: string) => void
}) {
  const g = T.graph
  const heading = useRef<HTMLHeadingElement>(null)
  const key = target ? keyOf(target) : ''
  // Opened from a button of the list, the keyboard follows it here before anything else can happen; from the
  // canvas it stays there.
  useLayoutEffect(() => {
    if (key && !inGraph && heading.current && !(document.activeElement instanceof HTMLCanvasElement))
      heading.current.focus()
  }, [key])
  if (!target)
    return (
      <aside class="graph-inspector empty" aria-labelledby="inspector-name">
        <p class="section-title" id="inspector-name">
          {g.inspector}
        </p>
        <p class="meta">{g.inspectorEmpty}</p>
      </aside>
    )
  const at = model?.index.get(key) ?? -1
  return (
    <aside class="graph-inspector" aria-labelledby="inspector-name inspector-title">
      <div class="inspector-head">
        <p class="section-title" id="inspector-name">
          {g.inspector}
        </p>
        <button type="button" class="button quiet" onClick={onClose}>
          {g.closeInspector}
        </button>
      </div>
      {target.kind === 'page' ? (
        <PagePeek
          slug={slug}
          address={target.address}
          model={model}
          at={at}
          headingRef={heading}
          onFocus={onFocus}
          onShow={onShow}
        />
      ) : (
        <GroupPeek
          prefix={target.prefix}
          model={model}
          at={at}
          headingRef={heading}
          onOpenGroup={onOpenGroup}
          onGroupList={onGroupList}
          onShow={onShow}
        />
      )}
    </aside>
  )
}

function PagePeek({
  slug,
  address,
  model,
  at,
  headingRef,
  onFocus,
  onShow,
}: {
  slug: string
  address: string
  model: Model | null
  at: number
  headingRef: preact.RefObject<HTMLHeadingElement>
  onFocus: (address: string, hops: 1 | 2) => void
  onShow: (key: string) => void
}) {
  const g = T.graph
  const r = peekResource(slug, address)
  const reading = r.data.value
  const item = at >= 0 ? model?.items[at] : undefined
  const page = reading?.page
  const title = page?.title ?? (item?.kind === 'page' ? item.title : address)
  const status = page?.status ?? (item?.kind === 'page' ? item.status : '')
  const type = page?.type ?? (item?.kind === 'page' ? item.type : '')
  const drawable = status !== 'retired'
  const shownHere = (a: string) => model?.index.has(`p:${a}`) ?? false
  // "Caching → mentions → Research overview": who links to whom, by what.
  const links = (
    list: NonNullable<typeof reading>['links']['out'],
    out: boolean,
    heading: string,
    id: string,
  ) => (
    <div class="aside-block">
      <h3 class="aside-sub" id={id}>
        {heading}
      </h3>
      {list.length ? (
        <ul class="plain inspector-links" aria-labelledby={id}>
          {list.map((l) => {
            const other =
              l.state === 'broken' ? (
                <span>
                  <span class="mono">{l.address}</span> <span class="meta">{g.noPage}</span>
                </span>
              ) : (
                <a href={pageHref(slug, l.address)}>{l.title ?? l.address}</a>
              )
            const kind = (
              <span class="meta">
                {' '}
                {g.arrow} {g.linkKinds[l.kind] ?? l.kind} {g.arrow}{' '}
              </span>
            )
            return (
              <li key={`${l.kind}:${l.address}`}>
                {out ? (
                  <>
                    <span>{title}</span>
                    {kind}
                    {other}
                  </>
                ) : (
                  <>
                    {other}
                    {kind}
                    <span>{title}</span>
                  </>
                )}
                {l.state !== 'ok' && l.state !== 'broken' ? (
                  <>
                    {' '}
                    <StatusTag status={l.state} />
                  </>
                ) : null}
                {shownHere(l.address) && l.state !== 'broken' ? (
                  <>
                    {' '}
                    <button
                      type="button"
                      class="button quiet small"
                      aria-label={g.inspectName(l.title ?? l.address)}
                      onClick={() => onShow(`p:${l.address}`)}
                    >
                      {g.inspect}
                    </button>
                  </>
                ) : null}
              </li>
            )
          })}
        </ul>
      ) : (
        <p class="meta">{g.noLinks}</p>
      )}
    </div>
  )
  return (
    <>
      <h2 id="inspector-title" class="inspector-title" tabIndex={-1} ref={headingRef}>
        {title}
      </h2>
      <p class="meta mono">{address}</p>
      <p class="tags">
        {type ? <TypeTag type={type} /> : null} {status ? <StatusTag status={status} /> : null}
      </p>
      {reading ? (
        page?.summary ? (
          <p class="summary">{page.summary}</p>
        ) : null
      ) : r.error.value ? (
        <ErrorState error={r.error.value} onRetry={() => void r.reload()} focus={false} />
      ) : (
        <p class="meta">{g.summaryLoading}</p>
      )}
      <div class="inspector-actions">
        <a class="button" href={pageHref(slug, address)}>
          {g.openPage}
        </a>
        {drawable ? (
          <>
            <button type="button" class="button" onClick={() => onFocus(address, 1)}>
              {g.focus1}
            </button>
            <button type="button" class="button" onClick={() => onFocus(address, 2)}>
              {g.focus2}
            </button>
          </>
        ) : null}
      </div>
      {reading ? (
        <>
          {links(reading.links.out, true, g.linksOut, 'inspector-out')}
          {links(reading.links.in, false, g.linksIn, 'inspector-in')}
        </>
      ) : null}
    </>
  )
}

function GroupPeek({
  prefix,
  model,
  at,
  headingRef,
  onOpenGroup,
  onGroupList,
  onShow,
}: {
  prefix: string
  model: Model | null
  at: number
  headingRef: preact.RefObject<HTMLHeadingElement>
  onOpenGroup: (prefix: string) => void
  onGroupList: (prefix: string) => void
  onShow: (key: string) => void
}) {
  const g = T.graph
  const item = at >= 0 ? model?.items[at] : undefined
  const group = item?.kind === 'group' ? item : null
  const lines =
    model && at >= 0 ? linksOf(model, at).filter((l) => model.items[l.index]?.kind === 'group') : []
  return (
    <>
      <h2 id="inspector-title" class="inspector-title mono" tabIndex={-1} ref={headingRef}>
        {prefix}
      </h2>
      {group ? <p class="meta">{g.groupPages(group.count)}</p> : null}
      <div class="inspector-actions">
        <button type="button" class="button" onClick={() => onOpenGroup(prefix)}>
          {g.openGroup}
        </button>
        <button type="button" class="button quiet" onClick={() => onGroupList(prefix)}>
          {g.groupInList}
        </button>
      </div>
      {group ? (
        <div class="aside-block">
          <h3 class="aside-sub">{g.typesIn}</h3>
          <ul class="plain">
            {Object.entries(group.types).map(([t, n]) => (
              <li key={t}>
                {T.wiki.typesPlural[t] ?? t}: {n}
              </li>
            ))}
          </ul>
        </div>
      ) : null}
      {lines.length ? (
        <div class="aside-block">
          <h3 class="aside-sub">{g.linksWithGroups}</h3>
          <ul class="plain">
            {lines.map((l) => {
              const other = model?.items[l.index]
              if (other?.kind !== 'group') return null
              return (
                <li key={other.prefix}>
                  <button
                    type="button"
                    class="button quiet small"
                    aria-label={g.inspectName(other.prefix)}
                    onClick={() => onShow(`g:${other.prefix}`)}
                  >
                    {other.prefix}
                  </button>{' '}
                  <span class="meta">{g.linksCount(l.count)}</span>
                </li>
              )
            })}
          </ul>
        </div>
      ) : null}
    </>
  )
}
