// The graph's families (spec amendment 2026-11-09, CA12; plan canvas-ui SB3). A page's family is its type,
// each type in a colour of its own among the seven of shared.css v2; a group takes the type most of its pages
// have. Colour is never the only signal: the type also has a shape (render.ts SHAPES) and the legend names it.
// No DOM here.
import { PAGE_TYPES } from '../lib/wiki.ts'
import type { Model } from './model.ts'

export type FamilyColour = 'orange' | 'amber' | 'blue' | 'cyan' | 'pink' | 'violet' | 'green'
export type Family = { type: string; colour: FamilyColour }

const COLOUR: Record<(typeof PAGE_TYPES)[number], FamilyColour> = {
  topic: 'orange',
  entity: 'blue',
  guide: 'cyan',
  overview: 'amber',
  agent: 'violet',
  decision: 'pink',
  source: 'green',
}

// In the order of PAGE_TYPES (the same order as the shapes): the index of a family is the index of its type.
export const FAMILIES: readonly Family[] = PAGE_TYPES.map((type) => ({ type, colour: COLOUR[type] }))

const byType = new Map(FAMILIES.map((f, k) => [f.type, k]))
const indexOfType = (type: string) => byType.get(type) ?? 0

// An unknown type is drawn in the first family: never out of the picture.
export const familyOfType = (type: string): Family => FAMILIES[indexOfType(type)] as Family

// Per item, the index of its family in FAMILIES.
export function familyIndex(m: Model): Uint8Array {
  const out = new Uint8Array(m.items.length)
  m.items.forEach((it, i) => {
    if (it.kind === 'page') {
      out[i] = indexOfType(it.type)
      return
    }
    let best = ''
    let most = 0
    for (const [type, n] of Object.entries(it.types))
      if (n > most || (n === most && indexOfType(type) < indexOfType(best))) {
        best = type
        most = n
      }
    out[i] = indexOfType(best)
  })
  return out
}

export type FamilyCount = Family & { index: number; count: number }

// The drawn pages of each family, the biggest first (then in the families' order); families with none left
// out. A group counts its pages by type.
export function familyCounts(m: Model, visible: Uint8Array): FamilyCount[] {
  const counts = new Array<number>(FAMILIES.length).fill(0)
  m.items.forEach((it, i) => {
    if (!visible[i]) return
    if (it.kind === 'page') counts[indexOfType(it.type)] = (counts[indexOfType(it.type)] ?? 0) + 1
    else
      for (const [type, n] of Object.entries(it.types))
        counts[indexOfType(type)] = (counts[indexOfType(type)] ?? 0) + n
  })
  return FAMILIES.map((f, index) => ({ ...f, index, count: counts[index] ?? 0 }))
    .filter((c) => c.count > 0)
    .sort((a, b) => b.count - a.count || a.index - b.index)
}

export type Centroid = { x: number; y: number; n: number }

// Where each family's pill goes: the middle of its drawn points (positions [x0, y0, x1, y1, …]); null for a
// family with none drawn.
export function centroids(
  xy: Float32Array,
  fam: Uint8Array,
  visible: Uint8Array,
  families: number,
): (Centroid | null)[] {
  const sx = new Float64Array(families)
  const sy = new Float64Array(families)
  const n = new Uint32Array(families)
  for (let i = 0; i < fam.length; i++) {
    if (!visible[i]) continue
    const f = fam[i] as number
    sx[f] = (sx[f] as number) + (xy[2 * i] as number)
    sy[f] = (sy[f] as number) + (xy[2 * i + 1] as number)
    n[f] = (n[f] as number) + 1
  }
  return Array.from({ length: families }, (_, f) => {
    const k = n[f] as number
    return k ? { x: (sx[f] as number) / k, y: (sy[f] as number) / k, n: k } : null
  })
}

// Where a family's pill goes in three dimensions: its dense core (visual review, 2026-11-09). The point with the
// most of its family within a reach (six tenths of the family's spread), and the middle of those: a few far
// points never drag the pill toward the hub, as they drag the plain middle. Worked out once a layout.
export type Core = { x: number; y: number; z: number; n: number }
const CANDIDATES = 300
export function cores(
  xyz: Float32Array,
  fam: Uint8Array,
  visible: Uint8Array,
  families: number,
): (Core | null)[] {
  const members: number[][] = Array.from({ length: families }, () => [])
  for (let i = 0; i < fam.length; i++) if (visible[i]) members[fam[i] as number]?.push(i)
  const at = (i: number, a: number) => xyz[3 * i + a] as number
  return members.map((list) => {
    const m = list.length
    if (!m) return null
    let mx = 0
    let my = 0
    let mz = 0
    for (const i of list) {
      mx += at(i, 0)
      my += at(i, 1)
      mz += at(i, 2)
    }
    mx /= m
    my /= m
    mz /= m
    let s = 0
    for (const i of list) s += (at(i, 0) - mx) ** 2 + (at(i, 1) - my) ** 2 + (at(i, 2) - mz) ** 2
    const reach2 = (0.6 * Math.sqrt(s / m)) ** 2
    const d2 = (i: number, j: number) =>
      (at(i, 0) - at(j, 0)) ** 2 + (at(i, 1) - at(j, 1)) ** 2 + (at(i, 2) - at(j, 2)) ** 2
    const step = Math.max(1, Math.floor(m / CANDIDATES))
    let best = list[0] as number
    let most = -1
    for (let c = 0; c < m; c += step) {
      const i = list[c] as number
      let k = 0
      for (const j of list) if (d2(i, j) <= reach2) k += 1
      if (k > most) {
        most = k
        best = i
      }
    }
    let cx = 0
    let cy = 0
    let cz = 0
    let k = 0
    for (const j of list)
      if (d2(best, j) <= reach2) {
        cx += at(j, 0)
        cy += at(j, 1)
        cz += at(j, 2)
        k += 1
      }
    return { x: cx / k, y: cy / k, z: cz / k, n: m }
  })
}

// Pills on screen pushed apart until none overlaps another (with `gap` between), each move along the shorter
// way out and shared by the two; a few passes. The array's boxes are moved in place and returned.
export type Pill = { x: number; y: number; w: number; h: number }
export function spreadPills<T extends Pill>(pills: T[], gap = 4): T[] {
  for (let pass = 0; pass < 24; pass++) {
    let moved = false
    for (let a = 0; a < pills.length; a++)
      for (let b = a + 1; b < pills.length; b++) {
        const p = pills[a] as T
        const q = pills[b] as T
        const ox = Math.min(p.x + p.w + gap - q.x, q.x + q.w + gap - p.x)
        const oy = Math.min(p.y + p.h + gap - q.y, q.y + q.h + gap - p.y)
        if (ox <= 0 || oy <= 0) continue
        moved = true
        // Along y when that is shorter (pills are wide and low), else along x; half each.
        if (oy <= ox) {
          const sgn = p.y + p.h / 2 <= q.y + q.h / 2 ? 1 : -1
          p.y -= (sgn * oy) / 2
          q.y += (sgn * oy) / 2
        } else {
          const sgn = p.x + p.w / 2 <= q.x + q.w / 2 ? 1 : -1
          p.x -= (sgn * ox) / 2
          q.x += (sgn * ox) / 2
        }
      }
    if (!moved) break
  }
  return pills
}
