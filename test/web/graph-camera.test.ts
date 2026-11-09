// Spec amendment 2026-11-09, CA12 (plan canvas-ui SB4, SB5): the graph is a cloud of points in three
// dimensions, turned about the vertical axis through its middle (yaw), tilted (pitch, within limits), and seen in
// perspective: near points come out bigger, far ones smaller. Pure math, no DOM.
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  CAMERA,
  clampPitch,
  frameOf,
  parkRows,
  project,
  projectPoint,
  ROW_GAP,
  spinBox,
  yawText,
} from '../../web/src/graph/camera.ts'

const near = (a: number, b: number, eps = 1e-3) => Math.abs(a - b) < eps

// Six points on the axes, radius 100, around (10, 20, 30).
const C = [10, 20, 30]
const AXES = new Float32Array(
  [
    [100, 0, 0],
    [-100, 0, 0],
    [0, 100, 0],
    [0, -100, 0],
    [0, 0, 100],
    [0, 0, -100],
  ].flatMap(([x, y, z]) => [(x as number) + 10, (y as number) + 20, (z as number) + 30]),
)
const ALL = new Uint8Array(6).fill(1)

describe('the graph camera', () => {
  it('finds the middle of the cloud and how far it reaches', () => {
    const f = frameOf(AXES, ALL)
    assert.deepEqual([f.cx, f.cy, f.cz], C)
    assert.ok(near(f.r, 100))
    // Only what the mask keeps counts.
    const g = frameOf(AXES, new Uint8Array([1, 1, 0, 0, 0, 0]))
    assert.deepEqual([g.cx, g.cy, g.cz], C)
  })

  it('at yaw and pitch 0 a point in the plane of the middle stays where it is', () => {
    const f = frameOf(AXES, ALL)
    const [x, y, s] = projectPoint(110, 20, 30, f, { yaw: 0, pitch: 0 })
    assert.ok(near(x, 110) && near(y, 20) && near(s, 1))
  })

  it('a near point comes out bigger than a far one, and both lean toward the middle', () => {
    const f = frameOf(AXES, ALL)
    const xy = new Float32Array(12)
    const depth = new Float32Array(6)
    project(AXES, f, { yaw: 0, pitch: 0 }, xy, depth)
    // z −100 is toward the viewer, z +100 away.
    assert.ok((depth[5] as number) > 1 && (depth[4] as number) < 1)
    // The +x point stays on the x axis through the middle.
    assert.ok(near(xy[0] as number, 110) && near(xy[1] as number, 20))
  })

  it('a quarter turn brings the +x point to the middle line, nearest the viewer; a full turn brings it back', () => {
    const f = frameOf(AXES, ALL)
    const [x, , s] = projectPoint(110, 20, 30, f, { yaw: Math.PI / 2, pitch: 0 })
    assert.ok(near(x, 10), `x ${x}`)
    assert.ok(s > 1, 'it came toward the viewer')
    const [x2, y2, s2] = projectPoint(110, 20, 30, f, { yaw: 2 * Math.PI, pitch: 0 })
    assert.ok(near(x2, 110) && near(y2, 20) && near(s2, 1))
  })

  it('pitch tilts the cloud: the top comes toward or goes away from the viewer', () => {
    const f = frameOf(AXES, ALL)
    // The top of the cloud (y −80 from the middle: up on the screen).
    const toward = projectPoint(10, -60, 30, f, { yaw: 0, pitch: 0.5 })
    const away = projectPoint(10, -60, 30, f, { yaw: 0, pitch: -0.5 })
    const flat = projectPoint(10, -60, 30, f, { yaw: 0, pitch: 0 })
    assert.ok(toward[2] > 1 && away[2] < 1 && near(flat[2], 1))
    // The default looks from a little above: the top leans away, so it is drawn smaller.
    assert.ok(CAMERA.pitch0 < 0)
  })

  it('pitch stays within its limits', () => {
    assert.equal(clampPitch(5), CAMERA.pitchMax)
    assert.equal(clampPitch(-5), CAMERA.pitchMin)
    assert.equal(clampPitch(0.1), 0.1)
  })

  it('the box the spin is fitted to holds every point at every yaw', () => {
    const f = frameOf(AXES, ALL)
    const box = spinBox(AXES, ALL, f, CAMERA.pitch0)
    const xs = [box[0], box[2], box[4], box[6]] as number[]
    const ys = [box[1], box[3], box[5], box[7]] as number[]
    const xy = new Float32Array(12)
    const depth = new Float32Array(6)
    for (let k = 0; k < 72; k++) {
      project(AXES, f, { yaw: (k * Math.PI) / 36, pitch: CAMERA.pitch0 }, xy, depth)
      for (let i = 0; i < 6; i++) {
        assert.ok(
          (xy[2 * i] as number) >= Math.min(...xs) - 1e-3 && (xy[2 * i] as number) <= Math.max(...xs) + 1e-3,
        )
        assert.ok(
          (xy[2 * i + 1] as number) >= Math.min(...ys) - 1e-3 &&
            (xy[2 * i + 1] as number) <= Math.max(...ys) + 1e-3,
        )
      }
    }
  })

  it('says the yaw in degrees, from 0 to 360, to one decimal', () => {
    assert.equal(yawText(0), 'yaw 0.0°')
    assert.equal(yawText((124.3 * Math.PI) / 180), 'yaw 124.3°')
    assert.equal(yawText(-Math.PI / 2), 'yaw 270.0°')
    assert.equal(yawText(4 * Math.PI + 0.1), 'yaw 5.7°')
  })

  it('one turn takes between 40 and 60 seconds', () => {
    assert.ok(CAMERA.turnMs >= 40_000 && CAMERA.turnMs <= 60_000)
  })
})

describe('the box the spin is fitted to, keeping most points', () => {
  it('keeping 90% of the points is no bigger than keeping all, and smaller when a few lie far out', () => {
    // 100 points near the middle, 3 far out.
    const pts: number[] = []
    for (let i = 0; i < 100; i++) pts.push(Math.cos(i) * 50, Math.sin(i * 1.3) * 30, Math.sin(i) * 50)
    pts.push(900, 0, 0, -900, 0, 0, 0, 0, 900)
    const xyz = new Float32Array(pts)
    const mask = new Uint8Array(103).fill(1)
    const f = frameOf(xyz, mask)
    const all = spinBox(xyz, mask, f, CAMERA.pitch0)
    const most = spinBox(xyz, mask, f, CAMERA.pitch0, 0.9)
    const width = (b: Float32Array) => (b[2] as number) - (b[0] as number)
    const height = (b: Float32Array) => (b[5] as number) - (b[1] as number)
    assert.ok(width(most) < 0.5 * width(all), `${width(most)} against ${width(all)}`)
    assert.ok(height(most) <= height(all) + 1e-6)
  })

  // Visual review (2026-11-09): the turning box is as tight as the turn allows. What it holds at each yaw (the
  // share `keep` on each side) stays inside it, and on each side some yaw comes close to its edge: the cloud is
  // fitted to what it really covers, not to a bound no yaw reaches.
  it('the turning box with a share kept is tight: some yaw comes near each of its edges', () => {
    let seed = 7
    const rnd = () => {
      seed = (seed * 16807) % 2147483647
      return seed / 2147483647 - 0.5
    }
    const n = 400
    const xyz = new Float32Array(3 * n)
    for (let k = 0; k < 3 * n; k++) xyz[k] = rnd() * 200
    const mask = new Uint8Array(n).fill(1)
    const f = frameOf(xyz, mask)
    const keep = 0.95
    const box = spinBox(xyz, mask, f, CAMERA.pitch0, keep)
    const [bx0, by0, bx1, , , by1] = box as unknown as number[]
    const w = (bx1 as number) - (bx0 as number)
    const h = (by1 as number) - (by0 as number)
    const xy = new Float32Array(2 * n)
    const depth = new Float32Array(n)
    const reach = { x0: Number.POSITIVE_INFINITY, y0: Number.POSITIVE_INFINITY, x1: -1e9, y1: -1e9 }
    const cut = Math.floor((1 - keep) * n)
    for (let k = 0; k < 90; k++) {
      project(xyz, f, { yaw: (k * Math.PI) / 45 + 0.013, pitch: CAMERA.pitch0 }, xy, depth)
      const xs = Array.from({ length: n }, (_, i) => xy[2 * i] as number).sort((a, b) => a - b)
      const ys = Array.from({ length: n }, (_, i) => xy[2 * i + 1] as number).sort((a, b) => a - b)
      const [x0, x1, y0, y1] = [xs[cut], xs[n - 1 - cut], ys[cut], ys[n - 1 - cut]] as number[]
      assert.ok((x0 as number) >= (bx0 as number) - 0.02 * w && (x1 as number) <= (bx1 as number) + 0.02 * w)
      assert.ok((y0 as number) >= (by0 as number) - 0.02 * h && (y1 as number) <= (by1 as number) + 0.02 * h)
      reach.x0 = Math.min(reach.x0, x0 as number)
      reach.x1 = Math.max(reach.x1, x1 as number)
      reach.y0 = Math.min(reach.y0, y0 as number)
      reach.y1 = Math.max(reach.y1, y1 as number)
    }
    assert.ok(reach.x0 <= (bx0 as number) + 0.04 * w, `left: ${reach.x0} vs ${bx0}`)
    assert.ok(reach.x1 >= (bx1 as number) - 0.04 * w, `right: ${reach.x1} vs ${bx1}`)
    assert.ok(reach.y0 <= (by0 as number) + 0.04 * h, `top: ${reach.y0} vs ${by0}`)
    assert.ok(reach.y1 >= (by1 as number) - 0.04 * h, `bottom: ${reach.y1} vs ${by1}`)
  })
})

// Review R6: the pages without links do not belong to the cloud. They stay out of its frame (they would pull
// its middle off the hub) and lie flat in rows under it, the same at any yaw: they never sweep across it.
describe('the pages without links', () => {
  it('are left out of the frame and parked in rows under the cloud, whatever the yaw', () => {
    // 0–5 the cloud (AXES around C); 6–8 without links, far off at depth 0.
    const xyz = new Float32Array([...AXES, 900, 900, 0, 950, 900, 0, 1000, 900, 0])
    const role = new Uint8Array([0, 0, 0, 0, 0, 0, 1, 1, 1])
    const mask = new Uint8Array(9).fill(1)
    const f = frameOf(xyz, mask, role)
    assert.ok(near(f.cx, 10) && near(f.cy, 20) && near(f.cz, 30), `middle of the cloud: ${JSON.stringify(f)}`)
    assert.ok(near(f.r, 100))
    // Under what the cloud covers at any yaw (its turning box), close to it.
    const box = spinBox(xyz, new Uint8Array([1, 1, 1, 1, 1, 1, 0, 0, 0]), f, -0.2)
    const rows = (yaw: number) => {
      const xy = new Float32Array(18)
      project(xyz, f, { yaw, pitch: -0.2 }, xy, new Float32Array(9))
      parkRows(xy, role, mask, box)
      return [...xy.slice(12)]
    }
    const a = rows(0)
    assert.deepEqual(rows(1.3), a, 'the same at any yaw')
    const bottom = box[5] as number
    for (let k = 0; k < 3; k++) {
      const x = a[2 * k] as number
      const y = a[2 * k + 1] as number
      assert.ok(y > bottom && y < bottom + 3 * ROW_GAP, `just under the cloud: ${y} (bottom ${bottom})`)
      assert.ok(x >= (box[0] as number) && x <= (box[2] as number), `as wide as the cloud: ${x}`)
    }
    assert.equal(a[1], a[3], 'in a row')
    assert.notEqual(a[0], a[2])
  })
})
