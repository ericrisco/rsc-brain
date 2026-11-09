// Spec amendment 2026-11-09, CA12 (plan canvas-ui S.1, SB3): the graph's families. A page's family is its
// type, each type with a colour of its own among the seven of shared.css v2; a group takes the type most of
// its pages have. The legend counts the pages of each family that are drawn (a group counts its pages by
// type), and a family's pill sits at the middle of its drawn points.
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  centroids,
  cores,
  FAMILIES,
  familyCounts,
  familyIndex,
  familyOfType,
  spreadPills,
} from '../../web/src/graph/families.ts'
import { type Answer, modelOf } from '../../web/src/graph/model.ts'
import { PAGE_TYPES } from '../../web/src/lib/wiki.ts'

const KINDS = ['mentions', 'related']
const base = { kinds: KINDS, nodes: [], edges: [], across: [], groups: [], groupEdges: [] }

const pages: Answer = {
  ...base,
  mode: 'pages',
  prefix: null,
  total: 5,
  nodes: [
    ['a/one', 'One', 'topic', 'current', []],
    ['a/two', 'Two', 'topic', 'current', []],
    ['b/three', 'Three', 'decision', 'current', []],
    ['c/four', 'Four', 'source', 'current', []],
    ['c/five', 'Five', 'no-such-type', 'current', []],
  ],
}

describe('graph families', () => {
  it('each page type has a colour of its own, among the seven shared ones', () => {
    const colours = PAGE_TYPES.map((t) => familyOfType(t).colour)
    assert.equal(new Set(colours).size, PAGE_TYPES.length)
    for (const c of colours)
      assert.ok(['orange', 'amber', 'blue', 'cyan', 'pink', 'violet', 'green'].includes(c), c)
    assert.deepEqual(
      FAMILIES.map((f) => f.type),
      [...PAGE_TYPES],
    )
  })

  it('an unknown type falls into the first family, never out of the picture', () => {
    assert.equal(familyOfType('no-such-type'), FAMILIES[0])
  })

  it('per item: a page by its type, a group by the type most of its pages have', () => {
    const m = modelOf({
      ...base,
      mode: 'groups',
      prefix: null,
      total: 30,
      groups: [
        { prefix: 'ops', count: 20, types: { decision: 12, topic: 8 } },
        { prefix: 'misc', count: 10, types: {} },
      ],
    })
    const fam = familyIndex(m)
    assert.equal(FAMILIES[fam[0] as number]?.type, 'decision')
    assert.equal(FAMILIES[fam[1] as number]?.type, 'topic')
    const p = familyIndex(modelOf(pages))
    assert.deepEqual(
      [...p].map((k) => FAMILIES[k]?.type),
      ['topic', 'topic', 'decision', 'source', 'topic'],
    )
  })

  it('counts the drawn pages of each family, biggest first, and leaves out families with none', () => {
    const m = modelOf(pages)
    const all = familyCounts(m, new Uint8Array([1, 1, 1, 1, 1]))
    assert.deepEqual(
      all.map((c) => [c.type, c.count]),
      [
        ['topic', 3],
        ['decision', 1],
        ['source', 1],
      ],
    )
    const some = familyCounts(m, new Uint8Array([1, 0, 0, 1, 0]))
    assert.deepEqual(
      some.map((c) => [c.type, c.count]),
      [
        ['topic', 1],
        ['source', 1],
      ],
    )
  })

  it('a group counts its pages by type', () => {
    const m = modelOf({
      ...base,
      mode: 'groups',
      prefix: null,
      total: 30,
      groups: [
        { prefix: 'ops', count: 20, types: { decision: 12, topic: 8 } },
        { prefix: 'eng', count: 10, types: { topic: 10 } },
      ],
    })
    assert.deepEqual(
      familyCounts(m, new Uint8Array([1, 1])).map((c) => [c.type, c.count]),
      [
        ['topic', 18],
        ['decision', 12],
      ],
    )
  })

  it('a family’s pill sits at the middle of its drawn points; a family with none has no pill', () => {
    const fam = new Uint8Array([0, 0, 2, 2, 2])
    const xy = new Float32Array([0, 0, 10, 20, 100, 100, 110, 100, 105, 130])
    const c = centroids(xy, fam, new Uint8Array([1, 1, 1, 1, 0]), FAMILIES.length)
    assert.deepEqual(c[0], { x: 5, y: 10, n: 2 })
    assert.deepEqual(c[2], { x: 105, y: 100, n: 2 })
    assert.equal(c[1], null)
  })

  // Visual review: a pill sits on its family's dense core, not on the plain middle of its points (a few far
  // points drag the middle toward the hub).
  it('a family’s pill sits on its dense core, in three dimensions', () => {
    // Family 0: 24 points packed near (0, 100, 0) and 8 spread near the hub; family 1 elsewhere.
    const pts: number[] = []
    const fam: number[] = []
    for (let k = 0; k < 24; k++) {
      pts.push(Math.cos(k) * 4, 100 + Math.sin(k) * 4, Math.sin(2 * k) * 4)
      fam.push(0)
    }
    for (let k = 0; k < 8; k++) {
      pts.push(Math.cos(k) * 40, Math.sin(k) * 40, 0)
      fam.push(0)
    }
    pts.push(300, 0, 0, 310, 0, 0)
    fam.push(1, 1)
    const n = fam.length
    const c = cores(new Float32Array(pts), new Uint8Array(fam), new Uint8Array(n).fill(1), FAMILIES.length)
    const a = c[0] as { x: number; y: number; z: number }
    assert.ok(Math.hypot(a.x, a.y - 100, a.z) < 8, `on the packed core: ${JSON.stringify(a)}`)
    const b = c[1] as { x: number; y: number; z: number }
    assert.ok(Math.abs(b.x - 305) < 6)
    assert.equal(c[2], null)
  })

  it('pills that overlap on screen are pushed apart, each as little as it can', () => {
    const rects = [
      { x: 100, y: 100, w: 80, h: 20 },
      { x: 120, y: 105, w: 90, h: 20 },
      { x: 110, y: 95, w: 70, h: 20 },
      { x: 400, y: 400, w: 60, h: 20 },
    ]
    const out = spreadPills(
      rects.map((r) => ({ ...r })),
      4,
    )
    for (let a = 0; a < out.length; a++)
      for (let b = a + 1; b < out.length; b++) {
        const p = out[a] as { x: number; y: number; w: number; h: number }
        const q = out[b] as { x: number; y: number; w: number; h: number }
        const apart =
          p.x + p.w + 4 <= q.x + 0.5 ||
          q.x + q.w + 4 <= p.x + 0.5 ||
          p.y + p.h + 4 <= q.y + 0.5 ||
          q.y + q.h + 4 <= p.y + 0.5
        assert.ok(apart, `${a} and ${b} overlap: ${JSON.stringify([p, q])}`)
      }
    // The one alone does not move; the others stay near where they were.
    assert.deepEqual(out[3], rects[3])
    for (let k = 0; k < 3; k++)
      assert.ok(Math.hypot((out[k]?.x ?? 0) - (rects[k]?.x ?? 0), (out[k]?.y ?? 0) - (rects[k]?.y ?? 0)) < 60)
  })
})
