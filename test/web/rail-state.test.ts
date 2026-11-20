// Spec web redesign (Annex C 17, CA34): the rail starts open (228px) the first time, folds to 56px with a
// button, and the choice is remembered in this browser only. A storage that is blocked or holds something else never breaks it.
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { foldRail, RAIL_KEY, rail, readRail, setRail, startRail, toggleRail } from '../../web/src/lib/rail.ts'

function memory(initial: Record<string, string> = {}) {
  const data = new Map(Object.entries(initial))
  return {
    data,
    getItem: (k: string) => data.get(k) ?? null,
    setItem: (k: string, v: string) => void data.set(k, v),
  }
}

const blocked = {
  getItem: (): string | null => {
    throw new Error('blocked')
  },
  setItem: (): void => {
    throw new Error('blocked')
  },
}

describe('the rail', () => {
  it('is kept under rscb.rail', () => {
    assert.equal(RAIL_KEY, 'rscb.rail')
  })

  it('starts open when nothing is remembered, or something else is', () => {
    assert.equal(readRail(memory()), 'open')
    assert.equal(readRail(memory({ 'rscb.rail': 'wide' })), 'open')
    assert.equal(readRail(null), 'open')
    assert.equal(readRail(blocked), 'open')
  })

  it('starts folded when folded was remembered', () => {
    assert.equal(readRail(memory({ 'rscb.rail': 'folded' })), 'folded')
    const s = memory({ 'rscb.rail': 'folded' })
    startRail(s)
    assert.equal(rail.value, 'folded')
    startRail(memory())
    assert.equal(rail.value, 'open')
  })

  it('opening and folding is shown at once and remembered', () => {
    const s = memory()
    startRail(s)
    toggleRail(s)
    assert.equal(rail.value, 'folded')
    assert.equal(s.data.get('rscb.rail'), 'folded')
    toggleRail(s)
    assert.equal(rail.value, 'open')
    assert.equal(s.data.get('rscb.rail'), 'open')
    setRail('folded', s)
    assert.equal(rail.value, 'folded')
  })

  it('a blocked storage only means the choice is not remembered', () => {
    startRail(blocked)
    assert.doesNotThrow(() => toggleRail(blocked))
    assert.equal(rail.value, 'folded')
  })

  // Review R2: on a tablet (768–1099px) the open rail covers the screen, so opening it there is for the
  // moment only: never read, never saved.
  it('on a tablet it starts folded whatever was remembered, and opening it is not remembered', () => {
    const s = memory({ 'rscb.rail': 'open' })
    startRail(s, { tablet: true })
    assert.equal(rail.value, 'folded')
    toggleRail(s, { tablet: true })
    assert.equal(rail.value, 'open')
    assert.equal(s.data.get('rscb.rail'), 'open', 'the wide choice is kept as it was')
    const fresh = memory()
    startRail(fresh, { tablet: true })
    toggleRail(fresh, { tablet: true })
    assert.equal(rail.value, 'open')
    assert.equal(fresh.data.get('rscb.rail'), undefined)
    foldRail()
    assert.equal(rail.value, 'folded')
    assert.equal(fresh.data.get('rscb.rail'), undefined)
  })
})
