// The logic of the proposals inbox (spec B6 «Proposals: la bandeja», B2; T026–T028), without a browser:
// the operations that go together and why, choosing some (what one needs comes with it, and what needs
// one goes with it), what keeps each decision from being sent and why, what a decision sends (only what
// was seen), the choices kept when the proposal changes, the live notice of another curator's decision,
// how an operation reads, and the draft key of a person's choices.
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  approveBody,
  approveKeyHold,
  blockers,
  type Choices,
  choose,
  chooseNote,
  correctionOf,
  decidedNotice,
  editIsOld,
  groupsOf,
  inboxDraftKey,
  keepChoices,
  needsBase,
  opWords,
  purgedEdits,
  type ReviewOp,
  togetherWhy,
} from '../../web/src/lib/proposals.ts'

const op = (index: number, o: Partial<ReviewOp> = {}): ReviewOp => ({
  index,
  op: { op: 'create', address: `a/p${index}`, reason: 'r' },
  status: 'pending',
  corrected: false,
  before: null,
  after: null,
  dependsOn: [],
  stale: null,
  warnings: [],
  ...o,
})
const none: Choices = { selected: [], corrections: {}, baseReviewed: [], comment: '' }

describe('groupsOf', () => {
  it('puts operations that depend on each other together, in the order of the proposal', () => {
    const ops = [
      op(0),
      op(1, { dependsOn: [0] }),
      op(2),
      op(3, { dependsOn: [1] }),
      op(4, { dependsOn: [2] }),
    ]
    assert.deepEqual(groupsOf(ops), [
      [0, 1, 3],
      [2, 4],
    ])
    assert.deepEqual(groupsOf([op(0), op(1), op(2)]), [[0], [1], [2]])
    assert.deepEqual(groupsOf([op(0, { dependsOn: [1] }), op(1)]), [[0, 1]])
  })

  it('says why a group goes together, change by change, counted from 1', () => {
    const ops = [op(0), op(1, { dependsOn: [0] }), op(2, { dependsOn: [0, 1] })]
    assert.equal(togetherWhy([0, 1, 2], ops), 'Change 2 needs change 1; change 3 needs changes 1 and 2.')
  })
})

describe('choose', () => {
  const ops = [op(0), op(1, { dependsOn: [0] }), op(2, { dependsOn: [1] }), op(3)]
  it('choosing a change brings what it needs; leaving one out takes what needs it', () => {
    assert.deepEqual(choose([], 2, true, ops), [0, 1, 2])
    assert.deepEqual(choose([0, 1, 2, 3], 0, false, ops), [3])
    assert.deepEqual(choose([0, 1, 2], 2, false, ops), [0, 1])
    assert.deepEqual(choose([3], 3, true, ops), [3])
  })
  it('only pending changes can be chosen', () => {
    const decided = [op(0, { status: 'approved' }), op(1)]
    assert.deepEqual(choose([], 0, true, decided), [])
  })
})

describe('needsBase', () => {
  it('an edit on an old base needs a correction or «base reviewed» before it is approved', () => {
    const stale = op(1, { stale: { base: null, current: {}, proposed: {} } })
    assert.equal(needsBase(stale, none), true)
    assert.equal(needsBase(stale, { ...none, baseReviewed: [1] }), false)
    assert.equal(needsBase(stale, { ...none, corrections: { 1: { body: 'mine' } } }), false)
    assert.equal(needsBase(op(0), none), false)
  })
})

describe('blockers', () => {
  const ops = [op(0), op(1), op(2, { stale: { base: null, current: {}, proposed: {} } })]
  it('approve all waits for every old base; it needs no comment', () => {
    assert.match(blockers(ops, none).all ?? '', /Change 3 .*older version.*confirm you checked it/)
    assert.equal(blockers(ops, { ...none, baseReviewed: [2] }).all, null)
  })
  it('approve selected needs a choice that is not everything, and a comment for the rest', () => {
    const ok = { ...none, selected: [0, 1] }
    assert.match(blockers(ops, none).some ?? '', /Choose/)
    assert.match(blockers(ops, ok).some ?? '', /Write why/)
    assert.equal(blockers(ops, { ...ok, comment: 'Not the third.' }).some, null)
    assert.match(blockers(ops, { ...ok, selected: [0, 1, 2], comment: 'x' }).some ?? '', /Approve all/)
    assert.match(blockers(ops, { ...ok, selected: [2], comment: 'x' }).some ?? '', /Change 3/)
    assert.equal(blockers(ops, { ...ok, selected: [2], comment: 'x', baseReviewed: [2] }).some, null)
  })
  it('return needs a comment; spaces are not one', () => {
    assert.match(blockers(ops, { ...none, comment: '  ' }).back ?? '', /Write why/)
    assert.equal(blockers(ops, { ...none, comment: 'No.' }).back, null)
  })
  it('the comment is needed only for what the person is doing: «needs» says whether it is the comment', () => {
    assert.equal(blockers(ops, { ...none, selected: [0] }).someNeedsComment, true)
    assert.equal(blockers(ops, none).someNeedsComment, false)
    assert.equal(blockers(ops, none).backNeedsComment, true)
  })
})

describe('approveBody', () => {
  const ops = [
    op(0, { op: { op: 'edit', address: 'a/x', baseRevision: 1, body: 'b', reason: 'r' } }),
    op(1, { stale: { base: null, current: {}, proposed: {} } }),
    op(2),
  ]
  it('everything: only the fingerprint, and what was corrected or reviewed', () => {
    const c = { ...none, baseReviewed: [1], corrections: { 0: { body: 'mine', revision: 1 } } }
    assert.deepEqual(approveBody('fp1', ops, c, 'all'), {
      fingerprint: 'fp1',
      corrections: { 0: { body: 'mine', revision: 1 } },
      baseReviewed: [1],
    })
    assert.deepEqual(approveBody('fp1', ops, none, 'all'), { fingerprint: 'fp1' })
  })
  it('part: the chosen ones and the comment, trimmed; marks of what goes back are not sent', () => {
    const c = {
      selected: [2, 0],
      comment: '  The second is wrong. ',
      baseReviewed: [1],
      corrections: { 1: { title: 'Mine' } },
    }
    assert.deepEqual(approveBody('fp2', ops, c, 'some'), {
      fingerprint: 'fp2',
      approve: [0, 2],
      comment: 'The second is wrong.',
    })
  })
})

describe('keepChoices', () => {
  it('nothing to drop: the very same choices, so a late check never writes over what was typed', () => {
    const c = { selected: [0], comment: 'Typed.', baseReviewed: [], corrections: {} }
    assert.equal(keepChoices(c, [op(0), op(1)], 0), c)
  })

  it('a new version keeps what still applies: the comment always, the rest for pending changes', () => {
    const c = {
      selected: [0, 2, 5],
      comment: 'Why.',
      baseReviewed: [2, 5],
      corrections: { 5: { purges: 0 }, 0: { purges: 0 } },
    }
    const now = [op(0), op(1), op(2, { stale: { base: null, current: {}, proposed: {} } })]
    assert.deepEqual(keepChoices(c, now, 0), {
      selected: [0, 2],
      comment: 'Why.',
      baseReviewed: [2],
      corrections: { 0: { purges: 0 } },
    })
  })
})

describe('decidedNotice', () => {
  const e = (o: Record<string, unknown>) => ({
    kind: 'proposal.decided',
    who: { id: 'acc_eva', name: 'Eva' },
    target: { id: 'prp_1', label: 'approved' },
    ...o,
  })
  it('another person decided the proposal on screen: who and how', () => {
    assert.deepEqual(decidedNotice(e({}), 'prp_1', 'acc_eric'), {
      who: 'Eva',
      text: 'Approved by Eva just now. This proposal is read-only now.',
    })
    assert.equal(
      decidedNotice(e({ target: { id: 'prp_1', label: 'partially_approved' } }), 'prp_1', 'acc_eric')?.text,
      'Partly approved by Eva just now. This proposal is read-only now.',
    )
    assert.equal(
      decidedNotice(e({ target: { id: 'prp_1', label: 'returned' } }), 'prp_1', 'acc_eric')?.text,
      'Returned by Eva just now. This proposal is read-only now.',
    )
    // Spec v0.7: decided with a key; the status comes first in the label.
    assert.equal(
      decidedNotice(
        e({ target: { id: 'prp_1', label: 'returned with the key Eva agent' } }),
        'prp_1',
        'acc_eric',
      )?.text,
      'Returned by Eva just now. This proposal is read-only now.',
    )
    assert.equal(
      decidedNotice(
        e({ kind: 'proposal.withdrawn', target: { id: 'prp_1', label: 'T' } }),
        'prp_1',
        'acc_eric',
      )?.text,
      'Withdrawn by Eva just now. This proposal is read-only now.',
    )
  })
  it('nothing for another proposal, another kind, or my own decision', () => {
    assert.equal(decidedNotice(e({}), 'prp_2', 'acc_eric'), null)
    assert.equal(decidedNotice(e({ kind: 'entry.saved' }), 'prp_1', 'acc_eric'), null)
    assert.equal(decidedNotice(e({}), 'prp_1', 'acc_eva'), null)
    assert.equal(decidedNotice({ kind: 'proposal.decided' }, 'prp_1', 'acc_eric'), null)
  })
})

describe('opWords', () => {
  it('says each kind of change as a person would', () => {
    const w = (o: Record<string, unknown>) => opWords({ address: 'a/x', reason: 'r', ...o } as ReviewOp['op'])
    assert.equal(w({ op: 'create' }), 'New page a/x')
    assert.equal(w({ op: 'edit' }), 'Edit a/x')
    assert.equal(w({ op: 'move', to: 'b/y' }), 'Move a/x to b/y')
    assert.equal(w({ op: 'link', to: 'b/y', kind: 'depends-on' }), 'Link a/x to b/y (depends on)')
    assert.equal(w({ op: 'unlink', to: 'b/y', kind: 'related' }), 'Remove the link a/x to b/y (related to)')
    assert.equal(w({ op: 'status', status: 'stale' }), 'Mark a/x stale')
    assert.equal(w({ op: 'merge', from: 'b/y' }), 'Merge b/y into a/x')
    assert.equal(w({ op: 'revert', toRevision: 3 }), 'Restore a/x to revision 3')
  })
})

describe('inboxDraftKey', () => {
  it('is per person and proposal, in hex, so it never reads like a secret', () => {
    const a = inboxDraftKey('acc_eric', 'prp_1')
    assert.match(a, /^inbox\.[0-9a-f]{8}$/)
    assert.notEqual(a, inboxDraftKey('acc_ana', 'prp_1'))
    assert.notEqual(a, inboxDraftKey('acc_eric', 'prp_2'))
  })
})

describe('correctionOf', () => {
  const edit = op(0, {
    op: { op: 'edit', address: 'a/x', baseRevision: 2, title: 'Agent', body: 'Agent body.', reason: 'r' },
    before: { revision: 3, title: 'Page', body: 'Page body.', summary: 'S.' },
    after: { revision: 3, title: 'Agent', body: 'Agent body.', summary: 'S.' },
  })
  it('only the fields the person changed, and the revision of the page they saw', () => {
    assert.deepEqual(correctionOf(edit, { title: 'Mine', body: 'Agent body.' }, 0), {
      title: 'Mine',
      revision: 3,
      purges: 0,
    })
    assert.equal(correctionOf(edit, { title: 'Agent', body: 'Agent body.' }, 0), null)
  })
  it('a new page has no revision to send', () => {
    const create = op(1, {
      op: { op: 'create', address: 'a/y', reason: 'r' },
      after: { title: 'T', body: 'B' },
    })
    assert.deepEqual(correctionOf(create, { title: 'T', body: 'Mine' }, 0), { body: 'Mine', purges: 0 })
  })
})

describe('editIsOld', () => {
  it('an edit written on another revision than the one now shown is to be checked', () => {
    const o = op(0, { before: { revision: 4 } })
    assert.equal(editIsOld(o, { ...none, corrections: { 0: { title: 'x', revision: 3 } } }), true)
    assert.equal(editIsOld(o, { ...none, corrections: { 0: { title: 'x', revision: 4 } } }), false)
    assert.equal(editIsOld(o, none), false)
  })
})

describe('chooseNote', () => {
  const ops = [op(0), op(1, { dependsOn: [0] }), op(2)]
  it('says what came along or went with a choice', () => {
    assert.equal(chooseNote([], [0, 1], 1, true, ops), 'Also chose change 1, which change 2 needs.')
    assert.equal(chooseNote([0, 1], [], 0, false, ops), 'Also left out change 2, which needs change 1.')
    assert.equal(chooseNote([], [2], 2, true, ops), null)
  })
})

describe('approveKeyHold', () => {
  it('`a` approves all only with nothing chosen and nothing written', () => {
    assert.equal(approveKeyHold(none), null)
    assert.match(approveKeyHold({ ...none, selected: [0] }) ?? '', /You chose some changes/)
    assert.match(approveKeyHold({ ...none, comment: 'x' }) ?? '', /You wrote a comment/)
    assert.equal(approveKeyHold({ ...none, comment: '   ' }), null)
  })
})

describe('second pass of the PR21 review', () => {
  it('an edit written on an older revision does not settle an old base; «I’ve checked» does', () => {
    const o = op(0, { stale: { base: null, current: {}, proposed: {} }, before: { revision: 4 } })
    assert.equal(needsBase(o, { ...none, corrections: { 0: { body: 'x', revision: 3, purges: 0 } } }), true)
    assert.equal(needsBase(o, { ...none, corrections: { 0: { body: 'x', revision: 4, purges: 0 } } }), false)
    // A change the server does not call old, but whose edit was written before the page moved on.
    const moved = op(1, { before: { revision: 5 } })
    const c = { ...none, corrections: { 1: { title: 't', revision: 4, purges: 0 } } }
    assert.equal(needsBase(moved, c), true)
    assert.equal(needsBase(moved, { ...c, baseReviewed: [1] }), false)
    assert.deepEqual(approveBody('fp', [moved], { ...c, baseReviewed: [1] }, 'all').baseReviewed, [1])
    assert.deepEqual(keepChoices({ ...c, baseReviewed: [1] }, [moved], 0).baseReviewed, [1])
  })

  it('an edit carries the purges of the review it was written on', () => {
    const create = op(1, {
      op: { op: 'create', address: 'a/y', reason: 'r' },
      after: { title: 'T', body: 'B' },
    })
    assert.deepEqual(correctionOf(create, { title: 'T', body: 'Mine' }, 2), { body: 'Mine', purges: 2 })
  })

  it('a new purge drops the edits written before it, and only those', () => {
    const c = {
      ...none,
      comment: 'Why.',
      corrections: { 0: { body: 'old', purges: 1 }, 1: { body: 'new', purges: 2 } },
    }
    const kept = keepChoices(c, [op(0), op(1)], 2)
    assert.deepEqual(Object.keys(kept.corrections), ['1'])
    assert.equal(kept.comment, 'Why.')
    assert.equal(purgedEdits(c, 2), 1)
    assert.equal(purgedEdits(c, 1), 1)
    assert.equal(purgedEdits(none, 3), 0)
  })
})
