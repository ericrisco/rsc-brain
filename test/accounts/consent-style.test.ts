// Plan B6 §1 and T009: the sign-in and consent pages of the standard sign-in stay with the server (no
// JavaScript, strict CSP), and take the visual tokens of DESIGN.md: dark by default, the brand's
// palette, system fonts, nothing loaded from elsewhere.
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { PAGE_STYLE } from '../../src/http/routes/oauth.ts'

describe('the style of the consent pages', () => {
  it('uses the tokens of DESIGN.md, dark first', () => {
    for (const token of [
      'oklch(0.165 0.012 260)',
      'oklch(0.205 0.013 260)',
      'oklch(0.96 0.004 95)',
      'oklch(0.76 0.008 260)',
      'oklch(0.8 0.17 156)',
    ]) {
      assert.ok(PAGE_STYLE.includes(token), token)
    }
    assert.match(PAGE_STYLE, /prefers-color-scheme:\s*light/)
    assert.doesNotMatch(PAGE_STYLE, /prefers-color-scheme:\s*dark/)
  })

  it('loads nothing from elsewhere and uses system fonts', () => {
    assert.doesNotMatch(PAGE_STYLE, /@import|url\(|https?:/)
    assert.match(PAGE_STYLE, /ui-monospace/)
    assert.match(PAGE_STYLE, /system-ui/)
  })
})
