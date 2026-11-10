// The graph's Web Worker (plan §3.4; v0.5.0): it runs the live layout and, holding the canvas (OffscreenCanvas),
// paints it, so the page never waits for either. While the layout moves (settling, or a page held by the
// pointer) it takes a few steps and paints once per animation frame, and tells the page where every item is;
// at rest it paints only when what is shown changes. With reduced motion, or the canvas out of sight, nothing is
// animated: the layout is worked out to rest in slices of 8 ms and drawn once, still.
import { createLayout, type Layout } from './layout.ts'
import type { FromWorker, LayoutRequest, ToWorker } from './protocol.ts'
import { Renderer } from './render.ts'

const scope = self as unknown as {
  onmessage: ((e: MessageEvent<ToWorker>) => void) | null
  postMessage(m: FromWorker, transfer?: Transferable[]): void
  requestAnimationFrame?: (f: () => void) => number
}

// Steps a frame while the layout moves, within a time budget: from a cold start to rest in about a second.
const STEPS_A_FRAME = 5
const FRAME_BUDGET_MS = 12
// Steps a slice when the layout is worked out still (reduced motion), between which messages are heard.
const SLICE_MS = 8

let current = -1
let sim: Layout | null = null
let canvas: OffscreenCanvas | null = null
const renderer = new Renderer()
let reduced = false
let seen = true
// The layout has come to rest once (the page marks the settled picture), and the worker's working time until.
let settled = false
let busy = 0
// A frame is asked for; a still layout is being worked out in slices.
let frame = false
let slicing = false
// The layout moved since it was last told to the page.
let moved = false

const timed = <T>(f: () => T): T => {
  const t = performance.now()
  const out = f()
  if (!settled) busy += performance.now() - t
  return out
}

// Tells the page where every item is, and gives the painter the same.
function publish() {
  if (!sim) return
  moved = false
  const xy = sim.positions()
  const done = sim.done()
  const first = done && !settled
  if (first) settled = true
  renderer.layout = xy
  const copy = xy.slice()
  scope.postMessage({ type: 'positions', id: current, xy: copy, done, ...(first ? { ms: busy } : {}) }, [
    copy.buffer,
  ])
}

const animating = () => sim !== null && !sim.done() && !reduced && seen && !slicing

function paint() {
  frame = false
  if (animating() && sim) {
    const s = sim
    timed(() => s.run(FRAME_BUDGET_MS, STEPS_A_FRAME))
    moved = true
  }
  if (moved) publish()
  const st = renderer.state
  if (canvas && st) {
    const w = Math.round(st.width * st.dpr)
    const h = Math.round(st.height * st.dpr)
    if (canvas.width !== w || canvas.height !== h) {
      canvas.width = w
      canvas.height = h
    }
    const ctx = canvas.getContext('2d')
    const drawn = ctx ? renderer.paint(ctx) : null
    if (drawn) {
      if (!settled) busy += drawn.ms
      scope.postMessage({ type: 'drawn', id: current, ...drawn, settled, moving: animating() })
    }
  }
  if (animating()) request()
}
function request() {
  if (frame) return
  frame = true
  if (canvas && scope.requestAnimationFrame) scope.requestAnimationFrame(paint)
  else setTimeout(paint, 16)
}

// Works the layout out to rest without painting between, in slices so a new message is heard at once; then
// it is told and drawn once.
// A page held never comes to rest: the rest waits until it is let go.
function still() {
  if (slicing || !sim || sim.held() >= 0) return
  slicing = true
  const id = current
  const slice = () => {
    if (id !== current || !sim || sim.held() >= 0) {
      slicing = false
      return
    }
    const s = sim
    if (!timed(() => s.run(SLICE_MS))) {
      setTimeout(slice, 0)
      return
    }
    slicing = false
    moved = true
    request()
  }
  slice()
}

function layout(m: LayoutRequest) {
  current = m.id
  settled = false
  busy = 0
  slicing = false
  sim = timed(() => createLayout({ n: m.n, edges: m.edges, seed: m.seed, weights: m.weights, role: m.role }))
  // Moving, the first picture is the start; still, the one at rest.
  if (reduced || !seen) still()
  else {
    moved = true
    request()
  }
}

function hold(id: number, i: number, x: number, y: number) {
  if (id !== current || !sim) return
  if (i >= 0) sim.hold(i, x, y)
  else sim.release()
  if (reduced || !seen) {
    // Still: the page held follows the pointer and nothing else moves; let go, the rest is worked out at once.
    moved = true
    if (i < 0) still()
    else request()
  } else {
    moved = true
    request()
  }
}

scope.onmessage = (e) => {
  const m = e.data
  if (m.type === 'layout') return layout(m)
  if (m.type === 'hold') return hold(m.id, m.i, m.x, m.y)
  if (m.type === 'canvas') canvas = m.canvas
  else if (m.type === 'scene') renderer.setScene(m.scene)
  else if (m.type === 'state') renderer.state = m.state
  else if (m.type === 'motion') {
    const was = reduced || !seen
    reduced = m.reduced
    seen = m.seen
    // Less motion asked for, or out of sight, while it moves: the rest is worked out still.
    if (!was && (reduced || !seen) && sim && !sim.done()) still()
  }
  request()
}
