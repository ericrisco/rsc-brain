// Spec B6 «Graph» (T032, T033): the logic of the graph screen, without the DOM. The graph's answer becomes
// items and edges by index; filters by type, status, tag, words and link kind decide what is drawn, the same
// way the list filters; focus keeps a page and its neighbours at one or two hops; the arrow keys walk to the
// linked page that lies that way; a click finds the page under the pointer; the view fits what is drawn.
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { ROLE } from '../../web/src/graph/layout.ts'
import {
  type Answer,
  areas,
  fit,
  focusView,
  hit,
  hubs,
  keyOf,
  linksOf,
  mainCluster,
  modelOf,
  NO_FILTERS,
  neighbourhood,
  RINGS,
  radial,
  roles,
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

  it('a group opened further: its own page beside the groups, linked to the group it links into', () => {
    const m = modelOf({
      ...base,
      mode: 'groups',
      prefix: 'a',
      total: 5,
      nodes: [['a', 'A', 'overview', 'current', []]],
      across: [[0, 'a/x', 2]],
      groups: [
        { prefix: 'a/x', count: 3, types: { topic: 3 } },
        { prefix: 'a/y', count: 1, types: { topic: 1 } },
      ],
      groupEdges: [['a/x', 'a/y', 1]],
    })
    assert.equal(m.pages, 1)
    assert.deepEqual(
      m.items.map((i) => i.kind),
      ['page', 'group', 'group'],
    )
    assert.deepEqual(Array.from(m.edges), [0, 1, 1, 2])
    const v = visibility(m, NO_FILTERS)
    assert.deepEqual(Array.from(v.nodes), [1, 1, 1])
    assert.equal(v.pages, 5)
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
    assert.equal(v.pages, 4)
  })
  it('a link kind that does not exist filters nothing, the same as the list ignores it', () => {
    const v = visibility(m, { ...NO_FILTERS, linkKind: 'likes' })
    assert.equal(v.shown, 4)
    assert.deepEqual(Array.from(v.edges), [1, 1, 1])
  })
  it('several statuses at once, comma separated, as the list asks for them', () => {
    assert.deepEqual(shown({ status: 'stale,superseded' }), ['a/two', 'b/three'])
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
  it('a link kind keeps a page whose partner of that kind another filter hides, as the server does', () => {
    // a/one is related to a/two, a decision: by topic, a/two is hidden but a/one still has a related link.
    assert.deepEqual(shown({ linkKind: 'related', type: 'topic' }), ['a/one'])
    const v = visibility(m, { ...NO_FILTERS, linkKind: 'related', type: 'topic' })
    assert.deepEqual(Array.from(v.edges), [0, 0, 0])
  })
  it('in one group, the pages the server says match a link kind (links out of the group carry no kind)', () => {
    const one = modelOf(oneGroup)
    const v = visibility(one, { ...NO_FILTERS, linkKind: 'depends-on' }, undefined, new Set(['a/two']))
    assert.deepEqual(Array.from(v.nodes), [0, 1, 0])
    assert.equal(v.pages, 1)
  })
  it('an edge is drawn only when both its pages are', () => {
    const v = visibility(m, { ...NO_FILTERS, type: 'topic' })
    assert.deepEqual(Array.from(v.edges), [0, 0, 1])
  })
  it('groups show the counts the server gave for these filters, and hide a group left with none', () => {
    const g = modelOf(groups)
    const v = visibility(g, { ...NO_FILTERS, tag: 'q4' }, new Map([['a', 3]]))
    assert.deepEqual(Array.from(v.nodes), [1, 0])
    assert.deepEqual(Array.from(v.edges), [0])
    assert.equal(v.pages, 3)
    assert.equal(visibility(g, NO_FILTERS).pages, 30)
  })
  it('in one group, a box of another group shows while a page drawn links to it; it is never a page', () => {
    const one = modelOf(oneGroup)
    const v = visibility(one, NO_FILTERS)
    assert.deepEqual(Array.from(v.nodes), [1, 1, 1])
    assert.equal(v.pages, 2)
    const hidden = visibility(one, { ...NO_FILTERS, q: 'one' })
    assert.deepEqual(Array.from(hidden.nodes), [1, 0, 0])
    assert.equal(hidden.pages, 1)
  })
})

describe('reading the picture', () => {
  it('degree: how many items each links with; hubs are the most linked drawn ones', () => {
    const m = modelOf(pages)
    assert.deepEqual(Array.from(m.degree), [2, 2, 2, 0])
    const all = new Uint8Array([1, 1, 1, 1])
    assert.deepEqual(hubs(m, all, 2), [0, 2])
    assert.deepEqual(hubs(m, new Uint8Array([0, 1, 1, 1]), 5), [2, 1])
  })
  it('hubs: ties go to the page linked to most, then by title', () => {
    // All three linked pages link with two and are linked to once: by title, One, Three, Two.
    assert.deepEqual(hubs(modelOf(pages), new Uint8Array([1, 1, 1, 1]), 3), [0, 2, 1])
    const m = modelOf({
      ...pages,
      nodes: [
        ['p/b', 'B', 'topic', 'current', []],
        ['p/a', 'A', 'topic', 'current', []],
        ['p/c', 'C', 'topic', 'current', []],
        ['p/d', 'D', 'topic', 'current', []],
      ],
      edges: [
        [2, 0, 1],
        [0, 3, 1],
        [1, 3, 1],
      ],
    })
    // B and D both link with two; D is linked to twice.
    assert.deepEqual(hubs(m, new Uint8Array([1, 1, 1, 1]), 2), [3, 0])
  })
  it('roles: pages without links are parked, the boxes of other groups go on the rim', () => {
    assert.deepEqual(Array.from(roles(modelOf(pages))), [ROLE.free, ROLE.free, ROLE.free, ROLE.orphan])
    assert.deepEqual(Array.from(roles(modelOf(oneGroup))), [ROLE.free, ROLE.free, ROLE.rim])
    assert.deepEqual(Array.from(roles(modelOf(groups))), [ROLE.free, ROLE.free])
  })
  it('areas: the next part of the address under the open group pulls pages together', () => {
    const m = modelOf({
      ...base,
      mode: 'pages',
      prefix: 'a',
      total: 3,
      nodes: [
        ['a/x/1', '1', 'topic', 'current', []],
        ['a/y/1', '2', 'topic', 'current', []],
        ['a/x/2', '3', 'topic', 'current', []],
      ],
    })
    const a = areas(m)
    assert.equal(a[0], a[2])
    assert.notEqual(a[0], a[1])
  })
  it('the main cluster is the biggest linked part of what is drawn: the view fits it', () => {
    const m = modelOf({
      ...pages,
      edges: [
        [0, 1, 1],
        [1, 2, 1],
      ],
    })
    const v = visibility(m, NO_FILTERS)
    assert.deepEqual(Array.from(mainCluster(m, v.nodes, v.edges)), [1, 1, 1, 0])
    // Nothing linked: everything drawn counts.
    const lone = modelOf({ ...pages, edges: [] })
    const w = visibility(lone, NO_FILTERS)
    assert.deepEqual(Array.from(mainCluster(lone, w.nodes, w.edges)), [1, 1, 1, 1])
  })
  it('focus lays the page in the middle, one hop on a ring, two hops on a wider one', () => {
    const m = modelOf(pages)
    const hood = new Map([
      [0, 0],
      [1, 1],
      [2, 2],
    ])
    const xy = radial(m, hood, 4)
    const r = (i: number) => Math.hypot(xy[2 * i] as number, xy[2 * i + 1] as number)
    assert.equal(r(0), 0)
    assert.ok(Math.abs(r(1) - RINGS[0]) < 1e-3)
    assert.ok(Math.abs(r(2) - RINGS[1]) < 1e-3)
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
  it('focus with a filter: a hidden one-hop page still leads to its two-hop pages, by a faint line', () => {
    // one → two → three, all linked in a chain from a/one; two is a decision, hidden by type.
    const chain = modelOf({
      ...pages,
      edges: [
        [0, 1, 1],
        [1, 2, 0],
      ],
    })
    const base = visibility(chain, { ...NO_FILTERS, type: 'topic' })
    const f = focusView(chain, base, 0, 2)
    assert.deepEqual(Array.from(f.nodes), [1, 0, 1, 0])
    assert.equal(f.shown, 2)
    // three is reached through two, which the filter hides: one line from the page in focus.
    assert.deepEqual([...f.via], [[2, 1]])
    assert.deepEqual(f.bridges, [[0, 2]])
    assert.deepEqual(f.hiddenVia, new Set([1]))
    const plain = focusView(chain, visibility(chain, NO_FILTERS), 0, 2)
    assert.deepEqual(plain.bridges, [])
    assert.deepEqual([...plain.via], [[2, 1]])
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
