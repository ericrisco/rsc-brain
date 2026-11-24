// Painting the graph (plan §3.4; v0.5.0). The painter runs in the graph's worker on an OffscreenCanvas, so the
// page never waits for a picture (CA6); without OffscreenCanvas it runs on the page. It paints when the
// positions, the size or what the person does changes: frame after frame only while the layout moves.
//
// A flat picture with no words on it: each page a small neutral dot, bigger the more links it has; each group a
// rounded box; each link a thin pale line. What the picture is about (the page picked or under the pointer, its
// neighbours and its lines) takes the accent; the rest dims. In high contrast the pick's ring is thicker. Words come only on
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
  // The pages' grey per community slot (one neutral for all), the small ones' and the pages without links'.
  com: string[]
  other: string
  lone: string
  // The width of the ring of the page picked (thicker in high contrast).
  ring: number
  // The font of the labels (a CSS font family); the labels fall back to the browser's sans.
  font?: string
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
  // The names the picture may write beside the pages, the most linked first: `labelOf[k]` is an item's index,
  // `labelText[k]` its name (already short). Empty when there is nothing to name.
  labelOf?: Uint32Array
  labelText?: string[]
}

// How many names the picture writes at a zoom: few when the whole wiki is in view, more as the person zooms in.
// The names also keep clear of each other, so this is a ceiling, not a count.
export const labelCap = (scale: number) => Math.min(300, Math.ceil(10 * Math.max(0.4, scale) ** 2))

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
  // How the picture looks: plain (the default), or a hologram (a polar grid behind, glowing pages, a reticle
  // round the hubs). The person's choice; the same items, lines, rings and dimming either way.
  look?: Look
}

export type Look = 'plain' | 'holo'

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
  counts?: { lit: number; dim: number; lines: number; named?: number }
  // For a test: the rings drawn, by what they mark, with their radius and whether they are dashed.
  rings?: { what: string; r: number; dashed: boolean; width: number }[]
  // For a test: in the hologram look, how many reticles were drawn round the hubs.
  reticles?: number
}

// How far Fit zooms in at most: a small wiki's pages are dots with room between them, not blobs.
const FIT_MAX = 3
// How strong the lines are: at rest; brightened (the page under the pointer or picked); behind a pick.
export const EDGE = { quiet: 0.28, lit: 0.9, behind: 0.06 }
// How strong the pages are behind a pick, and behind the page under the pointer.
export const DIM = { picked: 0.16, hover: 0.35 }
// The hologram look: how strong the grid behind is, how far the pages glow, and how many of the best-linked
// pages get a reticle (never one with fewer than HOLO.hubMin links).
export const HOLO = { grid: 0.14, glow: 10, hubs: 24, hubMin: 3 }

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

    const holo = st.look === 'holo'
    if (holo) backdrop(ctx, sc, st, SX, SY, palette)

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
      ctx.strokeStyle = palette.accent
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
    const slotColour = (slot: number) =>
      palette.com[slot] ?? (slot === palette.com.length ? palette.other : palette.lone)
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
        // Bright behind a pick or the pointer: the page the picture is about and its neighbours, in the accent.
        ctx.fillStyle = lit && tier !== 2 ? palette.accent : slotColour(slot)
        ctx.globalAlpha = tier === 0 ? 1 : tier === 1 ? 0.5 : behind
        if (holo && tier === 0) {
          ctx.shadowColor = ctx.fillStyle
          ctx.shadowBlur = HOLO.glow
        }
        ctx.fill()
        if (holo) ctx.shadowBlur = 0
      }
    }
    // The hologram look: a reticle round the best-linked pages (and the groups), in their colour, its opening
    // turned by the item so they do not all look alike. Behind a pick they dim with the rest.
    let reticles = 0
    if (holo) {
      for (const i of hubs(sc, st)) {
        const r = radius(i) * (isGroup(i) ? 1.5 : 1) + 5
        const x = SX(i)
        const y = SY(i)
        const turn = (i * 2.399) % (Math.PI * 2)
        ctx.strokeStyle = lit?.[i] ? palette.accent : slotColour(sc.colour[i] as number)
        ctx.globalAlpha = lit && !lit[i] ? behind * 0.8 : 0.75
        ctx.lineWidth = 1.1
        ctx.beginPath()
        for (let k = 0; k < 3; k++) {
          const a = turn + (k * Math.PI * 2) / 3
          ctx.moveTo(x + r * Math.cos(a), y + r * Math.sin(a))
          ctx.arc(x, y, r, a, a + Math.PI * 0.42)
        }
        ctx.stroke()
        // Four ticks outside, like a sight.
        ctx.beginPath()
        for (let k = 0; k < 4; k++) {
          const a = turn + (k * Math.PI) / 2 + Math.PI / 4
          ctx.moveTo(x + (r + 2) * Math.cos(a), y + (r + 2) * Math.sin(a))
          ctx.lineTo(x + (r + 5) * Math.cos(a), y + (r + 5) * Math.sin(a))
        }
        ctx.globalAlpha *= 0.7
        ctx.stroke()
        reticles += 1
      }
      ctx.globalAlpha = 1
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

    // Names: the most linked pages first, as many as the zoom allows, each clear of those already written.
    let named = 0
    if (sc.labelOf?.length && sc.labelText) {
      const cap = labelCap(view.scale)
      const size = 11
      ctx.font = `${size}px ${palette.font ?? 'sans-serif'}, sans-serif`
      ctx.textBaseline = 'middle'
      ctx.textAlign = 'left'
      ctx.lineJoin = 'round'
      ctx.lineWidth = 3
      ctx.strokeStyle = palette.ground
      ctx.fillStyle = palette.text
      ctx.globalAlpha = 1
      const placed: number[] = []
      for (let k = 0; k < sc.labelOf.length && named < cap; k++) {
        const i = sc.labelOf[k] as number
        if (!st.nodes[i] || (lit && !lit[i])) continue
        const x = SX(i) + radius(i) + 3
        const y = SY(i)
        if (x < 0 || x > st.width || y < 0 || y > height) continue
        const text = sc.labelText[k] as string
        const w = ctx.measureText(text).width
        // Never half off the edge of the picture.
        if (x + w > st.width) continue
        let clash = false
        for (let p = 0; p < placed.length; p += 4)
          if (
            x < (placed[p + 2] as number) &&
            x + w > (placed[p] as number) &&
            y - size / 2 < (placed[p + 3] as number) &&
            y + size / 2 > (placed[p + 1] as number)
          ) {
            clash = true
            break
          }
        if (clash) continue
        placed.push(x, y - size / 2, x + w, y + size / 2)
        ctx.strokeText(text, x, y)
        ctx.fillText(text, x, y)
        named += 1
      }
    }

    // Rings: the page under the pointer (thin, light), the page in focus, the one picked (solid), and where the
    // keyboard is (dashed, further out): told apart by their shape, not their colour alone.
    const rings: { what: string; r: number; dashed: boolean; width: number }[] = []
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
      if (st.probe) rings.push({ what, r: Math.round(r * 10) / 10, dashed: dash.length > 0, width })
    }
    ring('hover', hovered, 1.5, 2, palette.text)
    ring('focus', st.focus, 1.5, 4, palette.muted)
    ring('selected', st.selected, palette.ring, 3, palette.accent)
    ring('active', st.active, 2, 8, palette.accent, [4, 3])

    const at = (i: number): [number, number] | null =>
      i >= 0 && st.nodes[i] ? [Math.round(SX(i)), Math.round(SY(i))] : null
    return {
      view,
      active: at(st.active),
      selected: at(st.selected),
      ms: performance.now() - started,
      seq: st.seq,
      ...(st.probe
        ? { counts: { lit: litCount, dim: dimCount, lines, ...(sc.labelOf ? { named } : {}) }, rings }
        : {}),
      ...(st.probe && holo ? { reticles } : {}),
    }
  }
}

// The hologram look's hubs: the best-linked pages drawn (HOLO.hubs at most, each with HOLO.hubMin links or
// more), and every group drawn.
export function hubs(sc: Scene, st: State): number[] {
  const groups: number[] = []
  const pages: number[] = []
  for (let i = 0; i < sc.n; i++) {
    if (!st.nodes[i]) continue
    if (sc.group[i] === 1) groups.push(i)
    else if ((sc.degree[i] as number) >= HOLO.hubMin) pages.push(i)
  }
  pages.sort((a, b) => (sc.degree[b] as number) - (sc.degree[a] as number) || a - b)
  return [...groups, ...pages.slice(0, HOLO.hubs)]
}

// The hologram look's ground: a polar grid round the middle of what is drawn (rings, spokes and the ticks of
// a dial), faint, in the accent colour. Drawn under the lines; it carries no information.
function backdrop(
  ctx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D,
  sc: Scene,
  st: State,
  SX: (i: number) => number,
  SY: (i: number) => number,
  palette: Palette,
): void {
  let cx = 0
  let cy = 0
  let k = 0
  for (let i = 0; i < sc.n; i++) {
    if (!st.nodes[i]) continue
    cx += SX(i)
    cy += SY(i)
    k += 1
  }
  if (k === 0) {
    cx = st.width / 2
    cy = st.height / 2
  } else {
    cx /= k
    cy /= k
  }
  const R = Math.hypot(st.width, st.height) / 2
  const step = Math.max(60, Math.min(st.width, st.height) / 7)
  ctx.save()
  ctx.strokeStyle = palette.accent
  ctx.lineWidth = 1
  // Paint the scan lines and corner marks on the same canvas as the grid. They stay
  // behind the nodes and cannot cover the keyboard outline or intercept the pointer.
  ctx.globalAlpha = 0.05
  ctx.beginPath()
  for (let y = 0.5; y < st.height; y += 3) {
    ctx.moveTo(0, y)
    ctx.lineTo(st.width, y)
  }
  ctx.stroke()
  ctx.globalAlpha = 0.6
  ctx.beginPath()
  for (const dx of [1, -1]) {
    for (const dy of [1, -1]) {
      const x = dx === 1 ? 10 : st.width - 10
      const y = dy === 1 ? 10 : st.height - 10
      ctx.moveTo(x + dx * 28, y)
      ctx.lineTo(x, y)
      ctx.lineTo(x, y + dy * 28)
    }
  }
  ctx.stroke()
  ctx.globalAlpha = HOLO.grid
  ctx.setLineDash([2, 5])
  ctx.beginPath()
  for (let r = step; r < R; r += step) {
    ctx.moveTo(cx + r, cy)
    ctx.arc(cx, cy, r, 0, Math.PI * 2)
  }
  ctx.stroke()
  ctx.setLineDash([])
  ctx.globalAlpha = HOLO.grid * 0.6
  ctx.beginPath()
  for (let s = 0; s < 12; s++) {
    const a = (s * Math.PI) / 6
    ctx.moveTo(cx + step * 0.5 * Math.cos(a), cy + step * 0.5 * Math.sin(a))
    ctx.lineTo(cx + R * Math.cos(a), cy + R * Math.sin(a))
  }
  ctx.stroke()
  // The dial: a solid ring with a tick every 5°, longer every 30°.
  const dial = step * 3
  ctx.globalAlpha = HOLO.grid * 1.6
  ctx.beginPath()
  ctx.moveTo(cx + dial, cy)
  ctx.arc(cx, cy, dial, 0, Math.PI * 2)
  for (let d = 0; d < 360; d += 5) {
    const a = (d * Math.PI) / 180
    const len = d % 30 === 0 ? 9 : 4
    ctx.moveTo(cx + dial * Math.cos(a), cy + dial * Math.sin(a))
    ctx.lineTo(cx + (dial + len) * Math.cos(a), cy + (dial + len) * Math.sin(a))
  }
  ctx.stroke()
  ctx.restore()
}
