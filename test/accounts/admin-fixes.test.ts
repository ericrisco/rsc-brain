// Fixes of the reviews of B6 PR25b: a provider whose address or key changes while meaning search is on stops
// it until the warning is accepted again; no part of the mail password is kept or shown; sealed secrets are
// bound to what they are for; a new mail server needs its password again; the environment's address of a
// local provider is not shown whole; an unreadable stored key falls back to the environment; a body over the
// limit is not read further; a mail failure is a short category; the download is pinned to the view.
import assert from 'node:assert/strict'
import { connect } from 'node:net'
import { after, before, describe, it } from 'node:test'
import { seal, unseal } from '../../src/auth/vault.ts'
import { mailError } from '../../src/mail/mail.ts'
import { png } from '../helpers/images.ts'
import { fakeProvider } from '../helpers/meaning.ts'
import { skipPg } from '../helpers/pg.ts'
import { type World, world } from '../helpers/world.ts'

type Json = Record<string, unknown>
const SECRET = 'test-secret-of-at-least-thirty-two-characters'

// A raw request: headers, then `send` bytes of body, then wait for an answer without sending the rest.
function rawRequest(
  base: string,
  o: { path: string; cookie: string; length: number | 'chunked'; send: number },
): Promise<{ status: number; ms: number }> {
  const u = new URL(base)
  return new Promise((resolve, reject) => {
    const t0 = Date.now()
    const s = connect(Number(u.port), u.hostname, () => {
      s.write(
        `PUT ${o.path} HTTP/1.1\r\nHost: ${u.host}\r\nContent-Type: application/json\r\nX-Requested-With: rsc-brain-web\r\n` +
          `Cookie: rscb_session=${o.cookie}\r\n${o.length === 'chunked' ? 'Transfer-Encoding: chunked' : `Content-Length: ${o.length}`}\r\n\r\n`,
      )
      if (o.length === 'chunked') s.write(`${o.send.toString(16)}\r\n${' '.repeat(o.send)}\r\n`)
      else s.write(Buffer.alloc(o.send, 0x20))
    })
    let got = ''
    s.on('data', (d) => {
      got += d.toString('latin1')
      const m = /^HTTP\/1\.1 (\d{3})/.exec(got)
      if (m) {
        resolve({ status: Number(m[1]), ms: Date.now() - t0 })
        s.destroy()
      }
    })
    s.on('error', () => {})
    s.on('close', () => reject(new Error(`closed without an answer: ${got.slice(0, 80)}`)))
    // No answer: the socket is closed too, so the server can stop.
    setTimeout(() => {
      s.destroy()
      reject(new Error('no answer in 3 s'))
    }, 3000).unref()
  })
}

describe('fixes of PR25b (reviews)', { skip: skipPg }, () => {
  let w: World
  let admin: { id: string; key: string }
  let other: { id: string; key: string }
  let ana: { id: string; key: string }
  let adminWeb: string
  let otherWeb: string
  let anaWeb: string
  const envOpenai = fakeProvider('openai', 'env-model')

  before(async () => {
    w = await world({ meaning: { openai: envOpenai } })
    admin = await w.person('Admin', { isAdmin: true })
    other = await w.person('Other', { isAdmin: true })
    ana = await w.person('Ana')
    adminWeb = await w.web(admin.id)
    otherWeb = await w.web(other.id)
    anaWeb = await w.web(ana.id)
  })
  after(async () => w.close())
  const meaning = async () => (await w.callWeb(adminWeb, 'GET', '/v1/admin/meaning')).body
  const mail = async () => (await w.callWeb(adminWeb, 'GET', '/v1/admin/mail')).body

  describe('1: a new destination for the provider in use needs the warning accepted again', () => {
    it('Ollama on this machine, then a third-party address: meaning search goes off and the acceptance is gone', async () => {
      await w.callWeb(adminWeb, 'PUT', '/v1/admin/meaning/providers/ollama', {
        url: 'http://localhost:11434',
      })
      const on = await w.callWeb(adminWeb, 'PUT', '/v1/admin/meaning', { provider: 'ollama', accept: true })
      assert.equal(on.body.enabled, true, on.text)
      const moved = await w.callWeb(adminWeb, 'PUT', '/v1/admin/meaning/providers/ollama', {
        url: 'https://embed.third-party.example',
      })
      assert.equal(moved.status, 200, moved.text)
      assert.deepEqual(
        [moved.body.enabled, moved.body.acceptedAt, moved.body.acceptedBy],
        [false, null, null],
      )
      const audit = await w.db.query(
        "SELECT detail FROM audit WHERE action = 'meaning.disable' ORDER BY id DESC LIMIT 1",
      )
      assert.match(String(audit[0]?.detail), /ollama/)
      const again = await w.callWeb(adminWeb, 'PUT', '/v1/admin/meaning', { provider: 'ollama' })
      assert.equal(again.status, 400)
    })

    it('a new key for the provider in use does the same; a key for another provider leaves it on', async () => {
      await w.callWeb(adminWeb, 'PUT', '/v1/admin/meaning/providers/ollama', {
        url: 'http://localhost:11434',
      })
      await w.callWeb(adminWeb, 'PUT', '/v1/admin/meaning', { provider: 'ollama', accept: true })
      const otherKey = await w.callWeb(adminWeb, 'PUT', '/v1/admin/meaning/providers/openai', {
        key: 'sk-other-provider-0123456789',
      })
      assert.equal(otherKey.body.enabled, true)
      await w.callWeb(adminWeb, 'PUT', '/v1/admin/meaning', { provider: 'openai', accept: true })
      const rekey = await w.callWeb(adminWeb, 'PUT', '/v1/admin/meaning/providers/openai', {
        key: 'sk-another-account-9876543210',
      })
      assert.deepEqual([rekey.body.enabled, rekey.body.acceptedAt], [false, null])
    })

    it('removing what the web set, when the environment has one: a new destination too, so it goes off', async () => {
      await w.callWeb(adminWeb, 'PUT', '/v1/admin/meaning', { provider: 'openai', accept: true })
      const r = await w.callWeb(adminWeb, 'DELETE', '/v1/admin/meaning/providers/openai')
      assert.equal(r.status, 200, r.text)
      assert.deepEqual([r.body.enabled, r.body.acceptedAt], [false, null])
    })
  })

  describe('6: precedence, and a stored key that cannot be opened', () => {
    it('a key set in the web wins over the environment', async () => {
      await w.callWeb(adminWeb, 'PUT', '/v1/admin/meaning/providers/openai', {
        key: 'sk-web-key-0123456789abcd',
      })
      const p = ((await meaning()).providers as Json[]).find((x) => x.name === 'openai') as Json
      assert.deepEqual([p.source, p.model], ['settings', 'text-embedding-3-small@256'])
    })

    it('a key sealed with another secret: the environment provider stays, and the screen is told why', async () => {
      await w.db.query('UPDATE meaning_settings SET openai_key = $1 WHERE id = 1', [
        seal('another-installation-secret-of-32-chars!', 'sk-lost', 'meaning.openai'),
      ])
      // Applied as at start-up (any provider change applies it again).
      await w.callWeb(adminWeb, 'PUT', '/v1/admin/meaning/providers/ollama', {
        url: 'http://localhost:11434',
      })
      const m = await meaning()
      assert.ok((m.available as string[]).includes('openai'))
      const p = (m.providers as Json[]).find((x) => x.name === 'openai') as Json
      assert.deepEqual([p.unreadable, p.model], [true, 'env-model'])
      await w.callWeb(adminWeb, 'DELETE', '/v1/admin/meaning/providers/openai')
    })
  })

  describe('5: the environment address of a local provider is not given whole', () => {
    it('only scheme, host and port, and that the rest is hidden', async () => {
      const w2 = await world({
        meaning: {
          ollama: {
            ...fakeProvider('ollama', 'm'),
            url: 'http://user:pw@gpu.internal:11434/secret/path?t=1',
          },
        },
      })
      try {
        const a = await w2.person('A', { isAdmin: true })
        const r = await w2.callWeb(await w2.web(a.id), 'GET', '/v1/admin/meaning')
        const p = (r.body.providers as Json[]).find((x) => x.name === 'ollama') as Json
        assert.deepEqual([p.source, p.url, p.urlHidden], ['environment', 'http://gpu.internal:11434', true])
        assert.ok(!r.text.includes('secret/path') && !r.text.includes('pw@'))
      } finally {
        await w2.close()
      }
    })
  })

  describe('2 and 4: no part of the mail password is kept or shown; a new server needs it again', () => {
    const SMTP = { host: 'smtp.example.com', port: 587, user: 'brain', fromAddress: 'brain@example.com' }

    it('only that it is set: no last characters in the answer or in storage', async () => {
      const r = await w.callWeb(adminWeb, 'PUT', '/v1/admin/mail', { ...SMTP, password: 'pw-ends-wxyz' })
      assert.equal(r.status, 200, r.text)
      const s = r.body.settings as Json
      assert.equal(s.hasPassword, true)
      assert.equal('passwordLast4' in s, false)
      assert.ok(!r.text.includes('wxyz'))
      const row = await w.db.one<{ mail: Json }>('SELECT mail FROM installation WHERE id = 1')
      assert.ok(!JSON.stringify(row?.mail).includes('wxyz'))
    })

    it('a new password with the same ending is still a change another administrator is told of', async () => {
      const read = (await mail()).base as Json
      await w.callWeb(otherWeb, 'PUT', '/v1/admin/mail', { ...SMTP, password: 'other-ends-wxyz', base: read })
      const r = await w.callWeb(adminWeb, 'PUT', '/v1/admin/mail', { ...SMTP, port: 2525, base: read })
      assert.deepEqual([r.status, r.body.error?.code], [409, 'settings_changed'], r.text)
    })

    it('two administrators saving on the same base: exactly one wins, every time', async () => {
      for (let round = 0; round < 20; round += 1) {
        const read = (await mail()).base as Json
        const [a, b] = await Promise.all([
          w.callWeb(adminWeb, 'PUT', '/v1/admin/mail', { ...SMTP, fromName: `A${round}`, base: read }),
          w.callWeb(otherWeb, 'PUT', '/v1/admin/mail', { ...SMTP, fromName: `B${round}`, base: read }),
        ])
        assert.deepEqual([a.status, b.status].sort(), [200, 409], `round ${round}: ${a.text} ${b.text}`)
      }
    })

    it('another server, port or user with the old password is refused; typing it again, or removing it, passes', async () => {
      for (const change of [{ host: 'smtp.elsewhere.example' }, { port: 465 }, { user: 'someone' }]) {
        const r = await w.callWeb(adminWeb, 'PUT', '/v1/admin/mail', { ...SMTP, ...change })
        assert.equal(r.status, 400, `${JSON.stringify(change)}: ${r.text}`)
        assert.match(r.body.error?.message ?? '', /password/i)
      }
      assert.equal(
        (
          await w.callWeb(adminWeb, 'PUT', '/v1/admin/mail', {
            ...SMTP,
            host: 'smtp.b.example',
            password: 'again-pw',
          })
        ).status,
        200,
      )
      assert.equal(
        (
          await w.callWeb(adminWeb, 'PUT', '/v1/admin/mail', {
            ...SMTP,
            host: 'smtp.c.example',
            password: '',
          })
        ).status,
        200,
      )
    })

    it('null for a password that is not set changes nothing and writes no audit line', async () => {
      const before = await w.db.one<{ n: number }>(
        "SELECT count(*)::int AS n FROM audit WHERE action = 'settings.mail'",
      )
      const r = await w.callWeb(adminWeb, 'PUT', '/v1/admin/mail', {
        ...SMTP,
        host: 'smtp.c.example',
        password: null,
        base: (await mail()).base,
      })
      assert.equal(r.body.unchanged, true, r.text)
      const now = await w.db.one<{ n: number }>(
        "SELECT count(*)::int AS n FROM audit WHERE action = 'settings.mail'",
      )
      assert.equal(now?.n, before?.n)
    })

    it('an empty sender name stays empty; mail goes as the installation, renamed or not', async () => {
      await w.setUpMail()
      await w.callWeb(adminWeb, 'PUT', '/v1/admin/mail', {
        host: 'smtp.test',
        fromAddress: 'brain@example.com',
        fromName: '',
      })
      assert.equal(((await mail()).settings as { from: Json }).from.name, '')
      await w.callWeb(adminWeb, 'PUT', '/v1/admin/settings', { name: 'Renamed' })
      await w.callWeb(adminWeb, 'POST', '/v1/admin/mail/test', {})
      const m = w.mails.at(-1) as unknown as { from: { name: string } }
      assert.equal(m.from.name, 'Renamed')
      await w.callWeb(adminWeb, 'PUT', '/v1/admin/settings', { name: 'Test' })
    })

    it('skipped mail (not set up) is among the failures', async () => {
      await w.callWeb(adminWeb, 'DELETE', '/v1/admin/mail')
      await w.callWeb(adminWeb, 'POST', '/v1/invitations', { emails: ['skipped@example.com'] })
      const f = ((await mail()).failures as Json[])[0] as Json
      assert.deepEqual([f.status, f.to], ['skipped', 'skipped@example.com'])
      await w.setUpMail()
    })
  })

  describe('8: a send that fails is a short category, never the server’s words', () => {
    it('maps errors to categories', () => {
      const e = (message: string, code?: string) => Object.assign(new Error(message), code ? { code } : {})
      assert.equal(mailError(e('connect ECONNREFUSED 10.0.0.1:587', 'ECONNREFUSED')), 'connection refused')
      assert.equal(mailError(e('Connection timeout', 'ETIMEDOUT')), 'timeout')
      assert.equal(mailError(e('Greeting never received', 'ETIMEDOUT')), 'timeout')
      assert.equal(mailError(e('getaddrinfo ENOTFOUND smtp.x', 'EDNS')), 'server not found')
      assert.equal(mailError(e('self-signed certificate in chain', 'ESOCKET')), 'TLS')
      assert.equal(mailError(e('535 5.7.8 Authentication failed', 'EAUTH')), 'auth failed')
      assert.equal(mailError(e('550 relay not permitted: <evil banner>', 'EENVELOPE')), 'rejected')
      assert.equal(mailError(e('something odd <script>')), 'failed')
    })

    it('the log and the answer hold only the category', async () => {
      w.mailFails = true
      try {
        const r = await w.callWeb(adminWeb, 'POST', '/v1/admin/mail/test', {})
        assert.equal(r.body.error, 'connection refused')
      } finally {
        w.mailFails = false
      }
      const row = await w.db.one<{ error: string }>(
        "SELECT error FROM mail_log WHERE status = 'failed' ORDER BY id DESC LIMIT 1",
      )
      assert.equal(row?.error, 'connection refused')
    })
  })

  describe('3: a sealed secret opens only where it was sealed for', () => {
    it('v2 binds the purpose; another purpose does not open it; v1 still opens', () => {
      const s = seal(SECRET, 'the mail password', 'mail.password')
      assert.match(s, /^v2\./)
      assert.equal(unseal(SECRET, s, 'mail.password'), 'the mail password')
      assert.throws(() => unseal(SECRET, s, 'meaning.openai'))
      assert.throws(() => unseal(SECRET, s, 'account.totp'))
      // v1, sealed before purposes: opens for any of them (re-sealed as v2 on the next write).
      const v1 = sealV1(SECRET, 'old seed')
      assert.equal(unseal(SECRET, v1, 'account.totp'), 'old seed')
    })

    it('a mail password moved into the provider key column does not open as a key', async () => {
      await w.callWeb(adminWeb, 'PUT', '/v1/admin/mail', {
        host: 'smtp.test',
        fromAddress: 'brain@example.com',
        password: 'moved-around-0123456789xyz',
      })
      const row = await w.db.one<{ mail: { password: string } }>('SELECT mail FROM installation WHERE id = 1')
      await w.db.query('UPDATE meaning_settings SET openai_key = $1 WHERE id = 1', [row?.mail.password])
      await w.callWeb(adminWeb, 'PUT', '/v1/admin/meaning/providers/ollama', {
        url: 'http://localhost:11434',
      })
      const p = ((await meaning()).providers as Json[]).find((x) => x.name === 'openai') as Json
      assert.equal(p.unreadable, true)
      await w.db.query('UPDATE meaning_settings SET openai_key = NULL WHERE id = 1')
    })
  })

  describe('7: a body over the limit is not read further', () => {
    it('the answer comes once the limit is passed, without waiting for the rest of the body', async () => {
      const r = await rawRequest(w.base, {
        path: '/v1/admin/settings',
        cookie: adminWeb,
        length: 50_000_000,
        send: 1_100_000,
      })
      assert.equal(r.status, 413)
    })

    it('a declared length over the limit is refused before a byte of the body is read', async () => {
      const r = await rawRequest(w.base, {
        path: '/v1/admin/settings',
        cookie: adminWeb,
        length: 50_000_000,
        send: 10,
      })
      assert.equal(r.status, 413)
    })

    it('a body with no declared length is refused as soon as it passes the limit', async () => {
      const r = await rawRequest(w.base, {
        path: '/v1/admin/settings',
        cookie: adminWeb,
        length: 'chunked',
        send: 1_100_000,
      })
      assert.equal(r.status, 413)
    })

    it('the logo route refuses whoever is not the administration before reading its body', async () => {
      const r = await rawRequest(w.base, {
        path: '/v1/admin/branding/logo',
        cookie: anaWeb,
        length: 3_000_000,
        send: 10,
      })
      assert.equal(r.status, 403)
    })

    it('a logo request over 3 MiB is refused like any other', async () => {
      const r = await rawRequest(w.base, {
        path: '/v1/admin/branding/logo',
        cookie: adminWeb,
        length: 3_200_000,
        send: 3_200_000,
      })
      assert.equal(r.status, 413)
    })

    it('a logo request within 3 MiB still goes', async () => {
      const r = await w.callWeb(adminWeb, 'PUT', '/v1/admin/branding/logo', {
        contentType: 'image/png',
        data: png(10, 10, { pad: 1_500_000 }).toString('base64'),
      })
      assert.equal(r.status, 200, r.text.slice(0, 200))
    })

    it('a weak ETag matches too', async () => {
      const res = await fetch(`${w.base}/v1/branding/logo`)
      const etag = String(res.headers.get('etag'))
      await res.arrayBuffer()
      for (const h of [`W/${etag}`, `"x", ${etag}`, '*']) {
        const again = await fetch(`${w.base}/v1/branding/logo`, { headers: { 'if-none-match': h } })
        assert.equal(again.status, 304, h)
      }
    })
  })

  describe('9: the download is pinned to the view', () => {
    it('upTo leaves out what came after the first line shown; two downloads in a row are the same file', async () => {
      const view = (await w.callWeb(adminWeb, 'GET', '/v1/admin/audit')).body.items as Json[]
      const top = String(view[0]?.id)
      // Something happens after the view was read.
      await w.callWeb(adminWeb, 'PUT', '/v1/admin/settings', { rateLimit: 700 })
      const get = async () =>
        (
          await fetch(`${w.base}/v1/admin/audit/export?upTo=${top}`, {
            headers: { cookie: `rscb_session=${adminWeb}` },
          })
        ).text()
      const a = await get()
      const b = await get()
      assert.equal(a, b)
      const ids = a
        .trim()
        .split('\r\n')
        .slice(1)
        .map((l) => l.split(',')[0])
      assert.equal(ids[0], top)
      assert.equal(
        (
          await fetch(`${w.base}/v1/admin/audit/export?upTo=x1`, {
            headers: { cookie: `rscb_session=${adminWeb}` },
          })
        ).status,
        400,
      )
    })
  })

  describe('G14: the progress of meaning search', () => {
    it('is given while it is on', async () => {
      await w.callWeb(adminWeb, 'PUT', '/v1/admin/meaning/providers/ollama', {
        url: 'http://localhost:11434',
      })
      await w.callWeb(adminWeb, 'PUT', '/v1/admin/meaning', { provider: 'ollama', accept: true })
      const s = (await w.callWeb(adminWeb, 'GET', '/v1/admin/system')).body.meaning as Json
      assert.deepEqual([s.enabled, s.provider], [true, 'ollama'])
      assert.deepEqual(Object.keys(s.progress as Json).sort(), ['done', 'total'])
      await w.callWeb(adminWeb, 'DELETE', '/v1/admin/meaning')
    })
  })
})

// The format before purposes (v1), as it was written.
import { createCipheriv, randomBytes, scryptSync } from 'node:crypto'

function sealV1(secret: string, text: string): string {
  const key = scryptSync(secret, 'rsc-brain vault v1', 32)
  const iv = randomBytes(12)
  const c = createCipheriv('aes-256-gcm', key, iv)
  const body = Buffer.concat([c.update(text, 'utf8'), c.final()])
  return `v1.${iv.toString('base64url')}.${c.getAuthTag().toString('base64url')}.${body.toString('base64url')}`
}
