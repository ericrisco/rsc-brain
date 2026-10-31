// The logic of the graph screen (spec B6 «Graph», plan §3.4), without the DOM: the answer of
// GET …/wiki/graph as items and edges by index; what the filters leave drawn (the list filters the same
// way on the server); focus at one or two hops; where an arrow key goes; what is under the pointer; and
// how to fit what is drawn into the canvas.

export type Answer = {
  mode: 'pages' | 'groups' | 'too-big'
  prefix: string | null
  total: number
  kinds: string[]
  nodes: [address: string, title: string, type: string, status: string, tags: string[]][]
  edges: [number, number, number][]
  across: [number, string, number][]
  groups: { prefix: string; count: number; types: Record<string, number> }[]
  groupEdges: [string, string, number][]
}

export type PageItem = {
  kind: 'page'
  address: string
  title: string
  type: string
  status: string
  tags: string[]
}
export type GroupItem = { kind: 'group'; prefix: string; count: number; types: Record<string, number> }
export type Item = PageItem | GroupItem

export type Model = {
  mode: Answer['mode']
  prefix: string | null
  total: number
  kinds: string[]
  // Pages first, then groups (all of them; or, in one group, those its pages link with).
  items: Item[]
  pages: number
  // Pairs of item indices.
  edges: Uint32Array
  // Per edge: the index of its link kind, or −1 between a page and a group or two groups.
  kind: Int8Array
  // Per edge: how many links it stands for.
  count: Uint32Array
  // Per item: how heavy it is in the layout (a group: its pages).
  weights: Float32Array
  // Per item: how many other items it links with.
  degree: Uint32Array
  index: Map<string, number>
}

export const keyOf = (i: { kind: 'page'; address: string } | { kind: 'group'; prefix: string }) =>
  i.kind === 'page' ? `p:${i.address}` : `g:${i.prefix}`

export function modelOf(a: Answer): Model {
  const items: Item[] = [
    ...a.nodes.map(
      ([address, title, type, status, tags]): PageItem => ({
        kind: 'page',
        address,
        title,
        type,
        status,
        tags,
      }),
    ),
    ...a.groups.map((g): GroupItem => ({ kind: 'group', prefix: g.prefix, count: g.count, types: g.types })),
  ]
  const index = new Map(items.map((it, i) => [keyOf(it), i]))
  const pairs: number[] = []
  const kinds: number[] = []
  const counts: number[] = []
  for (const [i, j, k] of a.edges) {
    pairs.push(i, j)
    kinds.push(k)
    counts.push(1)
  }
  for (const [i, prefix, n] of a.across) {
    const g = index.get(`g:${prefix}`)
    if (g === undefined) continue
    pairs.push(i, g)
    kinds.push(-1)
    counts.push(n)
  }
  for (const [x, y, n] of a.groupEdges) {
    const i = index.get(`g:${x}`)
    const j = index.get(`g:${y}`)
    if (i === undefined || j === undefined) continue
    pairs.push(i, j)
    kinds.push(-1)
    counts.push(n)
  }
  const near = items.map(() => new Set<number>())
  for (let e = 0; e < pairs.length; e += 2) {
    near[pairs[e] as number]?.add(pairs[e + 1] as number)
    near[pairs[e + 1] as number]?.add(pairs[e] as number)
  }
  return {
    degree: new Uint32Array(near.map((x) => x.size)),
    mode: a.mode,
    prefix: a.prefix,
    total: a.total,
    kinds: a.kinds,
    items,
    pages: a.nodes.length,
    edges: new Uint32Array(pairs),
    kind: new Int8Array(kinds),
    count: new Uint32Array(counts),
    weights: new Float32Array(items.map((it) => (it.kind === 'group' ? Math.max(1, it.count) : 1))),
    index,
  }
}

export type Filters = { q: string; type: string; status: string; tag: string; linkKind: string }
export const NO_FILTERS: Filters = { q: '', type: '', status: '', tag: '', linkKind: '' }

export type Visibility = {
  nodes: Uint8Array
  edges: Uint8Array
  // Items drawn (pages and group boxes).
  shown: number
  // Pages this picture stands for: the pages drawn, or, by groups, the pages in the groups drawn.
  pages: number
}

const KNOWN_KINDS = [
  'mentions',
  'related',
  'depends-on',
  'contradicts',
  'supersedes',
  'part-of',
  'example-of',
]

// What is drawn under these filters, the list's own: a page that matches them all (statuses may be several,
// comma separated); with a link kind, only links of that kind and only pages with one; an edge when both ends
// are drawn. A link kind that does not exist filters nothing, as the list leaves it out. Groups are counted
// by the server under the same filters (`counts`), and a group left with no page is not drawn. In one group,
// the box of another group shows while a page drawn links to it.
export function visibility(m: Model, f: Filters, counts?: Map<string, number>): Visibility {
  const n = m.items.length
  const nodes = new Uint8Array(n)
  const edges = new Uint8Array(m.kind.length)
  const q = f.q.trim().toLowerCase()
  const statuses = f.status ? f.status.split(',') : null
  const kind = f.linkKind && KNOWN_KINDS.includes(f.linkKind) ? m.kinds.indexOf(f.linkKind) : -2
  const byGroups = m.mode === 'groups'
  let pages = 0
  for (let i = 0; i < n; i++) {
    const it = m.items[i] as Item
    if (it.kind === 'group') {
      if (!byGroups) continue
      const c = counts ? (counts.get(it.prefix) ?? 0) : it.count
      if (c > 0) {
        nodes[i] = 1
        pages += c
      }
      continue
    }
    nodes[i] =
      (!f.type || it.type === f.type) &&
      (!statuses || statuses.includes(it.status)) &&
      (!f.tag || it.tags.includes(f.tag)) &&
      (!q || it.address.includes(q) || it.title.toLowerCase().includes(q))
        ? 1
        : 0
  }
  const linked = new Uint8Array(n)
  for (let e = 0; e < edges.length; e++) {
    const i = m.edges[2 * e] as number
    const j = m.edges[2 * e + 1] as number
    const k = m.kind[e] as number
    const page = i < m.pages ? i : j < m.pages ? j : -1
    const group = i >= m.pages ? i : j >= m.pages ? j : -1
    if (!byGroups && page >= 0 && group >= 0) {
      // A link out of the group: drawn while its page is and no link kind is asked for (it has none).
      if (nodes[page] && kind === -2) {
        edges[e] = 1
        nodes[group] = 1
      }
      continue
    }
    if (!nodes[i] || !nodes[j]) continue
    if (kind !== -2 && k >= 0 && k !== kind) continue
    edges[e] = 1
    linked[i] = 1
    linked[j] = 1
  }
  if (kind !== -2) for (let i = 0; i < m.pages; i++) if (!linked[i]) nodes[i] = 0
  let shown = 0
  for (let i = 0; i < n; i++) {
    shown += nodes[i] as number
    if (i < m.pages && nodes[i]) pages += 1
  }
  return { nodes, edges, shown, pages }
}

// The `count` most linked items drawn, the most linked first (ties: the first one).
export function hubs(m: Model, nodes: Uint8Array, count: number): number[] {
  const drawn: number[] = []
  for (let i = 0; i < nodes.length; i++) if (nodes[i] && (m.degree[i] as number) > 0) drawn.push(i)
  return drawn.sort((a, b) => (m.degree[b] as number) - (m.degree[a] as number) || a - b).slice(0, count)
}

// Where each item goes once the forces are done (layout.ts ROLE): a page with no link is parked; in one
// group, the boxes of the other groups go on the rim.
export function roles(m: Model): Uint8Array {
  return new Uint8Array(
    m.items.map((it, i) =>
      it.kind === 'group' ? (m.mode === 'groups' ? 0 : 2) : (m.degree[i] as number) === 0 ? 1 : 0,
    ),
  )
}

// The area of each page: the next part of its address under the group open (or the first part); −1 for a box.
export function areas(m: Model): Int32Array {
  const depth = m.prefix === null ? 0 : m.prefix.split('/').length
  const ids = new Map<string, number>()
  return new Int32Array(
    m.items.map((it) => {
      if (it.kind !== 'page') return -1
      const key = it.address
        .split('/')
        .slice(0, depth + 1)
        .join('/')
      if (!ids.has(key)) ids.set(key, ids.size)
      return ids.get(key) as number
    }),
  )
}

// The biggest linked part of what is drawn (and the boxes on the rim): what the view fits, so a few pages far
// off never shrink the rest. Nothing linked: everything drawn.
export function mainCluster(m: Model, nodes: Uint8Array, edges: Uint8Array): Uint8Array {
  const n = nodes.length
  const parent = Int32Array.from({ length: n }, (_, i) => i)
  const find = (i: number): number => {
    while (parent[i] !== i) {
      parent[i] = parent[parent[i] as number] as number
      i = parent[i] as number
    }
    return i
  }
  for (let e = 0; e < edges.length; e++) {
    if (!edges[e]) continue
    const i = m.edges[2 * e] as number
    const j = m.edges[2 * e + 1] as number
    if (m.mode !== 'groups' && (i >= m.pages || j >= m.pages)) continue
    parent[find(i)] = find(j)
  }
  const size = new Map<number, number>()
  for (let i = 0; i < n; i++) if (nodes[i]) size.set(find(i), (size.get(find(i)) ?? 0) + 1)
  let best = -1
  let most = 1
  for (const [root, c] of size)
    if (c > most) {
      most = c
      best = root
    }
  const out = new Uint8Array(n)
  for (let i = 0; i < n; i++)
    out[i] = nodes[i] && (best === -1 || find(i) === best || (m.mode !== 'groups' && i >= m.pages)) ? 1 : 0
  return out
}

// The radii of the rings of focus: one hop, two hops.
export const RINGS = [130, 260] as const

// Focus as a picture: the page in the middle, its neighbours on a ring, theirs on a wider one, each ring in
// even steps; a two-hop item sits near the one-hop item that leads to it.
export function radial(m: Model, hood: Map<number, number>, n: number): Float32Array {
  const xy = new Float32Array(2 * n)
  const ring = (h: number) => [...hood].filter(([, d]) => d === h).map(([i]) => i)
  const first = ring(1).sort((a, b) => a - b)
  const angle = new Map<number, number>()
  first.forEach((i, k) => {
    const a = (k / Math.max(1, first.length)) * Math.PI * 2 - Math.PI / 2
    angle.set(i, a)
    xy[2 * i] = RINGS[0] * Math.cos(a)
    xy[2 * i + 1] = RINGS[0] * Math.sin(a)
  })
  // Second ring: in the order of the first-ring item each is reached from.
  const via = (j: number) => {
    let best = Number.POSITIVE_INFINITY
    for (const l of linksOf(m, j)) {
      const a = angle.get(l.index)
      if (a !== undefined && a < best) best = a
    }
    return best
  }
  const second = ring(2).sort((a, b) => via(a) - via(b) || a - b)
  second.forEach((i, k) => {
    const a = (k / Math.max(1, second.length)) * Math.PI * 2 - Math.PI / 2
    xy[2 * i] = RINGS[1] * Math.cos(a)
    xy[2 * i + 1] = RINGS[1] * Math.sin(a)
  })
  return xy
}

// The item and those within `hops` links of it, either way, with how far each is.
export function neighbourhood(m: Model, start: number, hops: 1 | 2): Map<number, number> {
  const out = new Map<number, number>([[start, 0]])
  let frontier = new Set([start])
  for (let h = 1; h <= hops; h++) {
    const reached: number[] = []
    for (let e = 0; e < m.kind.length; e++) {
      const i = m.edges[2 * e] as number
      const j = m.edges[2 * e + 1] as number
      for (const [a, b] of [
        [i, j],
        [j, i],
      ] as const) {
        if (frontier.has(a) && !out.has(b)) {
          out.set(b, h)
          reached.push(b)
        }
      }
    }
    frontier = new Set(reached)
  }
  return out
}

export type LinkLine = { index: number; kind: string | null; way: 'out' | 'in' | 'both'; count: number }

// The links of an item in this view: to and from pages by kind; with groups, how many links both ways.
export function linksOf(m: Model, i: number): LinkLine[] {
  const out: LinkLine[] = []
  for (let e = 0; e < m.kind.length; e++) {
    const a = m.edges[2 * e] as number
    const b = m.edges[2 * e + 1] as number
    if (a !== i && b !== i) continue
    const k = m.kind[e] as number
    const other = a === i ? b : a
    out.push({
      index: other,
      kind: k < 0 ? null : (m.kinds[k] ?? null),
      way: k < 0 ? 'both' : a === i ? 'out' : 'in',
      count: m.count[e] as number,
    })
  }
  return out.sort((x, y) => x.index - y.index || (x.kind ?? '').localeCompare(y.kind ?? ''))
}

export type Direction = 'up' | 'down' | 'left' | 'right'
const AXIS: Record<Direction, [number, number]> = { up: [0, -1], down: [0, 1], left: [-1, 0], right: [1, 0] }

// Where an arrow key goes from `from`: the nearest linked item that lies that way (within 60° of it);
// without one, the nearest drawn item that way; without that, nowhere.
export function step(m: Model, xy: Float32Array, visible: Uint8Array, from: number, dir: Direction): number {
  const [ax, ay] = AXIS[dir]
  const fx = xy[2 * from] as number
  const fy = xy[2 * from + 1] as number
  const score = (j: number) => {
    const dx = (xy[2 * j] as number) - fx
    const dy = (xy[2 * j + 1] as number) - fy
    const along = dx * ax + dy * ay
    const across = Math.abs(dx * ay - dy * ax)
    if (along <= 0 || across > along * Math.sqrt(3)) return Number.POSITIVE_INFINITY
    // Straight ahead counts nearer than off to the side.
    return along + 2 * across
  }
  const best = (candidates: Iterable<number>) => {
    let pick = -1
    let low = Number.POSITIVE_INFINITY
    for (const j of candidates) {
      if (j === from || !visible[j]) continue
      const s = score(j)
      if (s < low) {
        low = s
        pick = j
      }
    }
    return pick
  }
  const linked = best(linksOf(m, from).map((l) => l.index))
  if (linked !== -1) return linked
  const any = best(m.items.keys())
  return any === -1 ? from : any
}

// The drawn item nearest to (x, y) within `reach`, or −1.
export function hit(xy: Float32Array, visible: Uint8Array, x: number, y: number, reach: number): number {
  let pick = -1
  let low = reach * reach
  for (let i = 0; i < visible.length; i++) {
    if (!visible[i]) continue
    const dx = (xy[2 * i] as number) - x
    const dy = (xy[2 * i + 1] as number) - y
    const d = dx * dx + dy * dy
    if (d <= low) {
      low = d
      pick = i
    }
  }
  return pick
}

export type View = { scale: number; tx: number; ty: number }

// The scale and shift that put every drawn item inside a canvas of w × h with `pad` around, centred.
export function fit(xy: Float32Array, visible: Uint8Array, w: number, h: number, pad: number): View {
  let x0 = Number.POSITIVE_INFINITY
  let y0 = Number.POSITIVE_INFINITY
  let x1 = Number.NEGATIVE_INFINITY
  let y1 = Number.NEGATIVE_INFINITY
  for (let i = 0; i < visible.length; i++) {
    if (!visible[i]) continue
    const x = xy[2 * i] as number
    const y = xy[2 * i + 1] as number
    if (x < x0) x0 = x
    if (x > x1) x1 = x
    if (y < y0) y0 = y
    if (y > y1) y1 = y
  }
  if (x0 === Number.POSITIVE_INFINITY) return { scale: 1, tx: w / 2, ty: h / 2 }
  const scale = Math.min(2, (w - 2 * pad) / Math.max(x1 - x0, 1e-9), (h - 2 * pad) / Math.max(y1 - y0, 1e-9))
  return { scale, tx: w / 2 - ((x0 + x1) / 2) * scale, ty: h / 2 - ((y0 + y1) / 2) * scale }
}
