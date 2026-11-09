// Plan canvas-ui D4 and CA8: the graph of a brain is drawn on a canvas that fills the screen; every other
// screen is a page that scrolls. Which is which depends on the address alone.
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { isCanvasRoute } from '../../web/src/lib/nav.ts'

describe('canvas routes', () => {
  it('the graph of any brain is a canvas', () => {
    assert.equal(isCanvasRoute('/b/growth/wiki/graph'), true)
    assert.equal(isCanvasRoute('/b/growth/wiki/graph/'), true)
    assert.equal(isCanvasRoute('/b/a%20b/wiki/graph'), true)
  })

  it('every other screen is a page', () => {
    for (const p of [
      '/',
      '/b/growth',
      '/b/growth/wiki',
      '/b/growth/wiki/log',
      '/b/growth/wiki/graph/more',
      '/b/growth/pages/wiki/graph',
      '/b//wiki/graph',
      '/b/growth/wiki/graphs',
      '/people',
    ]) {
      assert.equal(isCanvasRoute(p), false, p)
    }
  })
})
