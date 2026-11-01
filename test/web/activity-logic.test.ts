// Spec B6 «Activity», «Health» and «Search» (PR23, T037–T039): the logic of the three screens, free of the
// DOM. Activity says each event in words and filters by client, kind and reference; a Factory reference
// links to its run only with a safe Factory address. Health lists the sections of B2, each item leading to
// where it is fixed, and copies an instruction that names the tool and the brain. Search asks for the
// current brain or all of them, with its filters, and says what to try when nothing is found.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { describe, it } from 'node:test'
import { SAFE_URL as SERVER_SAFE_URL } from '../../src/core/urls.ts'
import { SEARCH_TYPES } from '../../src/domain/search.ts'
import {
  clientsOf,
  describeEvent,
  factoryRunHref,
  filterEvents,
  KINDS,
  SAFE_URL,
} from '../../web/src/lib/activity.ts'
import { askAgent, HEALTH_SECTIONS, healthItems, totalProblems } from '../../web/src/lib/health.ts'
import { noResults, searchParams, TYPES } from '../../web/src/lib/search.ts'
import type { LiveEvent } from '../../web/src/live/stream.ts'

const ev = (kind: string, o: Partial<LiveEvent> = {}): LiveEvent => ({
  id: '1',
  at: '2026-11-01T10:00:00.000Z',
  brain: 'growth',
  kind,
  who: { id: 'acc_ana', name: 'Ana' },
  key: { id: 'crd_1', ref: null },
  target: { id: 'x', label: 'Short intros win' },
  query: null,
  client: 'claude-code',
  ...o,
})

describe('activity in words', () => {
  it('says who did what, with the client as a person says it', () => {
    assert.deepEqual(describeEvent(ev('entry.saved')), {
      who: 'Ana',
      client: 'Claude Code',
      did: 'saved',
      what: 'Short intros win',
      kind: 'writes',
    })
    assert.equal(describeEvent(ev('search', { query: 'pricing', target: null })).did, 'searched')
    assert.equal(describeEvent(ev('search', { query: 'pricing', target: null })).what, '“pricing”')
    assert.equal(
      describeEvent(ev('read', { target: { id: 'p', label: 'style/intros' } })).did,
      'read the page',
    )
    assert.equal(describeEvent(ev('session.opened')).did, 'opened a session')
    assert.equal(describeEvent(ev('session.closed')).did, 'closed a session')
    assert.equal(describeEvent(ev('proposal.submitted')).did, 'proposed')
    assert.equal(
      describeEvent(ev('proposal.decided', { target: { id: 'p', label: 'approved' } })).did,
      'decided a proposal: approved',
    )
    assert.equal(describeEvent(ev('wiki.changed')).did, 'changed the wiki')
    // The installation itself (a session closed for being idle).
    assert.equal(describeEvent(ev('session.closed', { who: null, client: null })).who, 'rsc-brain')
    // An unknown kind still reads.
    assert.equal(describeEvent(ev('something.new')).did, 'something.new')
  })

  it('filters by client, kind and reference, and lists the clients seen', () => {
    const all = [
      ev('entry.saved', { id: '4', client: 'claude-code', key: { id: 'k', ref: 'run r_abc' } }),
      ev('search', { id: '3', client: 'web', query: 'x' }),
      ev('proposal.submitted', { id: '2', client: 'codex' }),
      ev('read', { id: '1', client: null }),
    ]
    assert.deepEqual(
      filterEvents(all, { client: 'Claude Code', kind: '', ref: '' }).map((e) => e.id),
      ['4'],
    )
    assert.deepEqual(
      filterEvents(all, { client: '', kind: 'proposals', ref: '' }).map((e) => e.id),
      ['2'],
    )
    assert.deepEqual(
      filterEvents(all, { client: '', kind: '', ref: 'R_ABC' }).map((e) => e.id),
      ['4'],
    )
    assert.equal(filterEvents(all, { client: '', kind: '', ref: '' }).length, 4)
    assert.deepEqual(clientsOf(all), ['Claude Code', 'Codex', 'the web'])
    assert.deepEqual(
      KINDS.map((k) => k.id),
      ['writes', 'sessions', 'proposals', 'wiki', 'searches', 'reads'],
    )
  })
})

describe('the Factory link (CA9, read side)', () => {
  it('uses the same safe address rule as the server', () => {
    assert.equal(SAFE_URL.source, SERVER_SAFE_URL.source)
  })

  it('links a run reference to its run only with a safe Factory address', () => {
    assert.equal(
      factoryRunHref('https://factory.example.com', 'run r_abc, step 2'),
      'https://factory.example.com/runs/r_abc',
    )
    assert.equal(factoryRunHref('http://localhost:4000/', 'r_A-1_b'), 'http://localhost:4000/runs/r_A-1_b')
    assert.equal(factoryRunHref(null, 'run r_abc'), null)
    assert.equal(factoryRunHref('', 'run r_abc'), null)
    assert.equal(factoryRunHref('javascript:alert(1)', 'run r_abc'), null)
    assert.equal(factoryRunHref('https://user:pw@factory.example.com', 'run r_abc'), null)
    assert.equal(factoryRunHref('https://factory.example.com/#x', 'run r_abc'), null)
    assert.equal(factoryRunHref('https://factory.example.com', 'ticket-42'), null)
    assert.equal(factoryRunHref('https://factory.example.com', 'curr_abc'), null)
    assert.equal(factoryRunHref('https://factory.example.com', null), null)
  })
})

describe('health', () => {
  const empty = {
    orphans: [],
    broken: [],
    conflicts: [],
    stale: [],
    unavailableSources: [],
    long: [],
    similarTitles: [],
    maintenance: { suggested: false, approvalsSince: 0, every: 20 },
  }

  it('has the sections of B2, in the order that matters most', () => {
    assert.deepEqual(
      HEALTH_SECTIONS.map((s) => s.id),
      ['broken', 'conflicts', 'orphans', 'stale', 'unavailableSources', 'long', 'similarTitles'],
    )
    assert.equal(totalProblems(empty), 0)
  })

  it('each item leads to where it is fixed', () => {
    const h = {
      ...empty,
      broken: [{ from: 'style/intros', to: 'style/outro' }],
      conflicts: [{ a: 'pricing/annual', b: 'pricing/monthly' }],
      orphans: [{ address: 'misc/lost', title: 'Lost' }],
      stale: [{ address: 'old/page', title: 'Old', updatedAt: '2026-01-01T00:00:00.000Z', newEntries: 3 }],
      unavailableSources: [{ address: 'style/intros', entryId: 'ent_9', state: 'forgotten' as const }],
      long: [{ address: 'big/page', title: 'Big', chars: 41000 }],
      similarTitles: [{ a: 'style/intro', b: 'style/intros' }],
    }
    assert.equal(totalProblems(h), 7)
    const items = healthItems('growth', h)
    assert.deepEqual(items.broken?.[0]?.links, [
      { label: 'style/intros', href: '/b/growth/pages/style/intros' },
    ])
    assert.match(items.broken?.[0]?.text ?? '', /links to style\/outro, which does not exist/)
    assert.equal(items.conflicts?.[0]?.links.length, 2)
    assert.equal(items.unavailableSources?.[1 - 1]?.links[1]?.href, '/b/growth/journal/entries/ent_9')
    assert.match(items.stale?.[0]?.text ?? '', /3 newer entries/)
    assert.match(items.long?.[0]?.text ?? '', /41,000 characters/)
  })

  it('«ask an agent to fix this» names the tools, the count and the brain', () => {
    const text = askAgent('growth', 'broken', 3)
    assert.match(text, /brain_health/)
    assert.match(text, /brain_propose/)
    assert.match(text, /3 broken links/)
    assert.match(text, /"growth"/)
    assert.match(askAgent('growth', 'broken', 1), /the broken link /)
    assert.match(askAgent('growth', 'all', 7), /all 7 problems/)
  })
})

describe('search', () => {
  it('asks for the current brain or all of them, with the filters', () => {
    assert.deepEqual(
      searchParams({ q: ' intros ', scope: 'brain', brain: 'growth', what: '', type: '', from: '' }),
      {
        q: 'intros',
        limit: 20,
        brains: 'growth',
      },
    )
    assert.deepEqual(
      searchParams({
        q: 'x',
        scope: 'all',
        brain: 'growth',
        what: 'pages',
        type: 'decision',
        from: '2026-10-01',
      }),
      { q: 'x', limit: 20, in: 'pages', types: 'decision', from: '2026-10-01' },
    )
    // Outside a brain there is no current brain: all of them.
    assert.equal(
      searchParams({ q: 'x', scope: 'brain', brain: null, what: '', type: '', from: '' }).brains,
      undefined,
    )
    assert.equal(
      searchParams({ q: 'x', scope: 'all', brain: null, what: '', type: '', from: '' }, 40).offset,
      40,
    )
  })

  it('offers the same types the server searches by', () => {
    assert.deepEqual(TYPES, [...SEARCH_TYPES].sort())
  })

  it('with no results, suggests removing the filters or searching every brain', () => {
    assert.deepEqual(noResults({ filtered: true, scope: 'brain', inBrain: true }), ['clear', 'all'])
    assert.deepEqual(noResults({ filtered: false, scope: 'brain', inBrain: true }), ['all'])
    assert.deepEqual(noResults({ filtered: true, scope: 'all', inBrain: true }), ['clear'])
    assert.deepEqual(noResults({ filtered: false, scope: 'all', inBrain: false }), [])
  })
})

describe('names', () => {
  it('the new screens never call the product "Brain" alone', () => {
    for (const f of ['activity.ts', 'health.ts', 'search.ts']) {
      const src = readFileSync(new URL(`../../web/src/lib/${f}`, import.meta.url), 'utf8')
      assert.doesNotMatch(src, /'Brain\b|"Brain\b| Brain /, f)
    }
  })
})
