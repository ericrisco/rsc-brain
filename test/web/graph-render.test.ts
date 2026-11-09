// Review round 2 (S1, S4, S6): the painter keeps the still cloud in a layer and draws the light over it. The layer
// must be painted again whenever what it shows changes (the names, the scene, the face), and the light must stay
// off the names. Run on a recording stand-in for the canvas (no DOM).
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { CAMERA } from '../../web/src/graph/camera.ts'
import { type Palette, Renderer, type Scene, type State } from '../../web/src/graph/render.ts'

type Op = { op: string; args: unknown[]; composite: string }
// A 2D context that records what is written and every op with the blending in force.
function recorder() {
  const ops: Op[] = []
  const state: Record<string, unknown> = { globalCompositeOperation: 'source-over' }
  const gradient = { addColorStop() {} }
  const ctx = new Proxy(state, {
    get(t, k: string) {
      if (k in t) return t[k]
      if (k === 'measureText') return (s: string) => ({ width: s.length * 7 })
      if (k === 'createLinearGradient' || k === 'createRadialGradient') return () => gradient
      return (...args: unknown[]) => {
        ops.push({ op: k, args, composite: String(t.globalCompositeOperation) })
      }
    },
    set(t, k: string, v) {
      t[k] = v
      return true
    },
  })
  return { ctx: ctx as unknown as CanvasRenderingContext2D, ops }
}
const layers: ReturnType<typeof recorder>[] = []
;(globalThis as Record<string, unknown>).OffscreenCanvas = class {
  width: number
  height: number
  rec = recorder()
  constructor(w: number, h: number) {
    this.width = w
    this.height = h
    layers.push(this.rec)
  }
  getContext() {
    return this.rec.ctx
  }
}

const palette: Palette = {
  edge: '#888',
  text: '#eee',
  muted: '#999',
  accent: '#0f0',
  danger: '#f00',
  ground: '#000',
  dot: '#333',
  card: '#111',
  cardLine: '#444',
  cardInk: '#fff',
  cardSub: '#aaa',
  fam: ['#f80', '#48f', '#0cc', '#a6f', '#fb0', '#f6a', '#3d6'],
  famDim: ['#310', '#013', '#033', '#213', '#320', '#312', '#031'],
  pulse: '#fff',
  panelInk: '#fff',
}
const scene = (labels: string[]): Scene => ({
  n: 3,
  pages: 3,
  byGroups: false,
  shape: new Uint8Array([0, 0, 1]),
  superseded: new Uint8Array(3),
  count: new Uint32Array(3),
  degree: new Uint32Array([1, 2, 1]),
  edges: new Uint32Array([0, 1, 1, 2]),
  kind: new Int8Array([0, 0]),
  links: new Uint32Array([1, 1]),
  kinds: ['related'],
  labels,
  role: new Uint8Array(3),
  fam: new Uint8Array([0, 0, 1]),
  famNames: ['topics', 'entities', 'guides', 'agents', 'overviews', 'decisions', 'sources'],
  hub: null,
})
const ones = new Uint8Array([1, 1, 1])
const state = (seq: number): State => ({
  width: 800,
  height: 600,
  dpr: 1,
  palette,
  nodes: ones,
  edges: new Uint8Array([1, 1]),
  fit: ones,
  autoFit: false,
  view: { scale: 0.5, tx: 400, ty: 300 },
  active: -1,
  selected: 1,
  focus: -1,
  hover: -1,
  hop: null,
  xy: null,
  hubs: [],
  bridges: null,
  orphanLabel: '',
  inset: 0,
  top: 0,
  right: 0,
  bottom: 0,
  left: 0,
  blocked: [],
  seq,
  probe: false,
  spin: false,
  pulses: true,
  camera: { yaw: CAMERA.yaw0, pitch: CAMERA.pitch0, seq: 1 },
})
const painter = () => {
  const r = new Renderer()
  r.setScene(scene(['Alpha', 'Bravo', 'Charlie']))
  r.layout = new Float32Array([-100, 0, 0, 0, 0, 40, 100, 20, -40])
  r.state = state(1)
  return r
}
const written = (ops: Op[]) => ops.filter((o) => o.op === 'fillText').map((o) => String(o.args[0]))

describe('the still layer of the cloud', () => {
  it('is painted again when the names change, the scene changes or a face comes in', () => {
    const r = painter()
    const main = recorder()
    layers.length = 0
    r.paint(main.ctx, 1000)
    const layer = layers.at(-1) as ReturnType<typeof recorder>
    assert.ok(written(layer.ops).includes('Bravo'), `painted the picked page's name: ${written(layer.ops)}`)
    // The same state, new names: the layer shows them.
    layer.ops.length = 0
    r.setLabels(['Alpha', 'Bravissimo', 'Charlie'])
    r.paint(main.ctx, 1016)
    assert.ok(written(layer.ops).includes('Bravissimo'), 'new names painted')
    // A new scene with the same state.
    layer.ops.length = 0
    r.setScene(scene(['Uno', 'Dos', 'Tres']))
    r.layout = new Float32Array([-100, 0, 0, 0, 0, 40, 100, 20, -40])
    r.paint(main.ctx, 1032)
    assert.ok(written(layer.ops).includes('Dos'), 'new scene painted')
    // A face came in: painted again.
    layer.ops.length = 0
    r.fontsChanged()
    r.paint(main.ctx, 1048)
    assert.ok(written(layer.ops).includes('Dos'), 'painted again for the new face')
  })

  it('draws the light under the names: no light is added after a name is written', () => {
    const r = painter()
    const main = recorder()
    layers.length = 0
    r.paint(main.ctx, 1000)
    r.paint(main.ctx, 1200)
    const ops = main.ops
    const lastLight = ops.map((o) => o.composite === 'lighter' && o.op === 'fill').lastIndexOf(true)
    assert.ok(lastLight >= 0, 'the light is drawn')
    // Whatever writes names on the main canvas comes after the light, or the names come from a layer copied
    // after it.
    const copies = ops.map((o, k) => (o.op === 'drawImage' ? k : -1)).filter((k) => k >= 0)
    const afterLight = copies.some((k) => k > lastLight) || written(ops.slice(lastLight)).length > 0
    assert.ok(afterLight, 'the names are drawn over the light')
  })
})
