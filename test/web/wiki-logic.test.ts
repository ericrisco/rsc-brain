// The logic behind the wiki screens (spec B6 «Wiki», PR19), free of the DOM: filters of the map and the
// decisions, links grouped by kind, the difference between two revisions, the `[[` autocomplete of the
// editor, and what an edit sends (only what changed, against the revision read).
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  canRebase,
  completeAt,
  completionAt,
  draftKeyOf,
  editChanges,
  filterDecisions,
  filterMap,
  groupLinks,
  mapTags,
  mapTypes,
  parseTags,
  pickPair,
  sourceKey,
  wordDiff,
} from '../../web/src/lib/wiki.ts'

const GROUPS = [
  {
    type: 'topic',
    area: 'audience',
    pages: [
      { address: 'audience/retention', title: 'Retention', summary: 'What keeps viewers.', tags: ['metric'] },
      { address: 'audience/intros', title: 'Intros', summary: 'Short ones work.', tags: ['q4', 'metric'] },
    ],
  },
  {
    type: 'decision',
    area: 'pricing',
    pages: [{ address: 'pricing/annual', title: 'Annual plans', summary: 'Two months free.', tags: ['q4'] }],
  },
]

describe('the map', () => {
  it('filters by type, tag and words, keeping only groups with pages left', () => {
    assert.deepEqual(
      filterMap(GROUPS, { type: 'decision' }).map((g) => g.area),
      ['pricing'],
    )
    assert.deepEqual(
      filterMap(GROUPS, { tag: 'q4' }).flatMap((g) => g.pages.map((p) => p.address)),
      ['audience/intros', 'pricing/annual'],
    )
    assert.deepEqual(
      filterMap(GROUPS, { q: 'VIEWERS' }).flatMap((g) => g.pages.map((p) => p.address)),
      ['audience/retention'],
    )
    assert.deepEqual(filterMap(GROUPS, { q: 'nothing like it' }), [])
    assert.equal(filterMap(GROUPS, {}), GROUPS)
  })

  it('offers the tags and types that are there, in a stable order', () => {
    assert.deepEqual(mapTags(GROUPS), ['metric', 'q4'])
    assert.deepEqual(mapTypes(GROUPS), ['topic', 'decision'])
  })
})

describe('the decisions', () => {
  const list = [
    { address: 'a', title: 'Annual plans', summary: 'Two months free.', status: 'current' },
    { address: 'b', title: 'Old pricing', summary: 'Monthly only.', status: 'superseded' },
  ]
  it('filters by status and words', () => {
    assert.deepEqual(
      filterDecisions(list, { status: 'superseded' }).map((d) => d.address),
      ['b'],
    )
    assert.deepEqual(
      filterDecisions(list, { q: 'months' }).map((d) => d.address),
      ['a'],
    )
    assert.equal(filterDecisions(list, {}).length, 2)
  })
})

describe('the links of a page', () => {
  it('are grouped by kind, mentions first, each kind once', () => {
    const groups = groupLinks([
      { kind: 'related', address: 'x' },
      { kind: 'mentions', address: 'y' },
      { kind: 'contradicts', address: 'z' },
      { kind: 'related', address: 'w' },
    ])
    assert.deepEqual(
      groups.map((g) => [g.kind, g.items.map((i) => i.address)]),
      [
        ['mentions', ['y']],
        ['related', ['x', 'w']],
        ['contradicts', ['z']],
      ],
    )
  })
})

describe('two revisions', () => {
  it('show what was added and removed, word by word', () => {
    assert.deepEqual(wordDiff('Keep intros short.', 'Keep intros under ten seconds.'), [
      { kind: 'same', text: 'Keep intros ' },
      { kind: 'removed', text: 'short' },
      { kind: 'added', text: 'under ten seconds' },
      { kind: 'same', text: '.' },
    ])
    assert.deepEqual(wordDiff('same', 'same'), [{ kind: 'same', text: 'same' }])
  })

  it('the pair to compare comes from the address, or is the last two', () => {
    assert.deepEqual(pickPair('1,3', 5), [1, 3])
    assert.deepEqual(pickPair('3,1', 5), [1, 3])
    assert.deepEqual(pickPair(undefined, 5), [4, 5])
    assert.deepEqual(pickPair('x', 5), [4, 5])
    assert.deepEqual(pickPair('2,9', 5), [4, 5])
    assert.deepEqual(pickPair('2,2', 5), [4, 5])
    assert.equal(pickPair(undefined, 1), null)
  })
})

describe('the `[[` autocomplete', () => {
  it('starts after [[ and follows what is typed, until ]] or a new line', () => {
    assert.deepEqual(completionAt('See [[aud', 9), { start: 6, query: 'aud' })
    assert.deepEqual(completionAt('See [[', 6), { start: 6, query: '' })
    assert.equal(completionAt('See [[aud]] now', 15), null)
    assert.equal(completionAt('See [[aud\nx', 11), null)
    assert.equal(completionAt('See [aud', 8), null)
    assert.equal(completionAt('See [[a b', 9), null)
    // The caret inside an earlier, finished mention.
    assert.deepEqual(completionAt('[[aud]] and [[pri', 17), { start: 14, query: 'pri' })
  })

  it('puts the chosen address in, closes the mention and moves the caret after it', () => {
    assert.deepEqual(completeAt('See [[aud and more', 6, 9, 'audience/intros'), {
      text: 'See [[audience/intros]] and more',
      caret: 23,
    })
    // Already closed: the closing brackets are not doubled.
    assert.deepEqual(completeAt('See [[aud]] x', 6, 9, 'audience/intros'), {
      text: 'See [[audience/intros]] x',
      caret: 23,
    })
  })
})

describe('an edit', () => {
  const read = {
    revision: 4,
    type: 'topic',
    title: 'Intros',
    summary: 'Short.',
    body: 'Body.',
    tags: ['q4'],
    sources: [{ entryId: 'ent_1' }],
  }
  it('sends only what changed, with the revision it was made on', () => {
    assert.deepEqual(editChanges(read, { ...read, body: 'New body.' }), {
      baseRevision: 4,
      body: 'New body.',
    })
    assert.deepEqual(editChanges(read, { ...read, tags: ['q4', 'metric'], title: 'Intros ' }), {
      baseRevision: 4,
      tags: ['q4', 'metric'],
    })
    assert.equal(editChanges(read, { ...read }), null)
    assert.deepEqual(editChanges(read, { ...read, sources: [] }), { baseRevision: 4, sources: [] })
  })

  it('reads tags from a line of words split by commas', () => {
    assert.deepEqual(parseTags(' q4, metric ,, q4 '), ['q4', 'metric'])
    assert.deepEqual(parseTags(''), [])
  })

  it('names each source by what it points at', () => {
    assert.equal(sourceKey({ entryId: 'ent_1' }), 'entry:ent_1')
    assert.equal(sourceKey({ url: 'https://x.test' }), 'url:https://x.test')
  })
})

describe('the draft of an edit', () => {
  it('has a key made from the page, never from words that would look like a secret', () => {
    const k = draftKeyOf('acc_eric', 'claude-code', 'infra/token-rotation')
    assert.doesNotMatch(k, /password|code|token|secret/i)
    assert.equal(k, draftKeyOf('acc_eric', 'claude-code', 'infra/token-rotation'))
    assert.notEqual(k, draftKeyOf('acc_eric', 'claude-code', 'infra/token-rotations'))
    assert.notEqual(k, draftKeyOf('acc_eric', 'other', 'infra/token-rotation'))
  })
})

describe('after a link or a status changed by the same curator', () => {
  const base = {
    type: 'topic',
    title: 'T',
    summary: 'S',
    body: 'B',
    tags: ['a'],
    sources: [{ entryId: 'e' }],
  }
  it('the edit moves to the new revision when the content did not change', () => {
    assert.equal(canRebase(base, { ...base }), true)
  })
  it('but not when someone else changed the content meanwhile', () => {
    assert.equal(canRebase(base, { ...base, body: 'Other.' }), false)
    assert.equal(canRebase(base, { ...base, sources: [] }), false)
  })
})
