// Spec amendment 2026-11-09, CA12 (plan canvas-ui S.1, SB3): the graph's families. A page's family is its
// type, each type with a colour of its own among the seven of shared.css v2; a group takes the type most of
// its pages have. The legend counts the pages of each family that are drawn (a group counts its pages by
// type), and a family's pill sits at the middle of its drawn points.
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { centroids, FAMILIES, familyCounts, familyIndex, familyOfType } from '../../web/src/graph/families.ts'
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
})
