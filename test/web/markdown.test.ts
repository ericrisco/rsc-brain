// Spec B6 «Wiki › Page» and plan risk 5: a page body is markdown written by agents, so it is rendered with
// raw HTML off and links checked — nothing in a body can run in the web session (which can approve). A
// [[mention]] leads to the page it names; one that names no page looks different and says so.
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { renderMarkdown } from '../../web/src/lib/markdown.ts'

const links = [
  { kind: 'mentions', address: 'audience/intros', state: 'ok' },
  { kind: 'mentions', address: 'drafts/not-yet', state: 'broken' },
  { kind: 'mentions', address: 'audience/old-intros', state: 'superseded' },
  { kind: 'mentions', address: 'legal/retired-one', state: 'retired' },
  { kind: 'related', address: 'drafts/not-yet', state: 'ok' },
] as const
const md = (body: string) => renderMarkdown(body, { slug: 'growth', links: [...links] })

describe('a page body', () => {
  it('formats markdown: headings, lists, emphasis, code', () => {
    const html = md('# Title\n\n- one\n- **two**\n\n`code`')
    assert.match(html, /<h1>Title<\/h1>/)
    assert.match(html, /<li><strong>two<\/strong><\/li>/)
    assert.match(html, /<code>code<\/code>/)
  })

  it('never lets raw HTML through: it shows as text', () => {
    for (const body of [
      '<script>alert(1)</script>',
      '<img src=x onerror=alert(1)>',
      '<a href="javascript:alert(1)">x</a>',
      '<iframe src="https://evil.test"></iframe>',
      '<svg onload=alert(1)>',
    ]) {
      const html = md(body)
      assert.doesNotMatch(html, /<(script|img|a href="javascript|iframe|svg)/i, body)
      assert.match(html, /&lt;/, body)
    }
  })

  it('keeps only links to http, https, mailto and addresses inside the web', () => {
    for (const bad of [
      '[x](javascript:alert(1))',
      '[x](JaVaScRiPt:alert(1))',
      '[x](  javascript:alert(1))',
      '[x](java&#x09;script:alert(1))',
      '[x](vbscript:msgbox)',
      '[x](data:text/html;base64,PHNjcmlwdD4=)',
      '[x](file:///etc/passwd)',
      '[x](//evil.test/path)',
      '[x](/\\evil.test)',
      '<javascript:alert(1)>',
    ]) {
      const html = md(bad)
      assert.doesNotMatch(html, /href/i, bad)
    }
    assert.match(md('[ok](https://example.test/a)'), /href="https:\/\/example\.test\/a"/)
    assert.match(md('[mail](mailto:ana@example.test)'), /href="mailto:ana@example\.test"/)
    assert.match(md('[here](/b/growth/wiki)'), /href="\/b\/growth\/wiki"/)
  })

  it('opens a link that leaves the web in a new tab, telling it nothing of where it came from', () => {
    const html = md('[site](https://example.test)')
    assert.match(html, /rel="noopener noreferrer"/)
    assert.match(html, /target="_blank"/)
    const inside = md('[map](/b/growth/wiki)')
    assert.doesNotMatch(inside, /target=/)
  })

  it('shows an image as a link to it, never loading it into the page', () => {
    const html = md('![a chart](https://example.test/chart.png)')
    assert.doesNotMatch(html, /<img/i)
    assert.match(html, /<a [^>]*href="https:\/\/example\.test\/chart\.png"[^>]*>Image: a chart<\/a>/)
    assert.doesNotMatch(md('![x](javascript:alert(1))'), /href/)
  })

  it('turns [[address]] and [[address|text]] into links to those pages', () => {
    const html = md('Read [[audience/intros]] and [[audience/intros|the intros page]].')
    assert.match(
      html,
      /<a href="\/b\/growth\/pages\/audience\/intros" class="wikilink">audience\/intros<\/a>/,
    )
    assert.match(html, /<a href="\/b\/growth\/pages\/audience\/intros" class="wikilink">the intros page<\/a>/)
  })

  it('a mention of a page that does not exist looks different and says so in words', () => {
    const html = md('Soon: [[drafts/not-yet]].')
    assert.match(html, /class="wikilink broken"/)
    assert.match(html, /no page yet/)
  })

  it('a mention of a retired or superseded page says that too', () => {
    assert.match(
      md('[[legal/retired-one]]'),
      /class="wikilink retired"[^>]*>legal\/retired-one<span class="link-note"> \(retired\)/,
    )
    assert.match(md('[[audience/old-intros]]'), /class="wikilink superseded"/)
  })

  it('an address the server would not take stays text, escaped', () => {
    const html = md('[[a" onmouseover="alert(1)]] and [[Not An Address]]')
    assert.doesNotMatch(html, /<a /)
    assert.match(html, /&quot;/)
  })

  it('a mention by an old address is a working link (the server redirects it)', () => {
    assert.match(md('[[audience/first-intros]]'), /class="wikilink"/)
  })

  it('the text of a mention is escaped', () => {
    const html = md('[[audience/intros|<b>bold</b>]]')
    assert.match(html, />&lt;b&gt;bold&lt;\/b&gt;</)
  })
})
