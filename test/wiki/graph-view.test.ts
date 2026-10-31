// Spec B6 «Graph», plan §3.5 G10 (T031): what the graph answer holds, worked out from the pages and their
// resolved links without a database (the queries feed it; test/wiki/graph.test.ts runs it on PostgreSQL).
// Retired pages are left out, superseded ones carry their status (the web dims them), and above 2 000 pages
// the wiki comes as groups by the first part of the address, each opened on its own with `prefix`.
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { GRAPH_KINDS, type GraphLink, type GraphPage, graphView } from '../../src/domain/wiki/graph.ts'

const page = (address: string, extra: Partial<GraphPage> = {}): GraphPage => ({
  address,
  title: `Page ${address}`,
  type: 'topic',
  status: 'current',
  tags: [],
  ...extra,
})
const link = (from: string, to: string, kind = 'related'): GraphLink => ({ from, to, kind })

describe('the graph of a wiki (G10)', () => {
  it('one node a page and one edge a link, by index, with the link kind by index too', () => {
    const v = graphView(
      [page('b/one', { type: 'decision', tags: ['q4'] }), page('a/two')],
      [link('b/one', 'a/two', 'depends-on'), link('a/two', 'b/one', 'mentions')],
    )
    assert.equal(v.mode, 'pages')
    assert.equal(v.prefix, null)
    assert.equal(v.total, 2)
    assert.deepEqual(v.kinds, GRAPH_KINDS)
    // In address order.
    assert.deepEqual(v.nodes, [
      ['a/two', 'Page a/two', 'topic', 'current', []],
      ['b/one', 'Page b/one', 'decision', 'current', ['q4']],
    ])
    assert.deepEqual(v.edges, [
      [0, 1, GRAPH_KINDS.indexOf('mentions')],
      [1, 0, GRAPH_KINDS.indexOf('depends-on')],
    ])
    assert.deepEqual(v.groups, [])
    assert.deepEqual(v.groupEdges, [])
    assert.deepEqual(v.across, [])
  })

  it('leaves retired pages and their links out, and keeps superseded ones with their status', () => {
    const v = graphView(
      [page('a/old', { status: 'retired' }), page('a/was', { status: 'superseded' }), page('a/now')],
      [link('a/now', 'a/old'), link('a/old', 'a/was'), link('a/now', 'a/was', 'supersedes')],
    )
    assert.deepEqual(
      v.nodes.map((n) => [n[0], n[3]]),
      [
        ['a/now', 'current'],
        ['a/was', 'superseded'],
      ],
    )
    assert.equal(v.total, 2)
    assert.deepEqual(v.edges, [[0, 1, GRAPH_KINDS.indexOf('supersedes')]])
  })

  it('drops links to pages it does not know, links to itself and repeated links', () => {
    const v = graphView(
      [page('a/x'), page('a/y')],
      [
        link('a/x', 'nowhere'),
        link('a/x', 'a/x'),
        link('a/x', 'a/y'),
        link('a/x', 'a/y'),
        link('a/x', 'a/y', 'bogus'),
      ],
    )
    assert.deepEqual(v.edges, [[0, 1, GRAPH_KINDS.indexOf('related')]])
  })

  it('an empty wiki is an empty graph of pages', () => {
    const v = graphView([], [])
    assert.deepEqual([v.mode, v.total, v.nodes, v.edges], ['pages', 0, [], []])
  })

  it('above the limit it comes as groups by the first part of the address, with the links between them', () => {
    const pages = [
      page('sales/a'),
      page('sales/b', { type: 'decision' }),
      page('sales'),
      page('ops/c'),
      page('ops/d/e', { status: 'superseded' }),
      page('legal/z', { status: 'retired' }),
    ]
    const links = [
      link('sales/a', 'ops/c'),
      link('ops/c', 'sales/b', 'mentions'),
      link('sales/a', 'sales/b'),
      link('ops/d/e', 'legal/z'),
    ]
    const v = graphView(pages, links, { max: 3 })
    assert.equal(v.mode, 'groups')
    assert.equal(v.total, 5)
    assert.deepEqual(v.nodes, [])
    assert.deepEqual(v.edges, [])
    assert.deepEqual(v.groups, [
      { prefix: 'ops', count: 2, types: { topic: 2 } },
      { prefix: 'sales', count: 3, types: { decision: 1, topic: 2 } },
    ])
    // Links inside a group are not drawn between groups; both directions add up.
    assert.deepEqual(v.groupEdges, [['ops', 'sales', 2]])
  })

  it('at the limit itself it still draws pages', () => {
    const v = graphView([page('a/1'), page('a/2'), page('b/3')], [], { max: 3 })
    assert.equal(v.mode, 'pages')
  })

  it('opens one group with `prefix`: its pages, the links inside, and links out by the other group', () => {
    const pages = [
      page('sales/a'),
      page('sales/b'),
      page('sales'),
      page('salesy/q'),
      page('ops/c'),
      page('ops/d'),
    ]
    const links = [
      link('sales/a', 'sales/b'),
      link('sales/a', 'ops/c'),
      link('ops/d', 'sales/a', 'mentions'),
      link('ops/c', 'sales/b'),
      link('ops/c', 'ops/d'),
    ]
    const v = graphView(pages, links, { max: 3, prefix: 'sales' })
    assert.equal(v.mode, 'pages')
    assert.equal(v.prefix, 'sales')
    assert.equal(v.total, 3)
    // "salesy/q" is another group: a prefix is a whole first part.
    assert.deepEqual(
      v.nodes.map((n) => n[0]),
      ['sales', 'sales/a', 'sales/b'],
    )
    assert.deepEqual(v.edges, [[1, 2, GRAPH_KINDS.indexOf('related')]])
    // sales/a has two links with ops (out and in), sales/b one.
    assert.deepEqual(v.across, [
      [1, 'ops', 2],
      [2, 'ops', 1],
    ])
    assert.deepEqual(v.groups, [{ prefix: 'ops', count: 2, types: { topic: 2 } }])
  })

  it('a prefix with no page is an empty graph of that prefix', () => {
    const v = graphView([page('a/x')], [], { prefix: 'nothing' })
    assert.deepEqual([v.mode, v.prefix, v.total, v.nodes], ['pages', 'nothing', 0, []])
  })

  it('pages that would pass the size limit come as groups; a group that would says it is too big', () => {
    const pages = Array.from({ length: 40 }, (_, i) => page(`a${i % 2}/p${i}`, { title: 'x'.repeat(200) }))
    const whole = graphView(pages, [], { maxChars: 2000 })
    assert.equal(whole.mode, 'groups')
    assert.equal(whole.groups.length, 2)
    const one = graphView(pages, [], { maxChars: 2000, prefix: 'a0' })
    assert.equal(one.mode, 'too-big')
    assert.equal(one.total, 20)
    assert.deepEqual([one.nodes, one.groups, one.across], [[], [], []])
  })

  it('works out 5 000 pages in a blink', () => {
    const pages = Array.from({ length: 5000 }, (_, i) => page(`area${i % 12}/p${i}`))
    const links = pages.flatMap((p, i) => [link(p.address, pages[(i + 7) % 5000]?.address ?? '')])
    const t = process.cpuUsage()
    const v = graphView(pages, links)
    const ms = (process.cpuUsage(t).user + process.cpuUsage(t).system) / 1000
    assert.equal(v.mode, 'groups')
    assert.equal(v.groups.length, 12)
    assert.ok(ms < 500, `${ms} ms of CPU`)
  })
})
