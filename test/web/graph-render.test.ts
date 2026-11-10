// v0.5.0: the painter of the graph, run on a recording stand-in for the canvas (no DOM). It writes no words
// (they come on asking, in the DOM), draws nothing travelling on the lines, brightens the page under the pointer
// and its lines, keeps the page picked and its neighbours bright while the rest dims, and leaves out what is
// hidden (a filter, a community unticked).
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { DIM, EDGE, type Palette, Renderer, type Scene, type State } from '../../web/src/graph/render.ts'

type Op = { op: string; args: unknown[]; alpha: number; fill: string; stroke: string }
// A 2D context that records every call with the alpha and colours in force.
function recorder() {
  const ops: Op[] = []
  const state: Record<string, unknown> = { globalAlpha: 1 }
  const ctx = new Proxy(state, {
    get(t, k: string) {
      if (k in t) return t[k]
      if (k === 'measureText') return (s: string) => ({ width: s.length * 7 })
      return (...args: unknown[]) => {
        ops.push({
          op: k,
          args,
          alpha: Number(t.globalAlpha ?? 1),
          fill: String(t.fillStyle ?? ''),
          stroke: String(t.strokeStyle ?? ''),
        })
      }
    },
    set(t, k: string, v) {
      t[k] = v
      return true
    },
  })
  return { ctx: ctx as unknown as CanvasRenderingContext2D, ops }
}

const palette: Palette = {
  edge: '#888',
  text: '#eee',
  muted: '#999',
  accent: '#0f0',
  ground: '#000',
  com: ['#c00', '#0c0', '#00c', '#cc0', '#0cc', '#c0c', '#c80', '#08c', '#8c0', '#80c'],
  other: '#777',
  lone: '#555',
}
// Four pages: 0–1–2 linked in a chain (community 0 and 1), 3 without links.
const scene: Scene = {
  n: 4,
  pages: 4,
  byGroups: false,
  group: new Uint8Array(4),
  superseded: new Uint8Array(4),
  count: new Uint32Array(4),
  degree: new Uint32Array([1, 2, 1, 0]),
  edges: new Uint32Array([0, 1, 1, 2]),
  colour: new Uint8Array([0, 0, 1, 11]),
}
const state = (o: Partial<State> = {}): State => ({
  width: 800,
  height: 600,
  dpr: 1,
  palette,
  nodes: new Uint8Array([1, 1, 1, 1]),
  edges: new Uint8Array([1, 1]),
  fit: new Uint8Array([1, 1, 1, 1]),
  autoFit: true,
  view: { scale: 1, tx: 0, ty: 0 },
  active: -1,
  selected: -1,
  focus: -1,
  hover: -1,
  hop: null,
  xy: null,
  bridges: null,
  inset: 0,
  top: 0,
  right: 0,
  bottom: 0,
  left: 0,
  seq: 1,
  probe: true,
  ...o,
})
function paint(o: Partial<State> = {}) {
  const r = new Renderer()
  r.setScene(scene)
  r.layout = new Float32Array([-60, 0, 0, 0, 60, 0, 0, 120])
  r.state = state(o)
  const { ctx, ops } = recorder()
  const d = r.paint(ctx)
  return { d, ops }
}
const dots = (ops: Op[]) => ops.filter((o) => o.op === 'arc')
const filled = (ops: Op[]) => ops.filter((o) => o.op === 'fill')

describe('the painter of the graph', () => {
  it('writes no words, at rest, under the pointer, picked or under the keyboard', () => {
    for (const o of [{}, { hover: 1 }, { selected: 1 }, { active: 2, selected: 0 }]) {
      const { ops } = paint(o)
      assert.deepEqual(
        ops.filter((x) => x.op === 'fillText' || x.op === 'strokeText').map((x) => x.args[0]),
        [],
        JSON.stringify(o),
      )
    }
  })

  it('draws a dot a page and nothing more on the lines: no light travels them', () => {
    const { ops, d } = paint()
    // Four pages, four dots; no rings at rest.
    assert.equal(dots(ops).length, 4)
    assert.equal(d?.counts?.lines, 2)
    // The same picture twice: nothing in it moves with time.
    assert.deepEqual(
      paint().ops.map((o) => [o.op, o.args.map((a) => (typeof a === 'number' ? Math.round(a) : a))]),
      ops.map((o) => [o.op, o.args.map((a) => (typeof a === 'number' ? Math.round(a) : a))]),
    )
  })

  it('colours each page by its community; a page without links in its own colour', () => {
    const { ops } = paint()
    const colours = filled(ops).map((o) => o.fill)
    assert.ok(colours.includes('#c00'))
    assert.ok(colours.includes('#0c0'))
    assert.ok(colours.includes(palette.lone))
  })

  it('at rest every line is pale', () => {
    const { ops } = paint()
    const lines = ops.filter((o) => o.op === 'stroke')
    assert.ok(lines.length >= 1)
    for (const l of lines) assert.ok(l.alpha <= EDGE.quiet + 1e-9, `line at ${l.alpha}`)
  })

  it('under the pointer: the page and its lines are brightened, the others a little dimmed', () => {
    const { ops, d } = paint({ hover: 0 })
    // Page 0 and its neighbour 1 bright; 2 and 3 dimmed behind it.
    assert.deepEqual(d?.counts, { lit: 2, dim: 2, lines: 2 })
    assert.ok(
      ops.some((o) => o.op === 'stroke' && o.alpha >= EDGE.lit),
      'its line brightened',
    )
    assert.ok(
      filled(ops).some((o) => Math.abs(o.alpha - DIM.hover) < 1e-9),
      'the rest dimmed',
    )
    // A light ring around it.
    assert.equal(dots(ops).length, 5)
  })

  it('picked: it and its neighbours stay bright and everything else dims, more than under the pointer', () => {
    const { ops, d } = paint({ selected: 1 })
    assert.deepEqual(d?.counts, { lit: 3, dim: 1, lines: 2 })
    assert.ok(filled(ops).some((o) => Math.abs(o.alpha - DIM.picked) < 1e-9))
    assert.ok(DIM.picked < DIM.hover)
    // A solid ring for the page picked, a dashed one further out for the keyboard: told apart by shape.
    const both = paint({ selected: 1, active: 2 }).ops
    const dashes = both.filter((o) => o.op === 'setLineDash').map((o) => (o.args[0] as number[]).length)
    assert.ok(
      dashes.some((n) => n > 0),
      'a dashed ring',
    )
  })

  it('leaves out what is hidden: its dot and its lines', () => {
    const { ops, d } = paint({ nodes: new Uint8Array([1, 1, 0, 1]) })
    assert.equal(dots(ops).length, 3)
    assert.equal(d?.counts?.lines, 1)
  })

  it('fits what it is told to fit, inside the room the panels leave', () => {
    const { d } = paint({ right: 400 })
    const v = d?.view as { scale: number; tx: number }
    // The rightmost page (x 60) is drawn left of the panel.
    assert.ok(60 * v.scale + v.tx < 800 - 400)
  })

  it('paints nothing before it has a layout', () => {
    const r = new Renderer()
    r.setScene(scene)
    r.state = state()
    assert.equal(r.paint(recorder().ctx), null)
  })
})
