// Plan §3.4 (T030, T032; v0.5.0): the live layout of the graph, worked out in a Web Worker. Pure code, tested
// here: the same data and seed always give the same picture, it comes to rest in a bounded number of steps,
// linked pages end up nearer than unlinked ones, no two pages sit on each other, a page held by the pointer
// pulls its neighbours along and the picture rests again once it is let go, pages without links sit evenly on a
// ring around the linked ones, and it is quick enough for 2 000 pages (the most one view draws). The CPU times
// are bounds with a wide margin.
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { createLayout, LAYOUT, ROLE, ringPlaces } from '../../web/src/graph/layout.ts'

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

const at = (xy: Float32Array, i: number) => [xy[2 * i] as number, xy[2 * i + 1] as number] as const
const dist = (xy: Float32Array, i: number, j: number) =>
  Math.hypot(
    (xy[2 * i] as number) - (xy[2 * j] as number),
    (xy[2 * i + 1] as number) - (xy[2 * j + 1] as number),
  )

function rest(l: ReturnType<typeof createLayout>, cap = 5000) {
  let steps = 0
  while (!l.done() && steps < cap) {
    l.tick()
    steps += 1
  }
  return steps
}

describe('the live layout of the graph', () => {
  it('the same pages, links and seed give the same picture', () => {
    const run = () => {
      const l = createLayout({ n: 120, edges: sample(120), seed: 48291 })
      rest(l)
      return Array.from(l.positions())
    }
    assert.deepEqual(run(), run())
  })

  it('comes to rest within its step budget', () => {
    const l = createLayout({ n: 300, edges: sample(300), seed: 1 })
    const steps = rest(l)
    assert.ok(l.done())
    assert.ok(steps <= LAYOUT.settleTicks + 5, `${steps} steps`)
    assert.ok(steps > 50, 'it does move')
  })

  it('linked pages end up nearer than unlinked ones, and none sit on each other', () => {
    const n = 200
    const edges = sample(n)
    const l = createLayout({ n, edges, seed: 7 })
    rest(l)
    const xy = l.positions()
    let linked = 0
    for (let e = 0; e < edges.length; e += 2) linked += dist(xy, edges[e] as number, edges[e + 1] as number)
    linked /= edges.length / 2
    let all = 0
    let pairs = 0
    let nearest = Number.POSITIVE_INFINITY
    for (let i = 0; i < n; i++)
      for (let j = i + 1; j < n; j++) {
        all += dist(xy, i, j)
        pairs += 1
        nearest = Math.min(nearest, dist(xy, i, j))
      }
    assert.ok(linked < (all / pairs) * 0.5, `linked ${linked.toFixed(1)} vs any ${(all / pairs).toFixed(1)}`)
    // The room kept around each page: never nearer than most of two rooms.
    assert.ok(nearest > LAYOUT.collide, `nearest pair ${nearest.toFixed(2)}`)
    for (const v of xy) assert.ok(Number.isFinite(v))
  })

  it('no page, one page, and pages without links are fine', () => {
    for (const n of [0, 1, 2, 40]) {
      const l = createLayout({
        n,
        edges: new Uint32Array(),
        seed: 3,
        role: new Uint8Array(n).fill(ROLE.orphan),
      })
      rest(l, 1000)
      assert.ok(l.done(), `${n} pages rest`)
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
    rest(l)
    const xy = l.positions()
    assert.ok(dist(xy, 0, 2) > 40)
  })

  it('a page held by the pointer goes where it is held, and its neighbours follow', () => {
    const n = 120
    const edges = sample(n)
    const l = createLayout({ n, edges, seed: 11 })
    rest(l)
    const before = l.positions()
    // Page 0 is linked to 1, 2 and 20 (sample); 60 is in another cluster, far along the ring.
    const [x0, y0] = at(before, 0)
    const target = [x0 + 300, y0 + 300] as const
    l.hold(0, target[0], target[1])
    assert.equal(l.held(), 0)
    assert.ok(!l.done(), 'holding wakes it')
    for (let k = 0; k < 80; k++) l.tick()
    const during = l.positions()
    assert.deepEqual(at(during, 0).map(Math.round), target.map(Math.round), 'it stays under the pointer')
    const moved = (xy: Float32Array, i: number) =>
      Math.hypot(
        (xy[2 * i] as number) - (before[2 * i] as number),
        (xy[2 * i + 1] as number) - (before[2 * i + 1] as number),
      )
    assert.ok(moved(during, 1) > 60, `a neighbour follows: ${moved(during, 1).toFixed(1)}`)
    assert.ok(moved(during, 1) > 2 * moved(during, 60), 'a neighbour moves more than a page far away')
    assert.ok(!l.done(), 'still warm while held')
    // Let go: it is not pinned, and the whole picture comes to rest again.
    l.release()
    assert.equal(l.held(), -1)
    const steps = rest(l)
    assert.ok(l.done(), `rests again after ${steps} steps`)
    assert.ok(steps < LAYOUT.settleTicks + 50, `${steps} steps to rest`)
    const after = l.positions()
    assert.ok(dist(after, 0, 1) < LAYOUT.linkDistance * 3, 'the page let go goes back near its neighbours')
  })

  it('pages without links sit evenly on a ring outside every linked page', () => {
    const n = 150
    const linked = 120
    const role = new Uint8Array(n)
    for (let i = linked; i < n; i++) role[i] = ROLE.orphan
    const l = createLayout({ n, edges: sample(linked), seed: 13, role })
    rest(l)
    const xy = l.positions()
    // The middle and the reach of the linked pages.
    let x0 = Infinity
    let x1 = -Infinity
    let y0 = Infinity
    let y1 = -Infinity
    for (let i = 0; i < linked; i++) {
      x0 = Math.min(x0, xy[2 * i] as number)
      x1 = Math.max(x1, xy[2 * i] as number)
      y0 = Math.min(y0, xy[2 * i + 1] as number)
      y1 = Math.max(y1, xy[2 * i + 1] as number)
    }
    const cx = (x0 + x1) / 2
    const cy = (y0 + y1) / 2
    let reach = 0
    for (let i = 0; i < linked; i++)
      reach = Math.max(reach, Math.hypot((xy[2 * i] as number) - cx, (xy[2 * i + 1] as number) - cy))
    const radii: number[] = []
    for (let i = linked; i < n; i++)
      radii.push(Math.hypot((xy[2 * i] as number) - cx, (xy[2 * i + 1] as number) - cy))
    for (const r of radii) {
      assert.ok(r > reach, `on the ring (${r.toFixed(1)}) outside the linked pages (${reach.toFixed(1)})`)
      assert.ok(Math.abs(r - (radii[0] as number)) < 1, 'all on one ring')
    }
    assert.ok((radii[0] as number) < reach + 2 * LAYOUT.ringGap, 'just beyond the linked pages')
    // Evenly spaced: each next to the next at the same distance.
    const gaps: number[] = []
    for (let i = linked; i < n; i++) gaps.push(dist(xy, i, i + 1 < n ? i + 1 : linked))
    for (const g of gaps)
      assert.ok(Math.abs(g - (gaps[0] as number)) < 1, `even spacing: ${gaps.map((x) => x.toFixed(1))}`)
  })

  it('a page on the ring held by the pointer follows it, and goes back to its place once let go', () => {
    const role = new Uint8Array(50)
    for (let i = 40; i < 50; i++) role[i] = ROLE.orphan
    const l = createLayout({ n: 50, edges: sample(40), seed: 4, role })
    rest(l)
    const place = at(l.positions(), 45)
    l.hold(45, 0, 0)
    for (let k = 0; k < 10; k++) l.tick()
    assert.deepEqual(at(l.positions(), 45), [0, 0])
    l.release()
    rest(l)
    const back = at(l.positions(), 45)
    assert.ok(
      Math.hypot(back[0] - place[0], back[1] - place[1]) < 30,
      `back near its place: ${back} vs ${place}`,
    )
  })

  it('puts groups around an opened group on a rim outside the ring, toward the pages they link with', () => {
    // 0–3 linked in a square around the middle; 4–6 without links; 7 a group linked to 1 (on the right).
    const x = [-10, 10, 10, -10, 0, 0, 0, 0]
    const y = [-10, -10, 10, 10, 0, 0, 0, 0]
    const role = new Uint8Array([0, 0, 0, 0, ROLE.orphan, ROLE.orphan, ROLE.orphan, ROLE.rim])
    const edges = new Uint32Array([0, 1, 1, 2, 2, 3, 1, 7])
    const out = ringPlaces(x, y, role, edges)
    const r = (i: number) => Math.hypot(out[2 * i] as number, out[2 * i + 1] as number)
    for (const i of [4, 5, 6]) assert.ok(r(i) > Math.hypot(10, 10), `orphan ${i} outside the linked pages`)
    assert.ok(r(7) > r(4), 'the rim outside the ring')
    assert.ok((out[14] as number) > 0, 'on the side of the page it links with')
    // The free pages do not move.
    assert.deepEqual(Array.from(out.slice(0, 8)), [-10, -10, 10, -10, 10, 10, -10, 10])
  })

  it('many groups on the rim, all pointing the same way, are spread evenly and never overlap', () => {
    const n = 2 + 12
    const x = new Array<number>(n).fill(0)
    x[0] = -5
    x[1] = 5
    const y = new Array<number>(n).fill(0)
    const role = new Uint8Array(n).fill(ROLE.rim)
    role[0] = ROLE.free
    role[1] = ROLE.free
    const edges = new Uint32Array([0, 1, ...Array.from({ length: 12 }, (_, k) => [1, 2 + k]).flat()])
    const out = ringPlaces(x, y, role, edges)
    const xy = Float32Array.from(out)
    let closest = Number.POSITIVE_INFINITY
    for (let a = 2; a < n; a++) for (let b = a + 1; b < n; b++) closest = Math.min(closest, dist(xy, a, b))
    assert.ok(closest >= 60, `closest ${closest.toFixed(1)}`)
  })

  it('runs in slices of a few milliseconds, so the worker can paint between them', () => {
    const l = createLayout({ n: 2000, edges: sample(2000), seed: 9 })
    let calls = 0
    while (!l.done() && calls < 5) {
      const t = performance.now()
      l.run(8, 5)
      calls += 1
      // One step past the budget at most (a step of 2 000 pages is a few ms).
      assert.ok(performance.now() - t < 120, `slice took ${performance.now() - t} ms`)
    }
    assert.ok(l.ticks() <= 25, 'at most the steps asked for')
  })

  for (const n of [300, 2000, 5000]) {
    it(`${n} pages settle in bounded CPU time (load test, T030)`, () => {
      const edges = sample(n)
      let steps = 0
      const ms = cpuMs(() => {
        const l = createLayout({ n, edges, seed: 48291 })
        steps = rest(l)
      })
      // Reported for the record (plan T030); the bound has a wide margin for slow CI machines.
      process.stdout.write(
        `# layout ${n} pages: ${steps} steps, ${ms.toFixed(0)} ms CPU, ${(ms / steps).toFixed(2)} ms a step\n`,
      )
      assert.ok(ms / steps < (n <= 300 ? 10 : n <= 2000 ? 60 : 150), `${(ms / steps).toFixed(1)} ms a step`)
    })
  }
})
