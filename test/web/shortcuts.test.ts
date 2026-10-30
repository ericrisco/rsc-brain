// Spec B6 «Accesibilidad, teclado» and CA20 (T010): ⌘K or Ctrl K searches from anywhere, "g" and a letter
// go to a section, "?" shows the list. A shortcut never fires while the person is typing (except search),
// and every shortcut names the visible control that does the same.
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { createKeymap, SHORTCUTS } from '../../web/src/lib/shortcuts.ts'

const key = (
  k: string,
  o: Partial<{ meta: boolean; ctrl: boolean; alt: boolean; typing: boolean }> = {},
) => ({
  key: k,
  metaKey: o.meta ?? false,
  ctrlKey: o.ctrl ?? false,
  altKey: o.alt ?? false,
  typing: o.typing ?? false,
})

describe('keyboard shortcuts', () => {
  it('⌘K and Ctrl K open search, even from a text field', () => {
    const m = createKeymap(() => 0)
    assert.equal(m.handle(key('k', { meta: true })), 'search')
    assert.equal(m.handle(key('K', { ctrl: true, typing: true })), 'search')
  })

  it('"?" opens the list of shortcuts', () => {
    assert.equal(createKeymap(() => 0).handle(key('?')), 'help')
  })

  it('"g" then "p" goes to People; the list says it is only for whoever may invite', () => {
    const m = createKeymap(() => 0)
    assert.equal(m.handle(key('g')), null)
    assert.equal(m.handle(key('p')), 'go-people')
    const people = SHORTCUTS.find((s) => s.id === 'go-people')
    assert.equal(people?.invite, true)
    assert.match(String(people?.control), /People/)
  })

  it('"g" then a letter goes to a section, within a second and a half', () => {
    let now = 0
    const m = createKeymap(() => now)
    assert.equal(m.handle(key('g')), null)
    now = 500
    assert.equal(m.handle(key('h')), 'go-home')
    assert.equal(m.handle(key('g')), null)
    now = 2500
    assert.equal(m.handle(key('o')), null)
    assert.equal(m.handle(key('g')), null)
    assert.equal(m.handle(key('o')), 'go-overview')
    assert.equal(m.handle(key('g')), null)
    assert.equal(m.handle(key('w')), 'go-wiki')
  })

  it('nothing fires while typing, or with a modifier the browser owns', () => {
    const m = createKeymap(() => 0)
    assert.equal(m.handle(key('?', { typing: true })), null)
    assert.equal(m.handle(key('g', { typing: true })), null)
    assert.equal(m.handle(key('h', { typing: true })), null)
    assert.equal(m.handle(key('g', { ctrl: true })), null)
    assert.equal(m.handle(key('h')), null)
  })

  it('every shortcut names its visible control', () => {
    const ids = new Set<string>()
    for (const s of SHORTCUTS) {
      assert.ok(s.keys.length > 0 && s.label && s.control, s.id)
      assert.ok(!ids.has(s.id), `${s.id} twice`)
      ids.add(s.id)
    }
    assert.deepEqual([...ids].sort(), [
      'edit',
      'go-decisions',
      'go-home',
      'go-journal',
      'go-log',
      'go-overview',
      'go-people',
      'go-wiki',
      'help',
      'search',
    ])
  })

  it('"e" edits the page; "g" then "d" or "l" goes to the decisions or the log (review of PR19)', () => {
    const m = createKeymap(() => 0)
    assert.equal(m.handle(key('e')), 'edit')
    assert.equal(m.handle(key('e', { typing: true })), null)
    assert.equal(m.handle(key('g')), null)
    assert.equal(m.handle(key('d')), 'go-decisions')
    assert.equal(m.handle(key('g')), null)
    assert.equal(m.handle(key('l')), 'go-log')
  })

  it('"g" then "j" goes to the journal (PR20)', () => {
    const m = createKeymap(() => 0)
    assert.equal(m.handle(key('g')), null)
    assert.equal(m.handle(key('j')), 'go-journal')
    assert.equal(m.handle(key('j')), null)
  })
})
