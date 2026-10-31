// Painting the graph on a 2D canvas (plan §3.4): called when the data, the positions, the size or what the
// person does changes, never in a loop (DESIGN.md «Motion»). A page's shape says its type and a line's dash
// says its link kind, so colour is never the only sign; superseded pages are dimmed; the item in focus and the
// one selected carry the accent and a ring. Lines are batched by kind and shapes by type: one path each.
import type { Model, View } from './model.ts'

export type Palette = {
  text: string
  muted: string
  rule: string
  accent: string
  danger: string
  ground: string
}

// The dash of each link kind, in screen pixels (the legend draws the same).
export const DASH: Record<string, number[]> = {
  mentions: [1, 3],
  related: [],
  'depends-on': [6, 4],
  contradicts: [2, 2, 8, 2],
  supersedes: [],
  'part-of': [12, 4],
  'example-of': [6, 3, 1, 3],
}
export const SHAPES = ['topic', 'entity', 'decision', 'guide', 'agent', 'source', 'overview'] as const

// A page's shape at (x, y) with radius r, added to the current path.
export function shape(
  ctx: CanvasRenderingContext2D | Path2D,
  type: string,
  x: number,
  y: number,
  r: number,
): void {
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
        [0, -1.2],
        [1.2, 0],
        [0, 1.2],
        [-1.2, 0],
      ])
      return
    case 'guide':
      poly([
        [0, -1.2],
        [1.1, 0.9],
        [-1.1, 0.9],
      ])
      return
    case 'source':
      poly([
        [0, 1.2],
        [1.1, -0.9],
        [-1.1, -0.9],
      ])
      return
    case 'agent':
      poly(
        Array.from({ length: 6 }, (_, k): [number, number] => [
          Math.cos((Math.PI / 3) * k),
          Math.sin((Math.PI / 3) * k),
        ]),
      )
      return
    case 'overview':
      // A ring: the outer circle and, drawn the other way, the hole.
      ctx.moveTo(x + r * 1.1, y)
      ctx.arc(x, y, r * 1.1, 0, Math.PI * 2)
      ctx.moveTo(x + r * 0.5, y)
      ctx.arc(x, y, r * 0.5, 0, Math.PI * 2, true)
      return
    default:
      ctx.moveTo(x + r, y)
      ctx.arc(x, y, r, 0, Math.PI * 2)
  }
}

export const NODE_R = 5
export const groupRadius = (count: number) => Math.min(28, 7 + 1.1 * Math.sqrt(count))
// Pages shrink when the picture is zoomed far out (many pages on a phone), never below 2.5 px.
export const nodeRadius = (scale: number) => Math.min(NODE_R, Math.max(2.5, NODE_R * Math.sqrt(scale)))

export type Paint = {
  model: Model
  xy: Float32Array
  nodes: Uint8Array
  edges: Uint8Array
  view: View
  width: number
  height: number
  dpr: number
  palette: Palette
  // The item the keyboard is on, the one open in the inspector, the one in focus mode, or −1.
  active: number
  selected: number
  focus: number
  // Items to name on the canvas (the rest are named when zoomed in).
  labelled: Set<number>
}

const MAX_LABELS = 160

export function paint(ctx: CanvasRenderingContext2D, p: Paint): void {
  const { model: m, xy, view, dpr, palette } = p
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
  ctx.clearRect(0, 0, p.width, p.height)
  ctx.setTransform(dpr * view.scale, 0, 0, dpr * view.scale, dpr * view.tx, dpr * view.ty)
  const px = 1 / view.scale
  const X = (i: number) => xy[2 * i] as number
  const Y = (i: number) => xy[2 * i + 1] as number
  const dimmed = (i: number) => {
    const it = m.items[i]
    return it?.kind === 'page' && it.status === 'superseded'
  }

  // Lines: one path per kind (and one for links with groups, wider for more links).
  ctx.lineCap = 'round'
  for (let k = -1; k < m.kinds.length; k++) {
    for (const faint of [false, true]) {
      ctx.beginPath()
      let any = false
      for (let e = 0; e < m.kind.length; e++) {
        if (!p.edges[e] || m.kind[e] !== k) continue
        const i = m.edges[2 * e] as number
        const j = m.edges[2 * e + 1] as number
        if ((dimmed(i) || dimmed(j)) !== faint) continue
        ctx.moveTo(X(i), Y(i))
        ctx.lineTo(X(j), Y(j))
        any = true
      }
      if (!any) continue
      const name = k < 0 ? 'group' : (m.kinds[k] as string)
      ctx.setLineDash((DASH[name] ?? []).map((d) => d * px))
      ctx.lineWidth = (name === 'supersedes' ? 2 : k < 0 ? 1.5 : 1) * px
      ctx.strokeStyle = name === 'contradicts' ? palette.danger : palette.muted
      ctx.globalAlpha = faint ? 0.2 : name === 'contradicts' ? 0.8 : 0.45
      ctx.stroke()
    }
  }
  ctx.setLineDash([])
  ctx.globalAlpha = 1

  // Groups: rounded squares sized by their pages, named.
  for (let i = m.pages; i < m.items.length; i++) {
    if (!p.nodes[i]) continue
    const it = m.items[i]
    if (it?.kind !== 'group') continue
    const r = groupRadius(it.count) * px * (m.pages > 0 ? 0.6 : 1)
    ctx.beginPath()
    ctx.roundRect(X(i) - r, Y(i) - r, 2 * r, 2 * r, r * 0.3)
    ctx.fillStyle = palette.ground
    ctx.fill()
    ctx.lineWidth = 1.5 * px
    ctx.strokeStyle = i === p.selected || i === p.active ? palette.accent : palette.text
    ctx.globalAlpha = m.pages > 0 ? 0.6 : 1
    ctx.stroke()
    ctx.globalAlpha = 1
  }

  // Pages: one path per type and dimness.
  const r = nodeRadius(view.scale) * px
  for (const type of [...SHAPES, '']) {
    for (const faint of [false, true]) {
      ctx.beginPath()
      let any = false
      for (let i = 0; i < m.pages; i++) {
        if (!p.nodes[i]) continue
        const it = m.items[i]
        if (it?.kind !== 'page') continue
        const known = (SHAPES as readonly string[]).includes(it.type)
        if ((type === '' ? known : it.type !== type) || dimmed(i) !== faint) continue
        shape(ctx, type || 'topic', X(i), Y(i), r)
        any = true
      }
      if (!any) continue
      ctx.globalAlpha = faint ? 0.35 : 1
      ctx.fillStyle = palette.text
      ctx.fill('evenodd')
    }
  }
  ctx.globalAlpha = 1

  // Rings: what the keyboard is on (accent), what is selected (accent, thicker), the page in focus.
  const ring = (i: number, width: number, gap: number, color: string) => {
    if (i < 0 || !p.nodes[i]) return
    const it = m.items[i]
    const rr =
      it?.kind === 'group' ? groupRadius(it.count) * px * (m.pages > 0 ? 0.6 : 1) + gap * px : r + gap * px
    ctx.beginPath()
    ctx.arc(X(i), Y(i), rr * 1.3, 0, Math.PI * 2)
    ctx.lineWidth = width * px
    ctx.strokeStyle = color
    ctx.stroke()
  }
  ring(p.focus, 1.5, 4, palette.muted)
  ring(p.selected, 2.5, 3, palette.accent)
  ring(p.active, 2, 6, palette.accent)

  // Names: the groups always; around what the person is on; and everything when zoomed in enough.
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
  ctx.font = '12px ui-sans-serif, system-ui, sans-serif'
  ctx.textBaseline = 'middle'
  let named = 0
  const name = (i: number) => {
    const it = m.items[i]
    if (!it || !p.nodes[i]) return
    const sx = X(i) * view.scale + view.tx
    const sy = Y(i) * view.scale + view.ty
    if (sx < -100 || sy < -20 || sx > p.width + 100 || sy > p.height + 20) return
    const text =
      it.kind === 'group'
        ? `${it.prefix} · ${it.count}`
        : it.title.length > 40
          ? `${it.title.slice(0, 39)}…`
          : it.title
    const off =
      it.kind === 'group' ? groupRadius(it.count) * (m.pages > 0 ? 0.6 : 1) + 6 : nodeRadius(view.scale) + 6
    ctx.lineWidth = 3
    ctx.strokeStyle = palette.ground
    ctx.globalAlpha = dimmed(i) ? 0.6 : 1
    ctx.strokeText(text, sx + off, sy)
    ctx.fillStyle = i === p.selected || i === p.active ? palette.accent : palette.text
    ctx.fillText(text, sx + off, sy)
    ctx.globalAlpha = 1
    named += 1
  }
  const done = new Set<number>()
  for (const i of [p.active, p.selected, p.focus, ...p.labelled]) {
    if (i < 0 || done.has(i)) continue
    done.add(i)
    name(i)
  }
  for (let i = m.pages; i < m.items.length; i++) if (!done.has(i)) name(i)
  if (view.scale >= 1.4) for (let i = 0; i < m.pages && named < MAX_LABELS; i++) if (!done.has(i)) name(i)
}
