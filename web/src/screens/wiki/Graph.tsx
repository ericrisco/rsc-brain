// The graph of a wiki (spec B6 «Graph», plan §3.4; T032–T034). Who: any member. Job: see how the wiki's
// pages hang together and reach one of them. Done when: the person opened the page they were after, or saw
// what links to it. A canvas draws a node a page (shape by type) and a line a link (dash by kind); the
// layout is worked out in a Web Worker. Filters, focus at one or two hops and the inspector work the same in
// the list, which is never optional: everything the canvas does, the list does by keyboard. Above 2 000
// pages the graph comes by groups, opened one by one; the list stays whole, by pages.
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'preact/hooks'
import { useFresh } from '../../api/fresh.ts'
import { DASH, NODE_R, type Palette, paint, SHAPES, shape } from '../../graph/draw.ts'
import {
  type Direction,
  type Filters,
  fit,
  hit,
  keyOf,
  linksOf,
  type Model,
  modelOf,
  neighbourhood,
  step,
  type View,
  visibility,
} from '../../graph/model.ts'
import type { LayoutRequest, PositionsMessage } from '../../graph/protocol.ts'
import { PAGE_STATUSES, PAGE_TYPES } from '../../lib/wiki.ts'
import { online } from '../../session.ts'
import { T } from '../../text.ts'
import { viewState } from '../../ui/state.ts'
import { Empty, ErrorState, Skeleton } from '../../ui/states.tsx'
import { pageHref, StatusTag, TypeTag, useBrain, useFilters, WikiHead } from './common.tsx'
import { graphResource, peekResource } from './data.ts'
import { GraphList } from './GraphList.tsx'

export const graphHref = (slug: string) => `/b/${encodeURIComponent(slug)}/wiki/graph`
const KINDS = ['mentions', 'related', 'depends-on', 'contradicts', 'supersedes', 'part-of', 'example-of']
const SEED = 48291
const areaOf = (address: string) => address.split('/', 1)[0] as string

export type Target = { kind: 'page'; address: string } | { kind: 'group'; prefix: string }
const targetOf = (key: string | null): Target | null =>
  key === null
    ? null
    : key.startsWith('p:')
      ? { kind: 'page', address: key.slice(2) }
      : { kind: 'group', prefix: key.slice(2) }

export function WikiGraph({ slug }: { slug: string }) {
  const { brain, gate } = useBrain(slug)
  if (!brain) return gate
  return <GraphScreen slug={slug} />
}

const KEYS = ['view', 'q', 'type', 'status', 'tag', 'linkKind', 'group', 'focus', 'hops', 'sort'] as const

function GraphScreen({ slug }: { slug: string }) {
  const g = T.graph
  const w = T.wiki
  const f = useFilters(KEYS)
  const v = f.values
  const group = v.group
  const r = graphResource(slug, group)
  useFresh(r)
  const data = r.data.value
  const model = useMemo(() => (data ? modelOf(data) : null), [data])
  const filters: Filters = { q: v.q, type: v.type, status: v.status, tag: v.tag, linkKind: v.linkKind }
  const filtering = Boolean(v.q || v.type || v.status || v.tag || v.linkKind)
  const hops: 1 | 2 = v.hops === '2' ? 2 : 1
  const [selected, setSelected] = useState<string | null>(null)
  const opener = useRef<HTMLElement | null>(null)
  const list = v.view === 'list'

  // A page to focus on lives in a group: in a wiki drawn by groups, its group opens first.
  useEffect(() => {
    if (model?.mode === 'groups' && !group && v.focus) f.set({ group: areaOf(v.focus) })
  }, [model, v.focus, group])

  const vis = useMemo(() => {
    if (!model) return null
    const base = visibility(model, filters)
    const at = v.focus ? model.index.get(keyOf({ kind: 'page', address: v.focus })) : undefined
    if (at === undefined) return { ...base, focus: -1, hood: null as Map<number, number> | null }
    const hood = neighbourhood(model, at, hops)
    const nodes = new Uint8Array(base.nodes.length)
    let shown = 0
    for (const [i] of hood) {
      // The page in focus always shows; its neighbours as the filters say.
      nodes[i] = i === at ? 1 : (base.nodes[i] as number)
      shown += nodes[i] as number
    }
    const edges = new Uint8Array(base.edges.length)
    for (let e = 0; e < edges.length; e++)
      edges[e] =
        base.edges[e] && nodes[model.edges[2 * e] as number] && nodes[model.edges[2 * e + 1] as number]
          ? 1
          : 0
    return { ...base, nodes, edges, shown, focus: at, hood }
  }, [model, v.q, v.type, v.status, v.tag, v.linkKind, v.focus, hops])

  const state = viewState({
    loading: r.loading.value,
    data,
    error: r.error.value,
    online: online.value,
  })
  const selectedIndex = selected && model ? (model.index.get(selected) ?? -1) : -1
  const focusItem = vis && vis.focus >= 0 ? model?.items[vis.focus] : undefined
  const tags = useMemo(
    () =>
      model ? [...new Set(model.items.flatMap((it) => (it.kind === 'page' ? it.tags : [])))].sort() : [],
    [model],
  )

  const select = (key: string | null) => {
    if (key !== null && document.activeElement instanceof HTMLElement) opener.current = document.activeElement
    setSelected(key)
  }
  const close = () => {
    setSelected(null)
    opener.current?.focus()
  }
  const focusOn = (address: string, h: 1 | 2) =>
    f.set({
      focus: address,
      hops: h === 2 ? '2' : '',
      // In a wiki drawn by groups the page's group opens; inside one, a page of another group moves there.
      group: model?.mode === 'groups' || (group && areaOf(address) !== group) ? areaOf(address) : group,
    })
  const openGroup = (prefix: string) => {
    setSelected(null)
    f.set({ group: prefix, focus: '' })
  }

  const head = (
    <>
      <WikiHead title={g.title} lead={g.lead}>
        {model ? (
          <span class="tag">
            {model.mode === 'groups' && !group
              ? g.groupsCount(model.items.length, model.total)
              : g.count(vis?.shown ?? 0, model.pages)}
          </span>
        ) : null}
      </WikiHead>
      <div class="graph-bar">
        <fieldset class="toggle graph-views">
          <legend class="sr-only">{g.views}</legend>
          <button
            type="button"
            class="button quiet"
            aria-pressed={list ? 'false' : 'true'}
            onClick={() => f.set({ view: '' })}
          >
            {g.graphView}
          </button>
          <button
            type="button"
            class="button quiet"
            aria-pressed={list ? 'true' : 'false'}
            onClick={() => f.set({ view: 'list' })}
          >
            {g.listView}
          </button>
        </fieldset>
        {group ? (
          <nav class="graph-trail" aria-label={g.groupTrail}>
            <button type="button" class="button quiet" onClick={() => f.set({ group: '', focus: '' })}>
              {g.allGroups}
            </button>
            <span aria-hidden="true">›</span>
            <span class="mono" aria-current="location">
              {group}
            </span>
          </nav>
        ) : null}
      </div>
      <search aria-label={g.filters}>
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
              value={v.type}
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
              value={v.status}
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
              value={v.linkKind}
              onChange={(e) => f.set({ linkKind: (e.currentTarget as HTMLSelectElement).value })}
            >
              <option value="">{g.anyLinkKind}</option>
              {KINDS.map((k) => (
                <option key={k} value={k}>
                  {g.linkKinds[k]}
                </option>
              ))}
            </select>
          </div>
          <div class="field">
            <label for="graph-tag">{w.tag}</label>
            {tags.length ? (
              <select
                id="graph-tag"
                value={v.tag}
                onChange={(e) => f.set({ tag: (e.currentTarget as HTMLSelectElement).value })}
              >
                <option value="">{w.anyTag}</option>
                {[...new Set([...tags, ...(v.tag ? [v.tag] : [])])].map((t) => (
                  <option key={t} value={t}>
                    {t}
                  </option>
                ))}
              </select>
            ) : (
              // Groups do not know their tags: the tag is typed (the list filters by it at once).
              <input
                id="graph-tag"
                type="text"
                value={v.tag}
                onChange={(e) => f.set({ tag: (e.currentTarget as HTMLInputElement).value.trim() })}
              />
            )}
          </div>
          {filtering ? (
            <div class="actions">
              <button
                type="button"
                class="button quiet"
                onClick={() => f.set({ q: '', type: '', status: '', tag: '', linkKind: '' })}
              >
                {T.states.clearFilters}
              </button>
            </div>
          ) : null}
        </form>
      </search>
      {focusItem?.kind === 'page' ? (
        <div class="graph-focus">
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
          <button type="button" class="button quiet" onClick={() => f.set({ focus: '', hops: '' })}>
            {g.leaveFocus}
          </button>
        </div>
      ) : null}
      {model?.mode === 'groups' && !group ? <p class="graph-note">{g.huge(model.total)}</p> : null}
      {vis?.partial && !list ? <p class="graph-note">{g.partial}</p> : null}
    </>
  )

  const target = targetOf(selected)
  const inspector = target ? (
    <Inspector
      slug={slug}
      model={model}
      target={target}
      inGraph={!list}
      onClose={close}
      onFocus={focusOn}
      onShow={(key) => setSelected(key)}
      onOpenGroup={openGroup}
      onGroupList={(prefix) => f.set({ view: 'list', group: prefix, focus: '' })}
    />
  ) : null

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
        group={group}
        sort={v.sort}
        focus={vis && vis.focus >= 0 ? { index: vis.focus, hood: vis.hood as Map<number, number> } : null}
        setSort={(sort) => f.set({ sort })}
        onInspect={(t) => select(keyOf(t))}
        onFocus={focusOn}
        onOpenGroup={openGroup}
        selected={selected}
      />
    )
  else if (model.mode === 'too-big')
    body = (
      <Empty title={g.tooBigTitle}>
        <p>{g.tooBigLead(model.total)}</p>
        <button type="button" class="button" onClick={() => f.set({ view: 'list' })}>
          {g.openList}
        </button>
      </Empty>
    )
  else if (model.items.length === 0)
    body = (
      <Empty title={g.emptyTitle}>
        <p>{g.emptyLead}</p>
        <button type="button" class="button" onClick={() => f.set({ view: 'list' })}>
          {g.openList}
        </button>
      </Empty>
    )
  else if (vis && vis.shown === 0)
    body = (
      <Empty
        title={g.emptyTitle}
        filtered
        onClear={() => f.set({ q: '', type: '', status: '', tag: '', linkKind: '', focus: '' })}
      />
    )
  else if (vis)
    body = (
      <GraphCanvas
        model={model}
        nodes={vis.nodes}
        edges={vis.edges}
        shown={vis.shown}
        focus={vis.focus}
        selected={selectedIndex}
        onSelect={(i) => {
          const it = model.items[i]
          if (it) select(keyOf(it))
        }}
        onClose={close}
        refit={`${group}|${v.focus}|${hops}|${v.q}|${v.type}|${v.status}|${v.tag}|${v.linkKind}`}
      />
    )

  return (
    <>
      {head}
      <div class={`graph-layout${inspector ? ' with-inspector' : ''}`}>
        <div class="graph-main">{body}</div>
        {inspector}
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
    rule: v('--rule'),
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

function GraphCanvas({
  model,
  nodes,
  edges,
  shown,
  focus,
  selected,
  onSelect,
  onClose,
  refit,
}: {
  model: Model
  nodes: Uint8Array
  edges: Uint8Array
  shown: number
  focus: number
  selected: number
  onSelect: (i: number) => void
  onClose: () => void
  // Changes when what is drawn changes: the view fits it again.
  refit: string
}) {
  const g = T.graph
  const canvas = useRef<HTMLCanvasElement>(null)
  const box = useRef<HTMLDivElement>(null)
  const worker = useRef<Worker | null>(null)
  const layoutId = useRef(0)
  const [xy, setXy] = useState<Float32Array | null>(null)
  const [settled, setSettled] = useState(false)
  const [active, setActive] = useState(-1)
  const [said, setSaid] = useState('')
  const view = useRef<View>({ scale: 1, tx: 0, ty: 0 })
  // Once the person pans or zooms, the view stays theirs until what is drawn changes.
  const moved = useRef(false)
  const hover = useRef(-1)
  const size = useRef({ w: 0, h: 0 })
  const frame = useRef(0)
  const draws = useRef(0)
  const marked = useRef({ ready: false, settled: false })
  const latest = useRef({ model, nodes, edges, focus, selected, active, xy, settled })
  latest.current = { model, nodes, edges, focus, selected, active, xy, settled }

  const draw = () => {
    const c = canvas.current
    const s = latest.current
    if (!c || !s.xy || s.xy.length !== 2 * s.model.items.length) return
    const { w, h } = size.current
    if (w === 0 || h === 0) return
    const dpr = window.devicePixelRatio || 1
    if (c.width !== Math.round(w * dpr) || c.height !== Math.round(h * dpr)) {
      c.width = Math.round(w * dpr)
      c.height = Math.round(h * dpr)
    }
    if (!moved.current) view.current = fit(s.xy, s.nodes, w, h, 48)
    const ctx = c.getContext('2d')
    if (!ctx) return
    const labelled = new Set<number>()
    for (const i of [s.active, s.selected, hover.current, s.focus])
      if (i >= 0) {
        labelled.add(i)
        if (i === s.active || i === s.selected) for (const l of linksOf(s.model, i)) labelled.add(l.index)
      }
    if (hover.current >= 0) labelled.add(hover.current)
    paint(ctx, {
      model: s.model,
      xy: s.xy,
      nodes: s.nodes,
      edges: s.edges,
      view: view.current,
      width: w,
      height: h,
      dpr,
      palette: palette(),
      active: s.active,
      selected: s.selected,
      focus: s.focus,
      labelled,
    })
    draws.current += 1
    c.dataset.draws = String(draws.current)
    // Where the keyboard's item is on screen (a pointer can go to the same place).
    if (s.active >= 0) {
      const v = view.current
      c.dataset.active = `${Math.round((s.xy[2 * s.active] as number) * v.scale + v.tx)},${Math.round((s.xy[2 * s.active + 1] as number) * v.scale + v.ty)}`
    } else delete c.dataset.active
    if (!marked.current.ready) {
      marked.current.ready = true
      performance.mark('graph:ready')
    }
    if (s.settled && !marked.current.settled) {
      marked.current.settled = true
      performance.mark('graph:settled')
      c.dataset.settled = 'true'
    }
  }
  const request = () => {
    if (frame.current) return
    frame.current = requestAnimationFrame(() => {
      frame.current = 0
      draw()
    })
  }

  useEffect(() => {
    const wk = new Worker(new URL('../../graph/worker.ts', import.meta.url), { type: 'module' })
    worker.current = wk
    return () => {
      wk.terminate()
      cancelAnimationFrame(frame.current)
    }
  }, [])

  // A new layout for each new set of items.
  useEffect(() => {
    const wk = worker.current
    if (!wk) return
    layoutId.current += 1
    const id = layoutId.current
    setXy(null)
    setSettled(false)
    setActive(-1)
    moved.current = false
    marked.current.settled = false
    if (canvas.current) {
      delete canvas.current.dataset.settled
      canvas.current.dataset.frames = '0'
    }
    wk.onmessage = (e: MessageEvent<PositionsMessage>) => {
      if (e.data.type !== 'positions' || e.data.id !== id) return
      // How many pictures the worker sent for this layout (one, with reduced motion: CA7).
      if (canvas.current)
        canvas.current.dataset.frames = String(Number(canvas.current.dataset.frames ?? 0) + 1)
      setXy(e.data.xy)
      if (e.data.done) setSettled(true)
    }
    const message: LayoutRequest = {
      type: 'layout',
      id,
      n: model.items.length,
      edges: model.edges.slice(),
      weights: model.weights.slice(),
      seed: SEED,
      reducedMotion: reducedMotion(),
    }
    wk.postMessage(message, [message.edges.buffer, message.weights.buffer])
  }, [model])

  // The size of the box, and a new picture when it changes.
  useLayoutEffect(() => {
    const el = box.current
    if (!el) return
    const measure = () => {
      const rect = el.getBoundingClientRect()
      if (rect.width === size.current.w && rect.height === size.current.h) return
      size.current = { w: rect.width, h: rect.height }
      request()
    }
    measure()
    const ro = new ResizeObserver(measure)
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  useEffect(() => {
    moved.current = false
  }, [refit])
  useEffect(request, [xy, settled, nodes, edges, focus, selected, active, refit])

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
    moved.current = true
    request()
  }
  const fitAll = () => {
    moved.current = false
    request()
  }

  const toWorld = (sx: number, sy: number) => {
    const v = view.current
    return [(sx - v.tx) / v.scale, (sy - v.ty) / v.scale] as const
  }
  const reach = () => Math.max(NODE_R + 6, 12) / view.current.scale
  const describe = (i: number) => {
    const it = model.items[i]
    if (!it) return ''
    return it.kind === 'group'
      ? g.onGroup(it.prefix, it.count)
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
    // Keep it on screen.
    const x = latest.current.xy
    if (!x) return
    const v = view.current
    const sx = (x[2 * i] as number) * v.scale + v.tx
    const sy = (x[2 * i + 1] as number) * v.scale + v.ty
    const { w, h } = size.current
    if (sx < 24 || sy < 24 || sx > w - 24 || sy > h - 24) {
      view.current = { ...v, tx: v.tx + (w / 2 - sx), ty: v.ty + (h / 2 - sy) }
      moved.current = true
    }
  }
  // The item nearest the middle of what is shown: where the keyboard starts.
  const start = () => {
    const x = latest.current.xy
    if (!x) return -1
    if (selected >= 0 && nodes[selected]) return selected
    if (focus >= 0) return focus
    const [cx, cy] = toWorld(size.current.w / 2, size.current.h / 2)
    return hit(x, nodes, cx, cy, Number.POSITIVE_INFINITY)
  }

  const onKey = (e: KeyboardEvent) => {
    const x = latest.current.xy
    if (!x) return
    const dir = ARROWS[e.key]
    if (dir) {
      e.preventDefault()
      const from = active >= 0 && nodes[active] ? active : start()
      if (from < 0) return
      moveTo(active >= 0 && nodes[active] ? step(model, x, nodes, from, dir) : from)
      return
    }
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault()
      const i = active >= 0 ? active : start()
      if (i >= 0) {
        setActive(i)
        onSelect(i)
        setSaid(g.inspectorOpen)
      }
      return
    }
    if (e.key === 'Escape' && selected >= 0) {
      e.preventDefault()
      onClose()
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
  const onPointerMove = (e: PointerEvent) => {
    const d = drag.current
    if (d) {
      const dx = e.clientX - d.x
      const dy = e.clientY - d.y
      if (!d.moved && Math.hypot(dx, dy) < 4) return
      d.moved = true
      view.current = { ...view.current, tx: d.tx + dx, ty: d.ty + dy }
      moved.current = true
      request()
      return
    }
    const x = latest.current.xy
    const c = canvas.current
    if (!x || !c) return
    const rect = c.getBoundingClientRect()
    const [wx, wy] = toWorld(e.clientX - rect.left, e.clientY - rect.top)
    const i = hit(x, nodes, wx, wy, reach())
    if (i !== hover.current) {
      hover.current = i
      if (i >= 0) c.dataset.hover = ''
      else delete c.dataset.hover
      request()
    }
  }
  const onPointerUp = (e: PointerEvent) => {
    const d = drag.current
    drag.current = null
    if (!d || d.moved) return
    const x = latest.current.xy
    const c = canvas.current
    if (!x || !c) return
    const rect = c.getBoundingClientRect()
    const [wx, wy] = toWorld(e.clientX - rect.left, e.clientY - rect.top)
    const i = hit(x, nodes, wx, wy, reach())
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
              request()
            }
          }}
        />
        {xy ? null : (
          <div class="graph-wait">
            <Skeleton rows={2} />
          </div>
        )}
      </div>
      <p id="graph-help" class="hint">
        {g.canvasHelp}
      </p>
      <p class="sr-only" aria-live="polite">
        {said}
      </p>
      <Legend />
    </section>
  )
}

function Legend() {
  const g = T.graph
  return (
    <details class="graph-legend">
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
          <p class="meta">{g.dimmed}</p>
        </div>
        <div>
          <p class="section-title">{g.lines}</p>
          <ul class="plain">
            {[...KINDS, 'group'].map((k) => (
              <li key={k}>
                <svg
                  width="36"
                  height="10"
                  aria-hidden="true"
                  class={`legend-line${k === 'contradicts' ? ' danger' : ''}`}
                >
                  <line
                    x1="2"
                    y1="5"
                    x2="34"
                    y2="5"
                    stroke-width={k === 'supersedes' ? 2.5 : 1.5}
                    stroke-dasharray={(DASH[k] ?? []).join(' ') || undefined}
                    stroke-linecap="round"
                  />
                </svg>
                {g.linkKinds[k]}
              </li>
            ))}
          </ul>
        </div>
      </div>
    </details>
  )
}

// The shape of a page type as a small picture (the same path the canvas draws).
function ShapeIcon({ type }: { type: string }) {
  const ref = useRef<HTMLCanvasElement>(null)
  useLayoutEffect(() => {
    const c = ref.current
    const ctx = c?.getContext('2d')
    if (!c || !ctx) return
    const dpr = window.devicePixelRatio || 1
    c.width = 14 * dpr
    c.height = 14 * dpr
    ctx.scale(dpr, dpr)
    ctx.beginPath()
    shape(ctx, type, 7, 7, 5)
    ctx.fillStyle = palette().text
    ctx.fill('evenodd')
  }, [type])
  // biome-ignore lint/a11y/noAriaHiddenOnFocusable: a canvas without tabindex is never focused; the word beside it names the type
  return <canvas ref={ref} class="legend-shape" width={14} height={14} aria-hidden="true" />
}

// What the person picked: a page (its summary, status, links and the way to it) or a group (its pages by
// type and the groups it links with). The same panel serves the graph and the list.
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
  target: Target
  inGraph: boolean
  onClose: () => void
  onFocus: (address: string, hops: 1 | 2) => void
  onShow: (key: string) => void
  onOpenGroup: (prefix: string) => void
  onGroupList: (prefix: string) => void
}) {
  const g = T.graph
  const panel = useRef<HTMLElement>(null)
  const heading = useRef<HTMLHeadingElement>(null)
  const key = keyOf(target)
  // Opened from a button of the list, the keyboard follows it here; from the canvas it stays there.
  useEffect(() => {
    if (!inGraph && heading.current && !(document.activeElement instanceof HTMLCanvasElement))
      heading.current.focus()
  }, [key])
  const onKey = (e: KeyboardEvent) => {
    if (e.key === 'Escape') {
      e.preventDefault()
      onClose()
    }
  }
  const at = model?.index.get(key) ?? -1
  return (
    <aside
      class="graph-inspector"
      aria-labelledby="inspector-name inspector-title"
      ref={panel}
      onKeyDown={onKey}
    >
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
          inGraph={inGraph}
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
  inGraph,
}: {
  slug: string
  address: string
  model: Model | null
  at: number
  headingRef: preact.RefObject<HTMLHeadingElement>
  onFocus: (address: string, hops: 1 | 2) => void
  onShow: (key: string) => void
  inGraph: boolean
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
  const links = (list: NonNullable<typeof reading>['links']['out'], title: string, id: string) => (
    <div class="aside-block">
      <h3 class="aside-sub" id={id}>
        {title}
      </h3>
      {list.length ? (
        <ul class="plain inspector-links" aria-labelledby={id}>
          {list.map((l) => (
            <li key={`${l.kind}:${l.address}`}>
              <span class="meta">{g.linkKinds[l.kind] ?? l.kind}</span>{' '}
              {l.state === 'broken' ? (
                <span>
                  <span class="mono">{l.address}</span> <span class="meta">{g.noPage}</span>
                </span>
              ) : (
                <a href={pageHref(slug, l.address)}>{l.title ?? l.address}</a>
              )}
              {inGraph && shownHere(l.address) && l.state !== 'broken' ? (
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
          ))}
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
            <button type="button" class="button quiet" onClick={() => onFocus(address, 1)}>
              {g.focus1}
            </button>
            <button type="button" class="button quiet" onClick={() => onFocus(address, 2)}>
              {g.focus2}
            </button>
          </>
        ) : null}
      </div>
      {reading ? (
        <>
          {links(reading.links.out, g.linksOut, 'inspector-out')}
          {links(reading.links.in, g.linksIn, 'inspector-in')}
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
