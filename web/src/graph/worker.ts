// The graph's Web Worker (plan §3.4): it works out the layout, in three dimensions, and, holding the canvas
// (OffscreenCanvas), paints it, so the page never waits for either. The camera's flat projection goes back to
// the page with each still picture (it finds what is under the pointer and where an arrow key leads). With
// reduced motion one picture, the settled one; otherwise a picture every ~32 ms while it settles, and then one
// per animation frame while the cloud turns or light travels its lines. Work goes in slices of 8 ms, so a new
// layout (a group opened) replaces the old one at once, and a frame is painted at most once per animation
// frame, whatever asked for it. A turning picture is told to the page at most four times a second.
import { arrange, createLayout } from './layout.ts'
import type { DrawnMessage, FromWorker, LayoutRequest, ToWorker } from './protocol.ts'
import { Renderer } from './render.ts'

const scope = self as unknown as {
  onmessage: ((e: MessageEvent<ToWorker>) => void) | null
  postMessage(m: FromWorker, transfer?: Transferable[]): void
  requestAnimationFrame?: (f: () => void) => number
}

let current = -1
let settled = false
let canvas: OffscreenCanvas | null = null
const renderer = new Renderer()
let frame = false
// What was told to the page last, and the painting time of the pictures not told since (CA5 adds it up).
let told = { at: 0, seq: -1, spinning: false, settled: false }
let untold = 0
const TELL_EVERY = 250

function paint() {
  frame = false
  const st = renderer.state
  if (!canvas || !st) return
  const w = Math.round(st.width * st.dpr)
  const h = Math.round(st.height * st.dpr)
  if (canvas.width !== w || canvas.height !== h) {
    canvas.width = w
    canvas.height = h
  }
  const ctx = canvas.getContext('2d')
  if (!ctx) return
  const now = performance.now()
  const drawn = renderer.paint(ctx, now)
  if (!drawn) return
  untold += drawn.ms
  const fresh =
    drawn.xy !== null ||
    drawn.seq !== told.seq ||
    drawn.spinning !== told.spinning ||
    settled !== told.settled ||
    now - told.at >= TELL_EVERY
  if (fresh) {
    told = { at: now, seq: drawn.seq, spinning: drawn.spinning, settled }
    const message: DrawnMessage = { type: 'drawn', id: current, ...drawn, ms: untold, settled }
    untold = 0
    scope.postMessage(message, drawn.xy ? [drawn.xy.buffer] : [])
  }
  if (drawn.animating) request()
}
function request() {
  if (frame || !canvas) return
  frame = true
  if (scope.requestAnimationFrame) scope.requestAnimationFrame(paint)
  else setTimeout(paint, 16)
}

function layout(m: LayoutRequest) {
  // The worker's own working time, idle gaps between slices left out (CA5 reads it).
  let busy = 0
  const timed = <T>(f: () => T): T => {
    const t = performance.now()
    const out = f()
    busy += performance.now() - t
    return out
  }
  current = m.id
  settled = false
  // Only the pages with links feel the forces; the rest is placed around them when they are done.
  const free: number[] = []
  for (let i = 0; i < m.n; i++) if (m.role[i] === 0) free.push(i)
  const local = new Map(free.map((g, l) => [g, l]))
  const pairs: number[] = []
  for (let e = 0; e < m.edges.length; e += 2) {
    const a = local.get(m.edges[e] as number)
    const b = local.get(m.edges[e + 1] as number)
    if (a !== undefined && b !== undefined) pairs.push(a, b)
  }
  const l = timed(() =>
    createLayout({
      n: free.length,
      edges: new Uint32Array(pairs),
      seed: m.seed,
      weights: Float32Array.from(free, (g) => m.weights[g] as number),
      area: Int32Array.from(free, (g) => m.area[g] as number),
      dims: 3,
      family: Int32Array.from(free, (g) => m.family[g] as number),
    }),
  )

  const post = (done: boolean) => {
    const part = l.positions3()
    // The pages without links and the rim are placed on the flat picture, at depth 0.
    const xy = new Float32Array(2 * m.n)
    free.forEach((g, k) => {
      xy[2 * g] = part[3 * k] as number
      xy[2 * g + 1] = part[3 * k + 1] as number
    })
    timed(() => arrange(xy, m.role, m.edges))
    const xyz = new Float32Array(3 * m.n)
    for (let i = 0; i < m.n; i++) {
      xyz[3 * i] = xy[2 * i] as number
      xyz[3 * i + 1] = xy[2 * i + 1] as number
    }
    free.forEach((g, k) => {
      xyz[3 * g + 2] = part[3 * k + 2] as number
    })
    if (done) settled = true
    renderer.layout = xyz
    request()
    const copy = xyz.slice()
    scope.postMessage({ type: 'positions', id: m.id, xyz: copy, done, ...(done ? { ms: busy } : {}) }, [
      copy.buffer,
    ])
  }
  let last = performance.now()
  if (!m.reducedMotion && !l.done()) post(false)
  if (l.done()) return post(true)
  const slice = () => {
    if (current !== m.id) return
    if (timed(() => l.run(8))) return post(true)
    const now = performance.now()
    if (!m.reducedMotion && now - last >= 32) {
      last = now
      post(false)
    }
    setTimeout(slice, 0)
  }
  setTimeout(slice, 0)
}

scope.onmessage = (e) => {
  const m = e.data
  if (m.type === 'layout') layout(m)
  else if (m.type === 'canvas') canvas = m.canvas
  else if (m.type === 'scene') renderer.setScene(m.scene)
  else if (m.type === 'labels') renderer.setLabels(m.labels)
  else if (m.type === 'facts') renderer.setFacts(m.facts)
  else if (m.type === 'state') renderer.state = m.state
  request()
}
