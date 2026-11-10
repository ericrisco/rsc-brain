// The layout of the graph (plan §3.4; v0.5.0): a live force simulation in two dimensions over typed arrays,
// run in the graph's Web Worker. Pages push each other apart (Barnes–Hut on a quadtree, so 2 000 pages cost a
// few milliseconds a step) and keep a little room around them, links pull their two ends together, and a weak
// pull to the middle keeps the picture together. It cools down step by step and comes to rest; a page held
// by the pointer warms it again, so its neighbours follow, and once let go it cools down again. The same
// pages, links and seed always give the same picture. No DOM here.
//
// The pages without links (ROLE.orphan) feel no force: they sit evenly spaced on a ring just outside the
// linked pages, and in one group the boxes of the other groups (ROLE.rim) on a ring outside that. Both rings
// follow the linked pages as they move; a page on a ring held by the pointer goes back to its place once let go.

export const LAYOUT = {
  alphaMin: 0.001,
  // From a cold start to rest in this many steps.
  settleTicks: 300,
  // How warm the simulation is kept while a page is held.
  dragAlpha: 0.3,
  // Each step keeps 60% of the speed.
  velocityKeep: 0.6,
  charge: -30,
  linkDistance: 30,
  centre: 0.04,
  // The room kept around a page, in layout units, times how it grows with its links (render.ts grows it the
  // same way on screen).
  collide: 4,
  collideStrength: 0.7,
  // Barnes–Hut: a cell this small seen from this far counts as one body.
  theta2: 0.81,
  distanceMin2: 1,
  // The rings: how far outside the linked pages, and the least room between two places on them.
  ringGap: 40,
  orphanStep: 14,
  rimStep: 80,
  // How much of the way to its place on a ring a page goes each step.
  anchorPull: 0.2,
}

// Where a node goes (layout.ts and model.ts roles): laid out by the forces (`free`), on the ring of pages
// without links (`orphan`), or on the rim around them (`rim`: a group a page of an opened group links with).
export const ROLE = { free: 0, orphan: 1, rim: 2 } as const

export type LayoutInput = {
  n: number
  // Links as pairs of node indices: [from0, to0, from1, to1, ...]. A link with a node off the forces is left out.
  edges: Uint32Array
  seed: number
  // How heavy each node is (a group of many pages pushes harder); 1 by default.
  weights?: Float32Array
  // Each node's role (ROLE); all free by default.
  role?: Uint8Array
}

export type Layout = {
  tick(): void
  // Steps until `budgetMs` has passed, `maxTicks` are done, or it rests; says whether it rests.
  run(budgetMs: number, maxTicks?: number): boolean
  // At rest: cold, nothing held, every page on a ring at its place.
  done(): boolean
  // [x0, y0, x1, y1, ...], a new array each time (it is handed over to the page).
  positions(): Float32Array
  // Holds node i at (x, y) and keeps the simulation warm until it is let go.
  hold(i: number, x: number, y: number): void
  // Lets the node held go: it moves with the forces again, and the simulation cools down.
  release(): void
  // The node held, or −1.
  held(): number
  // Steps taken since the start.
  ticks(): number
}

// mulberry32: small and the same everywhere.
function rng(seed: number) {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

// How much bigger a page is drawn, and the room kept around it, with its links: up to three times.
export const grow = (degree: number) => Math.min(3, 1 + 0.25 * Math.sqrt(degree))

export function createLayout(input: LayoutInput): Layout {
  const { n } = input
  const role = input.role ?? new Uint8Array(n)
  const random = rng(input.seed)
  const jiggle = () => (random() - 0.5) * 1e-6
  const x = new Float64Array(n)
  const y = new Float64Array(n)
  const vx = new Float64Array(n)
  const vy = new Float64Array(n)
  const strength = new Float64Array(n)
  const room = new Float64Array(n)
  // The nodes the forces move, and the others (on a ring), each list in index order.
  const free: number[] = []
  const ringed: number[] = []
  for (let i = 0; i < n; i++) (role[i] === ROLE.free ? free : ringed).push(i)
  // Links between two free nodes only.
  const pairs: number[] = []
  for (let e = 0; e + 1 < input.edges.length; e += 2) {
    const s = input.edges[e] as number
    const t = input.edges[e + 1] as number
    if (s !== t && s < n && t < n && role[s] === ROLE.free && role[t] === ROLE.free) pairs.push(s, t)
  }
  const m = pairs.length >> 1
  const degree = new Float64Array(n)
  for (const i of pairs) degree[i] = (degree[i] as number) + 1
  free.forEach((i, k) => {
    // A sunflower spiral to start from: even, and the same every time.
    const a = k * Math.PI * (3 - Math.sqrt(5))
    const r = 10 * Math.sqrt(0.5 + k)
    x[i] = r * Math.cos(a)
    y[i] = r * Math.sin(a)
    strength[i] = LAYOUT.charge * Math.sqrt(input.weights?.[i] ?? 1)
    room[i] = LAYOUT.collide * grow(degree[i] as number)
  })
  // Links: each pulls with a strength shared by the busier end, as springs of the same rest length.
  const linkStrength = new Float64Array(m)
  const bias = new Float64Array(m)
  const distance = new Float64Array(m)
  for (let e = 0; e < m; e++) {
    const s = pairs[2 * e] as number
    const t = pairs[2 * e + 1] as number
    const ds = degree[s] as number
    const dt = degree[t] as number
    linkStrength[e] = 1 / Math.min(ds, dt)
    bias[e] = ds / (ds + dt)
    // Heavy nodes (groups) sit further apart.
    distance[e] =
      LAYOUT.linkDistance *
      Math.max(1, Math.sqrt(Math.sqrt((input.weights?.[s] ?? 1) + (input.weights?.[t] ?? 1))))
  }
  let alpha = free.length <= 1 && ringed.length === 0 ? 0 : 1
  let alphaTarget = 0
  const alphaDecay = 1 - LAYOUT.alphaMin ** (1 / LAYOUT.settleTicks)
  let ticks = 0
  let holding = -1
  let holdX = 0
  let holdY = 0
  // Where each ringed node belongs.
  const ax = new Float64Array(n)
  const ay = new Float64Array(n)

  // The quadtree, rebuilt each step in flat arrays: per cell its 4 children (-1: none), its first node (a leaf),
  // its weight and centre. Nodes in the same leaf are chained by `next`.
  let child = new Int32Array(0)
  let point = new Int32Array(0)
  let cw = new Float64Array(0)
  let cx = new Float64Array(0)
  let cy = new Float64Array(0)
  let csize = new Float64Array(0)
  const next = new Int32Array(n)
  let cells = 0

  function grow2(cap: number) {
    if (cap <= point.length) return
    const size = Math.max(cap, point.length * 2, 64)
    const c2 = new Int32Array(size * 4).fill(-1)
    c2.set(child)
    child = c2
    const p2 = new Int32Array(size).fill(-1)
    p2.set(point)
    point = p2
    const more = (old: Float64Array) => {
      const fresh = new Float64Array(size)
      fresh.set(old)
      return fresh
    }
    cw = more(cw)
    cx = more(cx)
    cy = more(cy)
    csize = more(csize)
  }
  const internal = (k: number) =>
    child[4 * k] !== -1 || child[4 * k + 1] !== -1 || child[4 * k + 2] !== -1 || child[4 * k + 3] !== -1
  function cell(size: number): number {
    grow2(cells + 1)
    const k = cells++
    child.fill(-1, 4 * k, 4 * k + 4)
    point[k] = -1
    csize[k] = size
    return k
  }

  function build() {
    cells = 0
    let x0 = Number.POSITIVE_INFINITY
    let y0 = Number.POSITIVE_INFINITY
    let x1 = Number.NEGATIVE_INFINITY
    let y1 = Number.NEGATIVE_INFINITY
    for (const i of free) {
      const xi = x[i] as number
      const yi = y[i] as number
      if (xi < x0) x0 = xi
      if (xi > x1) x1 = xi
      if (yi < y0) y0 = yi
      if (yi > y1) y1 = yi
    }
    const size = Math.max(x1 - x0, y1 - y0, 1) * 1.0001
    const root = cell(size)
    for (const i of free) {
      next[i] = -1
      let k = root
      let kx = x0
      let ky = y0
      let ks = size
      let depth = 0
      const xi = x[i] as number
      const yi = y[i] as number
      for (;;) {
        const p = point[k] as number
        const leaf = p !== -1
        if (!leaf && !internal(k)) {
          // An empty cell (only the root can be one): it takes the node.
          point[k] = i
          break
        }
        if (leaf) {
          // The same place, or as deep as it goes: share the leaf.
          if (depth > 40 || ((x[p] as number) === xi && (y[p] as number) === yi)) {
            next[i] = next[p] as number
            next[p] = i
            break
          }
          // Split: the node there moves one level down.
          point[k] = -1
          const half = ks / 2
          const q = ((x[p] as number) >= kx + half ? 1 : 0) | ((y[p] as number) >= ky + half ? 2 : 0)
          const c = cell(half)
          child[4 * k + q] = c
          point[c] = p
        }
        const half = ks / 2
        const q = (xi >= kx + half ? 1 : 0) | (yi >= ky + half ? 2 : 0)
        if (q & 1) kx += half
        if (q & 2) ky += half
        ks = half
        depth += 1
        const c = child[4 * k + q] as number
        if (c === -1) {
          const fresh = cell(half)
          child[4 * k + q] = fresh
          point[fresh] = i
          break
        }
        k = c
      }
    }
    // Weights and centres, children before parents (a child is always made after its parent).
    for (let k = cells - 1; k >= 0; k--) {
      let w = 0
      let sx = 0
      let sy = 0
      if ((point[k] as number) !== -1) {
        for (let p = point[k] as number; p !== -1; p = next[p] as number) {
          const s = strength[p] as number
          w += s
          sx += s * (x[p] as number)
          sy += s * (y[p] as number)
        }
      } else {
        for (let q = 0; q < 4; q++) {
          const c = child[4 * k + q] as number
          if (c === -1) continue
          const s = cw[c] as number
          w += s
          sx += s * (cx[c] as number)
          sy += s * (cy[c] as number)
        }
      }
      cw[k] = w
      cx[k] = w === 0 ? 0 : sx / w
      cy[k] = w === 0 ? 0 : sy / w
    }
  }

  // Repulsion, and the room around each node: two nodes nearer than their rooms are pushed apart.
  const stack = new Int32Array(4 * 64 + 16)
  function charge() {
    if (free.length < 2) return
    build()
    for (const i of free) {
      const xi = x[i] as number
      const yi = y[i] as number
      const ri = room[i] as number
      let top = 0
      stack[top++] = 0
      while (top > 0) {
        const k = stack[--top] as number
        const w = cw[k] as number
        if (w === 0) continue
        let dx = (cx[k] as number) - xi
        let dy = (cy[k] as number) - yi
        let l = dx * dx + dy * dy
        const s = csize[k] as number
        const leaf = (point[k] as number) !== -1
        if (!leaf && (s * s) / l < LAYOUT.theta2) {
          if (l < LAYOUT.distanceMin2) l = Math.sqrt(LAYOUT.distanceMin2 * l)
          vx[i] = (vx[i] as number) + (dx * w * alpha) / l
          vy[i] = (vy[i] as number) + (dy * w * alpha) / l
          continue
        }
        if (!leaf) {
          for (let q = 0; q < 4; q++) {
            const c = child[4 * k + q] as number
            if (c !== -1) stack[top++] = c
          }
          continue
        }
        for (let p = point[k] as number; p !== -1; p = next[p] as number) {
          if (p === i) continue
          dx = (x[p] as number) - xi
          dy = (y[p] as number) - yi
          if (dx === 0) dx = jiggle()
          if (dy === 0) dy = jiggle()
          l = dx * dx + dy * dy
          const near = ri + (room[p] as number)
          if (l < near * near) {
            // Too close: each moves half the overlap apart.
            const d = Math.sqrt(l)
            const push = ((near - d) / d) * 0.5 * LAYOUT.collideStrength
            vx[i] = (vx[i] as number) - dx * push
            vy[i] = (vy[i] as number) - dy * push
          }
          if (l < LAYOUT.distanceMin2) l = Math.sqrt(LAYOUT.distanceMin2 * l)
          const ws = strength[p] as number
          vx[i] = (vx[i] as number) + (dx * ws * alpha) / l
          vy[i] = (vy[i] as number) + (dy * ws * alpha) / l
        }
      }
    }
  }

  function links() {
    for (let e = 0; e < m; e++) {
      const s = pairs[2 * e] as number
      const t = pairs[2 * e + 1] as number
      let dx = (x[t] as number) + (vx[t] as number) - (x[s] as number) - (vx[s] as number)
      let dy = (y[t] as number) + (vy[t] as number) - (y[s] as number) - (vy[s] as number)
      if (dx === 0) dx = jiggle()
      if (dy === 0) dy = jiggle()
      let l = Math.sqrt(dx * dx + dy * dy)
      l = ((l - (distance[e] as number)) / l) * alpha * (linkStrength[e] as number)
      dx *= l
      dy *= l
      const b = bias[e] as number
      vx[t] = (vx[t] as number) - dx * b
      vy[t] = (vy[t] as number) - dy * b
      vx[s] = (vx[s] as number) + dx * (1 - b)
      vy[s] = (vy[s] as number) + dy * (1 - b)
    }
  }

  // The places on the rings, around the free nodes as they are now.
  function places() {
    if (!ringed.length) return
    const at = ringPlaces(x, y, role, pairsAll)
    for (const i of ringed) {
      ax[i] = at[2 * i] as number
      ay[i] = at[2 * i + 1] as number
    }
  }
  // The links with a group on the rim: it is placed toward the pages it links with.
  const rimLinks: number[] = []
  for (let e = 0; e + 1 < input.edges.length; e += 2) {
    const s = input.edges[e] as number
    const t = input.edges[e + 1] as number
    if (role[s] === ROLE.rim || role[t] === ROLE.rim) rimLinks.push(s, t)
  }
  const pairsAll = new Uint32Array(rimLinks)
  places()
  for (const i of ringed) {
    x[i] = ax[i] as number
    y[i] = ay[i] as number
  }

  // How far the ringed nodes are from their places, at most.
  const offPlace = () => {
    let far = 0
    for (const i of ringed)
      if (i !== holding)
        far = Math.max(
          far,
          Math.abs((x[i] as number) - (ax[i] as number)) + Math.abs((y[i] as number) - (ay[i] as number)),
        )
    return far
  }

  const layout: Layout = {
    tick() {
      alpha += (alphaTarget - alpha) * alphaDecay
      ticks += 1
      links()
      charge()
      for (const i of free) {
        vx[i] = ((vx[i] as number) - (x[i] as number) * LAYOUT.centre * alpha) * LAYOUT.velocityKeep
        vy[i] = ((vy[i] as number) - (y[i] as number) * LAYOUT.centre * alpha) * LAYOUT.velocityKeep
        x[i] = (x[i] as number) + (vx[i] as number)
        y[i] = (y[i] as number) + (vy[i] as number)
      }
      if (holding >= 0) {
        x[holding] = holdX
        y[holding] = holdY
        vx[holding] = 0
        vy[holding] = 0
      }
      places()
      for (const i of ringed) {
        if (i === holding) continue
        x[i] = (x[i] as number) + ((ax[i] as number) - (x[i] as number)) * LAYOUT.anchorPull
        y[i] = (y[i] as number) + ((ay[i] as number) - (y[i] as number)) * LAYOUT.anchorPull
      }
    },
    run(budgetMs, maxTicks = Number.POSITIVE_INFINITY) {
      const start = performance.now()
      let k = 0
      while (!layout.done() && k < maxTicks) {
        layout.tick()
        k += 1
        if (performance.now() - start >= budgetMs) break
      }
      return layout.done()
    },
    done: () => holding < 0 && alphaTarget === 0 && alpha < LAYOUT.alphaMin && offPlace() < 0.5,
    positions() {
      const out = new Float32Array(2 * n)
      for (let i = 0; i < n; i++) {
        out[2 * i] = x[i] as number
        out[2 * i + 1] = y[i] as number
      }
      return out
    },
    hold(i, hx, hy) {
      if (i < 0 || i >= n) return
      holding = i
      holdX = hx
      holdY = hy
      x[i] = hx
      y[i] = hy
      alphaTarget = LAYOUT.dragAlpha
      if (alpha < LAYOUT.dragAlpha) alpha = Math.max(alpha, LAYOUT.dragAlpha * 0.5)
    },
    release() {
      holding = -1
      alphaTarget = 0
    },
    held: () => holding,
    ticks: () => ticks,
  }
  return layout
}

// Where the ringed nodes go around the free ones as they are (x, y per node): the pages without links evenly
// spaced on a ring just outside the farthest free node, in index order from the top; the rim's groups on a
// ring outside that, each toward the free pages it links with. The places of free nodes are left as they are.
// Returned as [x0, y0, …] for every node.
export function ringPlaces(
  x: ArrayLike<number>,
  y: ArrayLike<number>,
  role: Uint8Array,
  edges: Uint32Array,
): Float64Array {
  const n = role.length
  const out = new Float64Array(2 * n)
  let x0 = Number.POSITIVE_INFINITY
  let y0 = Number.POSITIVE_INFINITY
  let x1 = Number.NEGATIVE_INFINITY
  let y1 = Number.NEGATIVE_INFINITY
  const orphans: number[] = []
  const rim: number[] = []
  for (let i = 0; i < n; i++) {
    out[2 * i] = x[i] as number
    out[2 * i + 1] = y[i] as number
    if (role[i] === ROLE.orphan) orphans.push(i)
    else if (role[i] === ROLE.rim) rim.push(i)
    else {
      const xi = x[i] as number
      const yi = y[i] as number
      if (xi < x0) x0 = xi
      if (xi > x1) x1 = xi
      if (yi < y0) y0 = yi
      if (yi > y1) y1 = yi
    }
  }
  if (!Number.isFinite(x0)) [x0, x1, y0, y1] = [0, 0, 0, 0]
  const cx = (x0 + x1) / 2
  const cy = (y0 + y1) / 2
  let reach = 0
  for (let i = 0; i < n; i++)
    if (role[i] === ROLE.free)
      reach = Math.max(reach, Math.hypot((x[i] as number) - cx, (y[i] as number) - cy))
  let radius = reach > 0 ? reach + LAYOUT.ringGap : 0
  if (orphans.length) {
    // Wide enough to leave orphanStep between two places.
    radius = Math.max(radius, (orphans.length * LAYOUT.orphanStep) / (2 * Math.PI))
    const step = (2 * Math.PI) / orphans.length
    orphans.forEach((i, k) => {
      const a = -Math.PI / 2 + k * step
      out[2 * i] = cx + radius * Math.cos(a)
      out[2 * i + 1] = cy + radius * Math.sin(a)
    })
    radius += LAYOUT.ringGap
  }
  if (!rim.length) return out
  // Each group where its pages point, then spread evenly in that order, turned so each sits as near its own as
  // the others allow.
  const toward = rim.map((i, k) => {
    let sx = 0
    let sy = 0
    for (let e = 0; e + 1 < edges.length; e += 2) {
      const a = edges[e] as number
      const b = edges[e + 1] as number
      const other = a === i ? b : b === i ? a : -1
      if (other < 0 || role[other] !== ROLE.free) continue
      sx += (x[other] as number) - cx
      sy += (y[other] as number) - cy
    }
    return { i, angle: sx === 0 && sy === 0 ? k : Math.atan2(sy, sx) }
  })
  toward.sort((a, b) => a.angle - b.angle || a.i - b.i)
  const step = (2 * Math.PI) / toward.length
  const r = Math.max(
    radius + (orphans.length ? 0 : LAYOUT.rimStep - LAYOUT.ringGap),
    toward.length > 1 ? LAYOUT.rimStep / (2 * Math.sin(step / 2)) : 0,
  )
  let sx = 0
  let sy = 0
  toward.forEach((t, k) => {
    sx += Math.cos(t.angle - k * step)
    sy += Math.sin(t.angle - k * step)
  })
  const turn = sx === 0 && sy === 0 ? 0 : Math.atan2(sy, sx)
  toward.forEach((t, k) => {
    const a = toward.length === 1 ? t.angle : turn + k * step
    out[2 * t.i] = cx + r * Math.cos(a)
    out[2 * t.i + 1] = cy + r * Math.sin(a)
  })
  return out
}
