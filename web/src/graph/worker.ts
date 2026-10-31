// The graph's Web Worker (plan §3.4): it works out the layout so the page never waits for it. In: the size,
// the links as pairs of indices, the weights, the seed and whether the person asked the system for reduced
// motion. Out: positions, handed over (not copied). With reduced motion one message, the settled picture;
// otherwise a picture every ~32 ms while it settles, then the last one. Work goes in slices of 8 ms so a new
// layout (a group opened meanwhile) replaces the old one at once.
import { createLayout } from './layout.ts'
import type { LayoutRequest, PositionsMessage } from './protocol.ts'

const scope = self as unknown as {
  onmessage: ((e: MessageEvent<LayoutRequest>) => void) | null
  postMessage(m: PositionsMessage, transfer: Transferable[]): void
}

let current = -1

scope.onmessage = (e) => {
  const m = e.data
  if (m.type !== 'layout') return
  current = m.id
  const layout = createLayout({ n: m.n, edges: m.edges, seed: m.seed, weights: m.weights })
  const post = (done: boolean) => {
    const xy = layout.positions()
    scope.postMessage({ type: 'positions', id: m.id, xy, done }, [xy.buffer])
  }
  let last = performance.now()
  // A first picture at once: the page has something to show while the rest settles.
  if (!m.reducedMotion) post(layout.done())
  if (layout.done()) {
    if (m.reducedMotion) post(true)
    return
  }
  const slice = () => {
    if (current !== m.id) return
    const done = layout.run(8)
    if (done) return post(true)
    const now = performance.now()
    if (!m.reducedMotion && now - last >= 32) {
      last = now
      post(false)
    }
    setTimeout(slice, 0)
  }
  setTimeout(slice, 0)
}
