// Plan §3.4 (T030, T032): the layout of the graph, worked out in a Web Worker. Pure code, tested here: the same
// data and seed always give the same picture, it settles in a bounded number of steps, linked pages end up
// nearer than unlinked ones, no two pages sit on each other, and it is quick enough for 2 000 pages (the
// most one view draws) to settle without the page noticing. The CPU times are bounds with a wide margin.
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { createLayout, LAYOUT } from '../../web/src/graph/layout.ts'

// A ring of clusters: each node linked to the next two in its cluster, clusters linked in a ring.
function sample(n: number, cluster = 20) {
  const pairs: number[] = []
  for (let i = 0; i < n; i++) {
    const base = i - (i % cluster)
    for (const k of [1, 2]) {
      const j = base + ((i - base + k) % cluster)
      if (j < n && j !== i) pairs.push(i, j)
    }
    if (i % cluster === 0 && i + cluster < n) pairs.push(i, i + cluster)
  }
  return new Uint32Array(pairs)
}

const cpuMs = (f: () => void) => {
  const t = process.cpuUsage()
  f()
  const d = process.cpuUsage(t)
  return (d.user + d.system) / 1000
}

describe('the layout of the graph', () => {
  it('the same pages, links and seed give the same picture', () => {
    const run = () => {
      const l = createLayout({ n: 120, edges: sample(120), seed: 48291 })
      while (!l.done()) l.tick()
      return Array.from(l.positions())
    }
    assert.deepEqual(run(), run())
  })

  it('settles within its step budget', () => {
    const l = createLayout({ n: 300, edges: sample(300), seed: 1 })
    let steps = 0
    while (!l.done()) {
      l.tick()
      steps += 1
    }
    assert.ok(steps <= LAYOUT.maxTicks, `${steps} steps`)
    assert.ok(steps > 50, 'it does move')
  })

  it('linked pages end up nearer than unlinked ones, and none sit on each other', () => {
    const n = 200
    const edges = sample(n)
    const l = createLayout({ n, edges, seed: 7 })
    while (!l.done()) l.tick()
    const xy = l.positions()
    const d = (i: number, j: number) =>
      Math.hypot(
        (xy[2 * i] as number) - (xy[2 * j] as number),
        (xy[2 * i + 1] as number) - (xy[2 * j + 1] as number),
      )
    let linked = 0
    for (let e = 0; e < edges.length; e += 2) linked += d(edges[e] as number, edges[e + 1] as number)
    linked /= edges.length / 2
    let all = 0
    let pairs = 0
    let nearest = Number.POSITIVE_INFINITY
    for (let i = 0; i < n; i++)
      for (let j = i + 1; j < n; j++) {
        all += d(i, j)
        pairs += 1
        nearest = Math.min(nearest, d(i, j))
      }
    assert.ok(linked < (all / pairs) * 0.5, `linked ${linked.toFixed(1)} vs any ${(all / pairs).toFixed(1)}`)
    assert.ok(nearest > 1, `nearest pair ${nearest.toFixed(2)}`)
    for (const v of xy) assert.ok(Number.isFinite(v))
  })

  it('no page, one page, and pages without links are fine', () => {
    for (const n of [0, 1, 2, 40]) {
      const l = createLayout({ n, edges: new Uint32Array(), seed: 3 })
      let steps = 0
      while (!l.done() && steps++ < 1000) l.tick()
      assert.ok(l.done())
      assert.equal(l.positions().length, 2 * n)
      for (const v of l.positions()) assert.ok(Number.isFinite(v))
    }
  })

  it('heavier nodes (groups with many pages) push harder and stay apart', () => {
    const l = createLayout({
      n: 3,
      edges: new Uint32Array([0, 1, 1, 2]),
      seed: 5,
      weights: new Float32Array([400, 1, 400]),
    })
    while (!l.done()) l.tick()
    const xy = l.positions()
    assert.ok(Math.hypot((xy[0] as number) - (xy[4] as number), (xy[1] as number) - (xy[5] as number)) > 40)
  })

  it('runs in slices of a few milliseconds, so the worker can post frames between them', () => {
    const l = createLayout({ n: 2000, edges: sample(2000), seed: 9 })
    let calls = 0
    while (!l.done() && calls < 5) {
      const t = performance.now()
      l.run(8)
      calls += 1
      // One step past the budget at most (a step of 2 000 pages is a few ms).
      assert.ok(performance.now() - t < 120, `slice took ${performance.now() - t} ms`)
    }
  })

  for (const n of [300, 2000, 5000]) {
    it(`${n} pages settle in bounded CPU time (load test, T030)`, () => {
      const edges = sample(n)
      let steps = 0
      const ms = cpuMs(() => {
        const l = createLayout({ n, edges, seed: 48291 })
        while (!l.done()) {
          l.tick()
          steps += 1
        }
      })
      // Reported for the record (plan T030); the bound has a wide margin for slow CI machines.
      process.stdout.write(
        `# layout ${n} pages: ${steps} steps, ${ms.toFixed(0)} ms CPU, ${(ms / steps).toFixed(2)} ms a step\n`,
      )
      assert.ok(ms / steps < (n <= 300 ? 10 : n <= 2000 ? 60 : 150), `${(ms / steps).toFixed(1)} ms a step`)
    })
  }
})
