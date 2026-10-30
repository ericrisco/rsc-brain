// Review of PR19 (spec B6 «Wiki»), the logic kept free of the DOM: drafts kept per person, page and brain;
// what saving over a newer revision keeps (a line-level three-way merge, lists merged by item); the
// differences of two revisions by line, whole lines when most of a line changed, and never blocking the
// page on a huge text; completing `[[` inside an existing link; the map by status; who read a page,
// grouped; what each revision was; search snippets as plain text.
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { draft } from '../../web/src/api/draft.ts'
import { plainText, renderMarkdown } from '../../web/src/lib/markdown.ts'
import {
  bodyDiff,
  changeLabel,
  completeAt,
  completionAt,
  conflictBody,
  draftKeyOf,
  filterMap,
  groupReaders,
  merge3,
  mergeList,
  wordDiff,
} from '../../web/src/lib/wiki.ts'

// The work a call costs this process, in ms of CPU: other test files running at the same time slow the
// clock, not the work, and the budget is about the work a browser tab would do.
function cpuMs<T>(f: () => T): { value: T; ms: number } {
  const c = process.cpuUsage()
  const value = f()
  const d = process.cpuUsage(c)
  return { value, ms: (d.user + d.system) / 1000 }
}

describe('a draft of an edit', () => {
  it('is kept per person, brain and page', () => {
    const k = draftKeyOf('acc_eric', 'growth', 'pg_one')
    assert.match(k, /^wiki-edit\./)
    assert.equal(k, draftKeyOf('acc_eric', 'growth', 'pg_one'))
    assert.notEqual(k, draftKeyOf('acc_ana', 'growth', 'pg_one'))
    assert.notEqual(k, draftKeyOf('acc_eric', 'support', 'pg_one'))
    assert.notEqual(k, draftKeyOf('acc_eric', 'growth', 'pg_two'))
  })
  it('never spells a word the draft store refuses (a hash that read «code» broke the editor)', () => {
    const store = new Map<string, string>()
    const mem = {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => void store.set(k, v),
      removeItem: (k: string) => void store.delete(k),
    }
    assert.doesNotThrow(() => draft(draftKeyOf('acc_eric', 'growth', 'pg_nsnz'), mem))
    for (let i = 0; i < 200_000; i++) {
      const k = draftKeyOf('acc_eric', 'growth', `pg_${i.toString(36)}`)
      assert.doesNotMatch(k, /password|code|token|secret/i, `pg_${i.toString(36)}`)
    }
  })
})

describe('saving over a newer revision', () => {
  it('both added a paragraph at the end: keeping both keeps both, theirs first', () => {
    const base = 'Intro.\n\nMiddle.'
    const r = merge3(base, `${base}\n\nMine at the end.`, `${base}\n\nTheirs at the end.`)
    assert.deepEqual(r, { ok: true, text: `${base}\n\nTheirs at the end.\n\nMine at the end.` })
  })
  it('changes to different lines both stay', () => {
    const r = merge3('a\nb\nc\nd', 'A\nb\nc\nd', 'a\nb\nc\nD')
    assert.deepEqual(r, { ok: true, text: 'A\nb\nc\nD' })
  })
  it('the same line changed two ways does not merge', () => {
    assert.deepEqual(merge3('a\nb\nc', 'a\nmine\nc', 'a\ntheirs\nc'), { ok: false })
  })
  it('an insertion where the other side replaced lines does not merge, whichever side did which', () => {
    // Mine inserts X before 2; theirs replaces 2 and 3 with Y: not 1,Y,X,2,3,4.
    assert.deepEqual(merge3('1\n2\n3\n4', '1\nX\n2\n3\n4', '1\nY\n4'), { ok: false })
    assert.deepEqual(merge3('1\n2\n3\n4', '1\nY\n4', '1\nX\n2\n3\n4'), { ok: false })
  })
  it('changes to lines next to each other both stay, whichever side changed the first', () => {
    assert.deepEqual(merge3('1\n2\n3\n4', '1\nA\n3\n4', '1\n2\nB\n4'), { ok: true, text: '1\nA\nB\n4' })
    assert.deepEqual(merge3('1\n2\n3\n4', '1\n2\nB\n4', '1\nA\n3\n4'), { ok: true, text: '1\nA\nB\n4' })
  })
  it('the same change made by both is kept once', () => {
    assert.deepEqual(merge3('a\nb', 'a\nB', 'a\nB'), { ok: true, text: 'a\nB' })
  })
  it('lists merge by item: both additions stay, a removal stays unless the other side touched it', () => {
    const key = (s: string) => s
    assert.deepEqual(mergeList(['a', 'b', 'c'], ['a', 'c', 'mine'], ['a', 'b', 'c', 'theirs'], key), [
      'a',
      'c',
      'theirs',
      'mine',
    ])
    assert.deepEqual(mergeList(['a', 'b'], ['a'], ['b'], key), [])
  })
})

describe('the differences of two revisions', () => {
  it('a sentence replaced shows the old line and the new line whole', () => {
    const d = bodyDiff(
      'Keep this.\nLong intros lose viewers.',
      'Keep this.\nShort openings win the first minute.',
    )
    assert.deepEqual(d, [
      { kind: 'same', text: 'Keep this.' },
      { kind: 'removed', text: 'Long intros lose viewers.' },
      { kind: 'added', text: 'Short openings win the first minute.' },
    ])
  })
  it('a line with a few words changed shows those words', () => {
    const d = bodyDiff('Intros of ten seconds keep viewers.', 'Intros of five seconds keep viewers.')
    assert.equal(d.length, 1)
    const line = d[0] as { kind: string; words: { kind: string; text: string }[] }
    assert.equal(line.kind, 'changed')
    assert.deepEqual(
      line.words.filter((w) => w.kind !== 'same').map((w) => [w.kind, w.text]),
      [
        ['removed', 'ten'],
        ['added', 'five'],
      ],
    )
  })
  it('a huge rewrite never blocks the page: under 200 ms, old and new shown whole', () => {
    const words = (n: number, seed: string) =>
      Array.from({ length: n }, (_, i) => `${seed}${(i * 7919) % 10007}`).join(' ')
    const a = words(8000, 'a')
    const b = words(8000, 'b')
    const { value: w, ms: wms } = cpuMs(() => wordDiff(a, b))
    assert.ok(wms < 200, `wordDiff took ${wms.toFixed(0)} ms of CPU`)
    assert.equal(w.map((s) => s.text).join(''), `${a}${b}`)
    const lines = (n: number, seed: string) =>
      Array.from({ length: n }, (_, i) => `${seed} line ${(i * 7919) % 10007} of the text`).join('\n')
    const { value: d, ms: dms } = cpuMs(() => bodyDiff(lines(4000, 'old'), lines(4000, 'new')))
    assert.ok(dms < 200, `bodyDiff took ${dms.toFixed(0)} ms of CPU`)
    assert.ok(d.length > 0)
  })
  it('a conflict on a long body (both sides rewrote 6000 short lines) is worked out in under 200 ms', () => {
    let seed = 11
    const rnd = () => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff
      return seed / 0x7fffffff
    }
    const text = () =>
      Array.from({ length: 6000 }, () => ['- a', '- b', '', '- c'][Math.floor(rnd() * 4)]).join('\n')
    for (let k = 0; k < 3; k++) {
      const [base, theirs, mine] = [text(), text(), text()]
      const { value: c, ms: took } = cpuMs(() => conflictBody(base, mine, theirs))
      assert.ok(took < 200, `the conflict took ${took.toFixed(0)} ms of CPU`)
      assert.ok(c.theirs.length > 0)
    }
  })
  it('a conflict gives the same merge and differences as each one alone', () => {
    const base = 'Intro.\nMiddle line here.\nEnd.'
    const mine = 'Intro!\nMiddle line here.\nEnd.'
    const theirs = 'Intro.\nMiddle line there.\nEnd.'
    const c = conflictBody(base, mine, theirs)
    assert.deepEqual(c.merged, merge3(base, mine, theirs))
    assert.deepEqual(c.theirs, bodyDiff(base, theirs))
  })
})

describe('completing [[ inside a link already there', () => {
  it('replaces the address up to its ]] instead of leaving its tail', () => {
    const text = 'See [[audience/intros]] now.'
    const caret = text.indexOf('aud') + 3
    const at = completionAt(text, caret)
    assert.ok(at)
    const out = completeAt(text, at.start, caret, 'audience/intros')
    assert.equal(out.text, 'See [[audience/intros]] now.')
    assert.equal(out.caret, 'See [[audience/intros]]'.length)
  })
})

describe('the map by status', () => {
  const groups = [
    {
      type: 'topic',
      area: 'a',
      pages: [
        { address: 'a/one', title: 'One', summary: '', tags: [], status: 'current' },
        { address: 'a/two', title: 'Two', summary: '', tags: [], status: 'stale' },
      ],
    },
  ]
  it('keeps every status unless one is asked for', () => {
    assert.equal(filterMap(groups, {})[0]?.pages.length, 2)
    assert.deepEqual(
      filterMap(groups, { status: 'stale' })[0]?.pages.map((p) => p.address),
      ['a/two'],
    )
    assert.deepEqual(
      filterMap(groups, { q: 'two' })[0]?.pages.map((p) => p.address),
      ['a/two'],
    )
  })
})

describe('who read a page', () => {
  it('one line per person and client, with how many times and the last time', () => {
    const line = (id: number, at: string, who: string, client: string, kind = 'read') => ({
      id,
      at,
      kind,
      account: { id: `acc_${who}`, name: who },
      credential: { kind: client === 'web' ? 'web' : 'token', name: client },
    })
    const g = groupReaders([
      line(1, '2026-10-29T09:00:00.000Z', 'Ana', 'Claude Code'),
      line(2, '2026-10-29T09:10:00.000Z', 'Eric', 'web'),
      line(3, '2026-10-29T09:20:00.000Z', 'Ana', 'Claude Code'),
      line(4, '2026-10-29T09:30:00.000Z', 'Eric', 'web', 'context'),
    ])
    assert.deepEqual(
      g.map((x) => [x.name, x.via, x.count, x.last]),
      [
        ['Eric', null, 2, '2026-10-29T09:30:00.000Z'],
        ['Ana', 'Claude Code', 2, '2026-10-29T09:20:00.000Z'],
      ],
    )
  })
})

describe('what a revision was', () => {
  it('says the change in words', () => {
    const r = { change: 'status', status: 'stale', restoredFrom: null }
    assert.equal(changeLabel(r), 'status → stale')
    assert.equal(changeLabel({ ...r, change: 'restored', restoredFrom: 2 }), 'restored revision 2')
    assert.equal(changeLabel({ ...r, change: 'linked' }), 'linked')
    assert.equal(changeLabel({ ...r, change: 'created' }), 'created')
  })
})

describe('text shown out of markdown', () => {
  it('a search snippet loses its markup', () => {
    assert.equal(
      plainText('## What keeps **viewers**\n- See [[audience/intros]] and [the report](https://x.test).'),
      'What keeps viewers See audience/intros and the report.',
    )
  })
  it('a [[link]] shows the title of its page, its address on hover; a stale page says so', () => {
    const html = renderMarkdown('[[audience/intros]] and [[guides/weekly-review]]', {
      slug: 'growth',
      links: [
        { kind: 'mentions', address: 'audience/intros', state: 'ok', title: 'Writing intros' },
        { kind: 'mentions', address: 'guides/weekly-review', state: 'stale', title: 'Weekly review' },
      ],
    })
    assert.match(html, /title="audience\/intros"[^>]*>Writing intros<\/a>/)
    assert.match(html, /Weekly review<span class="link-note"> \(stale\)<\/span>/)
  })
})
