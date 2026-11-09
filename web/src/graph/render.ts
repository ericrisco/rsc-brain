// Painting the graph (plan §3.4). The painter runs in the graph's worker on an OffscreenCanvas, so the page
// never waits for a picture (CA6: on a slow machine the copy of a painted canvas alone used to block the page
// for longer than 200 ms); without OffscreenCanvas it runs on the page. It paints when the positions, the
// size or what the person does changes, never in a loop (DESIGN.md «Motion»).
//
// What says what, never by colour alone: a page's shape says its type and its size how linked it is; a
// superseded page is dimmed and struck through; a line's dash and width say its link kind, with an arrowhead
// for the kinds that have a direction; links with a group are wide and pale. In focus, the page sits in the
// middle, one hop on a filled ring and two hops on a hollow, smaller one. Names go where they fit: the item
// the person is on, its neighbours, the hubs, the groups, and everything once zoomed in.
import {
  CARD_MAX,
  CARD_PAD,
  type Card,
  clipToRect,
  dotGrid,
  fitCards,
  GROUP_MAX,
  placeCards,
  TILE_H,
  TILE_MIN,
  TILE_SCALE,
  TILE_TEXT,
} from './cards.ts'
import type { View } from './model.ts'
import { fit, fitPad, GROUP_SHAPE, groupRadius } from './model.ts'

export { fitPad, GROUP_SHAPE, groupRadius }

export type Palette = {
  text: string
  muted: string
  accent: string
  danger: string
  ground: string
  // The canvas: its dots, a card's ground, line, words and second line.
  dot: string
  card: string
  cardLine: string
  cardInk: string
  cardSub: string
}

export const SHAPES = ['topic', 'entity', 'decision', 'guide', 'agent', 'source', 'overview'] as const

// Each link kind: its dash (screen px), width, and whether it points somewhere (an arrowhead at its end).
export const LINE: Record<string, { dash: number[]; width: number; arrow: boolean }> = {
  mentions: { dash: [1.5, 4], width: 1.2, arrow: true },
  related: { dash: [], width: 1, arrow: false },
  'depends-on': { dash: [8, 4], width: 1.4, arrow: true },
  contradicts: { dash: [2, 3, 9, 3], width: 1.8, arrow: false },
  supersedes: { dash: [], width: 2.6, arrow: true },
  'part-of': { dash: [16, 5], width: 1.6, arrow: true },
  'example-of': { dash: [7, 3, 1.5, 3], width: 1.2, arrow: true },
  group: { dash: [], width: 4, arrow: false },
}

type Path = CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D | Path2D

// A page's shape at (x, y), radius r, added to the current path. Distinct at 8 px: a circle, a square, a
// diamond, a triangle up, a five-point star, a triangle down, a ring.
export function shape(ctx: Path, type: string, x: number, y: number, r: number): void {
  const poly = (points: [number, number][]) => {
    for (const [i, [px, py]] of points.entries()) {
      if (i === 0) ctx.moveTo(x + px * r, y + py * r)
      else ctx.lineTo(x + px * r, y + py * r)
    }
    ctx.closePath()
  }
  switch (type) {
    case 'entity':
      ctx.rect(x - r * 0.85, y - r * 0.85, r * 1.7, r * 1.7)
      return
    case 'decision':
      poly([
        [0, -1.25],
        [1.25, 0],
        [0, 1.25],
        [-1.25, 0],
      ])
      return
    case 'guide':
      poly([
        [0, -1.25],
        [1.15, 0.9],
        [-1.15, 0.9],
      ])
      return
    case 'source':
      poly([
        [0, 1.25],
        [1.15, -0.9],
        [-1.15, -0.9],
      ])
      return
    case 'agent':
      poly(
        Array.from({ length: 10 }, (_, k): [number, number] => {
          const a = -Math.PI / 2 + (Math.PI / 5) * k
          const m = k % 2 === 0 ? 1.35 : 0.55
          return [m * Math.cos(a), m * Math.sin(a)]
        }),
      )
      return
    case 'overview':
      ctx.moveTo(x + r * 1.15, y)
      ctx.arc(x, y, r * 1.15, 0, Math.PI * 2)
      ctx.moveTo(x + r * 0.5, y)
      ctx.arc(x, y, r * 0.5, 0, Math.PI * 2, true)
      return
    default:
      ctx.moveTo(x + r, y)
      ctx.arc(x, y, r, 0, Math.PI * 2)
  }
}

export const NODE_R = 5

// Pages shrink when the picture is zoomed far out (many pages on a phone), never below 2.5 px.
export const nodeRadius = (scale: number) => Math.min(NODE_R, Math.max(2.5, NODE_R * Math.sqrt(scale)))
// A page grows with how linked it is, up to twice its size.
export const grow = (degree: number) => Math.min(2, 1 + 0.22 * Math.sqrt(degree))

// What does not change while the person looks: the items, their links, their names.
export type Scene = {
  n: number
  pages: number
  byGroups: boolean
  // Per item: the index of its shape in SHAPES, or GROUP_SHAPE.
  shape: Uint8Array
  superseded: Uint8Array
  // Per group: its pages (the box's size); 0 for a page.
  count: Uint32Array
  degree: Uint32Array
  edges: Uint32Array
  kind: Int8Array
  // Per edge: how many links it stands for.
  links: Uint32Array
  kinds: string[]
  labels: string[]
  // Per item: free, parked without links, or on the rim (layout.ts ROLE).
  role: Uint8Array
}

// What changes as the person looks.
export type State = {
  width: number
  height: number
  dpr: number
  palette: Palette
  nodes: Uint8Array
  edges: Uint8Array
  // What the view fits (the main cluster).
  fit: Uint8Array
  autoFit: boolean
  view: View
  active: number
  selected: number
  focus: number
  hover: number
  // In focus: −1 not in it, 0 the page, 1 or 2 hops.
  hop: Int8Array | null
  // Positions to draw instead of the layout's (focus as rings).
  xy: Float32Array | null
  // Names worth showing first (the hubs), after the ones the person is on.
  hubs: number[]
  // In focus: [page, two-hop item] pairs reached only through one-hop pages a filter hides (a faint line).
  bridges: Uint32Array | null
  // The caption over the row of pages without links ("" for none).
  orphanLabel: string
  // The height at the bottom of the canvas a sheet covers (a phone's inspector): fit leaves it out.
  inset: number
  // The band at the top the screen's controls cover: fit draws below it.
  top: number
  // The width at the right a panel covers (the inspector): fit draws left of it.
  right: number
  // The band at the bottom the zoom buttons cover: fit draws above it.
  bottom: number
  // Which state this is: the picture drawn from it says so (tests wait for the picture of the last one).
  seq: number
  // A test drives the browser (navigator.webdriver): the picture also says the words of its cards.
  probe: boolean
}

export type Drawn = {
  view: View
  active: [number, number] | null
  // The cards drawn, first the most wanted (the page finds what is under the pointer from them).
  cards: Card[]
  // The step of the dotted ground in screen pixels (0: left out).
  dots: number
  // Each card's words as drawn (a cut title ends in "…"), in the order of `cards`.
  titles: string[]
  // How long this picture took to paint, in ms (the timing tests add it up: CDP cannot slow a worker).
  ms: number
  // The state this picture was drawn from (State.seq).
  seq: number
}

const TITLE = '13px ui-sans-serif, system-ui, sans-serif'
const GROUP_TITLE = '600 13px ui-sans-serif, system-ui, sans-serif'
const SUB = '12px ui-sans-serif, system-ui, sans-serif'
// How far Fit zooms in at most: far enough that a small wiki's pages are drawn as cards side by side.
const FIT_MAX = 8
// How many cards a picture describes to a test.
export const PROBE_CARDS = 40
const TILE_TITLE = '600 14px ui-sans-serif, system-ui, sans-serif'
// Where a card's words start: after the disc with the type's shape.
const TEXT_X = 32

export class Renderer {
  scene: Scene | null = null
  state: State | null = null
  layout: Float32Array | null = null
  // Each item's words as a card shows them (cut to fit), and their width: measured once.
  private words = new Map<number, { t: string; s: string; w: number }>()

  setScene(s: Scene): void {
    this.scene = s
    this.layout = null
    this.words.clear()
    this.tiles.clear()
  }

  setLabels(labels: string[]): void {
    if (!this.scene) return
    this.scene = { ...this.scene, labels }
    this.words.clear()
    this.tiles.clear()
  }

  // Paints a frame; null when there is nothing to paint yet.
  paint(ctx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D): Drawn | null {
    const sc = this.scene
    const st = this.state
    const xy = st?.xy ?? this.layout
    if (!sc || !st || !xy || xy.length !== 2 * sc.n || st.width === 0 || st.height === 0) return null
    const started = performance.now()
    const fitWith = (pad: number, max = FIT_MAX) =>
      fit(xy, st.fit, st.width, Math.max(120, st.height - Math.max(st.inset, st.bottom)), pad, st.top, {
        max,
        right: st.right,
      })
    const view = st.autoFit ? fitCards(fitWith, fitPad(sc, st.fit)) : st.view
    const tile = view.scale >= TILE_SCALE
    const { palette, dpr } = st
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    ctx.clearRect(0, 0, st.width, st.height)
    const SX = (i: number) => (xy[2 * i] as number) * view.scale + view.tx
    const SY = (i: number) => (xy[2 * i + 1] as number) * view.scale + view.ty
    const base = nodeRadius(view.scale)
    const isGroup = (i: number) => sc.shape[i] === GROUP_SHAPE
    const boxR = (i: number) => groupRadius(sc.count[i] as number) * (sc.byGroups ? 1 : 0.6)
    const radius = (i: number) => {
      if (isGroup(i)) return boxR(i)
      const r = base * grow(sc.degree[i] as number)
      return st.hop && st.hop[i] === 2 ? r * 0.8 : r
    }
    // Under the pointer: the item and its lines stand out, the rest is dimmed.
    let lit: Uint8Array | null = null
    if (st.hover >= 0 && st.nodes[st.hover]) {
      lit = new Uint8Array(sc.n)
      lit[st.hover] = 1
      for (let e = 0; e < sc.kind.length; e++) {
        if (!st.edges[e]) continue
        const i = sc.edges[2 * e] as number
        const j = sc.edges[2 * e + 1] as number
        if (i === st.hover) lit[j] = 1
        if (j === st.hover) lit[i] = 1
      }
    }
    const dim = (i: number) => sc.superseded[i] === 1 || (lit !== null && !lit[i])
    // Everything is drawn in screen pixels: line widths and dashes stay the same at any zoom.

    // The dotted ground, moving with the view; each dot snapped to the device's pixels.
    const dots = dotGrid(view)
    if (dots) {
      const d = Math.max(1, Math.round(1.5 * dpr)) / dpr
      ctx.beginPath()
      for (let y = dots.oy; y < st.height; y += dots.step)
        for (let x = dots.ox; x < st.width; x += dots.step)
          ctx.rect(Math.round(x * dpr) / dpr, Math.round(y * dpr) / dpr, d, d)
      ctx.fillStyle = palette.dot
      ctx.fill()
    }

    // The cards first: the lines stop at their edges, and an item with a card is drawn only as its card.
    const cards = this.place(ctx, st, sc, SX, SY, isGroup, tile)
    const cardOf = new Int32Array(sc.n).fill(-1)
    for (const [k, c] of cards.entries()) cardOf[c.i] = k

    if (st.hop && st.focus >= 0) {
      ctx.lineWidth = 1
      ctx.strokeStyle = palette.muted
      ctx.globalAlpha = 0.25
      ctx.setLineDash([2, 6])
      for (const r of [130, 260]) {
        ctx.beginPath()
        ctx.arc(SX(st.focus), SY(st.focus), r * view.scale, 0, Math.PI * 2)
        ctx.stroke()
      }
      ctx.setLineDash([])
      ctx.globalAlpha = 1
    }

    // Lines: one path per kind and dimness, arrowheads in one path per kind.
    ctx.lineCap = 'round'
    for (let k = -1; k < sc.kinds.length; k++) {
      const name = k < 0 ? 'group' : (sc.kinds[k] as string)
      const style = LINE[name] ?? (LINE.related as (typeof LINE)[string])
      for (const faint of [false, true]) {
        ctx.beginPath()
        const heads: number[] = []
        let any = false
        for (let e = 0; e < sc.kind.length; e++) {
          if (!st.edges[e] || sc.kind[e] !== k) continue
          const i = sc.edges[2 * e] as number
          const j = sc.edges[2 * e + 1] as number
          const off = lit ? i !== st.hover && j !== st.hover : dim(i) || dim(j)
          if (off !== faint) continue
          let x0 = SX(i)
          let y0 = SY(i)
          let x1 = SX(j)
          let y1 = SY(j)
          const ci = cardOf[i] as number
          const cj = cardOf[j] as number
          if (cj >= 0) [x1, y1] = clipToRect(x0, y0, x1, y1, cards[cj] as Card)
          if (ci >= 0) [x0, y0] = clipToRect(x1, y1, x0, y0, cards[ci] as Card)
          if (k < 0) {
            // A link with a group: as wide as it is busy.
            ctx.moveTo(x0, y0)
            ctx.lineTo(x1, y1)
            any = true
            continue
          }
          ctx.moveTo(x0, y0)
          ctx.lineTo(x1, y1)
          any = true
          const len = Math.hypot(x1 - x0, y1 - y0)
          if (style.arrow && len > 28) heads.push(x0, y0, x1, y1, len, cj >= 0 ? -1 : radius(j))
        }
        if (!any) continue
        ctx.setLineDash(style.dash)
        // Between groups: wide; from the pages of an opened group to the boxes around it: thin, many as they are.
        ctx.lineWidth = k < 0 ? (sc.byGroups ? 3 : 0.8) : style.width
        ctx.strokeStyle = name === 'contradicts' ? palette.danger : palette.muted
        ctx.globalAlpha = faint
          ? lit
            ? 0.08
            : 0.2
          : lit
            ? 0.95
            : k < 0
              ? sc.byGroups
                ? 0.25
                : 0.12
              : name === 'contradicts'
                ? 0.85
                : 0.55
        ctx.stroke()
        if (heads.length) {
          ctx.setLineDash([])
          ctx.beginPath()
          for (let h = 0; h < heads.length; h += 6) {
            const [x0, y0, x1, y1, len, r] = heads.slice(h, h + 6) as [
              number,
              number,
              number,
              number,
              number,
              number,
            ]
            const ux = (x1 - x0) / len
            const uy = (y1 - y0) / len
            const tx = x1 - ux * (r + 2)
            const ty = y1 - uy * (r + 2)
            ctx.moveTo(tx, ty)
            ctx.lineTo(tx - ux * 7 - uy * 3.5, ty - uy * 7 + ux * 3.5)
            ctx.lineTo(tx - ux * 7 + uy * 3.5, ty - uy * 7 - ux * 3.5)
            ctx.closePath()
          }
          ctx.fillStyle = name === 'contradicts' ? palette.danger : palette.muted
          ctx.fill()
        }
      }
    }
    ctx.setLineDash([])
    ctx.globalAlpha = 1

    // In focus with a filter: a faint dashed line to a two-hop page reached through a hidden one.
    if (st.bridges?.length) {
      ctx.beginPath()
      for (let b = 0; b < st.bridges.length; b += 2) {
        const i = st.bridges[b] as number
        const j = st.bridges[b + 1] as number
        ctx.moveTo(SX(i), SY(i))
        ctx.lineTo(SX(j), SY(j))
      }
      ctx.setLineDash([3, 6])
      ctx.lineWidth = 1
      ctx.strokeStyle = palette.muted
      ctx.globalAlpha = 0.45
      ctx.stroke()
      ctx.setLineDash([])
      ctx.globalAlpha = 1
    }

    // The caption over the row of pages without links.
    if (st.orphanLabel && !st.xy) {
      let x = Number.POSITIVE_INFINITY
      let y = Number.POSITIVE_INFINITY
      for (let i = 0; i < sc.n; i++)
        if (st.nodes[i] && sc.role[i] === 1) {
          x = Math.min(x, SX(i))
          y = Math.min(y, SY(i))
        }
      if (Number.isFinite(x)) {
        ctx.font = '12px ui-sans-serif, system-ui, sans-serif'
        ctx.textBaseline = 'bottom'
        ctx.fillStyle = palette.muted
        ctx.fillText(st.orphanLabel, Math.max(4, x - base), y - base - 6)
      }
    }

    // Group boxes, sized by their pages.
    for (let i = 0; i < sc.n; i++) {
      if (!st.nodes[i] || !isGroup(i) || (cardOf[i] as number) >= 0) continue
      const r = boxR(i)
      ctx.globalAlpha = lit && !lit[i] ? 0.35 : 1
      ctx.beginPath()
      ctx.roundRect(SX(i) - r, SY(i) - r, 2 * r, 2 * r, r * 0.3)
      ctx.fillStyle = palette.ground
      ctx.fill()
      ctx.lineWidth = sc.byGroups ? 1.5 : 1
      ctx.setLineDash(sc.byGroups ? [] : [3, 3])
      ctx.strokeStyle = i === st.selected || i === st.active ? palette.accent : palette.text
      ctx.stroke()
      ctx.setLineDash([])
    }
    ctx.globalAlpha = 1

    // Pages: one path per shape, filled (hollow at two hops), dimmed and struck when superseded.
    for (const [t, type] of SHAPES.entries()) {
      for (const hollow of [false, true]) {
        for (const faint of [false, true]) {
          ctx.beginPath()
          let any = false
          for (let i = 0; i < sc.n; i++) {
            if (!st.nodes[i] || sc.shape[i] !== t || dim(i) !== faint || (cardOf[i] as number) >= 0) continue
            if ((st.hop !== null && st.hop[i] === 2) !== hollow) continue
            shape(ctx, type, SX(i), SY(i), radius(i))
            any = true
          }
          if (!any) continue
          ctx.globalAlpha = faint ? (lit ? 0.25 : 0.45) : 1
          if (hollow) {
            ctx.lineWidth = 1.5
            ctx.strokeStyle = palette.text
            ctx.stroke()
          } else {
            ctx.fillStyle = palette.text
            ctx.fill('evenodd')
          }
        }
      }
    }
    ctx.globalAlpha = 1
    // The strike of superseded pages.
    ctx.beginPath()
    let struck = false
    for (let i = 0; i < sc.pages; i++) {
      if (!st.nodes[i] || sc.superseded[i] !== 1 || (cardOf[i] as number) >= 0) continue
      const r = radius(i) * 1.5
      ctx.moveTo(SX(i) - r, SY(i) + r)
      ctx.lineTo(SX(i) + r, SY(i) - r)
      struck = true
    }
    if (struck) {
      ctx.lineWidth = 1.5
      ctx.strokeStyle = palette.text
      ctx.stroke()
    }

    // Rings: the page in focus, the one selected, where the keyboard is.
    const ring = (i: number, width: number, gap: number, color: string) => {
      if (i < 0 || !st.nodes[i] || (cardOf[i] as number) >= 0) return
      ctx.beginPath()
      ctx.arc(SX(i), SY(i), (isGroup(i) ? boxR(i) * 1.45 : radius(i) * 1.3) + gap, 0, Math.PI * 2)
      ctx.lineWidth = width
      ctx.strokeStyle = color
      ctx.stroke()
    }
    ring(st.focus, 1.5, 4, palette.muted)
    ring(st.selected, 2.5, 3, palette.accent)
    ring(st.active, 2, 7, palette.accent)

    this.draw(ctx, st, sc, cards, lit, tile)
    ctx.textBaseline = 'alphabetic'
    const a = st.active
    return {
      view,
      active: a >= 0 && st.nodes[a] ? [Math.round(SX(a)), Math.round(SY(a))] : null,
      cards,
      dots: dots ? Math.round(dots.step * 10) / 10 : 0,
      // Only for a browser a test drives (State.probe): never built for a person, picture after picture.
      titles: st.probe
        ? cards.slice(0, PROBE_CARDS).map((c) => {
            const group = isGroup(c.i)
            return tile
              ? this.tileWords(ctx, sc, c.i, group).lines.join(' ')
              : this.wordsOf(ctx, sc, c.i, group).t
          })
        : [],
      ms: performance.now() - started,
      seq: st.seq,
    }
  }

  // An item's words on its card: a page's title, or a group's name and its pages on a second line; cut
  // with "…" to the card's widest.
  private wordsOf(
    ctx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D,
    sc: Scene,
    i: number,
    group: boolean,
  ): { t: string; s: string; w: number } {
    const known = this.words.get(i)
    if (known) return known
    const [raw = '', sub = ''] = (sc.labels[i] ?? '').split('\n')
    const room = (group ? GROUP_MAX : CARD_MAX) - CARD_PAD
    ctx.font = group ? GROUP_TITLE : TITLE
    let t = raw
    let w = ctx.measureText(t).width
    if (w > room) {
      let lo = 0
      let hi = raw.length
      while (lo < hi) {
        const mid = Math.ceil((lo + hi) / 2)
        if (ctx.measureText(`${raw.slice(0, mid).trimEnd()}…`).width <= room) lo = mid
        else hi = mid - 1
      }
      t = `${raw.slice(0, lo).trimEnd()}…`
      w = ctx.measureText(t).width
    }
    let sw = 0
    if (sub) {
      ctx.font = SUB
      sw = ctx.measureText(sub).width
    }
    const out = { t, s: sub, w: Math.min(room, Math.max(w, sw)) }
    this.words.set(i, out)
    return out
  }

  // An item's words on a tile: its title on up to two lines (wrapped at spaces, "…" only if it still does not
  // fit), a group's pages under its name; and the tile's size.
  private tiles = new Map<number, { lines: string[]; sub: string; w: number; h: number }>()
  private tileWords(
    ctx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D,
    sc: Scene,
    i: number,
    group: boolean,
  ): { lines: string[]; sub: string; w: number; h: number } {
    const known = this.tiles.get(i)
    if (known) return known
    const [raw = '', sub = ''] = (sc.labels[i] ?? '').split('\n')
    ctx.font = TILE_TITLE
    const width = (t: string) => ctx.measureText(t).width
    const lines: string[] = []
    let rest = raw.trim()
    const most = group ? 1 : 2
    while (rest && lines.length < most) {
      if (width(rest) <= TILE_TEXT) {
        lines.push(rest)
        break
      }
      if (lines.length === most - 1) {
        let cut = rest
        while (cut.length > 1 && width(`${cut}…`) > TILE_TEXT) cut = cut.slice(0, -1)
        lines.push(`${cut.trimEnd()}…`)
        break
      }
      const words = rest.split(' ')
      let line = words[0] as string
      let k = 1
      while (k < words.length && width(`${line} ${words[k]}`) <= TILE_TEXT) line = `${line} ${words[k++]}`
      if (width(line) > TILE_TEXT) {
        while (line.length > 1 && width(line) > TILE_TEXT) line = line.slice(0, -1)
        rest = rest.slice(line.length).trimStart()
      } else rest = words.slice(k).join(' ')
      lines.push(line)
    }
    const titleW = Math.max(0, ...lines.map(width))
    ctx.font = SUB
    const wide = Math.max(titleW, sub ? ctx.measureText(sub).width : 0)
    const out = { lines, sub, w: Math.max(TILE_MIN, Math.ceil(wide) + 32), h: TILE_H }
    this.tiles.set(i, out)
    return out
  }

  // Where the cards go (cards.ts): the person's own items first and always, then the neighbours of what
  // they are on, the hubs, the groups, and every other item where one still fits.
  private place(
    ctx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D,
    st: State,
    sc: Scene,
    SX: (i: number) => number,
    SY: (i: number) => number,
    isGroup: (i: number) => boolean,
    tile: boolean,
  ): Card[] {
    const sx = new Float32Array(2 * sc.n).fill(Number.NaN)
    for (let i = 0; i < sc.n; i++)
      if (st.nodes[i]) {
        sx[2 * i] = SX(i)
        sx[2 * i + 1] = SY(i)
      }
    const must = [st.active, st.selected, st.focus, st.hover].filter((i) => i >= 0 && st.nodes[i])
    const near = new Set<number>()
    for (const c of [st.active, st.selected, st.hover])
      if (c >= 0)
        for (let e = 0; e < sc.kind.length; e++) {
          if (!st.edges[e]) continue
          const i = sc.edges[2 * e] as number
          const j = sc.edges[2 * e + 1] as number
          if (i === c) near.add(j)
          if (j === c) near.add(i)
        }
    function* order() {
      yield* must
      yield* near
      yield* st.hubs
      for (let i = 0; i < sc.n; i++) if (isGroup(i)) yield i
      for (let i = 0; i < sc.n; i++) yield i
    }
    return placeCards({
      order: order(),
      sx,
      textW: (i) => this.wordsOf(ctx, sc, i, isGroup(i)).w,
      ...(tile ? { size: (i: number) => this.tileWords(ctx, sc, i, isGroup(i)) } : {}),
      group: isGroup,
      width: st.width,
      height: st.height,
      forced: new Set([st.active, st.selected, st.focus].filter((i) => i >= 0 && st.nodes[i])),
    })
  }

  // The cards, the most wanted on top. A page: a pill with its type's shape in a disc and its title. A
  // group: two lines in a double outline. Selected: a 2 px border in the accent. Where the keyboard is: a
  // ring outside the card (a shape of its own, never colour alone). Superseded: faint and struck through.
  private draw(
    ctx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D,
    st: State,
    sc: Scene,
    cards: Card[],
    lit: Uint8Array | null,
    tile: boolean,
  ): void {
    const p = st.palette
    if (tile) {
      this.drawTiles(ctx, st, sc, cards, lit)
      return
    }
    for (let k = cards.length - 1; k >= 0; k--) {
      const c = cards[k] as Card
      const i = c.i
      const group = sc.shape[i] === GROUP_SHAPE
      const superseded = sc.superseded[i] === 1
      const round = group ? 8 : c.h / 2
      const words = this.wordsOf(ctx, sc, i, group)
      ctx.globalAlpha = lit && !lit[i] ? 0.35 : superseded ? 0.6 : 1
      ctx.beginPath()
      ctx.roundRect(c.x + 0.5, c.y + 0.5, c.w - 1, c.h - 1, round)
      ctx.fillStyle = p.card
      ctx.fill()
      const selected = i === st.selected
      ctx.lineWidth = selected ? 2 : 1
      ctx.strokeStyle = selected ? p.accent : i === st.focus ? p.text : p.cardLine
      ctx.stroke()
      if (group) {
        ctx.beginPath()
        ctx.roundRect(c.x + 3.5, c.y + 3.5, c.w - 7, c.h - 7, 5)
        ctx.lineWidth = 1
        ctx.strokeStyle = p.cardLine
        ctx.stroke()
      }
      // The disc with the type's shape (a group: a small box), hollow at two hops in focus.
      const dx = c.x + 16
      const dy = c.y + c.h / 2
      ctx.beginPath()
      ctx.arc(dx, dy, 10, 0, Math.PI * 2)
      ctx.fillStyle = p.ground
      ctx.fill()
      ctx.beginPath()
      if (group) ctx.roundRect(dx - 5, dy - 5, 10, 10, 2.5)
      else shape(ctx, SHAPES[sc.shape[i] as number] ?? 'topic', dx, dy, 4.5)
      if (st.hop && st.hop[i] === 2) {
        ctx.lineWidth = 1.5
        ctx.strokeStyle = p.cardInk
        ctx.stroke()
      } else {
        ctx.fillStyle = p.cardInk
        ctx.fill('evenodd')
      }
      ctx.textBaseline = 'middle'
      ctx.fillStyle = p.cardInk
      ctx.font = group ? GROUP_TITLE : TITLE
      if (group) {
        ctx.fillText(words.t, c.x + TEXT_X, c.y + 16)
        ctx.font = SUB
        ctx.fillStyle = p.cardSub
        ctx.fillText(words.s, c.x + TEXT_X, c.y + 31)
      } else ctx.fillText(words.t, c.x + TEXT_X, dy + 0.5)
      if (superseded) {
        ctx.beginPath()
        ctx.moveTo(c.x + TEXT_X, dy + 0.5)
        ctx.lineTo(c.x + TEXT_X + ctx.measureText(words.t).width, dy + 0.5)
        ctx.lineWidth = 1.2
        ctx.strokeStyle = p.cardInk
        ctx.stroke()
      }
      ctx.globalAlpha = 1
      if (i === st.active) {
        ctx.beginPath()
        ctx.roundRect(c.x - 3.5, c.y - 3.5, c.w + 7, c.h + 7, round + 3.5)
        ctx.lineWidth = 2
        ctx.strokeStyle = p.accent
        ctx.stroke()
      }
    }
    ctx.globalAlpha = 1
  }

  // Tiles: a rounded box with the type's shape in a disc at the top and the title under it. Selected: a 2 px
  // border in the accent; where the keyboard is: a ring outside the tile; superseded: faint and struck.
  private drawTiles(
    ctx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D,
    st: State,
    sc: Scene,
    cards: Card[],
    lit: Uint8Array | null,
  ): void {
    const p = st.palette
    for (let k = cards.length - 1; k >= 0; k--) {
      const c = cards[k] as Card
      const i = c.i
      const group = sc.shape[i] === GROUP_SHAPE
      const superseded = sc.superseded[i] === 1
      const words = this.tileWords(ctx, sc, i, group)
      ctx.globalAlpha = lit && !lit[i] ? 0.35 : superseded ? 0.6 : 1
      ctx.beginPath()
      ctx.roundRect(c.x + 0.5, c.y + 0.5, c.w - 1, c.h - 1, 12)
      ctx.fillStyle = p.card
      ctx.fill()
      const selected = i === st.selected
      ctx.lineWidth = selected ? 2 : 1
      ctx.strokeStyle = selected ? p.accent : i === st.focus ? p.text : p.cardLine
      ctx.stroke()
      if (group) {
        ctx.beginPath()
        ctx.roundRect(c.x + 4.5, c.y + 4.5, c.w - 9, c.h - 9, 8)
        ctx.lineWidth = 1
        ctx.strokeStyle = p.cardLine
        ctx.stroke()
      }
      const cx = c.x + c.w / 2
      const dy = c.y + 28
      ctx.beginPath()
      ctx.arc(cx, dy, 17, 0, Math.PI * 2)
      ctx.fillStyle = p.ground
      ctx.fill()
      ctx.beginPath()
      if (group) ctx.roundRect(cx - 8, dy - 8, 16, 16, 3)
      else shape(ctx, SHAPES[sc.shape[i] as number] ?? 'topic', cx, dy, 7.5)
      if (st.hop && st.hop[i] === 2) {
        ctx.lineWidth = 1.5
        ctx.strokeStyle = p.cardInk
        ctx.stroke()
      } else {
        ctx.fillStyle = p.cardInk
        ctx.fill('evenodd')
      }
      ctx.textAlign = 'center'
      ctx.textBaseline = 'middle'
      const lines = words.sub ? [...words.lines, words.sub] : words.lines
      const first = lines.length > 1 ? c.y + 60 : c.y + 68
      for (const [n, line] of lines.entries()) {
        const sub = words.sub !== '' && n === lines.length - 1
        ctx.font = sub ? SUB : TILE_TITLE
        ctx.fillStyle = sub ? p.cardSub : p.cardInk
        ctx.fillText(line, cx, first + n * 18)
        if (superseded && !sub) {
          const w = ctx.measureText(line).width
          ctx.beginPath()
          ctx.moveTo(cx - w / 2, first + n * 18)
          ctx.lineTo(cx + w / 2, first + n * 18)
          ctx.lineWidth = 1.2
          ctx.strokeStyle = p.cardInk
          ctx.stroke()
        }
      }
      ctx.textAlign = 'start'
      ctx.globalAlpha = 1
      if (i === st.active) {
        ctx.beginPath()
        ctx.roundRect(c.x - 3.5, c.y - 3.5, c.w + 7, c.h + 7, 15.5)
        ctx.lineWidth = 2
        ctx.strokeStyle = p.accent
        ctx.stroke()
      }
    }
    ctx.globalAlpha = 1
  }
}
