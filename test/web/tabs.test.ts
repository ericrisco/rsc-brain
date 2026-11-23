// The row of tabs on a phone: where it starts so that no tab is cut at the left, the current one is in view,
// and when it says that more waits on either side.
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { LEAD, tabsMore, tabsStart } from '../../web/src/lib/tabs.ts'

// Tabs of 100px with a 24px gap: 0-100, 124-224, 248-348, ...
const row = (n: number) => Array.from({ length: n }, (_, i) => ({ left: i * 124, right: i * 124 + 100 }))
const scrollWidth = (n: number) => n * 124 - 24

describe('tabsStart', () => {
  it('does not move a row that fits', () => {
    assert.equal(tabsStart(row(3), 2, 400, 0), 0)
  })

  it('keeps the first tabs at the start while the current one is in view', () => {
    const w = 358
    assert.equal(tabsStart(row(8), 1, w, scrollWidth(8) - w), 0)
  })

  it('starts in the blank before a tab, not inside one, when the end is reached first', () => {
    const w = 358
    const max = scrollWidth(8) - w
    for (const cur of [5, 6, 7]) {
      const at = tabsStart(row(8), cur, w, max)
      const t = row(8)
      assert.ok(at <= max, `${cur}: not past the end`)
      assert.ok((t[cur]?.right as number) - at <= w, `${cur}: the current tab is whole in view`)
      const cut = t.filter((x) => x.left < at && x.right > at)
      assert.deepEqual(cut, [], `${cur}: no tab is cut at the left edge (starts at ${at})`)
    }
  })

  it('leaves the blank for the mark before the first tab shown', () => {
    const t = row(8)
    const at = tabsStart(t, 5, 358, scrollWidth(8) - 358)
    assert.equal(at, (t[4]?.left as number) - LEAD)
  })
})

describe('tabsMore', () => {
  it('says more waits to the right at the start, to the left at the end, both in the middle', () => {
    assert.deepEqual(tabsMore(0, 358, 1000), { start: false, end: true })
    assert.deepEqual(tabsMore(300, 358, 1000), { start: true, end: true })
    assert.deepEqual(tabsMore(642, 358, 1000), { start: true, end: false })
    assert.deepEqual(tabsMore(0, 358, 358), { start: false, end: false })
  })
})
