// The graph's camera (spec amendment 2026-11-09, CA12; plan canvas-ui SB4, SB5). The layout gives each page
// x, y and z; the camera turns the cloud about the vertical axis through its middle (yaw), tilts it (pitch,
// within limits), and draws it in perspective: a near point comes out bigger and a far one smaller. What comes
// out is a flat x, y in the layout's own units around the same middle, so Fit, the pointer, the arrow keys and
// the cards work on it as on any flat picture. Pure math; no DOM, no 3D library.

export const CAMERA = {
  // Where the picture starts, and where it stays with reduced motion.
  yaw0: 0.6,
  // A little from above.
  pitch0: -0.22,
  pitchMin: -0.9,
  pitchMax: 0.9,
  // One whole turn, in ms.
  turnMs: 50_000,
  // How far the eye is from the middle, in radii of the cloud: nearer is a stronger perspective.
  distance: 2.6,
  // How long the picture rests after the person's last touch before it turns again.
  restMs: 5_000,
}

export type Camera = { yaw: number; pitch: number }
// The middle of the cloud and how far it reaches from there.
export type Frame = { cx: number; cy: number; cz: number; r: number }

export const clampPitch = (p: number) => Math.min(CAMERA.pitchMax, Math.max(CAMERA.pitchMin, p))

// The middle of the points the mask keeps (the middle of their extent), and the farthest of them from it.
// With `role`, the pages without links (role 1) are left out: they are parked under the cloud, not in it, and
// would pull its middle off the hub (review R6). When nothing else is kept, they are the frame.
export function frameOf(xyz: Float32Array, given: Uint8Array, role?: Uint8Array): Frame {
  let mask = given
  if (role) {
    const cloud = given.slice()
    let left = 0
    for (let i = 0; i < cloud.length; i++) {
      if (role[i] === 1) cloud[i] = 0
      left += cloud[i] as number
    }
    if (left > 0) mask = cloud
  }
  let x0 = Number.POSITIVE_INFINITY
  let y0 = Number.POSITIVE_INFINITY
  let z0 = Number.POSITIVE_INFINITY
  let x1 = Number.NEGATIVE_INFINITY
  let y1 = Number.NEGATIVE_INFINITY
  let z1 = Number.NEGATIVE_INFINITY
  const n = mask.length
  for (let i = 0; i < n; i++) {
    if (!mask[i]) continue
    const x = xyz[3 * i] as number
    const y = xyz[3 * i + 1] as number
    const z = xyz[3 * i + 2] as number
    if (x < x0) x0 = x
    if (x > x1) x1 = x
    if (y < y0) y0 = y
    if (y > y1) y1 = y
    if (z < z0) z0 = z
    if (z > z1) z1 = z
  }
  if (!Number.isFinite(x0)) return { cx: 0, cy: 0, cz: 0, r: 1 }
  const cx = (x0 + x1) / 2
  const cy = (y0 + y1) / 2
  const cz = (z0 + z1) / 2
  let r = 0
  for (let i = 0; i < n; i++)
    if (mask[i])
      r = Math.max(
        r,
        Math.hypot(
          (xyz[3 * i] as number) - cx,
          (xyz[3 * i + 1] as number) - cy,
          (xyz[3 * i + 2] as number) - cz,
        ),
      )
  return { cx, cy, cz, r: Math.max(r, 1) }
}

// The pages without links (role 1) that the mask keeps, in rows just under what the cloud covers at any yaw
// (`box`, from spinBox) and as wide as it, flat on the picture: the same at any yaw, so they never sweep
// across the cloud as it turns (review R6).
export const ROW_GAP = 24
export function parkRows(xy: Float32Array, role: Uint8Array, mask: Uint8Array, box: Float32Array): void {
  const x0 = box[0] as number
  const width = Math.max(0, (box[2] as number) - x0)
  const perRow = Math.max(1, Math.floor(width / ROW_GAP) + 1)
  const top = (box[5] as number) + 1.5 * ROW_GAP
  let k = 0
  for (let i = 0; i < role.length; i++) {
    if (role[i] !== 1 || !mask[i]) continue
    xy[2 * i] = x0 + (k % perRow) * ROW_GAP
    xy[2 * i + 1] = top + Math.floor(k / perRow) * ROW_GAP
    k += 1
  }
}

// One point: its place on the flat picture and its perspective scale (1 in the plane of the middle, more when
// nearer). Yaw turns +x toward the viewer (−z); pitch turns the top (−y) toward the viewer.
export function projectPoint(
  x: number,
  y: number,
  z: number,
  f: Frame,
  cam: Camera,
): [number, number, number] {
  const dx = x - f.cx
  const dy = y - f.cy
  const dz = z - f.cz
  const cy = Math.cos(cam.yaw)
  const sy = Math.sin(cam.yaw)
  const cp = Math.cos(cam.pitch)
  const sp = Math.sin(cam.pitch)
  const x1 = dx * cy + dz * sy
  const z1 = -dx * sy + dz * cy
  const y2 = dy * cp - z1 * sp
  const z2 = dy * sp + z1 * cp
  const d = CAMERA.distance * f.r
  const s = d / Math.max(d * 0.2, d + z2)
  return [f.cx + x1 * s, f.cy + y2 * s, s]
}

// Every point: `xy` gets [x0, y0, x1, y1, …] and `depth` each point's scale.
export function project(
  xyz: Float32Array,
  f: Frame,
  cam: Camera,
  xy: Float32Array,
  depth: Float32Array,
): void {
  const n = depth.length
  const cy = Math.cos(cam.yaw)
  const sy = Math.sin(cam.yaw)
  const cp = Math.cos(cam.pitch)
  const sp = Math.sin(cam.pitch)
  const d = CAMERA.distance * f.r
  for (let i = 0; i < n; i++) {
    const dx = (xyz[3 * i] as number) - f.cx
    const dy = (xyz[3 * i + 1] as number) - f.cy
    const dz = (xyz[3 * i + 2] as number) - f.cz
    const x1 = dx * cy + dz * sy
    const z1 = -dx * sy + dz * cy
    const y2 = dy * cp - z1 * sp
    const z2 = dy * sp + z1 * cp
    const s = d / Math.max(d * 0.2, d + z2)
    xy[2 * i] = f.cx + x1 * s
    xy[2 * i + 1] = f.cy + y2 * s
    depth[i] = s
  }
}

// What the turning picture is fitted to: a box (four corners, [x, y, …]) that holds the points the mask keeps
// at any yaw, at this pitch. Fitting the picture of the moment would make it breathe as it turns. `keep` below 1
// lets that share of the farthest points leave the frame on each side, so a few far ones never shrink the rest.
export function spinBox(
  xyz: Float32Array,
  mask: Uint8Array,
  f: Frame,
  pitch: number,
  keep = 1,
): Float32Array {
  if (keep < 1) return sampledBox(xyz, mask, f, pitch, keep)
  // About the vertical axis a point keeps its height and its distance to the axis (ρ); the yaw only moves it
  // around that circle. Bound its screen x and y over the whole circle.
  const cp = Math.cos(pitch)
  const sp = Math.sin(pitch)
  const d = CAMERA.distance * f.r
  const left: number[] = []
  const right: number[] = []
  const top: number[] = []
  const bottom: number[] = []
  for (let i = 0; i < mask.length; i++) {
    if (!mask[i]) continue
    const dx = (xyz[3 * i] as number) - f.cx
    const dy = (xyz[3 * i + 1] as number) - f.cy
    const dz = (xyz[3 * i + 2] as number) - f.cz
    const rho = Math.hypot(dx, dz)
    // The nearest the point comes (z1 = −ρ) gives the biggest scale; it bounds x and y at every yaw.
    const zNear = dy * sp - rho * Math.abs(cp)
    const s = d / Math.max(d * 0.2, d + zNear)
    const yTop = dy * cp - rho * Math.abs(sp)
    const yBottom = dy * cp + rho * Math.abs(sp)
    left.push(f.cx - rho * s)
    right.push(f.cx + rho * s)
    top.push(f.cy + Math.min(yTop * s, yTop))
    bottom.push(f.cy + Math.max(yBottom * s, yBottom))
  }
  if (!left.length) return new Float32Array([f.cx, f.cy, f.cx, f.cy, f.cx, f.cy, f.cx, f.cy])
  const m = left.length
  const cut = Math.min(m - 1, Math.floor((1 - Math.min(1, keep)) * m))
  const low = (xs: number[]) => xs.sort((a, b) => a - b)[cut] as number
  const high = (xs: number[]) => xs.sort((a, b) => b - a)[cut] as number
  const x0 = Math.min(f.cx, low(left))
  const x1 = Math.max(f.cx, high(right))
  const y0 = Math.min(f.cy, low(top))
  const y1 = Math.max(f.cy, high(bottom))
  return new Float32Array([x0, y0, x1, y0, x1, y1, x0, y1])
}

// With a share kept: the cloud projected at many yaws, at each the share `keep` on each side, and the box
// that holds them all. Tight: each edge is reached at some yaw (the bound above puts each point at its nearest
// and widest at once, which no yaw does). Steps of 7.5°: between two the extents move by under a percent.
const SAMPLED_YAWS = 48
function sampledBox(
  xyz: Float32Array,
  mask: Uint8Array,
  f: Frame,
  pitch: number,
  keep: number,
): Float32Array {
  const kept: number[] = []
  for (let i = 0; i < mask.length; i++) if (mask[i]) kept.push(i)
  const m = kept.length
  if (!m) return new Float32Array([f.cx, f.cy, f.cx, f.cy, f.cx, f.cy, f.cx, f.cy])
  const sub = new Float32Array(3 * m)
  kept.forEach((i, k) => {
    sub[3 * k] = xyz[3 * i] as number
    sub[3 * k + 1] = xyz[3 * i + 1] as number
    sub[3 * k + 2] = xyz[3 * i + 2] as number
  })
  const xy = new Float32Array(2 * m)
  const depth = new Float32Array(m)
  const xs = new Float32Array(m)
  const ys = new Float32Array(m)
  const cut = Math.min(m - 1, Math.floor((1 - Math.min(1, keep)) * m))
  let x0 = f.cx
  let x1 = f.cx
  let y0 = f.cy
  let y1 = f.cy
  for (let k = 0; k < SAMPLED_YAWS; k++) {
    project(sub, f, { yaw: (k * 2 * Math.PI) / SAMPLED_YAWS, pitch }, xy, depth)
    for (let q = 0; q < m; q++) {
      xs[q] = xy[2 * q] as number
      ys[q] = xy[2 * q + 1] as number
    }
    xs.sort()
    ys.sort()
    x0 = Math.min(x0, xs[cut] as number)
    x1 = Math.max(x1, xs[m - 1 - cut] as number)
    y0 = Math.min(y0, ys[cut] as number)
    y1 = Math.max(y1, ys[m - 1 - cut] as number)
  }
  return new Float32Array([x0, y0, x1, y0, x1, y1, x0, y1])
}

// «yaw 124.3°»: the turn, in degrees from 0 to 360.
export function yawText(yaw: number): string {
  const deg = ((((yaw * 180) / Math.PI) % 360) + 360) % 360
  return `yaw ${deg.toFixed(1)}°`
}
