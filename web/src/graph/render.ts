// Painting the graph (plan §3.4). The painter runs in the graph's worker on an OffscreenCanvas, so the page
// never waits for a picture (CA6: on a slow machine the copy of a painted canvas alone used to block the page
// for longer than 200 ms); without OffscreenCanvas it runs on the page. It paints when the positions, the
// size or what the person does changes; it paints frame after frame only while the cloud turns or pulses
// travel, and never with reduced motion.
//
// The cloud (spec amendment 2026-11-09, CA12): the layout is in three dimensions and the camera (camera.ts)
// draws it in perspective, near points bigger and brighter, on top of far ones. Each family has its colour and
// a pill at the middle of its points; the brain's hub sits in the middle; the most linked pages are bigger and
// haloed. At rest, with motion allowed, it turns slowly and light pulses travel along the lines; a fact card
// shows one page after another. Touched, it stops and draws names and cards as a flat picture would.
//
// What says what, never by colour alone: a page's shape says its type and its size how linked it is; a
// superseded page is dimmed and struck through; a line's dash and width say its link kind, with an arrowhead
// for the kinds that have a direction; links with a group are wide and pale. In focus, the page sits in the
// middle, one hop on a filled ring and two hops on a hollow, smaller one. Names go where they fit: the item
// the person is on, its neighbours, the hubs, the groups, and everything once zoomed in.

import {
  CAMERA,
  type Camera,
  type Frame,
  frameOf,
  parkRows,
  project,
  projectPoint,
  spinBox,
  yawText,
} from './camera.ts'
import {
  CARD_MAX,
  CARD_PAD,
  type Card,
  clipToRect,
  dotGrid,
  fitCards,
  GROUP_MAX,
  placeCards,
  placeLabels,
  TILE_H,
  TILE_MIN,
  TILE_SCALE,
  TILE_TEXT,
} from './cards.ts'
import { centroids } from './families.ts'
import type { View } from './model.ts'
import { fit, fitPad, GROUP_SHAPE, groupRadius } from './model.ts'

export { fitPad, GROUP_SHAPE, groupRadius }

export type Palette = {
  // The lines at rest.
  edge: string
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
  // The families' colours and their dim grounds (shared.css v2 --fam-*), in the order of families.ts, the
  // pulses' light, and the words on a panel.
  fam: string[]
  famDim: string[]
  pulse: string
  panelInk: string
}

export const SHAPES = ['topic', 'entity', 'decision', 'guide', 'agent', 'source', 'overview'] as const

// Each link kind: its dash (screen px), width, and whether it points somewhere (an arrowhead at its end).
import { EDGE, LINE } from './lines.ts'

export { EDGE, LINE }

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
  // Per item: its family (families.ts), and each family's name on its pill.
  fam: Uint8Array
  famNames: string[]
  // The brain in the middle of the cloud: its initial and its name.
  hub: { initial: string; name: string } | null
}

// A page the fact card can show: its title, and where it comes from and when.
export type Fact = { i: number; title: string; sub: string }

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
  // The boxes of the controls over the canvas (x, y, w, h, …): no card is drawn under them.
  blocked: number[]
  // Which state this is: the picture drawn from it says so (tests wait for the picture of the last one).
  seq: number
  // A test drives the browser (navigator.webdriver): the picture also says the words of its cards.
  probe: boolean
  // The cloud turns (nobody touches it, motion is allowed, the tab is seen), and light travels its lines
  // (motion is allowed and the tab is seen).
  spin: boolean
  pulses: boolean
  // The person turned the cloud: the camera to draw with, applied once per seq.
  camera: (Camera & { seq: number }) | null
}

export type Drawn = {
  view: View
  active: [number, number] | null
  // The cards drawn, first the most wanted (the page finds what is under the pointer from them).
  cards: Card[]
  // The names written beside points, where no card fits.
  labels: Card[]
  // The step of the dotted ground in screen pixels (0: left out).
  dots: number
  // Each card's words as drawn (a cut title ends in "…"), in the order of `cards`.
  titles: string[]
  // How long this picture took to paint, in ms (the timing tests add it up: CDP cannot slow a worker).
  ms: number
  // The state this picture was drawn from (State.seq).
  seq: number
  // Where each item is on the flat picture, in the layout's units (the camera's projection), when it changed
  // and the cloud is still; null otherwise (the page keeps the last one for the pointer and the keys).
  xy: Float32Array | null
  // The camera, and whether the cloud is turning; the families' pills drawn; the hub's place; the pulses on
  // the lines; the page on the fact card (−1: none).
  yaw: number
  pitch: number
  spinning: boolean
  families: string[]
  hub: [number, number] | null
  // Where the caption over the pages without links is written (null: none).
  orphans: [number, number] | null
  pulses: number
  fact: number
  // The picture asks for the next frame (it turns, or light travels).
  animating: boolean
}

// A line's path key: kind (−1 for a group's line), strength 0–2, family 0–6 or ACROSS, depth step 0–3.
const ACROSS = 7
const lineKey = (kind: number, tier: number, family: number, step: number) =>
  (((kind + 1) * 3 + tier) * 8 + family) * 4 + step

// What the cloud is drawn from, and what its still part gives back.
type CloudInput = {
  xy: Float32Array
  depth: Float32Array
  view: View
  spinning: boolean
  now: number
  dt: number
  lit: Uint8Array | null
  dim: (i: number) => boolean
  isGroup: (i: number) => boolean
  boxR: (i: number) => number
  radius: (i: number) => number
  SX: (i: number) => number
  SY: (i: number) => number
}
type CloudOut = {
  cards: Card[]
  labels: Card[]
  families: string[]
  hub: [number, number] | null
  orphans: [number, number] | null
  // The lines drawn (light travels them) and each point's radius as drawn.
  edges: number[]
  rad: (i: number) => number
}

// The fit mask without the pages without links: the cloud the camera turns (review R6).
function cloudOnly(mask: Uint8Array, role: Uint8Array): Uint8Array {
  const m = mask.slice()
  let left = 0
  for (let i = 0; i < m.length; i++) {
    if (role[i] === 1) m[i] = 0
    left += m[i] as number
  }
  return left ? m : mask
}

// A box ([x, y] corners) grown to hold the rows of pages without links the mask keeps, as parked.
function withRows(box: Float32Array, xy: Float32Array, role: Uint8Array, mask: Uint8Array): Float32Array {
  let [x0, y0, x1, , , y1] = box as unknown as number[]
  for (let i = 0; i < role.length; i++) {
    if (role[i] !== 1 || !mask[i]) continue
    x0 = Math.min(x0 as number, xy[2 * i] as number)
    x1 = Math.max(x1 as number, xy[2 * i] as number)
    y0 = Math.min(y0 as number, xy[2 * i + 1] as number)
    y1 = Math.max(y1 as number, xy[2 * i + 1] as number)
  }
  return new Float32Array([x0, y0, x1, y0, x1, y1, x0, y1] as number[])
}

// The caption over the rows of pages without links; where it is written, or null.
function orphanCaption(
  ctx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D,
  st: State,
  sc: Scene,
  SX: (i: number) => number,
  SY: (i: number) => number,
  base: number,
  ink: string,
): [number, number] | null {
  if (!st.orphanLabel || st.xy) return null
  let x = Number.POSITIVE_INFINITY
  let y = Number.POSITIVE_INFINITY
  for (let i = 0; i < sc.n; i++)
    if (st.nodes[i] && sc.role[i] === 1) {
      x = Math.min(x, SX(i))
      y = Math.min(y, SY(i))
    }
  if (!Number.isFinite(x)) return null
  const at: [number, number] = [Math.max(4, x - base), y - base - 6]
  ctx.font = `12px ${MONO}`
  ctx.textBaseline = 'bottom'
  ctx.fillStyle = ink
  ctx.globalAlpha = 1
  ctx.fillText(st.orphanLabel, at[0], at[1])
  return [Math.round(at[0]), Math.round(at[1])]
}

// The interface's monospaced face (shared.css v2), with its fallbacks.
const MONO = '"JetBrains Mono", ui-monospace, SFMono-Regular, Menlo, Consolas, monospace'
const TITLE = `13px ${MONO}`
const GROUP_TITLE = `700 13px ${MONO}`
const SUB = `12px ${MONO}`
// How far Fit zooms in at most: far enough that a small wiki's pages are drawn as cards side by side.
const FIT_MAX = 8
// How many cards a picture describes to a test.
export const PROBE_CARDS = 40
const TILE_TITLE = `700 14px ${MONO}`
// A name beside a point: 12 px (its width is the card title's, at 13 px, scaled).
const LABEL = `12px ${MONO}`
const PILL = `700 11px ${MONO}`
const HUB = `700 18px ${MONO}`
// How long the fact card shows one page, and how long it fades in and out.
export const FACT_MS = 4200
const FACT_FADE = 600
// The pulses: how many at most, and one for this many lines.
const PULSES_MAX = 40
const PULSE_EVERY = 6
const ONES4 = new Uint8Array([1, 1, 1, 1])
// Room around the turning cloud when it is fitted, and the share of its points the fit keeps in the frame.
const SPIN_PAD = 16
const SPIN_KEEP = 0.9
// From this many items drawn, the still cloud names only what the person is on and its neighbours.
const QUIET_FROM = 60
const LABEL_SCALE = 12 / 13
// Where a card's words start: after the disc with the type's shape.
const TEXT_X = 32

export class Renderer {
  scene: Scene | null = null
  state: State | null = null
  // The layout: [x0, y0, z0, …] (z 0 for a flat one).
  layout: Float32Array | null = null
  // Each item's words as a card shows them (cut to fit), and their width: measured once.
  private words = new Map<number, { t: string; s: string; w: number }>()
  // The camera, the frame it turns about, and the projection drawn last.
  camera: Camera = { yaw: CAMERA.yaw0, pitch: CAMERA.pitch0 }
  private cameraSeq = -1
  private frame: { of: Float32Array; mask: Uint8Array; f: Frame } | null = null
  private box: { of: Float32Array; mask: Uint8Array; pitch: number; b: Float32Array } | null = null
  private proj = new Float32Array(0)
  private depth = new Float32Array(0)
  // The projection last sent to the page, by everything it depends on: the frame (layout and fit mask) and the
  // camera. Any of them changing moves the points on screen (review R2).
  private sent = ''
  private frames = 0
  // The still cloud, painted once for its state and camera (review R7).
  private still: { key: string; layout: Float32Array | null; out: CloudOut } | null = null
  private stillLayer: OffscreenCanvas | null = null
  private exact: { key: string; layout: Float32Array; view: View } | null = null
  private turning = false
  private last = 0
  private facts: Fact[] = []
  private factAt = 0
  private factIndex = -1
  // Pulses: per pulse its line, how far along it is (0–1, past 1 it fades out) and its speed per ms.
  private pulseEdge = new Int32Array(0)
  private pulseT = new Float32Array(0)
  private pulseV = new Float32Array(0)
  private seed = 48291

  setScene(s: Scene): void {
    this.scene = s
    this.layout = null
    this.frame = null
    this.box = null
    this.factIndex = -1
    this.pulseEdge = new Int32Array(0)
    this.words.clear()
    this.tiles.clear()
  }

  setLabels(labels: string[]): void {
    if (!this.scene) return
    this.scene = { ...this.scene, labels }
    this.words.clear()
    this.tiles.clear()
  }

  setFacts(facts: Fact[]): void {
    this.facts = facts
    this.factIndex = -1
  }

  private random(): number {
    this.seed = (this.seed + 0x6d2b79f5) >>> 0
    let t = this.seed
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }

  // Paints a frame; null when there is nothing to paint yet. `now` moves the turn, the pulses and the fact
  // card on.
  paint(
    ctx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D,
    now = performance.now(),
  ): Drawn | null {
    const sc = this.scene
    const st = this.state
    const layout = this.layout
    if (!sc || !st || st.width === 0 || st.height === 0) return null
    const flat = st.xy !== null && st.xy.length === 2 * sc.n
    if (!flat && (!layout || layout.length !== 3 * sc.n)) return null
    const started = performance.now()
    const dt = this.last ? Math.min(100, Math.max(0, now - this.last)) : 0
    this.last = now
    if (st.camera && st.camera.seq !== this.cameraSeq) {
      this.cameraSeq = st.camera.seq
      this.camera = { yaw: st.camera.yaw, pitch: st.camera.pitch }
    }
    let xy: Float32Array
    let depth: Float32Array | null = null
    let spinning = false
    const height = Math.max(120, st.height - Math.max(st.inset, st.bottom))
    const fitOn = (points: Float32Array, mask: Uint8Array, pad: number, max = FIT_MAX) =>
      fit(points, mask, st.width, height, pad, st.top, { max, right: st.right })
    let fitted: View | null = null
    if (flat) xy = st.xy as Float32Array
    else {
      const l = layout as Float32Array
      if (!this.frame || this.frame.of !== l || this.frame.mask !== st.fit) {
        this.frame = { of: l, mask: st.fit, f: frameOf(l, st.fit, sc.role) }
        this.frames += 1
      }
      const f = this.frame.f
      if (this.proj.length !== 2 * sc.n) {
        this.proj = new Float32Array(2 * sc.n)
        this.depth = new Float32Array(sc.n)
      }
      project(l, f, this.camera, this.proj, this.depth)
      parkRows(this.proj, sc.role, st.nodes, f)
      // A wiki small enough that Fit shows its pages as tiles is a flat picture to read: it does not turn.
      // Worked out once a state and still camera; while it turns, the one it started with (it only decides
      // whether the picture is tiles, which turning never changes: review R7).
      const exactKey = this.turning
        ? `${st.seq}|${this.frames}|turn`
        : `${st.seq}|${this.frames}|${this.camera.yaw}|${this.camera.pitch}`
      if (!this.exact || this.exact.key !== exactKey || this.exact.layout !== l)
        this.exact = {
          key: exactKey,
          layout: l,
          view: st.autoFit
            ? fitCards((pad, max) => fitOn(this.proj, st.fit, pad, max), fitPad(sc, st.fit))
            : st.view,
        }
      const exact = this.exact.view
      // With motion allowed the picture is fitted to what the cloud covers at any yaw (most of it): it never
      // breathes as it turns, and stopping it never rescales it.
      if (st.pulses && exact.scale < TILE_SCALE) {
        if (
          !this.box ||
          this.box.of !== l ||
          this.box.mask !== st.fit ||
          this.box.pitch !== this.camera.pitch
        )
          this.box = {
            of: l,
            mask: st.fit,
            pitch: this.camera.pitch,
            b: withRows(
              spinBox(l, cloudOnly(st.fit, sc.role), f, this.camera.pitch, SPIN_KEEP),
              this.proj,
              sc.role,
              st.fit,
            ),
          }
        fitted = st.autoFit ? fitOn(this.box.b, ONES4, SPIN_PAD, TILE_SCALE * 0.99) : st.view
        spinning = st.spin
        this.turning = spinning
        if (spinning) {
          this.camera.yaw += (dt * 2 * Math.PI) / CAMERA.turnMs
          project(l, f, this.camera, this.proj, this.depth)
          parkRows(this.proj, sc.role, st.nodes, f)
        }
      } else {
        fitted = exact
        this.turning = false
      }
      xy = this.proj
      depth = this.depth
    }
    const view: View =
      fitted ??
      (st.autoFit ? fitCards((pad, max) => fitOn(xy, st.fit, pad, max), fitPad(sc, st.fit)) : st.view)
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

    // What the page needs back to find what is under the pointer: the projection, when it changed and the
    // cloud is still.
    const xyOut = (): Float32Array | null => {
      // Turning (or flat), the page holds no projection: the next still one is always sent (review R3).
      if (spinning || flat) {
        this.sent = ''
        return null
      }
      const key = `${this.frames}|${this.camera.yaw}|${this.camera.pitch}`
      if (this.sent === key) return null
      this.sent = key
      return xy.slice()
    }
    const common = {
      yaw: this.camera.yaw,
      pitch: this.camera.pitch,
      spinning,
    }

    if (depth && !tile) {
      const out = this.cloud(ctx, st, sc, {
        xy,
        depth,
        view,
        spinning,
        now,
        dt,
        lit,
        dim,
        isGroup,
        boxR,
        radius,
        SX,
        SY,
      })
      const a = st.active
      return {
        view,
        active: a >= 0 && st.nodes[a] ? [Math.round(SX(a)), Math.round(SY(a))] : null,
        cards: out.cards,
        labels: out.labels,
        dots: 0,
        titles: st.probe
          ? out.cards.slice(0, PROBE_CARDS).map((c) => this.wordsOf(ctx, sc, c.i, isGroup(c.i)).t)
          : [],
        ms: performance.now() - started,
        seq: st.seq,
        xy: xyOut(),
        ...common,
        families: out.families,
        hub: out.hub,
        orphans: out.orphans,
        pulses: out.pulses,
        fact: out.fact,
        animating: out.animating,
      }
    }

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
    const { cards, labels } = this.place(ctx, st, sc, SX, SY, isGroup, tile)
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

    // Lines: one path per kind and strength, arrowheads in one path per kind. The lines of the page under the
    // pointer, or else of the page picked, are drawn last and at full strength.
    const on = st.hover >= 0 && st.nodes[st.hover] ? st.hover : st.selected
    ctx.lineCap = 'round'
    for (let k = -1; k < sc.kinds.length; k++) {
      const name = k < 0 ? 'group' : (sc.kinds[k] as string)
      const style = LINE[name] ?? (LINE.related as (typeof LINE)[string])
      for (const tier of [0, 1, 2] as const) {
        ctx.beginPath()
        const heads: number[] = []
        let any = false
        for (let e = 0; e < sc.kind.length; e++) {
          if (!st.edges[e] || sc.kind[e] !== k) continue
          const i = sc.edges[2 * e] as number
          const j = sc.edges[2 * e + 1] as number
          const touches = on >= 0 && (i === on || j === on)
          const t = touches ? 2 : (lit ? i !== st.hover && j !== st.hover : dim(i) || dim(j)) ? 0 : 1
          if (t !== tier) continue
          let x0 = SX(i)
          let y0 = SY(i)
          let x1 = SX(j)
          let y1 = SY(j)
          const ci = cardOf[i] as number
          const cj = cardOf[j] as number
          if (cj >= 0) [x1, y1] = clipToRect(x0, y0, x1, y1, cards[cj] as Card)
          if (ci >= 0) [x0, y0] = clipToRect(x1, y1, x0, y0, cards[ci] as Card)
          ctx.moveTo(x0, y0)
          ctx.lineTo(x1, y1)
          any = true
          if (k < 0) continue
          const len = Math.hypot(x1 - x0, y1 - y0)
          if (style.arrow && len > 28) heads.push(x0, y0, x1, y1, len, cj >= 0 ? -1 : radius(j))
        }
        if (!any) continue
        ctx.setLineDash(style.dash)
        // Between groups: wide; from the pages of an opened group to the boxes around it: thin, many as they are.
        const width = k < 0 ? (sc.byGroups ? 3 : 0.8) : style.width
        ctx.lineWidth = tier === 2 ? width + 0.6 : width
        const contradicts = name === 'contradicts'
        ctx.strokeStyle = contradicts ? palette.danger : tier === 2 ? palette.text : palette.edge
        ctx.globalAlpha =
          tier === 0
            ? EDGE.faint
            : tier === 2
              ? EDGE.lit
              : k < 0
                ? sc.byGroups
                  ? 0.25
                  : 0.1
                : contradicts
                  ? EDGE.contradicts
                  : EDGE.quiet
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
            ctx.lineTo(tx - ux * 6 - uy * 3, ty - uy * 6 + ux * 3)
            ctx.lineTo(tx - ux * 6 + uy * 3, ty - uy * 6 - ux * 3)
            ctx.closePath()
          }
          ctx.fillStyle = contradicts ? palette.danger : tier === 2 ? palette.text : palette.edge
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

    const orphans = orphanCaption(ctx, st, sc, SX, SY, base, palette.muted)

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
          // The family's colour (its type's: the shape says the same).
          const colour = palette.fam[t] ?? palette.text
          if (hollow) {
            ctx.lineWidth = 1.5
            ctx.strokeStyle = colour
            ctx.stroke()
          } else {
            ctx.fillStyle = colour
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
    this.drawLabels(ctx, st, sc, labels, lit, isGroup)
    ctx.textBaseline = 'alphabetic'
    const a = st.active
    return {
      view,
      active: a >= 0 && st.nodes[a] ? [Math.round(SX(a)), Math.round(SY(a))] : null,
      cards,
      labels,
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
      xy: xyOut(),
      ...common,
      families: [],
      hub: null,
      orphans,
      pulses: 0,
      fact: -1,
      animating: false,
    }
  }

  // The cloud: far to near, so the near points are drawn on top. Lines take their family's colour and fade
  // with depth; the most linked pages are haloed; each family has its pill; the hub sits in the middle; light
  // travels the lines; a fact card shows one page after another while it turns.
  private cloud(
    ctx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D,
    st: State,
    sc: Scene,
    o: CloudInput,
  ): CloudOut & { pulses: number; fact: number; animating: boolean } {
    // Still, the picture is the same from one frame of light to the next: it is painted once into a layer
    // kept for this state and camera, and each frame only copies it and draws the light (review R7).
    let base: CloudOut
    if (!o.spinning && typeof OffscreenCanvas !== 'undefined') {
      const key = `${st.seq}|${this.frames}|${this.camera.yaw}|${this.camera.pitch}|${st.width}|${st.height}|${st.dpr}`
      const w = Math.max(1, Math.round(st.width * st.dpr))
      const h = Math.max(1, Math.round(st.height * st.dpr))
      if (!this.still || this.still.key !== key || this.still.layout !== this.layout) {
        if (!this.stillLayer || this.stillLayer.width !== w || this.stillLayer.height !== h)
          this.stillLayer = new OffscreenCanvas(w, h)
        const lc = this.stillLayer.getContext('2d') as OffscreenCanvasRenderingContext2D
        lc.setTransform(st.dpr, 0, 0, st.dpr, 0, 0)
        lc.clearRect(0, 0, st.width, st.height)
        this.still = { key, layout: this.layout, out: this.cloudStill(lc, st, sc, o) }
      }
      ctx.setTransform(1, 0, 0, 1, 0, 0)
      ctx.drawImage(this.stillLayer as OffscreenCanvas, 0, 0)
      ctx.setTransform(st.dpr, 0, 0, st.dpr, 0, 0)
      base = this.still.out
    } else {
      this.still = null
      base = this.cloudStill(ctx, st, sc, o)
    }
    const pulses = this.light(ctx, st, sc, o, base.edges)
    // The fact card: while it turns, one page after another, with a ring around its point.
    let fact = -1
    const n = sc.n
    if (o.spinning && st.pulses && this.facts.length) {
      if (this.factIndex < 0 || o.now - this.factAt > FACT_MS) {
        for (let tries = 0; tries < this.facts.length; tries++) {
          this.factIndex = (this.factIndex + 1) % this.facts.length
          const c = this.facts[this.factIndex] as Fact
          if (c.i < n && st.nodes[c.i]) break
        }
        this.factAt = o.now
      }
      const c = this.facts[this.factIndex] as Fact
      if (c.i < n && st.nodes[c.i]) {
        fact = c.i
        const age = o.now - this.factAt
        const alpha = Math.min(1, age / FACT_FADE, (FACT_MS - age) / FACT_FADE)
        this.factCard(ctx, st, sc, c, o.SX(c.i), o.SY(c.i), base.rad(c.i), Math.max(0, alpha))
      }
    }
    return { ...base, pulses, fact, animating: o.spinning || (st.pulses && base.edges.length > 0) }
  }

  // Everything of the cloud but the light and the fact card.
  private cloudStill(
    ctx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D,
    st: State,
    sc: Scene,
    o: CloudInput,
  ): CloudOut {
    const { depth, view, spinning, lit, dim, isGroup, SX, SY } = o
    const p = st.palette
    const n = sc.n
    // How near each point is, from 0 (the farthest drawn) to 1 (the nearest), in four steps of light.
    let dmin = Number.POSITIVE_INFINITY
    let dmax = Number.NEGATIVE_INFINITY
    for (let i = 0; i < n; i++) {
      if (!st.nodes[i]) continue
      const d = depth[i] as number
      if (d < dmin) dmin = d
      if (d > dmax) dmax = d
    }
    const span = Math.max(1e-6, dmax - dmin)
    const FADE = [0.3, 0.48, 0.72, 1]
    const bucket = (i: number) => Math.min(3, Math.floor((((depth[i] as number) - dmin) / span) * 4))
    const size = (i: number) => Math.min(1.7, Math.max(0.55, depth[i] as number))
    // Points of a cloud are small; the most linked ones stand out bigger.
    const hubs = new Set(st.hubs)
    const rad = (i: number) => (isGroup(i) ? o.boxR(i) : o.radius(i) * (hubs.has(i) ? 0.85 : 0.6)) * size(i)

    // Still, the cards and names of a flat picture; turning, none (they would swim).
    // Still, a big cloud names only the pages the person is on and their neighbours (the reference is quiet);
    // the pointer names the rest one by one. A small one names all its pages.
    let drawn = 0
    for (let i = 0; i < n; i++) if (st.nodes[i]) drawn += 1
    const placed = spinning
      ? { cards: [], labels: [] }
      : this.place(ctx, st, sc, SX, SY, isGroup, false, drawn > QUIET_FROM)
    const { cards, labels } = placed
    const cardOf = new Int32Array(n).fill(-1)
    for (const [k, c] of cards.entries()) cardOf[c.i] = k

    // Lines: gathered in one pass by kind, strength, family and depth, then one stroke each.
    const on = st.hover >= 0 && st.nodes[st.hover] ? st.hover : st.selected
    // Each path's key is a number (no string per line, picture after picture): kind, strength, family (ACROSS:
    // between two families) and depth step.
    const paths = new Map<number, number[]>()
    const visibleEdges: number[] = []
    for (let e = 0; e < sc.kind.length; e++) {
      if (!st.edges[e]) continue
      visibleEdges.push(e)
      const i = sc.edges[2 * e] as number
      const j = sc.edges[2 * e + 1] as number
      const touches = on >= 0 && (i === on || j === on)
      const tier = touches ? 2 : (lit ? i !== st.hover && j !== st.hover : dim(i) || dim(j)) ? 0 : 1
      const k = sc.kind[e] as number
      // A line inside a family takes its colour; a line between two families stays faint.
      const family = sc.fam[i] === sc.fam[j] ? (sc.fam[i] as number) : ACROSS
      const key = tier === 1 ? lineKey(k, 1, family, Math.min(bucket(i), bucket(j))) : lineKey(k, tier, 0, 3)
      let x0 = SX(i)
      let y0 = SY(i)
      let x1 = SX(j)
      let y1 = SY(j)
      const ci = cardOf[i] as number
      const cj = cardOf[j] as number
      if (cj >= 0) [x1, y1] = clipToRect(x0, y0, x1, y1, cards[cj] as Card)
      if (ci >= 0) [x0, y0] = clipToRect(x1, y1, x0, y0, cards[ci] as Card)
      let list = paths.get(key)
      if (!list) {
        list = []
        paths.set(key, list)
      }
      list.push(x0, y0, x1, y1, cj >= 0 ? -1 : rad(j))
    }
    ctx.lineCap = 'round'
    for (const [key, list] of paths) {
      const bs = key % 4
      const fs = Math.floor(key / 4) % 8
      const tier = Math.floor(key / 32) % 3
      const k = Math.floor(key / 96) - 1
      const name = k < 0 ? 'group' : (sc.kinds[k] as string)
      const style = LINE[name] ?? (LINE.related as (typeof LINE)[string])
      const contradicts = name === 'contradicts'
      ctx.beginPath()
      for (let q = 0; q < list.length; q += 5) {
        ctx.moveTo(list[q] as number, list[q + 1] as number)
        ctx.lineTo(list[q + 2] as number, list[q + 3] as number)
      }
      ctx.setLineDash(style.dash)
      const width = k < 0 ? (sc.byGroups ? 2.5 : 0.8) : style.width
      ctx.lineWidth = tier === 2 ? width + 0.6 : width * 0.85
      const across = fs === ACROSS
      ctx.strokeStyle = contradicts ? p.danger : tier === 2 ? p.text : across ? p.edge : (p.fam[fs] ?? p.edge)
      ctx.globalAlpha =
        tier === 0
          ? EDGE.faint * 0.7
          : tier === 2
            ? EDGE.lit
            : (contradicts ? EDGE.contradicts : across ? 0.13 : 0.5) * (FADE[bs] as number)
      ctx.stroke()
      // Arrowheads on the lines of the page under the pointer or picked: the rest would only be noise.
      if (tier === 2 && style.arrow && k >= 0) {
        ctx.setLineDash([])
        ctx.beginPath()
        for (let q = 0; q < list.length; q += 5) {
          const x0 = list[q] as number
          const y0 = list[q + 1] as number
          const x1 = list[q + 2] as number
          const y1 = list[q + 3] as number
          const r = list[q + 4] as number
          const len = Math.hypot(x1 - x0, y1 - y0)
          if (len <= 28) continue
          const ux = (x1 - x0) / len
          const uy = (y1 - y0) / len
          const tx = x1 - ux * (r + 2)
          const ty = y1 - uy * (r + 2)
          ctx.moveTo(tx, ty)
          ctx.lineTo(tx - ux * 6 - uy * 3, ty - uy * 6 + ux * 3)
          ctx.lineTo(tx - ux * 6 + uy * 3, ty - uy * 6 - ux * 3)
          ctx.closePath()
        }
        ctx.fillStyle = contradicts ? p.danger : p.text
        ctx.fill()
      }
    }
    ctx.setLineDash([])
    ctx.globalAlpha = 1

    const f = this.frame?.f
    // The points, far to near: per depth step, one path per family and shape.
    const groups: number[][] = [[], [], [], []]
    const byStep: Map<number, number[]>[] = [new Map(), new Map(), new Map(), new Map()]
    for (let i = 0; i < n; i++) {
      if (!st.nodes[i] || (cardOf[i] as number) >= 0) continue
      const b = bucket(i)
      if (isGroup(i)) {
        ;(groups[b] as number[]).push(i)
        continue
      }
      const key = ((sc.fam[i] as number) * 16 + (sc.shape[i] as number)) * 2 + (dim(i) ? 1 : 0)
      const m = byStep[b] as Map<number, number[]>
      let list = m.get(key)
      if (!list) {
        list = []
        m.set(key, list)
      }
      list.push(i)
    }
    for (let b = 0; b < 4; b++) {
      const fade = FADE[b] as number
      // The most linked pages first get their halo, under their point.
      for (const list of (byStep[b] as Map<number, number[]>).values())
        for (const i of list) {
          if (!hubs.has(i)) continue
          const r = rad(i)
          const c = p.fam[sc.fam[i] as number] ?? p.text
          ctx.beginPath()
          ctx.arc(SX(i), SY(i), r * 2.8, 0, Math.PI * 2)
          ctx.fillStyle = c
          ctx.globalAlpha = 0.13 * fade
          ctx.fill()
          ctx.beginPath()
          ctx.arc(SX(i), SY(i), r * 1.9, 0, Math.PI * 2)
          ctx.strokeStyle = c
          ctx.lineWidth = 1
          ctx.globalAlpha = 0.5 * fade
          ctx.stroke()
        }
      for (const i of groups[b] as number[]) {
        const r = rad(i)
        ctx.globalAlpha = (lit && !lit[i] ? 0.35 : 1) * fade
        ctx.beginPath()
        ctx.roundRect(SX(i) - r, SY(i) - r, 2 * r, 2 * r, r * 0.3)
        ctx.fillStyle = p.ground
        ctx.fill()
        ctx.lineWidth = 1.5
        ctx.strokeStyle =
          i === st.selected || i === st.active ? p.accent : (p.fam[sc.fam[i] as number] ?? p.text)
        ctx.stroke()
      }
      for (const [key, list] of byStep[b] as Map<number, number[]>) {
        const faint = key % 2 === 1
        const shs = Math.floor(key / 2) % 16
        const fs = Math.floor(key / 32)
        const type = SHAPES[shs] ?? 'topic'
        ctx.beginPath()
        for (const i of list) shape(ctx, type, SX(i), SY(i), rad(i))
        ctx.fillStyle = p.fam[fs] ?? p.text
        ctx.globalAlpha = fade * (faint ? (lit ? 0.25 : 0.45) : 1)
        ctx.fill('evenodd')
      }
    }
    ctx.globalAlpha = 1
    // The strike of superseded pages.
    ctx.beginPath()
    let struck = false
    for (let i = 0; i < sc.pages; i++) {
      if (!st.nodes[i] || sc.superseded[i] !== 1 || (cardOf[i] as number) >= 0) continue
      const r = rad(i) * 1.5
      ctx.moveTo(SX(i) - r, SY(i) + r)
      ctx.lineTo(SX(i) + r, SY(i) - r)
      struck = true
    }
    if (struck) {
      ctx.lineWidth = 1.5
      ctx.strokeStyle = p.text
      ctx.stroke()
    }

    // The hub: the brain itself, in the middle of the cloud.
    let hub: [number, number] | null = null
    if (sc.hub && f) {
      const hx = f.cx * view.scale + view.tx
      const hy = f.cy * view.scale + view.ty
      hub = [Math.round(hx), Math.round(hy)]
      const orange = p.fam[0] ?? p.accent
      for (const [r, a] of [
        [44, 0.12],
        [31, 0.3],
      ] as const) {
        ctx.beginPath()
        ctx.arc(hx, hy, r, 0, Math.PI * 2)
        ctx.strokeStyle = orange
        ctx.lineWidth = 1
        ctx.globalAlpha = a
        ctx.stroke()
      }
      ctx.beginPath()
      ctx.arc(hx, hy, 21, 0, Math.PI * 2)
      ctx.fillStyle = orange
      ctx.globalAlpha = 0.22
      ctx.fill()
      ctx.beginPath()
      ctx.arc(hx, hy, 17, 0, Math.PI * 2)
      ctx.globalAlpha = 1
      ctx.fill()
      ctx.font = HUB
      ctx.textAlign = 'center'
      ctx.textBaseline = 'middle'
      ctx.fillStyle = p.ground
      ctx.fillText(sc.hub.initial, hx, hy + 1)
      ctx.font = SUB
      ctx.lineJoin = 'round'
      ctx.lineWidth = 3
      ctx.strokeStyle = p.ground
      ctx.strokeText(sc.hub.name, hx, hy + 36)
      ctx.fillStyle = p.panelInk
      ctx.fillText(sc.hub.name, hx, hy + 36)
      ctx.textAlign = 'start'
    }

    // Rings: the page in focus, the one selected, where the keyboard is.
    const ring = (i: number, width: number, gap: number, color: string) => {
      if (i < 0 || !st.nodes[i] || (cardOf[i] as number) >= 0) return
      ctx.beginPath()
      ctx.arc(SX(i), SY(i), (isGroup(i) ? rad(i) * 1.45 : rad(i) * 1.3) + gap, 0, Math.PI * 2)
      ctx.lineWidth = width
      ctx.strokeStyle = color
      ctx.stroke()
    }
    ring(st.focus, 1.5, 4, p.muted)
    ring(st.selected, 2.5, 3, p.accent)
    ring(st.active, 2, 7, p.accent)

    // Each family's pill, at the middle of its points.
    const families: string[] = []
    const mids = centroids(o.xy, sc.fam, st.nodes, sc.famNames.length)
    ctx.font = PILL
    ctx.textBaseline = 'middle'
    for (const [k, c] of mids.entries()) {
      if (!c) continue
      const name = sc.famNames[k] ?? ''
      const w = ctx.measureText(name).width + 18
      const x = Math.min(st.width - st.right - w - 6, Math.max(6, c.x * view.scale + view.tx - w / 2))
      const y = Math.min(st.height - 26, Math.max(st.top + 4, c.y * view.scale + view.ty - 10))
      ctx.globalAlpha = 0.92
      ctx.beginPath()
      ctx.roundRect(x, y, w, 20, 10)
      ctx.fillStyle = p.famDim[k] ?? p.card
      ctx.fill()
      ctx.globalAlpha = 1
      ctx.lineWidth = 1.2
      ctx.strokeStyle = p.fam[k] ?? p.text
      ctx.stroke()
      ctx.fillStyle = p.panelInk
      ctx.fillText(name, x + 9, y + 10.5)
      families.push(name)
    }

    // The cards and names, still.
    this.draw(ctx, st, sc, cards, lit, false)
    this.drawLabels(ctx, st, sc, labels, lit, isGroup)

    // How far it has turned, at the bottom right.
    ctx.font = `11px ${MONO}`
    ctx.textAlign = 'right'
    ctx.textBaseline = 'alphabetic'
    ctx.fillStyle = p.muted
    ctx.globalAlpha = 0.85
    ctx.fillText(
      yawText(this.camera.yaw),
      st.width - st.right - 14,
      st.height - Math.max(st.bottom, st.inset) - 8,
    )
    ctx.textAlign = 'start'
    ctx.globalAlpha = 1
    // The caption over the rows of pages without links, under the cloud.
    const orphans = orphanCaption(ctx, st, sc, SX, SY, nodeRadius(view.scale), p.muted)
    return { cards, labels, families, hub, orphans, edges: visibleEdges, rad }
  }

  // Light travelling the lines: a short bright stroke on each of a few lines, moving from one end to the other,
  // then on to another line. Worked out in three dimensions, so it follows the turn. How many are drawn.
  private light(
    ctx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D,
    st: State,
    sc: Scene,
    o: CloudInput,
    visibleEdges: number[],
  ): number {
    const p = st.palette
    const view = o.view
    let pulses = 0
    const f = this.frame?.f
    const layout = this.layout
    if (st.pulses && f && layout && visibleEdges.length) {
      const want = Math.min(PULSES_MAX, Math.max(4, Math.round(visibleEdges.length / PULSE_EVERY)))
      if (this.pulseEdge.length !== want) {
        this.pulseEdge = new Int32Array(want).fill(-1)
        this.pulseT = new Float32Array(want)
        this.pulseV = new Float32Array(want)
      }
      const len = 0.18
      const glow: number[] = []
      for (let q = 0; q < want; q++) {
        let e = this.pulseEdge[q] as number
        let t = (this.pulseT[q] as number) + (this.pulseV[q] as number) * o.dt
        if (e < 0 || !st.edges[e] || t > 1 + len) {
          e = visibleEdges[Math.floor(this.random() * visibleEdges.length)] as number
          // Started at different points, so they never move in step.
          t = this.pulseEdge[q] === -1 ? this.random() : 0
          this.pulseV[q] = 1 / (1100 + this.random() * 1400)
        }
        this.pulseEdge[q] = e
        this.pulseT[q] = t
        const i = sc.edges[2 * e] as number
        const j = sc.edges[2 * e + 1] as number
        const at = (u: number) => {
          const w = Math.min(1, Math.max(0, u))
          const [px, py] = projectPoint(
            (layout[3 * i] as number) + ((layout[3 * j] as number) - (layout[3 * i] as number)) * w,
            (layout[3 * i + 1] as number) +
              ((layout[3 * j + 1] as number) - (layout[3 * i + 1] as number)) * w,
            (layout[3 * i + 2] as number) +
              ((layout[3 * j + 2] as number) - (layout[3 * i + 2] as number)) * w,
            f,
            this.camera,
          )
          return [px * view.scale + view.tx, py * view.scale + view.ty] as const
        }
        const [hx, hy] = at(t)
        const [tx, ty] = at(t - len)
        if (Math.hypot(hx - tx, hy - ty) < 0.5) continue
        glow.push(tx, ty, hx, hy)
        pulses += 1
      }
      if (glow.length) {
        const stroke = (width: number, alpha: number) => {
          ctx.beginPath()
          for (let q = 0; q < glow.length; q += 4) {
            ctx.moveTo(glow[q] as number, glow[q + 1] as number)
            ctx.lineTo(glow[q + 2] as number, glow[q + 3] as number)
          }
          ctx.lineWidth = width
          ctx.strokeStyle = p.pulse
          ctx.globalAlpha = alpha
          ctx.stroke()
        }
        stroke(5, 0.16)
        stroke(1.8, 0.95)
        ctx.beginPath()
        for (let q = 0; q < glow.length; q += 4) {
          ctx.moveTo((glow[q + 2] as number) + 2.2, glow[q + 3] as number)
          ctx.arc(glow[q + 2] as number, glow[q + 3] as number, 2.2, 0, Math.PI * 2)
        }
        ctx.fillStyle = p.pulse
        ctx.globalAlpha = 1
        ctx.fill()
      }
    }

    return pulses
  }

  // A page's fact: a thin ring around its point, a line to a card with its title, and where it comes from
  // and when in its family's colour.
  private factCard(
    ctx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D,
    st: State,
    sc: Scene,
    c: Fact,
    x: number,
    y: number,
    r: number,
    alpha: number,
  ): void {
    const p = st.palette
    const colour = p.fam[sc.fam[c.i] as number] ?? p.accent
    ctx.globalAlpha = alpha
    ctx.beginPath()
    ctx.arc(x, y, r + 7, 0, Math.PI * 2)
    ctx.lineWidth = 1.3
    ctx.strokeStyle = p.panelInk
    ctx.stroke()
    ctx.font = TITLE
    const title = c.title.length > 44 ? `${c.title.slice(0, 43).trimEnd()}…` : c.title
    const tw = ctx.measureText(title).width
    ctx.font = SUB
    const sw = ctx.measureText(c.sub).width
    const w = Math.ceil(Math.max(tw, sw)) + 28
    const h = 50
    const right = st.width - st.right - 8
    let cx = x + r + 24
    let cy = y - h - 18
    if (cx + w > right) cx = x - r - 24 - w
    if (cy < st.top + 8) cy = y + r + 18
    ctx.beginPath()
    ctx.moveTo(x + (cx > x ? r + 7 : -r - 7), y)
    ctx.lineTo(cx > x ? cx : cx + w, cy + h / 2)
    ctx.lineWidth = 1
    ctx.strokeStyle = colour
    ctx.stroke()
    ctx.beginPath()
    ctx.rect(cx + 0.5, cy + 0.5, w, h)
    ctx.fillStyle = p.card
    ctx.fill()
    ctx.lineWidth = 1.2
    ctx.strokeStyle = colour
    ctx.stroke()
    ctx.textBaseline = 'middle'
    ctx.font = TITLE
    ctx.fillStyle = p.cardInk
    ctx.fillText(title, cx + 14, cy + 17)
    ctx.font = SUB
    ctx.fillStyle = colour
    ctx.fillText(c.sub, cx + 14, cy + 35)
    ctx.globalAlpha = 1
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
    // Only the person's own items and their neighbours (the still cloud).
    few = false,
  ): { cards: Card[]; labels: Card[] } {
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
      if (few) return
      yield* st.hubs
      for (let i = 0; i < sc.n; i++) if (isGroup(i)) yield i
      for (let i = 0; i < sc.n; i++) yield i
    }
    const placing = {
      sx,
      textW: (i: number) => this.wordsOf(ctx, sc, i, isGroup(i)).w,
      ...(tile ? { size: (i: number) => this.tileWords(ctx, sc, i, isGroup(i)) } : {}),
      group: isGroup,
      width: st.width,
      height: st.height,
      forced: new Set([st.active, st.selected, st.focus].filter((i) => i >= 0 && st.nodes[i])),
      // The controls, and the panel over the right of the canvas: no card or name goes under them.
      blocked: st.right > 0 ? [...st.blocked, st.width - st.right, 0, st.right, st.height] : st.blocked,
    }
    const cards = placeCards({ ...placing, order: order() })
    // Where a card does not fit, the page's name beside its point (closing review).
    const labels = placeLabels({
      ...placing,
      order: order(),
      cards,
      labelW: (i) => this.wordsOf(ctx, sc, i, isGroup(i)).w * LABEL_SCALE,
    })
    return { cards, labels }
  }

  // Names beside points, with a halo of the ground so lines under them do not cut them.
  private drawLabels(
    ctx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D,
    st: State,
    sc: Scene,
    labels: Card[],
    lit: Uint8Array | null,
    isGroup: (i: number) => boolean,
  ): void {
    const p = st.palette
    ctx.font = LABEL
    ctx.textBaseline = 'middle'
    ctx.lineJoin = 'round'
    ctx.lineWidth = 3
    for (const l of labels) {
      const text = this.wordsOf(ctx, sc, l.i, isGroup(l.i)).t
      ctx.font = LABEL
      ctx.globalAlpha = lit && !lit[l.i] ? 0.35 : sc.superseded[l.i] === 1 ? 0.6 : 0.9
      ctx.strokeStyle = p.ground
      ctx.strokeText(text, l.x + 3, l.y + l.h / 2)
      ctx.fillStyle = p.cardInk
      ctx.fillText(text, l.x + 3, l.y + l.h / 2)
    }
    ctx.globalAlpha = 1
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
