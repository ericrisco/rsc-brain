// Spec B6 «Graph» (T032, T033): the logic of the graph screen, without the DOM. The graph's answer becomes
// items and edges by index; filters by type, status, tag, words and link kind decide what is drawn, the same
// way the list filters; focus keeps a page and its neighbours at one or two hops; the arrow keys walk to the
// linked page that lies that way; a click finds the page under the pointer; the view fits what is drawn.
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  type Answer,
  fit,
  hit,
  keyOf,
  linksOf,
  modelOf,
  NO_FILTERS,
  neighbourhood,
  step,
  visibility,
} from '../../web/src/graph/model.ts'

const KINDS = ['mentions', 'related', 'depends-on', 'contradicts', 'supersedes', 'part-of', 'example-of']
const base = {
  kinds: KINDS,
  nodes: [],
  edges: [],
  across: [],
  groups: [],
  groupEdges: [],
}
// a/one → a/two (related), a/two → b/three (mentions), b/three → a/one (depends-on); c/four alone.
const pages: Answer = {
  ...base,
  mode: 'pages',
  prefix: null,
  total: 4,
  nodes: [
    ['a/one', 'One', 'topic', 'current', ['q4']],
    ['a/two', 'Two', 'decision', 'superseded', []],
    ['b/three', 'Three', 'topic', 'stale', ['q4', 'risk']],
    ['c/four', 'Four', 'guide', 'current', []],
  ],
  edges: [
    [0, 1, 1],
    [1, 2, 0],
    [2, 0, 2],
  ],
}
const groups: Answer = {
  ...base,
  mode: 'groups',
  prefix: null,
  total: 30,
  groups: [
    { prefix: 'a', count: 20, types: { topic: 15, decision: 5 } },
    { prefix: 'b', count: 10, types: { topic: 10 } },
  ],
  groupEdges: [['a', 'b', 7]],
}
const oneGroup: Answer = {
  ...base,
  mode: 'pages',
  prefix: 'a',
  total: 2,
  nodes: [
    ['a/one', 'One', 'topic', 'current', []],
    ['a/two', 'Two', 'topic', 'current', []],
  ],
  edges: [[0, 1, 1]],
  across: [[1, 'b', 3]],
  groups: [{ prefix: 'b', count: 10, types: { topic: 10 } }],
}

describe('the graph model', () => {
  it('pages become items with their edges by index and kind', () => {
    const m = modelOf(pages)
    assert.equal(m.items.length, 4)
    assert.equal(m.pages, 4)
    assert.deepEqual(m.items[1], {
      kind: 'page',
      address: 'a/two',
      title: 'Two',
      type: 'decision',
      status: 'superseded',
      tags: [],
    })
    assert.deepEqual(Array.from(m.edges), [0, 1, 1, 2, 2, 0])
    assert.deepEqual(Array.from(m.kind), [1, 0, 2])
    assert.equal(m.index.get(keyOf({ kind: 'page', address: 'b/three' })), 2)
  })

  it('groups become heavy items linked by how many links they share', () => {
    const m = modelOf(groups)
    assert.equal(m.pages, 0)
    assert.deepEqual(
      m.items.map((i) => (i.kind === 'group' ? [i.prefix, i.count] : null)),
      [
        ['a', 20],
        ['b', 10],
      ],
    )
    assert.deepEqual(Array.from(m.weights), [20, 10])
    assert.deepEqual(Array.from(m.edges), [0, 1])
    assert.deepEqual(Array.from(m.kind), [-1])
    assert.deepEqual(Array.from(m.count), [7])
  })

  it('one group: its pages, and the groups they link with as items after them', () => {
    const m = modelOf(oneGroup)
    assert.equal(m.pages, 2)
    assert.equal(m.items.length, 3)
    assert.equal(m.items[2]?.kind, 'group')
    assert.deepEqual(Array.from(m.edges), [0, 1, 1, 2])
    assert.deepEqual(Array.from(m.kind), [1, -1])
    assert.deepEqual(Array.from(m.count), [1, 3])
  })
})

describe('filters, the same as the list', () => {
  const m = modelOf(pages)
  const shown = (f: Partial<typeof NO_FILTERS>) => {
    const v = visibility(m, { ...NO_FILTERS, ...f })
    return m.items.flatMap((it, i) => (v.nodes[i] && it.kind === 'page' ? [it.address] : []))
  }
  it('no filter shows everything', () => {
    const v = visibility(m, NO_FILTERS)
    assert.equal(v.shown, 4)
    assert.deepEqual(Array.from(v.edges), [1, 1, 1])
    assert.equal(v.partial, false)
  })
  it('by type, status, tag and words in the title or the address', () => {
    assert.deepEqual(shown({ type: 'topic' }), ['a/one', 'b/three'])
    assert.deepEqual(shown({ status: 'superseded' }), ['a/two'])
    assert.deepEqual(shown({ tag: 'risk' }), ['b/three'])
    assert.deepEqual(shown({ q: 'THR' }), ['b/three'])
    assert.deepEqual(shown({ q: 'c/fo' }), ['c/four'])
  })
  it('by link kind: the pages with a link of that kind, either way, and only those links', () => {
    assert.deepEqual(shown({ linkKind: 'depends-on' }), ['a/one', 'b/three'])
    const v = visibility(m, { ...NO_FILTERS, linkKind: 'depends-on' })
    assert.deepEqual(Array.from(v.edges), [0, 0, 1])
  })
  it('an edge is drawn only when both its pages are', () => {
    const v = visibility(m, { ...NO_FILTERS, type: 'topic' })
    assert.deepEqual(Array.from(v.edges), [0, 0, 1])
  })
  it('groups filter by type only, and say the other filters wait for a group to open', () => {
    const g = modelOf(groups)
    const byType = visibility(g, { ...NO_FILTERS, type: 'decision' })
    assert.deepEqual(Array.from(byType.nodes), [1, 0])
    assert.equal(byType.partial, false)
    const byTag = visibility(g, { ...NO_FILTERS, tag: 'q4' })
    assert.deepEqual(Array.from(byTag.nodes), [1, 1])
    assert.equal(byTag.partial, true)
  })
})

describe('focus', () => {
  const m = modelOf(pages)
  it('one hop: the page and the pages it links with, either way', () => {
    assert.deepEqual([...neighbourhood(m, 0, 1)].sort(), [
      [0, 0],
      [1, 1],
      [2, 1],
    ])
  })
  it('two hops reach further; a page alone is alone', () => {
    const one = modelOf({
      ...pages,
      edges: [
        [0, 1, 1],
        [1, 2, 0],
      ],
    })
    assert.deepEqual([...neighbourhood(one, 0, 2)].sort(), [
      [0, 0],
      [1, 1],
      [2, 2],
    ])
    assert.deepEqual([...neighbourhood(m, 3, 2)], [[3, 0]])
  })
  it('the links of an item, both ways, with their kind', () => {
    assert.deepEqual(linksOf(m, 0), [
      { index: 1, kind: 'related', way: 'out', count: 1 },
      { index: 2, kind: 'depends-on', way: 'in', count: 1 },
    ])
    assert.deepEqual(linksOf(modelOf(oneGroup), 1), [
      { index: 0, kind: 'related', way: 'in', count: 1 },
      { index: 2, kind: null, way: 'both', count: 3 },
    ])
  })
})

describe('moving around', () => {
  // 0 in the middle, 1 to the right, 2 above (y grows down), 3 far left, not linked to 0.
  const m = modelOf({
    ...pages,
    edges: [
      [0, 1, 1],
      [2, 0, 1],
    ],
  })
  const xy = new Float32Array([0, 0, 50, 5, -5, -40, -200, 0])
  const all = new Uint8Array([1, 1, 1, 1])
  it('an arrow goes to the linked page that lies that way', () => {
    assert.equal(step(m, xy, all, 0, 'right'), 1)
    assert.equal(step(m, xy, all, 0, 'up'), 2)
  })
  it('with no linked page that way, to the nearest page that way; none: stays', () => {
    assert.equal(step(m, xy, all, 0, 'left'), 3)
    assert.equal(step(m, xy, all, 3, 'left'), 3)
    assert.equal(step(m, xy, all, 0, 'down'), 0)
  })
  it('hidden pages are skipped', () => {
    assert.equal(step(m, xy, new Uint8Array([1, 0, 1, 1]), 0, 'right'), 0)
  })
  it('a click finds the nearest drawn page within reach', () => {
    assert.equal(hit(xy, all, 48, 4, 8), 1)
    assert.equal(hit(xy, all, 25, 0, 8), -1)
    assert.equal(hit(xy, new Uint8Array([1, 0, 1, 1]), 48, 4, 8), -1)
  })
  it('fits what is drawn into the canvas, centred, never zoomed in past 2', () => {
    const f = fit(xy, all, 400, 300, 20)
    // From x −200 to 50 and y −40 to 5: 250 × 45 into 360 × 260.
    assert.ok(Math.abs(f.scale - 360 / 250) < 1e-6)
    assert.ok(Math.abs(f.tx - (200 - -75 * f.scale)) < 1e-6)
    const single = fit(new Float32Array([10, 10]), new Uint8Array([1]), 400, 300, 20)
    assert.equal(single.scale, 2)
  })
})
