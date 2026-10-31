// Plan §3.4 (T030, T032): the layout of the graph, worked out in a Web Worker. Pure code, tested here: the same
// data and seed always give the same picture, it settles in a bounded number of steps, linked pages end up
// nearer than unlinked ones, no two pages sit on each other, and it is quick enough for 2 000 pages (the
// most one view draws) to settle without the page noticing. The CPU times are bounds with a wide margin.
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { arrange, createLayout, LAYOUT, ROLE } from '../../web/src/graph/layout.ts'

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

  it('pages of the same area are pulled together', () => {
    // Two areas of 40, linked at random across and within: the area keeps its pages near.
    const n = 80
    const pairs: number[] = []
    for (let i = 0; i < n; i++) pairs.push(i, (i * 17 + 5) % n)
    const area = new Int32Array(n).map((_, i) => (i < 40 ? 0 : 1))
    const l = createLayout({ n, edges: new Uint32Array(pairs), seed: 3, area })
    while (!l.done()) l.tick()
    const xy = l.positions()
    const d = (i: number, j: number) =>
      Math.hypot(
        (xy[2 * i] as number) - (xy[2 * j] as number),
        (xy[2 * i + 1] as number) - (xy[2 * j + 1] as number),
      )
    let same = 0
    let other = 0
    for (let i = 0; i < n; i++)
      for (let j = 0; j < n; j++) {
        if ((area[i] as number) === (area[j] as number)) same += d(i, j)
        else other += d(i, j)
      }
    assert.ok(same / (2 * 40 * 40) < (other / (2 * 40 * 40)) * 0.8, `same ${same} other ${other}`)
  })

  it('parks pages without links in rows under the cluster, and puts groups around it on a rim', () => {
    // 0–3 linked in a square around the middle; 4–6 without links; 7 a group linked to 1 (on the right).
    const xy = new Float32Array([-10, -10, 10, -10, 10, 10, -10, 10, 0, 0, 0, 0, 0, 0, 0, 0])
    const role = new Uint8Array([0, 0, 0, 0, ROLE.orphan, ROLE.orphan, ROLE.orphan, ROLE.rim])
    const edges = new Uint32Array([0, 1, 1, 2, 2, 3, 1, 7])
    arrange(xy, role, edges)
    const at = (i: number) => [xy[2 * i] as number, xy[2 * i + 1] as number] as const
    for (const i of [4, 5, 6]) {
      assert.ok(at(i)[1] > 10, `orphan ${i} below the cluster: ${at(i)}`)
      assert.ok(at(i)[0] >= -10 && at(i)[0] <= 10 + 24 * 3)
    }
    assert.notDeepEqual(at(4), at(5))
    assert.equal(at(4)[1], at(5)[1], 'in a row')
    const [gx, gy] = at(7)
    assert.ok(Math.hypot(gx, gy) > Math.hypot(10, 10) + 20, 'outside the cloud')
    assert.ok(gx > 0, 'on the side of the page it links with')
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
