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
