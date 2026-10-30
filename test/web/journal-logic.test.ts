// The logic of the journal screens (spec B6 «Journal»; T023–T024), without a browser: how authorship
// reads, which actions a person has on an entry (the same rules as the server's can(), so the web never
// offers what the API refuses, nor hides what it allows), what a correction is about, how relations read,
// how a choice of relation becomes the request, and the filters of Sessions.
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  aboutOf,
  byline,
  dayOf,
  entryPowers,
  journalDraftKey,
  mergeById,
  relateBody,
  relationWords,
  sessionLabel,
  sessionQuery,
} from '../../web/src/lib/journal.ts'

const eric = { id: 'acc_eric', name: 'Eric' }

describe('byline', () => {
  it('names the agent and the person it writes for, as the spec says it', () => {
    assert.equal(
      byline({ author: eric, onBehalf: null, client: 'Claude Code', ref: null }),
      'Claude Code of Eric',
    )
    assert.equal(
      byline({
        author: { id: 'acc_f', name: 'RSC Factory' },
        onBehalf: eric,
        client: 'narrator',
        ref: 'run r_x, step 3',
      }),
      'RSC Factory (run r_x, step 3) on behalf of Eric',
    )
    assert.equal(byline({ author: eric, onBehalf: null, client: 'web', ref: null }), 'Eric, in the web')
    assert.equal(byline({ author: eric, onBehalf: null, client: null, ref: null }), 'Eric')
    assert.equal(
      byline({
        author: { id: 'a', name: 'RSC Factory' },
        onBehalf: null,
        client: 'narrator',
        ref: 'run r_1',
      }),
      'narrator of RSC Factory (run r_1)',
    )
  })
})

describe('entryPowers: the same rules as the server', () => {
  const entry = (o: Partial<{ type: string; state: string; authorId: string }> = {}) => ({
    type: 'learning',
    state: 'active',
    authorId: 'acc_ana',
    ...o,
  })
  const as = (role: string | null, me = 'acc_eric', archived = false) => ({ role, me, archived })

  it('a reader has no action at all', () => {
    const p = entryPowers(entry({ authorId: 'acc_rita' }), as('reader', 'acc_rita'))
    assert.deepEqual(Object.values(p).filter(Boolean), [])
  })

  it('a contributor corrects, dates and forgets only their own entries; relates and adds corrections', () => {
    const own = entryPowers(entry({ authorId: 'acc_ana' }), as('contributor', 'acc_ana'))
    assert.equal(own.correct, true)
    assert.equal(own.forget, true)
    assert.equal(own.schedule, true)
    assert.equal(own.relate, true)
    assert.equal(own.addCorrection, true)
    assert.equal(own.pin, false)
    assert.equal(own.recover, false)
    const other = entryPowers(entry({ authorId: 'acc_bob' }), as('contributor', 'acc_ana'))
    assert.equal(other.correct, false)
    assert.equal(other.forget, false)
    assert.equal(other.schedule, false)
    assert.equal(other.relate, true)
  })

  it('a curator does everything on an active entry, and recovers a forgotten one', () => {
    const p = entryPowers(entry(), as('curator'))
    assert.deepEqual(
      Object.entries(p)
        .filter(([, v]) => v)
        .map(([k]) => k)
        .sort(),
      ['addCorrection', 'correct', 'forget', 'pin', 'relate', 'schedule'],
    )
    const gone = entryPowers(entry({ state: 'forgotten' }), as('curator'))
    assert.deepEqual(
      Object.entries(gone)
        .filter(([, v]) => v)
        .map(([k]) => k)
        .sort(),
      ['addCorrection', 'recover'],
    )
    // Recovering is for curators only.
    assert.equal(
      entryPowers(entry({ state: 'forgotten', authorId: 'acc_ana' }), as('contributor', 'acc_ana')).recover,
      false,
    )
  })

  it('an archived brain is read-only for everyone, and a purged entry has no action', () => {
    assert.deepEqual(Object.values(entryPowers(entry(), as('curator', 'acc_eric', true))).filter(Boolean), [])
    const purged = entryPowers(entry({ state: 'purged' }), as('curator'))
    assert.equal(purged.correct || purged.forget || purged.recover || purged.pin || purged.relate, false)
  })
})

describe('what a correction is about, and its other references', () => {
  it('reads page:, entry: and keeps the rest', () => {
    assert.deepEqual(aboutOf(['page:style/intros', 'https://x.test/a', 'commit 1a2b']), {
      page: 'style/intros',
      entry: null,
      rest: ['https://x.test/a', 'commit 1a2b'],
    })
    assert.deepEqual(aboutOf(['entry:ent_1']), { page: null, entry: 'ent_1', rest: [] })
    assert.deepEqual(aboutOf([]), { page: null, entry: null, rest: [] })
  })
})

describe('relations in words', () => {
  const other = { id: 'ent_2', title: 'Ten seconds', type: 'learning', state: 'active' }
  it('says the relation from this entry’s side, and what waits', () => {
    assert.equal(
      relationWords({ kind: 'contradicts', direction: 'out', status: 'active', other }),
      'Contradicts',
    )
    assert.equal(
      relationWords({ kind: 'contradicts', direction: 'in', status: 'active', other }),
      'Contradicted by',
    )
    assert.equal(
      relationWords({ kind: 'supersedes', direction: 'out', status: 'active', other }),
      'Supersedes',
    )
    assert.equal(
      relationWords({ kind: 'supersedes', direction: 'in', status: 'active', other }),
      'Superseded by',
    )
    assert.equal(
      relationWords({ kind: 'not_related', direction: 'in', status: 'active', other }),
      'Not related to',
    )
    assert.equal(
      relationWords({ kind: 'supersedes', direction: 'in', status: 'pending_person', other }),
      'Superseded by (an agent asked; waits for a person)',
    )
    assert.equal(
      relationWords({ kind: 'supersedes', direction: 'out', status: 'rejected', other }),
      'Supersedes (turned down)',
    )
  })

  it('turns a choice into the request: this entry first, unless the other one wins', () => {
    assert.deepEqual(relateBody('contradicts', 'a', 'b'), { from: 'a', to: 'b', kind: 'contradicts' })
    assert.deepEqual(relateBody('supersedes', 'a', 'b'), { from: 'a', to: 'b', kind: 'supersedes' })
    assert.deepEqual(relateBody('superseded', 'a', 'b'), { from: 'b', to: 'a', kind: 'supersedes' })
    assert.deepEqual(relateBody('not_related', 'a', 'b'), { from: 'a', to: 'b', kind: 'not_related' })
  })
})

describe('sessions', () => {
  it('a session without a purpose says what it is', () => {
    assert.equal(sessionLabel({ purpose: 'Intros', day: null }), 'Intros')
    assert.equal(
      sessionLabel({ purpose: 'implicit', day: '2026-10-29' }),
      'Work without a session on 29 Oct 2026',
    )
    assert.equal(sessionLabel({ purpose: '', day: null }), 'Session with no purpose given')
  })

  it('filters become the query, empty ones left out and uncompiled as 1', () => {
    assert.deepEqual(
      sessionQuery({
        status: 'open',
        client: '',
        author: 'acc_1',
        type: '',
        ref: ' r_7 ',
        from: '2026-10-01',
        to: '',
        uncompiled: '1',
      }),
      { status: 'open', author: 'acc_1', ref: 'r_7', from: '2026-10-01', uncompiled: '1' },
    )
    assert.deepEqual(sessionQuery({ uncompiled: '' }), {})
  })

  it('a later page adds what the first does not already hold', () => {
    const a = [{ id: '1' }, { id: '2' }]
    assert.deepEqual(
      mergeById(a, [{ id: '2' }, { id: '3' }]).map((x) => x.id),
      ['1', '2', '3'],
    )
  })
})

describe('dates and drafts', () => {
  it('a date field shows the day of an instant, in UTC', () => {
    assert.equal(dayOf('2026-11-30T00:00:00.000Z'), '2026-11-30')
    assert.equal(dayOf(null), '')
  })

  it('a draft key is per person, brain and thing, in hex (no word a secret guard refuses)', () => {
    const k = journalDraftKey('acc_1', 'yt', 'entry:ent_code')
    assert.match(k, /^journal\.[0-9a-f]{8}$/)
    assert.notEqual(k, journalDraftKey('acc_2', 'yt', 'entry:ent_code'))
    assert.notEqual(k, journalDraftKey('acc_1', 'yt', 'correction'))
  })
})
