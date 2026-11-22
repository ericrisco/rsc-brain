// Spec web redesign (CA21, CA29): every mail is drawn in the web's light values — the frame's ground, a white
// sheet with a hairline edge, the web's ink, links in its accent — in the system's face, says it is a light
// mail (so a client in dark mode keeps it legible), and carries the installation's name and logo.
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import type { Db } from '../../src/db/db.ts'
import { branded, LOGO_CID, MAIL } from '../../src/mail/mail.ts'

const db = (row: { name: string; logo: Buffer | null; logo_type: string | null }) =>
  ({ one: async () => row }) as unknown as Db

const lum = (hex: string) => {
  const n = Number.parseInt(hex.slice(1), 16)
  const [r, g, b] = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((c) => {
    const s = c / 255
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4
  }) as [number, number, number]
  return 0.2126 * r + 0.7152 * g + 0.0722 * b
}
const contrast = (a: string, b: string) =>
  (Math.max(lum(a), lum(b)) + 0.05) / (Math.min(lum(a), lum(b)) + 0.05)

describe('the look of a mail', () => {
  it('uses the values of the web, a light sheet, and links in the accent', async () => {
    const m = await branded(db({ name: 'Acme memory', logo: null, logo_type: null }), {
      to: 'ana@example.org',
      subject: 'Reset your password',
      text: 'Open https://brain.example.org/reset#token=x to choose a new one.',
    })
    const html = m.html as string
    for (const v of ['#f9fbfc', '#ffffff', '#e8eaec', '#131416', '#1b6c80']) assert.ok(html.includes(v), v)
    assert.match(html, /border-radius:16px/)
    assert.match(html, /<meta name="color-scheme" content="light only">/)
    assert.match(html, /<a href="https:\/\/brain\.example\.org\/reset#token=x" style="color:#1b6c80/)
    assert.match(html, /font-family:system-ui/)
    assert.doesNotMatch(html, /#1b1d22|https?:\/\/fonts\./)
    assert.match(html, />Acme memory<\/p>/)
    assert.equal(m.attachments?.length, 0)
  })

  it('carries the installation logo inline', async () => {
    const m = await branded(db({ name: 'Acme memory', logo: Buffer.from('png'), logo_type: 'image/png' }), {
      to: 'ana@example.org',
      subject: 'x',
      text: 'y',
    })
    assert.match(m.html as string, new RegExp(`src="cid:${LOGO_CID}"`))
    assert.equal(m.attachments?.[0]?.cid, LOGO_CID)
  })

  it('every word reads at 4.5:1 on its ground', () => {
    for (const ink of [MAIL.text, MAIL.muted, MAIL.accent])
      for (const ground of [MAIL.surface, MAIL.ground])
        assert.ok(contrast(ink, ground) >= 4.5, `${ink} on ${ground}: ${contrast(ink, ground).toFixed(2)}`)
  })
})
