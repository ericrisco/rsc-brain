// Spec web redesign (CA20, CA10e): the pages the server draws itself (connecting an agent, maintenance) use the
// web's values and faces, served by the installation, with no script; they follow the system — light, dark, or
// high contrast when it asks for more — and load nothing from elsewhere. Their CSP only gains the faces.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { describe, it } from 'node:test'
import { PAGE_STYLE } from '../../src/http/routes/oauth.ts'

const SOURCE = readFileSync(new URL('../../src/http/routes/oauth.ts', import.meta.url), 'utf8')

describe('the style of the server-drawn pages', () => {
  it('uses the values of the web in light, dark and high contrast', () => {
    for (const v of ['#f9fbfc', '#ffffff', '#e8eaec', '#131416', '#5d5f60', '#1b6c80'])
      assert.ok(PAGE_STYLE.includes(v), v)
    for (const v of ['#0f1011', '#17181a', '#f2f3f4', '#a4a7ab']) assert.ok(PAGE_STYLE.includes(v), v)
    assert.match(PAGE_STYLE, /@media \(prefers-color-scheme:dark\)/)
    assert.match(PAGE_STYLE, /@media \(prefers-contrast:more\)/)
    assert.match(PAGE_STYLE, /border-radius:16px/)
  })

  it('writes in IBM Plex, served by the installation; nothing from elsewhere', () => {
    assert.match(PAGE_STYLE, /body\{[^}]*font:[^;}]*"IBM Plex Sans"/)
    const faces = [...PAGE_STYLE.matchAll(/src:url\("([^"]+)"\)/g)].map((m) => m[1])
    assert.ok(faces.length >= 3)
    for (const f of faces) assert.match(f as string, /^\/fonts\/ibm-plex-[a-z]+-latin1-\d00\.woff2$/)
    assert.doesNotMatch(PAGE_STYLE, /@import|https?:/)
    assert.doesNotMatch(PAGE_STYLE, /oklch|ui-monospace,"SF Mono"/)
  })

  it('the CSP gains the faces of this installation only', () => {
    assert.match(
      SOURCE,
      /"default-src 'none'; style-src 'unsafe-inline'; font-src 'self'; frame-ancestors 'none'; base-uri 'none'"/,
    )
  })

  it('the files the faces point at are built beside the web', () => {
    for (const f of [
      'ibm-plex-sans-latin1-400',
      'ibm-plex-sans-latin1-500',
      'ibm-plex-sans-latin1-600',
      'ibm-plex-mono-latin1-400',
    ])
      assert.ok(
        readFileSync(new URL(`../../web/src/styles/fonts/${f}.woff2`, import.meta.url)).length > 10_000,
        f,
      )
    const vite = readFileSync(new URL('../../web/vite.config.ts', import.meta.url), 'utf8')
    assert.match(vite, /fileName: `fonts\/\$\{f\}`/)
  })
})
