// Spec amendment 2026-11-09, CA12 (plan canvas-ui S.1, SB3): the page types' families, each type with a
// colour of its own among the seven of shared.css v2 (the wiki's map lists pages by them).
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { FAMILIES, familyOfType } from '../../web/src/graph/families.ts'
import { PAGE_TYPES } from '../../web/src/lib/wiki.ts'

describe('graph families', () => {
  it('each page type has a colour of its own, among the seven shared ones', () => {
    const colours = PAGE_TYPES.map((t) => familyOfType(t).colour)
    assert.equal(new Set(colours).size, PAGE_TYPES.length)
    for (const c of colours)
      assert.ok(['orange', 'amber', 'blue', 'cyan', 'pink', 'violet', 'green'].includes(c), c)
    assert.deepEqual(
      FAMILIES.map((f) => f.type),
      [...PAGE_TYPES],
    )
  })

  it('an unknown type falls into the first family, never out of the picture', () => {
    assert.equal(familyOfType('no-such-type'), FAMILIES[0])
  })
})
