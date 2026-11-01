// Spec B6 «Graph» (PR22, third review): where the keyboard goes after an action of the graph screen. It lands
// on its place as soon as that is drawn; once nothing is loading, or after two seconds, on the fallback; and a
// key or a click of the person's own cancels the wait, so it never takes the keyboard back later.
import assert from 'node:assert/strict'
import { afterEach, beforeEach, describe, it, mock } from 'node:test'
import { landing } from '../../web/src/lib/landing.ts'

type El = { id: string; focus: () => void }

// A document with the places that exist now, what got the keyboard, and the listeners it was given.
function page() {
  const present = new Map<string, El>()
  const focused: string[] = []
  const listeners = new Map<string, () => void>()
  const add = (sel: string) => present.set(sel, { id: sel, focus: () => focused.push(sel) })
  const doc = {
    querySelector: (sel: string) => {
      for (const s of sel.split(',').map((x) => x.trim())) {
        const el = present.get(s)
        if (el) return el
      }
      return null
    },
    addEventListener: (type: string, f: () => void) => listeners.set(type, f),
    removeEventListener: (type: string) => listeners.delete(type),
  }
  return { doc, add, focused, fire: (type: string) => listeners.get(type)?.() }
}

describe('where the keyboard lands after an action', () => {
  beforeEach(() => mock.timers.enable({ apis: ['setTimeout'] }))
  afterEach(() => mock.timers.reset())

  it('on its place as soon as it is drawn, even while something still loads', () => {
    const p = page()
    const l = landing(p.doc, '#fallback')
    l.want('#focus-bar')
    l.land(true)
    assert.deepEqual(p.focused, [])
    p.add('#focus-bar')
    l.land(true)
    assert.deepEqual(p.focused, ['#focus-bar'])
    assert.equal(l.pending(), null)
  })

  it('on the fallback once nothing is loading and the place is not there', () => {
    const p = page()
    p.add('#fallback')
    const l = landing(p.doc, '#fallback')
    l.want('[data-focus-for="gone"]')
    l.land(true)
    assert.deepEqual(p.focused, [])
    l.land(false)
    assert.deepEqual(p.focused, ['#fallback'])
    // Done waiting: the row coming back later does not take the keyboard.
    p.add('[data-focus-for="gone"]')
    l.land(false)
    assert.deepEqual(p.focused, ['#fallback'])
  })

  it('on the fallback after two seconds, even while something still loads', () => {
    const p = page()
    p.add('#fallback')
    const l = landing(p.doc, '#fallback')
    l.want('#never')
    l.land(true)
    mock.timers.tick(1999)
    assert.deepEqual(p.focused, [])
    mock.timers.tick(1)
    assert.deepEqual(p.focused, ['#fallback'])
    assert.equal(l.pending(), null)
  })

  for (const type of ['keydown', 'pointerdown'])
    it(`a ${type} of the person's own cancels the wait: nothing takes the keyboard later`, () => {
      const p = page()
      p.add('#fallback')
      const l = landing(p.doc, '#fallback')
      l.want('#late')
      p.fire(type)
      assert.equal(l.pending(), null)
      p.add('#late')
      l.land(false)
      mock.timers.tick(2000)
      assert.deepEqual(p.focused, [])
    })

  it('a newer action replaces the wait of an older one, and its timer', () => {
    const p = page()
    p.add('#fallback')
    const l = landing(p.doc, '#fallback')
    l.want('#first')
    mock.timers.tick(1500)
    l.want('#second')
    mock.timers.tick(600)
    assert.deepEqual(p.focused, [])
    p.add('#second')
    l.land(true)
    assert.deepEqual(p.focused, ['#second'])
  })

  it('stops listening when the screen goes', () => {
    const p = page()
    const l = landing(p.doc, '#fallback')
    l.dispose()
    l.want('#late')
    p.fire('keydown')
    assert.equal(l.pending(), '#late')
  })
})
