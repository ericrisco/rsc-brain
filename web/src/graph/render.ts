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
import type { View } from './model.ts'
import { fit, fitPad, GROUP_SHAPE, groupRadius } from './model.ts'

export { fitPad, GROUP_SHAPE, groupRadius }

export type Palette = { text: string; muted: string; accent: string; danger: string; ground: string }

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
  // The band at the bottom the zoom buttons cover: fit draws above it.
  bottom: number
}

export type Drawn = { view: View; active: [number, number] | null }

const MAX_LABELS = 160

export class Renderer {
  scene: Scene | null = null
  state: State | null = null
  layout: Float32Array | null = null
  private widths = new Map<number, number>()

  setScene(s: Scene): void {
    this.scene = s
    this.layout = null
    this.widths.clear()
  }

  setLabels(labels: string[]): void {
    if (!this.scene) return
    this.scene = { ...this.scene, labels }
    this.widths.clear()
  }

  // Paints a frame; null when there is nothing to paint yet.
  paint(ctx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D): Drawn | null {
    const sc = this.scene
    const st = this.state
    const xy = st?.xy ?? this.layout
    if (!sc || !st || !xy || xy.length !== 2 * sc.n || st.width === 0 || st.height === 0) return null
    const view = st.autoFit
      ? fit(
          xy,
          st.fit,
          st.width,
          Math.max(120, st.height - Math.max(st.inset, st.bottom)),
          fitPad(sc, st.fit),
          st.top,
        )
      : st.view
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
          const x0 = SX(i)
          const y0 = SY(i)
          const x1 = SX(j)
          const y1 = SY(j)
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
          if (style.arrow && len > 28) heads.push(x0, y0, x1, y1, len, radius(j))
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
      if (!st.nodes[i] || !isGroup(i)) continue
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
            if (!st.nodes[i] || sc.shape[i] !== t || dim(i) !== faint) continue
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
      if (!st.nodes[i] || sc.superseded[i] !== 1) continue
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
      if (i < 0 || !st.nodes[i]) return
      ctx.beginPath()
      ctx.arc(SX(i), SY(i), (isGroup(i) ? boxR(i) * 1.45 : radius(i) * 1.3) + gap, 0, Math.PI * 2)
      ctx.lineWidth = width
      ctx.strokeStyle = color
      ctx.stroke()
    }
    ring(st.focus, 1.5, 4, palette.muted)
    ring(st.selected, 2.5, 3, palette.accent)
    ring(st.active, 2, 7, palette.accent)

    this.names(ctx, st, sc, view, SX, SY, radius, isGroup, dim)
    ctx.textBaseline = 'alphabetic'
    const a = st.active
    return { view, active: a >= 0 && st.nodes[a] ? [Math.round(SX(a)), Math.round(SY(a))] : null }
  }

  // Names where they fit: never one over another, except the ones the person is on.
  private names(
    ctx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D,
    st: State,
    sc: Scene,
    view: View,
    SX: (i: number) => number,
    SY: (i: number) => number,
    radius: (i: number) => number,
    isGroup: (i: number) => boolean,
    dim: (i: number) => boolean,
  ): void {
    ctx.font = '12px ui-sans-serif, system-ui, sans-serif'
    ctx.textBaseline = 'middle'
    const placed: number[] = []
    const overlaps = (x: number, y: number, w: number, h: number) => {
      for (let p = 0; p < placed.length; p += 4)
        if (
          x < (placed[p] as number) + (placed[p + 2] as number) &&
          x + w > (placed[p] as number) &&
          y < (placed[p + 1] as number) + (placed[p + 3] as number) &&
          y + h > (placed[p + 1] as number)
        )
          return true
      return false
    }
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
    const must = [st.active, st.selected, st.focus, st.hover].filter((i) => i >= 0)
    const groups: number[] = []
    for (let i = 0; i < sc.n; i++) if (isGroup(i)) groups.push(i)
    const order = [...must, ...near, ...st.hubs, ...groups]
    if (view.scale >= 1.4 || (st.hop && st.focus >= 0)) for (let i = 0; i < sc.n; i++) order.push(i)
    const seen = new Set<number>()
    let named = 0
    for (const i of order) {
      if (named >= MAX_LABELS) break
      if (seen.has(i) || !st.nodes[i]) continue
      seen.add(i)
      const raw = sc.labels[i] ?? ''
      const text = raw.length > 40 ? `${raw.slice(0, 39)}…` : raw
      let w = this.widths.get(i)
      if (w === undefined) {
        w = ctx.measureText(text).width
        this.widths.set(i, w)
      }
      const cx = SX(i)
      const cy = SY(i)
      if (cx < -10 || cx > st.width + 10 || cy < -10 || cy > st.height + 10) continue
      const off = radius(i) * (isGroup(i) ? 1 : 1.3) + 6
      // Right of the item, else left of it, else above, else below; always inside the canvas.
      const inside = (x: number, y: number): [number, number] => [
        Math.min(Math.max(4, x), st.width - w - 4),
        Math.min(Math.max(10, y), st.height - 10),
      ]
      const spots: [number, number][] = [
        inside(cx + off, cy),
        inside(cx - off - w, cy),
        inside(cx - w / 2, cy - off - 4),
        inside(cx - w / 2, cy + off + 4),
      ]
      const forced = must.includes(i)
      const spot =
        spots.find(([x, y]) => !overlaps(x - 2, y - 8, w + 4, 16)) ?? (forced ? spots[0] : undefined)
      if (!spot) continue
      const [x, y] = spot
      placed.push(x - 2, y - 8, w + 4, 16)
      // A halo of the ground colour keeps the name readable over lines.
      ctx.lineWidth = 4
      ctx.lineJoin = 'round'
      ctx.strokeStyle = st.palette.ground
      ctx.globalAlpha = dim(i) ? 0.6 : 1
      ctx.strokeText(text, x, y)
      ctx.fillStyle = i === st.selected || i === st.active ? st.palette.accent : st.palette.text
      ctx.fillText(text, x, y)
      ctx.globalAlpha = 1
      named += 1
    }
  }
}
