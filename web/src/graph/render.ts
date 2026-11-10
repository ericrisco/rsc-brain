// Painting the graph (plan §3.4; v0.5.0). The painter runs in the graph's worker on an OffscreenCanvas, so the
// page never waits for a picture (CA6); without OffscreenCanvas it runs on the page. It paints when the
// positions, the size or what the person does changes: frame after frame only while the layout moves.
//
// A flat picture with no words on it: each page a small dot in its community's colour (communities.ts),
// bigger the more links it has; each group a rounded box; each link a thin pale line. Words come only on
// asking: the page under the pointer gets a tooltip and the page clicked the inspector, both in the DOM.
// Under the pointer a page and its lines are brightened; picked, it and its neighbours stay bright and the
// rest dims. Never by colour alone: a superseded page is dimmed and struck through, the page picked has a solid
// ring and the page under the keyboard a dashed one further out.
import { grow } from './layout.ts'
import type { View } from './model.ts'
import { fit, fitPad, groupRadius } from './model.ts'

export type Palette = {
  // The lines at rest.
  edge: string
  text: string
  muted: string
  accent: string
  ground: string
  // The communities' colours (tokens.css --com-0 …), then the small ones' and the pages without links'.
  com: string[]
  other: string
  lone: string
}

export const NODE_R = 4

// Pages shrink when the picture is zoomed far out (many pages on a phone), never below 1.6 px.
export const nodeRadius = (scale: number) => Math.min(NODE_R * 1.5, Math.max(1.6, NODE_R * Math.sqrt(scale)))

// What does not change while the layout moves: the items, their links, their colours.
export type Scene = {
  n: number
  pages: number
  byGroups: boolean
  // Per item: 1 for a group's box.
  group: Uint8Array
  superseded: Uint8Array
  // Per group: its pages (the box's size); 0 for a page.
  count: Uint32Array
  degree: Uint32Array
  edges: Uint32Array
  // Per item: its colour slot (communities.ts): an index in the palette's `com`, then other, then lone.
  colour: Uint8Array
}

// What changes as the person looks.
export type State = {
  width: number
  height: number
  dpr: number
  palette: Palette
  // What is drawn: the filters and the communities shown.
  nodes: Uint8Array
  edges: Uint8Array
  // What the view fits.
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
  // In focus: [page, two-hop item] pairs reached only through one-hop pages a filter hides (a faint line).
  bridges: Uint32Array | null
  // The height at the bottom of the canvas a sheet covers (a phone's inspector): fit leaves it out.
  inset: number
  // The band at the top the screen's controls cover: fit draws below it.
  top: number
  // The width at the right the panels cover (the communities, the inspector): fit draws left of it.
  right: number
  // The band at the bottom the zoom buttons cover: fit draws above it.
  bottom: number
  // The column at the left the place and focus bar cover: fit draws right of it.
  left: number
  // Which state this is: the picture drawn from it says so (tests wait for the picture of the last one).
  seq: number
  // A test drives the browser (navigator.webdriver): the picture says a little more about itself.
  probe: boolean
}

export type Drawn = {
  view: View
  // Where the page under the keyboard is drawn on the canvas.
  active: [number, number] | null
  // Where the page picked is drawn on the canvas.
  selected: [number, number] | null
  // How long this picture took to paint, in ms (the timing tests add it up: CDP cannot slow a worker).
  ms: number
  // The state this picture was drawn from (State.seq).
  seq: number
  // For a test: how many items and lines were drawn, at full strength and dimmed.
  counts?: { lit: number; dim: number; lines: number }
  // For a test: the rings drawn, by what they mark, with their radius and whether they are dashed.
  rings?: { what: string; r: number; dashed: boolean }[]
}

// How far Fit zooms in at most: a small wiki's pages are dots with room between them, not blobs.
const FIT_MAX = 3
// How strong the lines are: at rest; brightened (the page under the pointer or picked); behind a pick.
export const EDGE = { quiet: 0.28, lit: 0.9, behind: 0.06 }
// How strong the pages are behind a pick, and behind the page under the pointer.
export const DIM = { picked: 0.16, hover: 0.35 }

export class Renderer {
  scene: Scene | null = null
  state: State | null = null
  // The layout: [x0, y0, …].
  layout: Float32Array | null = null

  setScene(s: Scene): void {
    this.scene = s
    this.layout = null
  }

  // Paints a frame; null when there is nothing to paint yet.
  paint(ctx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D): Drawn | null {
    const sc = this.scene
    const st = this.state
    if (!sc || !st || st.width === 0 || st.height === 0) return null
    const flat = st.xy !== null && st.xy.length === 2 * sc.n
    const xy = flat ? (st.xy as Float32Array) : this.layout
    if (!xy || xy.length !== 2 * sc.n) return null
    const started = performance.now()
    const height = Math.max(120, st.height - Math.max(st.inset, st.bottom))
    const view: View = st.autoFit
      ? fit(xy, st.fit, st.width, height, fitPad(sc, st.fit), st.top, {
          max: FIT_MAX,
          right: st.right,
          left: st.left,
        })
      : st.view
    const { palette, dpr } = st
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    ctx.clearRect(0, 0, st.width, st.height)
    const SX = (i: number) => (xy[2 * i] as number) * view.scale + view.tx
    const SY = (i: number) => (xy[2 * i + 1] as number) * view.scale + view.ty
    const base = nodeRadius(view.scale)
    const isGroup = (i: number) => sc.group[i] === 1
    const boxR = (i: number) => groupRadius(sc.count[i] as number) * (sc.byGroups ? 1 : 0.6)
    const radius = (i: number) => {
      if (isGroup(i)) return boxR(i)
      const r = base * grow(sc.degree[i] as number)
      return st.hop && st.hop[i] === 2 ? r * 0.8 : r
    }
    const colourOf = (i: number) => {
      const c = sc.colour[i] as number
      return c < palette.com.length
        ? (palette.com[c] as string)
        : c === palette.com.length
          ? palette.other
          : palette.lone
    }

    // The page the picture is about: under the pointer, or else the one picked. It and its neighbours stay
    // bright; the rest dims, more behind a pick than behind the pointer.
    const hovered = st.hover >= 0 && st.nodes[st.hover] ? st.hover : -1
    const picked = st.selected >= 0 && st.nodes[st.selected] ? st.selected : -1
    const on = hovered >= 0 ? hovered : picked
    let lit: Uint8Array | null = null
    if (on >= 0) {
      lit = new Uint8Array(sc.n)
      lit[on] = 1
      for (let e = 0; e < st.edges.length; e++) {
        if (!st.edges[e]) continue
        const i = sc.edges[2 * e] as number
        const j = sc.edges[2 * e + 1] as number
        if (i === on) lit[j] = 1
        if (j === on) lit[i] = 1
      }
    }
    const behind = hovered >= 0 ? DIM.hover : DIM.picked

    // In focus: the two rings the hops sit on, faint.
    if (st.hop && st.focus >= 0 && st.nodes[st.focus]) {
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
    }

    // Lines: the quiet ones in one path, then the brightened ones (those of the page the picture is about).
    let lines = 0
    ctx.lineCap = 'round'
    ctx.beginPath()
    const bright: number[] = []
    for (let e = 0; e < st.edges.length; e++) {
      if (!st.edges[e]) continue
      const i = sc.edges[2 * e] as number
      const j = sc.edges[2 * e + 1] as number
      if (!st.nodes[i] || !st.nodes[j]) continue
      lines += 1
      if (on >= 0 && (i === on || j === on)) {
        bright.push(i, j)
        continue
      }
      ctx.moveTo(SX(i), SY(i))
      ctx.lineTo(SX(j), SY(j))
    }
    ctx.lineWidth = sc.byGroups ? 1.5 : 0.7
    ctx.strokeStyle = palette.edge
    ctx.globalAlpha = on >= 0 ? EDGE.behind : EDGE.quiet
    ctx.stroke()
    if (bright.length) {
      ctx.beginPath()
      for (let k = 0; k < bright.length; k += 2) {
        ctx.moveTo(SX(bright[k] as number), SY(bright[k] as number))
        ctx.lineTo(SX(bright[k + 1] as number), SY(bright[k + 1] as number))
      }
      ctx.lineWidth = 1.3
      ctx.strokeStyle = colourOf(on)
      ctx.globalAlpha = EDGE.lit
      ctx.stroke()
    }

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
    }

    // Items: one path per colour and strength. A superseded page is drawn at half strength and struck through.
    const slots = palette.com.length + 2
    let litCount = 0
    let dimCount = 0
    for (let slot = 0; slot < slots; slot++) {
      for (const tier of [0, 1, 2] as const) {
        // 0: bright, 1: superseded, 2: dimmed behind the page the picture is about.
        ctx.beginPath()
        let any = false
        for (let i = 0; i < sc.n; i++) {
          if (!st.nodes[i] || sc.colour[i] !== slot) continue
          const t = lit && !lit[i] ? 2 : sc.superseded[i] ? 1 : 0
          if (t !== tier) continue
          const x = SX(i)
          const y = SY(i)
          const r = radius(i)
          if (isGroup(i)) {
            ctx.roundRect(x - r, y - r, 2 * r, 2 * r, r * 0.3)
          } else {
            ctx.moveTo(x + r, y)
            ctx.arc(x, y, r, 0, Math.PI * 2)
          }
          any = true
          if (t === 2) dimCount += 1
          else litCount += 1
        }
        if (!any) continue
        ctx.fillStyle =
          slot < palette.com.length
            ? (palette.com[slot] as string)
            : slot === palette.com.length
              ? palette.other
              : palette.lone
        ctx.globalAlpha = tier === 0 ? 1 : tier === 1 ? 0.5 : behind
        ctx.fill()
      }
    }
    // The strike of superseded pages.
    ctx.beginPath()
    let struck = false
    for (let i = 0; i < sc.pages; i++) {
      if (!st.nodes[i] || sc.superseded[i] !== 1 || (lit && !lit[i])) continue
      const r = radius(i) * 1.6
      ctx.moveTo(SX(i) - r, SY(i) + r)
      ctx.lineTo(SX(i) + r, SY(i) - r)
      struck = true
    }
    if (struck) {
      ctx.lineWidth = 1.2
      ctx.strokeStyle = palette.text
      ctx.globalAlpha = 0.8
      ctx.stroke()
    }
    ctx.globalAlpha = 1

    // Rings: the page under the pointer (thin, light), the page in focus, the one picked (solid), and where the
    // keyboard is (dashed, further out): told apart by their shape, not their colour alone.
    const rings: { what: string; r: number; dashed: boolean }[] = []
    const ring = (
      what: string,
      i: number,
      width: number,
      gap: number,
      color: string,
      dash: number[] = [],
    ) => {
      if (i < 0 || !st.nodes[i]) return
      const r = (isGroup(i) ? boxR(i) * 1.45 : radius(i)) + gap
      ctx.beginPath()
      ctx.arc(SX(i), SY(i), r, 0, Math.PI * 2)
      ctx.lineWidth = width
      ctx.strokeStyle = color
      ctx.setLineDash(dash)
      ctx.stroke()
      ctx.setLineDash([])
      if (st.probe) rings.push({ what, r: Math.round(r * 10) / 10, dashed: dash.length > 0 })
    }
    ring('hover', hovered, 1.5, 2, palette.text)
    ring('focus', st.focus, 1.5, 4, palette.muted)
    ring('selected', st.selected, 2.5, 3, palette.accent)
    ring('active', st.active, 2, 8, palette.accent, [4, 3])

    const at = (i: number): [number, number] | null =>
      i >= 0 && st.nodes[i] ? [Math.round(SX(i)), Math.round(SY(i))] : null
    return {
      view,
      active: at(st.active),
      selected: at(st.selected),
      ms: performance.now() - started,
      seq: st.seq,
      ...(st.probe ? { counts: { lit: litCount, dim: dimCount, lines }, rings } : {}),
    }
  }
}
