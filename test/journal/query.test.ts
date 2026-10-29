import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { parseQuery } from '../../src/domain/search.ts'

describe('reading a search', () => {
  it('quoted text is a phrase wherever it sits; a minus before it excludes it', () => {
    assert.deepEqual(parseQuery('"bravo charlie"-"delta echo"').phrases, ['bravo charlie', 'delta echo'])
    assert.deepEqual(parseQuery('x"alpha beta"').phrases, ['alpha beta'])
    assert.deepEqual(parseQuery('"alpha""beta"').phrases, ['alpha', 'beta'])
    const q = parseQuery('kiwi -"dog food" -larga')
    assert.deepEqual([q.phrases, q.excludedPhrases, q.excluded], [[], ['dog food'], ['larga']])
  })
})
