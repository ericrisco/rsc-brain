// The cards of the graph (plan canvas-ui D6–D8), as pure functions the painter and the page share. Zoomed
// in, a page is drawn as a card (its type, its title); where a card would cover another card or another
// page, the page stays a point. The order says who comes first: the person's own items, then their
// neighbours, the hubs, the groups. The page finds what is under the pointer from the same rectangles the
// painter drew (DrawnMessage.cards).
import type { View } from './model.ts'

// A page's card: 28 px tall, its title plus room for the type disc and the padding, at most 220 px wide.
export const CARD_H = 28
export const CARD_PAD = 44
export const CARD_MAX = 220
// A group's card: its name and its number of pages, on two lines.
export const GROUP_H = 44
export const GROUP_MAX = 240
// The most cards in one picture (as many as names were before).
export const MAX_CARDS = 160
// The room kept between two cards, and around a page a card must not cover.
const GAP = 4
const CLEAR = 3

export type Rect = { x: number; y: number; w: number; h: number }
export type Card = Rect & { i: number }

export const cardSize = (textW: number, group: boolean): { w: number; h: number } => ({
  w: Math.min(group ? GROUP_MAX : CARD_MAX, Math.ceil(textW) + CARD_PAD),
  h: group ? GROUP_H : CARD_H,
})

export type Placing = {
  // The candidates, first the most wanted.
  order: Iterable<number>
  // Every item's place on the screen (x, y), NaN when it is not drawn.
  sx: Float32Array
  // The width of an item's title as painted (already cut to fit).
  textW: (i: number) => number
  group: (i: number) => boolean
  width: number
  height: number
  // Items that always get a card (where the keyboard is, what is selected), whatever they cover.
  forced: ReadonlySet<number>
  max?: number
}

const CELL = 32

export function placeCards(p: Placing): Card[] {
  const n = p.sx.length / 2
  // The drawn pages by cells of the screen, to find quickly which ones a card would cover.
  const cells = new Map<number, number[]>()
  const key = (cx: number, cy: number) => cx * 65_536 + cy
  for (let i = 0; i < n; i++) {
    const x = p.sx[2 * i] as number
    const y = p.sx[2 * i + 1] as number
    if (!Number.isFinite(x) || !Number.isFinite(y) || x < 0 || y < 0 || x > p.width || y > p.height) continue
    const k = key(Math.floor(x / CELL), Math.floor(y / CELL))
    const list = cells.get(k)
    if (list) list.push(i)
    else cells.set(k, [i])
  }
  const covers = (r: Rect, self: number) => {
    const x0 = r.x - CLEAR
    const y0 = r.y - CLEAR
    const x1 = r.x + r.w + CLEAR
    const y1 = r.y + r.h + CLEAR
    for (let cx = Math.floor(Math.max(0, x0) / CELL); cx <= Math.floor(x1 / CELL); cx++)
      for (let cy = Math.floor(Math.max(0, y0) / CELL); cy <= Math.floor(y1 / CELL); cy++)
        for (const j of cells.get(key(cx, cy)) ?? []) {
          if (j === self) continue
          const x = p.sx[2 * j] as number
          const y = p.sx[2 * j + 1] as number
          if (x >= x0 && x <= x1 && y >= y0 && y <= y1) return true
        }
    return false
  }
  const max = p.max ?? MAX_CARDS
  const placed: Card[] = []
  const seen = new Set<number>()
  const meets = (r: Rect) =>
    placed.some(
      (c) => r.x < c.x + c.w + GAP && r.x + r.w + GAP > c.x && r.y < c.y + c.h + GAP && r.y + r.h + GAP > c.y,
    )
  for (const i of p.order) {
    if (placed.length >= max) break
    if (seen.has(i) || i < 0 || i >= n) continue
    seen.add(i)
    const x = p.sx[2 * i] as number
    const y = p.sx[2 * i + 1] as number
    if (!Number.isFinite(x) || !Number.isFinite(y)) continue
    const { w, h } = cardSize(p.textW(i), p.group(i))
    const r = { x: Math.round(x - w / 2), y: Math.round(y - h / 2), w, h }
    // Wholly off the canvas: nothing to draw.
    if (r.x + r.w < 0 || r.y + r.h < 0 || r.x > p.width || r.y > p.height) continue
    if (!p.forced.has(i) && (r.x < 0 || r.y < 0 || r.x + r.w > p.width || r.y + r.h > p.height)) continue
    if (!p.forced.has(i) && (meets(r) || covers(r, i))) continue
    placed.push({ i, ...r })
  }
  return placed
}

// The item whose card is under (x, y), edges included: the first in the order where two meet; −1 for none.
export function hitCard(cards: readonly Card[], x: number, y: number): number {
  for (const c of cards) if (x >= c.x && x <= c.x + c.w && y >= c.y && y <= c.y + c.h) return c.i
  return -1
}

// A line from (x0, y0) to the middle of a card (x1, y1) stops where it crosses the card's edge. A line that
// starts inside the card is left whole.
export function clipToRect(x0: number, y0: number, x1: number, y1: number, r: Rect): [number, number] {
  const inside = (x: number, y: number) => x >= r.x && x <= r.x + r.w && y >= r.y && y <= r.y + r.h
  if (inside(x0, y0)) return [x1, y1]
  const dx = x1 - x0
  const dy = y1 - y0
  let t = 1
  // The first of the card's four sides the line meets on its way in.
  if (dx > 0) t = Math.min(t, Math.max(0, (r.x - x0) / dx))
  if (dx < 0) t = Math.min(t, Math.max(0, (r.x + r.w - x0) / dx))
  const tx = t
  t = 1
  if (dy > 0) t = Math.min(t, Math.max(0, (r.y - y0) / dy))
  if (dy < 0) t = Math.min(t, Math.max(0, (r.y + r.h - y0) / dy))
  const ty = t
  // The line enters through the side it reaches last of the two (the one where it is inside on both axes).
  const at = Math.max(dx === 0 ? 0 : tx, dy === 0 ? 0 : ty)
  return [x0 + dx * at, y0 + dy * at]
}

// The dotted ground: a dot every `step` px of the screen, shifted with the view so it moves with the
// picture. Zoomed out the step doubles (up to four times) to stay 12 px or more; under 6 px it is left out.
// Zoomed in it halves while it is 40 px or more, so the ground keeps its grain.
export const DOT_STEP = 24
export function dotGrid(view: View, base = DOT_STEP): { step: number; ox: number; oy: number } | null {
  let step = base * view.scale
  for (let k = 0; k < 4 && step < 12; k++) step *= 2
  for (let k = 0; k < 8 && step >= 40; k++) step /= 2
  if (!(step >= 6)) return null
  const mod = (a: number) => ((a % step) + step) % step
  return { step, ox: mod(view.tx), oy: mod(view.ty) }
}
