// Plan §3.4 (T030, T032): the layout of the graph, worked out in a Web Worker. Pure code, tested here: the same
// data and seed always give the same picture, it settles in a bounded number of steps, linked pages end up
// nearer than unlinked ones, no two pages sit on each other, and it is quick enough for 2 000 pages (the
// most one view draws) to settle without the page noticing. The CPU times are bounds with a wide margin.
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { arrange, createLayout, LAYOUT, ROLE } from '../../web/src/graph/layout.ts'
import { PAGE_TYPES } from '../../web/src/lib/wiki.ts'
import { generate } from '../../web/test/data/generate.ts'

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

  it('many groups on the rim, all pointing the same way, are spread evenly and never overlap', () => {
    // A small cluster and 12 groups, every one linked to page 1: they would all pile up on its side.
    const n = 2 + 12
    const xy = new Float32Array(2 * n)
    xy.set([-5, 0, 5, 0])
    const role = new Uint8Array(n).fill(ROLE.rim)
    role[0] = ROLE.free
    role[1] = ROLE.free
    const edges = new Uint32Array([0, 1, ...Array.from({ length: 12 }, (_, k) => [1, 2 + k]).flat()])
    arrange(xy, role, edges)
    let closest = Number.POSITIVE_INFINITY
    for (let a = 2; a < n; a++)
      for (let b = a + 1; b < n; b++)
        closest = Math.min(
          closest,
          Math.hypot(
            (xy[2 * a] as number) - (xy[2 * b] as number),
            (xy[2 * a + 1] as number) - (xy[2 * b + 1] as number),
          ),
        )
    // At least 60 apart: room for a box and its name at the zoom that fits them.
    assert.ok(closest >= 60, `closest ${closest.toFixed(1)}`)
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

// Spec amendment 2026-11-09, CA12 (plan canvas-ui SB4): the same forces in three dimensions. Each page gets x,
// y and z; the families gather in clusters around the middle, where the brain's hub sits; the picture is the
// same for the same data and seed, and the 2D layout above is unchanged.
describe('the layout of the graph in three dimensions', () => {
  const dist3 = (p: Float32Array, a: number, b: number) =>
    Math.hypot(
      (p[3 * a] as number) - (p[3 * b] as number),
      (p[3 * a + 1] as number) - (p[3 * b + 1] as number),
      (p[3 * a + 2] as number) - (p[3 * b + 2] as number),
    )

  it('gives every page x, y and z, the same for the same data and seed', () => {
    const run = () => {
      const l = createLayout({ n: 120, edges: sample(120), seed: 7, dims: 3 })
      l.run(10_000)
      return l.positions3()
    }
    const a = run()
    assert.equal(a.length, 360)
    assert.deepEqual(a, run())
    // Depth is used: the pages spread along z about as much as along x.
    let zs = 0
    let xs = 0
    for (let i = 0; i < 120; i++) {
      zs += Math.abs(a[3 * i + 2] as number)
      xs += Math.abs(a[3 * i] as number)
    }
    assert.ok(zs > 0.3 * xs, `z spread ${zs.toFixed(0)} against x spread ${xs.toFixed(0)}`)
  })

  it('linked pages end up nearer than unlinked ones, and none sit on each other', () => {
    const edges = sample(200)
    const l = createLayout({ n: 200, edges, seed: 3, dims: 3 })
    l.run(10_000)
    const p = l.positions3()
    let linked = 0
    for (let e = 0; e < edges.length; e += 2) linked += dist3(p, edges[e] as number, edges[e + 1] as number)
    linked /= edges.length / 2
    let all = 0
    let pairs = 0
    let closest = Number.POSITIVE_INFINITY
    for (let i = 0; i < 200; i++)
      for (let j = i + 1; j < 200; j++) {
        const d = dist3(p, i, j)
        all += d
        pairs += 1
        closest = Math.min(closest, d)
      }
    assert.ok(linked < 0.6 * (all / pairs), `linked ${linked.toFixed(1)} against ${(all / pairs).toFixed(1)}`)
    assert.ok(closest > 0.5, `closest pair ${closest}`)
  })

  it('pages of a family gather in a cluster of their own around the middle', () => {
    // Seven families of 30 pages, linked at random across families: the pull of a family still wins.
    const n = 210
    const family = Int32Array.from({ length: n }, (_, i) => i % 7)
    const pairs: number[] = []
    for (let i = 0; i < n; i++) pairs.push(i, (i * 37 + 11) % n)
    const l = createLayout({ n, edges: new Uint32Array(pairs), seed: 5, dims: 3, family })
    l.run(10_000)
    const p = l.positions3()
    let inside = 0
    let across = 0
    let ni = 0
    let na = 0
    for (let i = 0; i < n; i++)
      for (let j = i + 1; j < n; j++) {
        const d = dist3(p, i, j)
        if (family[i] === family[j]) {
          inside += d
          ni += 1
        } else {
          across += d
          na += 1
        }
      }
    assert.ok(inside / ni < 0.75 * (across / na), `inside ${inside / ni} against across ${across / na}`)
    // The middle of the whole cloud is near the origin, where the hub is drawn.
    let cx = 0
    let cy = 0
    let cz = 0
    let r = 0
    for (let i = 0; i < n; i++) {
      cx += p[3 * i] as number
      cy += p[3 * i + 1] as number
      cz += p[3 * i + 2] as number
      r = Math.max(r, Math.hypot(p[3 * i] as number, p[3 * i + 1] as number, p[3 * i + 2] as number))
    }
    assert.ok(Math.hypot(cx / n, cy / n, cz / n) < 0.15 * r)
  })

  it('positions() still gives x and y, the projection-free view of the same layout', () => {
    const l = createLayout({ n: 40, edges: sample(40), seed: 9, dims: 3 })
    l.run(10_000)
    const p3 = l.positions3()
    const p2 = l.positions()
    for (let i = 0; i < 40; i++) {
      assert.equal(p2[2 * i], p3[3 * i])
      assert.equal(p2[2 * i + 1], p3[3 * i + 1])
    }
  })

  it('in two dimensions every z is 0', () => {
    const l = createLayout({ n: 40, edges: sample(40), seed: 9 })
    l.run(10_000)
    const p3 = l.positions3()
    for (let i = 0; i < 40; i++) assert.equal(p3[3 * i + 2], 0)
  })

  for (const n of [300, 2000])
    it(`${n} pages settle in three dimensions in bounded CPU time`, () => {
      const l = createLayout({
        n,
        edges: sample(n),
        seed: 1,
        dims: 3,
        family: Int32Array.from({ length: n }, (_, i) => i % 7),
      })
      const ms = cpuMs(() => l.run(60_000))
      assert.ok(l.done())
      assert.ok(ms < (n === 300 ? 1500 : 12_000), `${ms.toFixed(0)} ms`)
    })
})

// Polish (plan canvas-ui SB4): each family is a blob of its own around the hub, as in the reference: the
// middle of every family lies farther from the middle of any other than twice either family's spread. Checked on
// the seeded wiki of 300 pages the browser tests draw, where four links in five cross families and folders cut
// across them.
describe('the families as separate clouds', () => {
  it('each family’s middle is farther from the others than twice its spread (seeded wiki)', () => {
    const g = generate({ pages: 300, seed: 48291 })
    const pages = g.pages.filter((p) => p.status !== 'retired')
    const index = new Map(pages.map((p, i) => [p.address, i]))
    const seen = new Set<string>()
    const raw: number[] = []
    for (const [from, to] of g.links) {
      const a = index.get(from)
      const b = index.get(to)
      if (a === undefined || b === undefined || a === b) continue
      const key = a < b ? `${a}-${b}` : `${b}-${a}`
      if (seen.has(key)) continue
      seen.add(key)
      raw.push(a, b)
    }
    // Only linked pages feel the forces (as in the worker).
    const linked = [...new Set(raw)].sort((a, b) => a - b)
    const local = new Map(linked.map((p, k) => [p, k]))
    const edges = Uint32Array.from(raw, (p) => local.get(p) as number)
    const n = linked.length
    const family = Int32Array.from(linked, (p) => Math.max(0, PAGE_TYPES.indexOf(pages[p]?.type as never)))
    const folders = [...new Set(pages.map((p) => p.address.split('/')[0]))]
    const area = Int32Array.from(linked, (p) => folders.indexOf(pages[p]?.address.split('/')[0]))
    const l = createLayout({ n, edges, seed: 48291, dims: 3, family, area })
    l.run(60_000)
    const pos = l.positions3()
    const fams = PAGE_TYPES.length
    const mid = Array.from({ length: fams }, () => [0, 0, 0, 0])
    for (let k = 0; k < n; k++) {
      const m = mid[family[k] as number] as number[]
      for (const a of [0, 1, 2]) m[a] = (m[a] as number) + (pos[3 * k + a] as number)
      m[3] = (m[3] as number) + 1
    }
    for (const m of mid) if (m[3]) for (const a of [0, 1, 2]) m[a] = (m[a] as number) / (m[3] as number)
    const spread = new Array<number>(fams).fill(0)
    for (let k = 0; k < n; k++) {
      const f = family[k] as number
      const m = mid[f] as number[]
      spread[f] =
        (spread[f] as number) +
        ((pos[3 * k] as number) - (m[0] as number)) ** 2 +
        ((pos[3 * k + 1] as number) - (m[1] as number)) ** 2 +
        ((pos[3 * k + 2] as number) - (m[2] as number)) ** 2
    }
    for (let f = 0; f < fams; f++)
      spread[f] = Math.sqrt((spread[f] as number) / Math.max(1, (mid[f] as number[])[3] as number))
    let crossing = 0
    for (let e = 0; e < edges.length; e += 2)
      if (family[edges[e] as number] !== family[edges[e + 1] as number]) crossing += 1
    assert.ok(crossing > 0.5 * (edges.length / 2), 'most links cross families in this wiki')
    for (let f = 0; f < fams; f++)
      for (let h = f + 1; h < fams; h++) {
        const a = mid[f] as number[]
        const b = mid[h] as number[]
        if (!a[3] || !b[3]) continue
        const d = Math.hypot(
          (a[0] as number) - (b[0] as number),
          (a[1] as number) - (b[1] as number),
          (a[2] as number) - (b[2] as number),
        )
        const most = Math.max(spread[f] as number, spread[h] as number)
        assert.ok(
          d > 2 * most,
          `${PAGE_TYPES[f]} and ${PAGE_TYPES[h]}: ${d.toFixed(0)} apart, spread ${most.toFixed(0)}`,
        )
      }
  })
})
