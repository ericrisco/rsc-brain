// Spec B6 «Graph», plan §3.5 G10 (T031): what the graph answer holds, worked out from the pages and their
// resolved links without a database (the queries feed it; test/wiki/graph.test.ts runs it on PostgreSQL).
// Retired pages are left out, superseded ones carry their status (the web dims them), and above 2 000 pages
// the wiki comes as groups by the first part of the address, each opened on its own with `prefix`.
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  checkFilters,
  GRAPH_KINDS,
  type GraphLink,
  type GraphPage,
  graphView,
} from '../../src/domain/wiki/graph.ts'

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
    // A group whose pages would not fit and have no deeper part to split them by: too big.
    const tiny = graphView(pages, [], { maxChars: 200, prefix: 'a0' })
    assert.equal(tiny.mode, 'too-big')
    assert.equal(tiny.total, 20)
    assert.deepEqual([tiny.nodes, tiny.groups, tiny.across], [[], [], []])
  })

  it('a group above the limit opens by the next part of the address, its own page beside the groups', () => {
    const pages = [
      page('a'),
      page('a/x/1'),
      page('a/x/2'),
      page('a/y/1', { type: 'decision' }),
      page('a/y/2'),
      page('a/z'),
      page('b/q'),
    ]
    const links = [link('a', 'a/x/1'), link('a/x/1', 'a/y/1'), link('a/x/2', 'a/y/2'), link('a/z', 'b/q')]
    const v = graphView(pages, links, { max: 3, prefix: 'a' })
    assert.equal(v.mode, 'groups')
    assert.equal(v.prefix, 'a')
    assert.equal(v.total, 6)
    assert.deepEqual(
      v.groups.map((g) => [g.prefix, g.count]),
      [
        ['a/x', 2],
        ['a/y', 2],
      ],
    )
    // The page at "a" itself and "a/z" (nothing under it) are not groups: they are drawn beside them.
    assert.deepEqual(
      v.nodes.map((n) => n[0]),
      ['a', 'a/z'],
    )
    assert.deepEqual(v.across, [[0, 'a/x', 1]])
    assert.deepEqual(v.groupEdges, [['a/x', 'a/y', 2]])
    // And one level down it opens as pages.
    assert.equal(graphView(pages, links, { max: 3, prefix: 'a/x' }).mode, 'pages')
  })

  it('a link out of a nested group names the outer group the other page is in', () => {
    const pages = [page('a/x/1'), page('a/y/1'), page('b/q')]
    const links = [link('a/x/1', 'a/y/1'), link('a/x/1', 'b/q')]
    const v = graphView(pages, links, { prefix: 'a/x' })
    assert.deepEqual(v.across, [
      [0, 'a/y', 1],
      [0, 'b', 1],
    ])
    assert.deepEqual(
      v.groups.map((g) => [g.prefix, g.count]),
      [
        ['a/y', 1],
        ['b', 1],
      ],
    )
  })

  it('too big only when it cannot be split: more groups than the limit', () => {
    const pages = Array.from({ length: 5 }, (_, i) => page(`a/p${i}`))
    const v = graphView(pages, [], { max: 3, prefix: 'a' })
    assert.equal(v.mode, 'too-big')
    assert.equal(v.total, 5)
  })

  it('filters count in the groups: the mode is decided by all pages, the counts by the filtered ones', () => {
    const pages = [
      page('s/a', { type: 'decision', tags: ['q4'] }),
      page('s/b'),
      page('o/c', { type: 'decision' }),
      page('o/d'),
      page('o/e'),
    ]
    const links = [link('s/a', 'o/c', 'depends-on'), link('s/b', 'o/d')]
    const v = graphView(pages, links, { max: 3, filters: { type: 'decision' } })
    assert.equal(v.mode, 'groups')
    assert.equal(v.total, 2)
    assert.deepEqual(
      v.groups.map((g) => [g.prefix, g.count]),
      [
        ['o', 1],
        ['s', 1],
      ],
    )
    assert.deepEqual(v.groupEdges, [['o', 's', 1]])
    const byKind = graphView(pages, links, { max: 3, filters: { linkKind: 'depends-on' } })
    assert.deepEqual(
      byKind.groups.map((g) => [g.prefix, g.count]),
      [
        ['o', 1],
        ['s', 1],
      ],
    )
    const byTag = graphView(pages, links, { max: 3, filters: { tag: 'q4', q: 'S/A' } })
    assert.deepEqual(
      byTag.groups.map((g) => g.prefix),
      ['s'],
    )
    const byStatus = graphView(pages, links, { max: 3, filters: { status: 'stale,superseded' } })
    assert.equal(byStatus.total, 0)
    // Under the limit the pages themselves are filtered.
    const small = graphView(pages, links, { filters: { type: 'decision' } })
    assert.deepEqual(
      small.nodes.map((n) => n[0]),
      ['o/c', 's/a'],
    )
    assert.deepEqual(small.edges, [[1, 0, GRAPH_KINDS.indexOf('depends-on')]])
  })

  it('pages or groups is decided on the unfiltered pages, also when a filter makes the answer small', () => {
    // The reviewers' case: 1 800 pages of long titles do not fit as pages, so they come by groups; a filter
    // that leaves 200 must not turn them into pages (every box would read 0).
    const pages = Array.from({ length: 1800 }, (_, i) =>
      page(`area${i % 5}/page-number-${String(i).padStart(5, '0')}`, {
        title: `A reasonably long title for the page number with more words ${i}`,
        type: i % 9 === 0 ? 'decision' : 'topic',
        tags: ['alpha', 'beta'],
      }),
    )
    const links = pages.slice(1).map((p, i) => link(p.address, pages[i]?.address ?? ''))
    const all = graphView(pages, links, { maxChars: 256_000 })
    assert.equal(all.mode, 'groups')
    const f = graphView(pages, links, { maxChars: 256_000, filters: { type: 'decision' } })
    assert.equal(f.mode, 'groups')
    assert.equal(f.total, 200)
    assert.deepEqual(
      f.groups.map((g) => g.count),
      [40, 40, 40, 40, 40],
    )
  })

  it('too big is decided on the unfiltered pages too', () => {
    const pages = ['x', 'y', 'z', 'w'].map((g, i) => page(`a/${g}/1`, { type: i ? 'topic' : 'decision' }))
    // Unfiltered, "a" makes 4 groups (more than 3): too big, whatever a filter leaves (here one group).
    const v = graphView(pages, [], { max: 3, prefix: 'a', filters: { type: 'decision' } })
    assert.equal(v.mode, 'too-big')
  })

  it('a page with no deeper part is a page beside the groups, at the top and inside a group', () => {
    const pages = [
      page('eng/backend/a'),
      page('eng/backend/b'),
      page('eng/frontend/c'),
      page('eng/note-1'),
      page('eng/note-2'),
      page('readme-1'),
      page('sales/x'),
    ]
    const top = graphView(pages, [link('readme-1', 'sales/x')], { max: 3 })
    assert.equal(top.mode, 'groups')
    assert.deepEqual(
      top.groups.map((g) => g.prefix),
      ['eng', 'sales'],
    )
    assert.deepEqual(
      top.nodes.map((n) => n[0]),
      ['readme-1'],
    )
    assert.deepEqual(top.across, [[0, 'sales', 1]])
    const eng = graphView(pages, [], { max: 3, prefix: 'eng' })
    assert.equal(eng.mode, 'groups')
    assert.deepEqual(
      eng.groups.map((g) => [g.prefix, g.count]),
      [
        ['eng/backend', 2],
        ['eng/frontend', 1],
      ],
    )
    assert.deepEqual(
      eng.nodes.map((n) => n[0]),
      ['eng/note-1', 'eng/note-2'],
    )
  })

  it('more than 50 such pages are gathered into one group of the other pages, opened with loose', () => {
    const pages = [
      ...Array.from({ length: 60 }, (_, i) => page(`eng/note-${i}`)),
      ...Array.from({ length: 4 }, (_, i) => page(`eng/backend/s${i}`)),
    ]
    const v = graphView(pages, [], { max: 60, prefix: 'eng' })
    assert.equal(v.mode, 'groups')
    assert.deepEqual(v.nodes, [])
    assert.deepEqual(
      v.groups.map((g) => [g.prefix, g.count, g.loose ?? false]),
      [
        ['eng/backend', 4, false],
        ['eng', 60, true],
      ],
    )
    const loose = graphView(pages, [], { max: 60, prefix: 'eng', loose: true })
    assert.equal(loose.mode, 'pages')
    assert.equal(loose.total, 60)
    assert.ok(loose.nodes.every((n) => n[0].startsWith('eng/note-')))
  })

  it('refuses a prefix, words or a tag longer than 200 characters', () => {
    assert.throws(() => checkFilters({ prefix: 'a'.repeat(201) }), /200/)
    assert.throws(() => checkFilters({ q: 'a'.repeat(201) }), /200/)
    checkFilters({ prefix: 'a'.repeat(200) })
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
