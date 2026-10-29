import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { isAddress, mentionsOf, nearlySame, type Problem, readOp } from '../../src/domain/wiki/model.ts'
import { SECRET_MARK } from '../../src/privacy/redact.ts'

describe('wiki words', () => {
  it('addresses are lowercase words with hyphens, levels split by "/"', () => {
    for (const a of ['audience/retention', 'agents/narrator', 'x', 'a-b/c-d/e1']) assert.ok(isAddress(a), a)
    for (const a of ['Audience', 'a//b', '/a', 'a/', 'a b', 'a_b', '', 'a'.repeat(201), 'á']) {
      assert.ok(!isAddress(a), a)
    }
  })

  it('mentions are [[address]] or [[address|text]], once each, well-formed only', () => {
    const body =
      'See [[audience/retention]] and [[agents/narrator|the narrator]], again [[audience/retention]], not [[Bad Address]] nor [[ ]].'
    assert.deepEqual(mentionsOf(body), ['audience/retention', 'agents/narrator'])
  })

  it('reads a create, redacting secrets and trimming', () => {
    const problems: Problem[] = []
    const op = readOp(
      {
        op: 'create',
        address: 'tools/deploy',
        type: 'guide',
        title: '  Deploy  ',
        body: 'token ghp_AbCdEfGhIjKlMnOpQrStUvWxYz0123456789 here',
        sources: [{ entryId: 'ent_0123456789ab' }, { url: 'https://example.com/a', title: 'A' }],
        links: [{ kind: 'related', to: 'tools/build' }],
        reason: 'needed',
      },
      0,
      problems,
    )
    assert.deepEqual(problems, [])
    assert.equal(op?.op, 'create')
    if (op?.op !== 'create') return
    assert.equal(op.title, 'Deploy')
    assert.ok(op.body.includes(SECRET_MARK) && !op.body.includes('ghp_'))
    assert.equal(op.sources.length, 2)
  })

  it('says every mistake of an operation, with its index', () => {
    const problems: Problem[] = []
    assert.equal(
      readOp({ op: 'create', address: 'Bad', type: 'nope', links: [{ kind: 'x', to: 'y' }] }, 3, problems),
      null,
    )
    assert.ok(problems.length >= 4)
    assert.ok(problems.every((p) => p.op === 3))
    const more: Problem[] = []
    readOp({ op: 'fly', address: 'a' }, 1, more)
    assert.match(more[0]?.message ?? '', /Unknown operation "fly"/)
    const edit: Problem[] = []
    readOp({ op: 'edit', address: 'a', reason: 'r' }, 0, edit)
    assert.match(edit[0]?.message ?? '', /changes at least one/)
    const self: Problem[] = []
    readOp({ op: 'link', address: 'a', kind: 'related', to: 'a', reason: 'r' }, 0, self)
    assert.match(self[0]?.message ?? '', /itself/)
  })

  it('a body over 100 000 characters is refused once secrets become marks', () => {
    const problems: Problem[] = []
    readOp({ op: 'merge', address: 'a', from: 'b', body: 'x'.repeat(100_001), reason: 'r' }, 0, problems)
    assert.match(problems[0]?.message ?? '', /longer than 100000/)
  })

  it('titles that share almost all their words are nearly the same', () => {
    assert.ok(nearlySame('What keeps our audience', 'What keeps our audience?'))
    assert.ok(!nearlySame('Narrator voice', 'Thumbnail colours'))
  })
})
