// The layout of the graph (plan §3.4): a force layout over typed arrays, run in the graph's Web Worker. Pages
// push each other apart (Barnes–Hut on a quadtree, so 2 000 pages cost a few milliseconds a step), links pull
// their two ends together, and a weak pull to the middle keeps pages without links in sight. It cools down
// step by step and stops; the same pages, links and seed always give the same picture. No DOM here.

export const LAYOUT = {
  maxTicks: 300,
  alphaMin: 0.001,
  // Each step keeps 60% of the speed.
  velocityKeep: 0.6,
  charge: -30,
  linkDistance: 30,
  centre: 0.04,
  // Barnes–Hut: a cell this small seen from this far counts as one body.
  theta2: 0.81,
  distanceMin2: 1,
}

export type LayoutInput = {
  n: number
  // Links as pairs of node indices: [from0, to0, from1, to1, ...].
  edges: Uint32Array
  seed: number
  // How heavy each node is (a group of many pages pushes harder); 1 by default.
  weights?: Float32Array
}

export type Layout = {
  tick(): void
  // Steps until `budgetMs` has passed or it is done; says whether it is done.
  run(budgetMs: number): boolean
  done(): boolean
  // [x0, y0, x1, y1, ...], a new array each time (it is handed over to the page).
  positions(): Float32Array
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

export function createLayout(input: LayoutInput): Layout {
  const { n, edges } = input
  const random = rng(input.seed)
  const jiggle = () => (random() - 0.5) * 1e-6
  const x = new Float64Array(n)
  const y = new Float64Array(n)
  const vx = new Float64Array(n)
  const vy = new Float64Array(n)
  const strength = new Float64Array(n)
  for (let i = 0; i < n; i++) {
    // A sunflower spiral to start from: even, and the same every time.
    const r = 10 * Math.sqrt(0.5 + i)
    const a = i * Math.PI * (3 - Math.sqrt(5))
    x[i] = r * Math.cos(a)
    y[i] = r * Math.sin(a)
    strength[i] = LAYOUT.charge * Math.sqrt(input.weights?.[i] ?? 1)
  }
  // Links: each pulls with a strength shared by the busier end, as springs of the same rest length.
  const m = edges.length >> 1
  const degree = new Float64Array(n)
  for (let e = 0; e < 2 * m; e++) degree[edges[e] as number] = (degree[edges[e] as number] ?? 0) + 1
  const linkStrength = new Float64Array(m)
  const bias = new Float64Array(m)
  const distance = new Float64Array(m)
  for (let e = 0; e < m; e++) {
    const s = edges[2 * e] as number
    const t = edges[2 * e + 1] as number
    const ds = degree[s] as number
    const dt = degree[t] as number
    linkStrength[e] = 1 / Math.min(ds, dt)
    bias[e] = ds / (ds + dt)
    // Heavy nodes (groups) sit further apart.
    distance[e] =
      LAYOUT.linkDistance *
      Math.max(1, Math.sqrt(Math.sqrt((input.weights?.[s] ?? 1) + (input.weights?.[t] ?? 1))))
  }
  let alpha = n <= 1 ? 0 : 1
  const alphaDecay = 1 - LAYOUT.alphaMin ** (1 / LAYOUT.maxTicks)
  let ticks = 0

  // The quadtree, rebuilt each step in flat arrays: per cell its 4 children (-1: none), its first page (a
  // leaf), its weight and centre. Pages in the same leaf are chained by `next`.
  let child = new Int32Array(0)
  let point = new Int32Array(0)
  let cw = new Float64Array(0)
  let cx = new Float64Array(0)
  let cy = new Float64Array(0)
  let csize = new Float64Array(0)
  const next = new Int32Array(n)
  let cells = 0

  function grow(cap: number) {
    if (cap <= point.length) return
    const size = Math.max(cap, point.length * 2, 64)
    const c2 = new Int32Array(size * 4).fill(-1)
    c2.set(child)
    child = c2
    const p2 = new Int32Array(size).fill(-1)
    p2.set(point)
    point = p2
    for (const name of ['w', 'x', 'y', 's'] as const) {
      const old = name === 'w' ? cw : name === 'x' ? cx : name === 'y' ? cy : csize
      const fresh = new Float64Array(size)
      fresh.set(old)
      if (name === 'w') cw = fresh
      else if (name === 'x') cx = fresh
      else if (name === 'y') cy = fresh
      else csize = fresh
    }
  }
  function cell(size: number): number {
    grow(cells + 1)
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
    for (let i = 0; i < n; i++) {
      const xi = x[i] as number
      const yi = y[i] as number
      if (xi < x0) x0 = xi
      if (xi > x1) x1 = xi
      if (yi < y0) y0 = yi
      if (yi > y1) y1 = yi
    }
    const size = Math.max(x1 - x0, y1 - y0, 1) * 1.0001
    const root = cell(size)
    for (let i = 0; i < n; i++) {
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
        const internal =
          !leaf &&
          (child[4 * k] !== -1 ||
            child[4 * k + 1] !== -1 ||
            child[4 * k + 2] !== -1 ||
            child[4 * k + 3] !== -1)
        if (!leaf && !internal) {
          // An empty cell (only the root can be one): it takes the page.
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
          // Split: the page there moves one level down.
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

  const stack = new Int32Array(4 * 64 + 8)
  function charge() {
    if (n < 2) return
    build()
    for (let i = 0; i < n; i++) {
      const xi = x[i] as number
      const yi = y[i] as number
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
      const s = edges[2 * e] as number
      const t = edges[2 * e + 1] as number
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

  const layout: Layout = {
    tick() {
      if (layout.done()) return
      alpha += (0 - alpha) * alphaDecay
      ticks += 1
      links()
      charge()
      for (let i = 0; i < n; i++) {
        vx[i] = ((vx[i] as number) - (x[i] as number) * LAYOUT.centre * alpha) * LAYOUT.velocityKeep
        vy[i] = ((vy[i] as number) - (y[i] as number) * LAYOUT.centre * alpha) * LAYOUT.velocityKeep
        x[i] = (x[i] as number) + (vx[i] as number)
        y[i] = (y[i] as number) + (vy[i] as number)
      }
    },
    run(budgetMs) {
      const start = performance.now()
      while (!layout.done()) {
        layout.tick()
        if (performance.now() - start >= budgetMs) break
      }
      return layout.done()
    },
    done: () => n <= 1 || alpha < LAYOUT.alphaMin || ticks >= LAYOUT.maxTicks,
    positions() {
      const out = new Float32Array(2 * n)
      for (let i = 0; i < n; i++) {
        out[2 * i] = x[i] as number
        out[2 * i + 1] = y[i] as number
      }
      return out
    },
  }
  return layout
}
