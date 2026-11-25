// Spec learning-memory A1 (plan §2.1, §2.2): each part of a proposal is applied, held for a person, or returned to
// redo on the current page; parts that depend on one another share their fate, so the wiki is never left half-done.
// classify() is pure: the facts (mode, permission, protected and corrected pages, current revisions) come from the
// caller (T005). CA-A4, A5, A6, A24.
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import type { Op } from '../../src/domain/wiki/model.ts'
import { classify, type Facts, writesTo } from '../../src/domain/wiki/parts.ts'

const R = 'Because.'
const create = (
  address: string,
  links: Array<{ kind: 'related' | 'supersedes' | 'contradicts'; to: string }> = [],
): Op => ({
  op: 'create',
  address,
  type: 'topic',
  title: address,
  summary: '',
  body: '',
  tags: [],
  sources: [],
  links,
  reason: R,
})
const edit = (address: string, baseRevision?: number): Op => ({
  op: 'edit',
  address,
  ...(baseRevision === undefined ? {} : { baseRevision }),
  body: 'New.',
  reason: R,
})
const link = (
  address: string,
  to: string,
  kind: 'related' | 'supersedes' | 'contradicts' = 'related',
): Op => ({
  op: 'link',
  address,
  kind,
  to,
  reason: R,
})

// Pages q (protected, id pg_q), c (corrected, id pg_c), a and b (plain), each at revision 3.
const facts = (o: Partial<Facts> = {}): Facts => ({
  mode: 'auto',
  canWrite: false,
  protectedPages: new Set(['pg_q']),
  correctedPages: new Set(['pg_c']),
  current: new Map([
    ['q', { pageId: 'pg_q', revision: 3 }],
    ['c', { pageId: 'pg_c', revision: 3 }],
    ['a', { pageId: 'pg_a', revision: 3 }],
    ['b', { pageId: 'pg_b', revision: 3 }],
  ]),
  ...o,
})

describe('writesTo: the pages a part writes', () => {
  it('its own address; the other page of a «supersedes» link; the page merged in; never a page only read', () => {
    assert.deepEqual(writesTo(edit('a', 3)), ['a'])
    assert.deepEqual(writesTo(link('a', 'b')), ['a'])
    assert.deepEqual(writesTo(link('a', 'b', 'supersedes')), ['a', 'b'])
    assert.deepEqual(writesTo({ op: 'unlink', address: 'a', kind: 'supersedes', to: 'b', reason: R }), [
      'a',
      'b',
    ])
    assert.deepEqual(
      writesTo(
        create('n', [
          { kind: 'supersedes', to: 'b' },
          { kind: 'related', to: 'a' },
        ]),
      ),
      ['n', 'b'],
    )
    assert.deepEqual(
      writesTo({ op: 'merge', address: 'a', from: 'b', body: '', dropSources: [], dropLinks: [], reason: R }),
      ['a', 'b'],
    )
    assert.deepEqual(
      writesTo({ op: 'status', address: 'a', status: 'superseded', supersededBy: 'b', reason: R }),
      ['a'],
    )
    assert.deepEqual(writesTo({ op: 'move', address: 'a', to: 'x', reason: R }), ['a'])
    assert.deepEqual(writesTo({ op: 'revert', address: 'a', toRevision: 1, reason: R }), ['a'])
  })
})

describe('classify', () => {
  it('everything applies on plain pages', () => {
    assert.deepEqual(classify([edit('a', 3), create('n'), link('n', 'b')], facts()), {
      apply: [0, 1, 2],
      held: [],
      returned: [],
    })
  })

  it('CA-A4, A5: a part on a protected page waits without the permission; the other part applies', () => {
    const r = classify([edit('q', 3), edit('a', 3)], facts())
    assert.deepEqual(r.apply, [1])
    assert.deepEqual(
      r.held.map((h) => [h.op, h.address, h.reason]),
      [[0, 'q', 'protected']],
    )
    assert.match(r.held[0]?.detail ?? '', /protected/)
    assert.deepEqual(r.returned, [])
  })

  it('CA-A17: with the wiki write permission, a protected page is written', () => {
    assert.deepEqual(classify([edit('q', 3)], facts({ canWrite: true })).apply, [0])
  })

  it('a «supersedes» link onto a protected page writes it, so it waits; a «related» link from a plain page does not', () => {
    const r = classify([link('a', 'q', 'supersedes'), link('a', 'q', 'related')], facts())
    assert.deepEqual(r.apply, [1])
    assert.deepEqual(
      r.held.map((h) => [h.op, h.address, h.reason]),
      [[0, 'q', 'protected']],
    )
  })

  it('CA-A6: a part that changes a corrected page waits, with the permission too', () => {
    for (const canWrite of [false, true]) {
      const r = classify([edit('c', 3), edit('a', 3)], facts({ canWrite }))
      assert.deepEqual(r.apply, [1])
      assert.deepEqual(
        r.held.map((h) => [h.op, h.address, h.reason]),
        [[0, 'c', 'correction']],
      )
      assert.match(r.held[0]?.detail ?? '', /correction/)
    }
  })

  it('CA-A6: a «contradicts» or «supersedes» link towards a corrected page waits; a «related» one does not', () => {
    const r = classify(
      [
        link('a', 'c', 'contradicts'),
        link('b', 'c', 'related'),
        create('n', [{ kind: 'contradicts', to: 'c' }]),
      ],
      facts(),
    )
    assert.deepEqual(r.apply, [1])
    assert.deepEqual(
      r.held.map((h) => [h.op, h.address, h.reason]),
      [
        [0, 'c', 'correction'],
        [2, 'c', 'correction'],
      ],
    )
  })

  it('a merge that takes in a corrected page waits', () => {
    const r = classify(
      [{ op: 'merge', address: 'a', from: 'c', body: '', dropSources: [], dropLinks: [], reason: R }],
      facts(),
    )
    assert.deepEqual(
      r.held.map((h) => [h.op, h.reason]),
      [[0, 'correction']],
    )
  })

  it('an edit written on an old revision comes back with the current one', () => {
    const r = classify([edit('a', 2), edit('b', 3), edit('b')], facts())
    assert.deepEqual(r.apply, [1, 2])
    assert.deepEqual(r.returned, [{ op: 0, address: 'a', reason: 'stale', currentRevision: 3 }])
  })

  it('«Ask first»: every part waits, whatever it is', () => {
    const r = classify(
      [edit('a', 3), create('n'), edit('b', 1)],
      facts({ mode: 'ask_first', canWrite: true }),
    )
    assert.deepEqual(r.apply, [])
    assert.deepEqual(
      r.held.map((h) => [h.op, h.reason]),
      [
        [0, 'ask_first'],
        [1, 'ask_first'],
        [2, 'ask_first'],
      ],
    )
    assert.deepEqual(r.returned, [])
  })

  it('CA-A24: create P and link to it from a protected page: P is created, the link waits, nothing points nowhere', () => {
    const r = classify([create('p'), link('q', 'p')], facts())
    assert.deepEqual(r.apply, [0])
    assert.deepEqual(
      r.held.map((h) => [h.op, h.address, h.reason]),
      [[1, 'q', 'protected']],
    )
  })

  it('CA-A24: what depends on a part that waits waits too, along a chain', () => {
    const ops: Op[] = [
      { op: 'move', address: 'q', to: 'k', reason: R }, // 0: moves a protected page → held
      create('n', [{ kind: 'related', to: 'k' }]), // 1: needs k (0) → held, depends
      link('a', 'n'), // 2: needs n (1) → held, depends (two steps away)
      create('m'), // 3: plain → applies
      link('b', 'm'), // 4: needs m (3) → applies
    ]
    const r = classify(ops, facts())
    assert.deepEqual(r.apply, [3, 4])
    assert.deepEqual(
      r.held.map((h) => [h.op, h.address, h.reason]),
      [
        [0, 'q', 'protected'],
        [1, 'n', 'depends'],
        [2, 'a', 'depends'],
      ],
    )
    assert.match(r.held.find((h) => h.op === 2)?.detail ?? '', /part 0/)
  })

  it('marking a page superseded goes with its «supersedes» link: when the link waits, so does the mark', () => {
    const ops: Op[] = [
      link('q', 'b', 'supersedes'), // 0: writes q (protected) → held
      { op: 'status', address: 'b', status: 'superseded', supersededBy: 'q', reason: R }, // 1: needs 0
    ]
    const r = classify(ops, facts())
    assert.deepEqual(r.apply, [])
    assert.deepEqual(
      r.held.map((h) => [h.op, h.reason]),
      [
        [0, 'protected'],
        [1, 'depends'],
      ],
    )
  })

  it('a part keeps its own reason to wait even when it also needs another waiting part', () => {
    const ops: Op[] = [
      { op: 'move', address: 'a', to: 'k', reason: R },
      edit('c', 3),
      link('k', 'c', 'contradicts'),
    ]
    const r = classify(ops, facts({ protectedPages: new Set(['pg_a']) }))
    assert.deepEqual(
      r.held.map((h) => [h.op, h.reason]),
      [
        [0, 'protected'],
        [1, 'correction'],
        [2, 'correction'],
      ],
    )
  })
})
