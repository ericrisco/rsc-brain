// v0.5.0: the graph's communities, the clusters of densely linked pages, worked out from the links alone and
// the same every time; each named after its most linked page, the biggest first, each of the biggest in a
// colour of its own and the small rest sharing one. Pages without links are a bucket of their own.
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  COLOURS,
  communitiesOf,
  louvain,
  NO_LINKS,
  OTHER,
  shortName,
} from '../../web/src/graph/communities.ts'
import { type Answer, modelOf } from '../../web/src/graph/model.ts'

// `k` cliques of `size` pages each, joined in a chain by one link between consecutive cliques.
function cliques(k: number, size: number) {
  const pairs: number[] = []
  for (let c = 0; c < k; c++) {
    const base = c * size
    for (let a = 0; a < size; a++) for (let b = a + 1; b < size; b++) pairs.push(base + a, base + b)
    if (c + 1 < k) pairs.push(base, base + size)
  }
  return new Uint32Array(pairs)
}

function answer(n: number, edges: Uint32Array, title = (i: number) => `Page ${i}`): Answer {
  const e: [number, number, number][] = []
  for (let k = 0; k < edges.length; k += 2) e.push([edges[k] as number, edges[k + 1] as number, 0])
  return {
    mode: 'pages',
    prefix: null,
    total: n,
    kinds: ['related'],
    nodes: Array.from({ length: n }, (_, i) => [`p/${i}`, title(i), 'topic', 'current', []]),
    edges: e,
    across: [],
    groups: [],
    groupEdges: [],
  }
}

describe('communities of the graph', () => {
  it('finds each densely linked cluster, whatever the order the links come in', () => {
    const edges = cliques(4, 6)
    const c = louvain(24, edges)
    for (let k = 0; k < 4; k++) {
      const first = c[6 * k] as number
      for (let i = 6 * k; i < 6 * k + 6; i++) assert.equal(c[i], first, `page ${i} with its clique`)
    }
    assert.equal(new Set(c).size, 4)
    // Reversed links: the same partition.
    const rev = new Uint32Array(edges.length)
    for (let e = 0; e < edges.length; e += 2) {
      rev[edges.length - 2 - e] = edges[e + 1] as number
      rev[edges.length - 1 - e] = edges[e] as number
    }
    const d = louvain(24, rev)
    for (let i = 0; i < 24; i++) for (let j = 0; j < 24; j++) assert.equal(c[i] === c[j], d[i] === d[j])
  })

  it('is the same every time', () => {
    const edges = cliques(9, 5)
    assert.deepEqual(Array.from(louvain(45, edges)), Array.from(louvain(45, edges)))
  })

  it('gives every page without links to the "no links" bucket, and nothing else', () => {
    const m = modelOf(answer(14, cliques(2, 6)))
    const c = communitiesOf(m)
    assert.equal(c.of[12], NO_LINKS)
    assert.equal(c.of[13], NO_LINKS)
    assert.equal(c.none, 2)
    for (let i = 0; i < 12; i++) assert.ok((c.of[i] as number) >= 0)
  })

  it('lists them biggest first, each named after its most linked page, shortened', () => {
    // Clique 0 has 4 pages, clique 1 has 7: page 7 (the second clique's first, linked back to clique 0) is the
    // most linked of its clique.
    const pairs: number[] = []
    for (let a = 0; a < 4; a++) for (let b = a + 1; b < 4; b++) pairs.push(a, b)
    for (let a = 4; a < 11; a++) for (let b = a + 1; b < 11; b++) pairs.push(a, b)
    pairs.push(0, 4)
    const long = 'A page whose title is far too long to sit in a row of the panel'
    const m = modelOf(
      answer(11, new Uint32Array(pairs), (i) => (i === 4 ? long : i === 0 ? 'Hub' : `Page ${i}`)),
    )
    const c = communitiesOf(m)
    assert.deepEqual(
      c.list.map((x) => x.count),
      [7, 4],
    )
    assert.equal(c.list[0]?.name, shortName(long))
    assert.ok((c.list[0]?.name.length ?? 99) <= 28)
    assert.ok(c.list[0]?.name.endsWith('…'))
    assert.equal(c.list[1]?.name, 'Hub')
    // Each item knows the row it is in.
    assert.equal(c.of[5], c.list[0]?.id)
    assert.equal(c.of[1], c.list[1]?.id)
  })

  it('gives the biggest communities a colour each, and the small rest the shared "other" colour', () => {
    const n = 5 * (COLOURS + 3)
    const c = communitiesOf(modelOf(answer(n, cliques(COLOURS + 3, 5))))
    assert.equal(c.list.length, COLOURS + 3)
    const colours = c.list.map((x) => x.colour)
    assert.deepEqual(
      colours.slice(0, COLOURS),
      Array.from({ length: COLOURS }, (_, k) => k),
    )
    for (const k of colours.slice(COLOURS)) assert.equal(k, OTHER)
    // Per item: the colour of its community.
    const at = (i: number) => c.colour[i]
    assert.equal(at(0), c.list.find((x) => x.id === c.of[0])?.colour)
  })

  it('an empty wiki, and a wiki of pages without links, have no communities', () => {
    assert.deepEqual(communitiesOf(modelOf(answer(0, new Uint32Array()))).list, [])
    const c = communitiesOf(modelOf(answer(3, new Uint32Array())))
    assert.deepEqual(c.list, [])
    assert.equal(c.none, 3)
  })

  it('2 000 pages take a few milliseconds', () => {
    const edges = cliques(200, 10)
    const t = performance.now()
    const c = louvain(2000, edges)
    const ms = performance.now() - t
    // Each clique whole in one community (modularity may join two neighbours in the chain).
    for (let k = 0; k < 200; k++) for (let i = 10 * k; i < 10 * k + 10; i++) assert.equal(c[i], c[10 * k])
    assert.ok(new Set(c).size >= 50, `${new Set(c).size} communities`)
    assert.ok(ms < 500, `${ms.toFixed(0)} ms`)
  })
})
