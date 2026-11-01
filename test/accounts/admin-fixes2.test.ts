// Second review of B6 PR25b: meaning search remembers where it agreed to send text (a fingerprint of the
// destination) and goes off when the live destination is another (an unreadable key falling back to the
// environment, an environment changed at restart); values sealed before purposes are sealed again at start;
// the vault takes a whole tag and exactly four parts; the mail password version never goes back; refusals
// before a body is read close the connection; mail errors are classified by code first; the download of an
// empty view is pinned to the newest line there was; a sender name set by the administration is used.
import assert from 'node:assert/strict'
import { createCipheriv, randomBytes, scryptSync } from 'node:crypto'
import { connect } from 'node:net'
import { after, before, describe, it } from 'node:test'
import { hashPassword } from '../../src/auth/password.ts'
import { resealV1 } from '../../src/auth/reseal.ts'
import { stepOf, totpAt } from '../../src/auth/totp.ts'
import { seal, unseal } from '../../src/auth/vault.ts'
import { mailError } from '../../src/mail/mail.ts'
import { applyStored } from '../../src/meaning/stored.ts'
import { fakeProvider } from '../helpers/meaning.ts'
import { skipPg } from '../helpers/pg.ts'
import { type World, world } from '../helpers/world.ts'

type Json = Record<string, unknown>
const SECRET = 'test-secret-of-at-least-thirty-two-characters'
const WEB = { 'x-requested-with': 'rsc-brain-web' }
const PW = 'correct horse battery staple'

function sealV1(secret: string, text: string): string {
  const key = scryptSync(secret, 'rsc-brain vault v1', 32)
  const iv = randomBytes(12)
  const c = createCipheriv('aes-256-gcm', key, iv)
  const body = Buffer.concat([c.update(text, 'utf8'), c.final()])
  return `v1.${iv.toString('base64url')}.${c.getAuthTag().toString('base64url')}.${body.toString('base64url')}`
}

// A request whose body keeps coming slowly: how the server answers, and whether it closes.
function trickle(
  base: string,
  path: string,
  cookie: string,
): Promise<{ status: string; closedMs: number | null; close: boolean }> {
  const u = new URL(base)
  return new Promise((resolve) => {
    const t0 = Date.now()
    let got = ''
    let tick: NodeJS.Timeout | undefined
    const s = connect(Number(u.port), u.hostname, () => {
      s.write(
        `PUT ${path} HTTP/1.1\r\nHost: ${u.host}\r\nContent-Type: application/json\r\nX-Requested-With: rsc-brain-web\r\nCookie: rscb_session=${cookie}\r\nContent-Length: 500000000\r\n\r\n`,
      )
      tick = setInterval(() => {
        if (!s.destroyed) s.write(Buffer.alloc(16384, 0x20))
      }, 5)
    })
    s.on('data', (d) => {
      got += d.toString('latin1')
    })
    s.on('error', () => {})
    const done = (closedMs: number | null) => {
      if (tick) clearInterval(tick)
      s.destroy()
      resolve({
        status: /HTTP\/1\.1 (\d{3})/.exec(got)?.[1] ?? '',
        closedMs,
        close: /connection: close/i.test(got),
      })
    }
    s.on('close', () => done(Date.now() - t0))
    setTimeout(() => done(null), 2000).unref()
  })
}

describe('vault: a whole tag, four parts', () => {
  it('a truncated tag or a fifth part does not open', () => {
    const s = seal(SECRET, 'x-secret', 'mail.password')
    const [v, iv, tag, body] = s.split('.') as [string, string, string, string]
    const short = Buffer.from(tag, 'base64url').subarray(0, 4).toString('base64url')
    assert.throws(() => unseal(SECRET, [v, iv, short, body].join('.'), 'mail.password'))
    assert.throws(() => unseal(SECRET, `${s}.junk`, 'mail.password'))
    assert.equal(unseal(SECRET, s, 'mail.password'), 'x-secret')
  })
})

describe('mail errors: the code first, then the words', () => {
  it('a host with "auth" in its name that cannot be found is not an authentication failure', () => {
    const e = Object.assign(new Error('getaddrinfo ENOTFOUND auth.mail.example.com'), { code: 'EDNS' })
    assert.equal(mailError(e), 'server not found')
    const t = Object.assign(new Error('timeout while authenticating'), { code: 'ETIMEDOUT' })
    assert.equal(mailError(t), 'timeout')
  })
})

describe('second review of PR25b', { skip: skipPg }, () => {
  let w: World
  let admin: { id: string; key: string }
  let adminWeb: string
  const envOpenai = fakeProvider('openai', 'env-model')
  const live = { openai: envOpenai } as Record<string, ReturnType<typeof fakeProvider>>

  before(async () => {
    w = await world({ meaning: live })
    admin = await w.person('Admin', { isAdmin: true })
    adminWeb = await w.web(admin.id)
  })
  after(async () => w.close())
  const meaning = async () => (await w.callWeb(adminWeb, 'GET', '/v1/admin/meaning')).body

  describe('S1: the destination agreed to is remembered', () => {
    it('a stored key that stops opening while on: the environment would get the text, so it goes off, and says why', async () => {
      await w.callWeb(adminWeb, 'PUT', '/v1/admin/meaning/providers/openai', {
        key: 'sk-web-key-0123456789abcd',
      })
      const on = await w.callWeb(adminWeb, 'PUT', '/v1/admin/meaning', { provider: 'openai', accept: true })
      assert.equal(on.body.enabled, true, on.text)
      await w.db.query('UPDATE meaning_settings SET openai_key = $1 WHERE id = 1', [
        seal('another-installation-secret-of-32-chars!', 'sk-lost', 'meaning.openai'),
      ])
      await applyStored(w.db, live, SECRET)
      const m = await meaning()
      assert.deepEqual([m.enabled, m.acceptedAt, m.acceptedBy], [false, null, null])
      assert.match(String(m.offReason), /changed/)
      const line = await w.db.one<{ detail: string }>(
        "SELECT detail FROM audit WHERE action = 'meaning.disable' ORDER BY id DESC LIMIT 1",
      )
      assert.match(String(line?.detail), /destination/)
      await w.db.query('UPDATE meaning_settings SET openai_key = NULL, openai_key_last4 = NULL WHERE id = 1')
      await applyStored(w.db, live, SECRET)
    })

    it('the environment changed at restart (another address): off; the same environment: still on', async () => {
      const first = { ollama: { ...fakeProvider('ollama', 'm'), url: 'http://gpu-a.internal:11434' } }
      const w2 = await world({ meaning: first })
      try {
        const a = await w2.person('A', { isAdmin: true })
        const web = await w2.web(a.id)
        const on = await w2.callWeb(web, 'PUT', '/v1/admin/meaning', { provider: 'ollama', accept: true })
        assert.equal(on.body.enabled, true, on.text)
        // Restarted with the same environment.
        await applyStored(
          w2.db,
          { ollama: { ...fakeProvider('ollama', 'm'), url: 'http://gpu-a.internal:11434' } },
          SECRET,
        )
        assert.equal((await w2.callWeb(web, 'GET', '/v1/admin/meaning')).body.enabled, true)
        // Restarted with another address in the environment.
        await applyStored(
          w2.db,
          { ollama: { ...fakeProvider('ollama', 'm'), url: 'https://embed.elsewhere.example' } },
          SECRET,
        )
        const m = (await w2.callWeb(web, 'GET', '/v1/admin/meaning')).body
        assert.deepEqual([m.enabled, m.acceptedAt], [false, null])
        // Turned on again, the reason is gone.
        await w2.callWeb(web, 'PUT', '/v1/admin/meaning', { provider: 'ollama', accept: true })
        assert.equal((await w2.callWeb(web, 'GET', '/v1/admin/meaning')).body.offReason, null)
      } finally {
        await w2.close()
      }
    })

    it('the fingerprint holds no key: a keyed hash of it, never the key itself', async () => {
      await w.callWeb(adminWeb, 'PUT', '/v1/admin/meaning/providers/openai', {
        key: 'sk-fingerprinted-0123456789',
      })
      await w.callWeb(adminWeb, 'PUT', '/v1/admin/meaning', { provider: 'openai', accept: true })
      const row = await w.db.one<{ destination: string }>(
        'SELECT destination FROM meaning_settings WHERE id = 1',
      )
      assert.match(String(row?.destination), /^openai:[0-9a-f]{32}$/)
      assert.ok(!String(row?.destination).includes('0123456789'))
      await w.callWeb(adminWeb, 'DELETE', '/v1/admin/meaning')
    })
  })

  describe('S2: values sealed before purposes are sealed again at start', () => {
    it('a v1 second-factor seed, the mail password and a provider key become v2, still open, and once only', async () => {
      const jo = await w.person('Jo')
      await w.db.query('UPDATE accounts SET password_hash = $2 WHERE id = $1', [
        jo.id,
        await hashPassword(PW),
      ])
      const web = await w.web(jo.id)
      const seed = String((await w.callWeb(web, 'POST', '/v1/me/totp')).body.secret)
      await w.callWeb(web, 'POST', '/v1/me/totp/confirm', { code: totpAt(seed, stepOf(w.now)) })
      await w.db.query('UPDATE accounts SET totp_secret = $2 WHERE id = $1', [jo.id, sealV1(SECRET, seed)])
      await w.db.query(`UPDATE installation SET mail = $1 WHERE id = 1`, [
        JSON.stringify({
          host: 'smtp.test',
          port: 587,
          secure: false,
          user: 'u',
          password: sealV1(SECRET, 'mail-pw'),
          from: { name: '', address: 'b@example.com' },
        }),
      ])
      await w.db.query('UPDATE meaning_settings SET openai_key = $1 WHERE id = 1', [
        sealV1(SECRET, 'sk-old-0123456789abcdefg'),
      ])
      const n = await resealV1(w.db, SECRET)
      assert.equal(n, 3)
      assert.equal(await resealV1(w.db, SECRET), 0)
      const acc = await w.db.one<{ totp_secret: string }>('SELECT totp_secret FROM accounts WHERE id = $1', [
        jo.id,
      ])
      assert.match(String(acc?.totp_secret), /^v2\./)
      assert.equal(unseal(SECRET, String(acc?.totp_secret), 'account.totp'), seed)
      const inst = await w.db.one<{ mail: { password: string } }>(
        'SELECT mail FROM installation WHERE id = 1',
      )
      assert.equal(unseal(SECRET, inst?.mail.password ?? '', 'mail.password'), 'mail-pw')
      const ms = await w.db.one<{ openai_key: string }>(
        'SELECT openai_key FROM meaning_settings WHERE id = 1',
      )
      assert.equal(unseal(SECRET, ms?.openai_key ?? '', 'meaning.openai'), 'sk-old-0123456789abcdefg')
      // And Jo still signs in with the code.
      const email = String((await w.db.one('SELECT email FROM accounts WHERE id = $1', [jo.id]))?.email)
      w.advance(60_000)
      const ok = await w.raw('POST', '/v1/auth/login', {
        headers: WEB,
        body: { email, password: PW, code: totpAt(seed, stepOf(w.now)) },
      })
      assert.equal(ok.status, 200, ok.text)
      await w.db.query('UPDATE meaning_settings SET openai_key = NULL WHERE id = 1')
    })

    it('a value sealed with another secret is left as it is', async () => {
      await w.db.query('UPDATE meaning_settings SET openai_key = $1 WHERE id = 1', [
        sealV1('another-secret-of-thirty-two-chars!!', 'x'),
      ])
      assert.equal(await resealV1(w.db, SECRET), 0)
      await w.db.query('UPDATE meaning_settings SET openai_key = NULL WHERE id = 1')
    })
  })

  describe('mail', () => {
    const SMTP = { host: 'smtp.test', port: 587, user: 'u', fromAddress: 'brain@example.com' }

    it('removing the mail settings does not take the password version back (no ABA)', async () => {
      await w.callWeb(adminWeb, 'PUT', '/v1/admin/mail', { ...SMTP, password: 'first-password' })
      const read = (await w.callWeb(adminWeb, 'GET', '/v1/admin/mail')).body.base as Json
      await w.callWeb(adminWeb, 'DELETE', '/v1/admin/mail')
      await w.callWeb(adminWeb, 'PUT', '/v1/admin/mail', { ...SMTP, password: 'another-password' })
      const r = await w.callWeb(adminWeb, 'PUT', '/v1/admin/mail', { ...SMTP, fromName: 'X', base: read })
      assert.deepEqual([r.status, r.body.error?.code], [409, 'settings_changed'], r.text)
    })

    it('a sender name the administration set is the one mail goes as', async () => {
      await w.callWeb(adminWeb, 'PUT', '/v1/admin/mail', { ...SMTP, fromName: 'Acme Mail' })
      await w.callWeb(adminWeb, 'POST', '/v1/admin/mail/test', {})
      const m = w.mails.at(-1) as unknown as { from: { name: string } }
      assert.equal(m.from.name, 'Acme Mail')
    })
  })

  describe('refusals before the body is read', () => {
    it('401, 403 and 404 close the connection instead of leaving a body half sent', async () => {
      const ana = await w.web((await w.person('Ana')).id)
      for (const [path, cookie, status] of [
        ['/v1/admin/settings', 'nope', '401'],
        ['/v1/admin/branding/logo', ana, '403'],
        ['/v1/nothing-here', adminWeb, '404'],
      ] as const) {
        const r = await trickle(w.base, path, cookie)
        assert.equal(r.status, status, path)
        assert.equal(r.close, true, `${path}: connection: close`)
        assert.ok(r.closedMs !== null && r.closedMs < 1500, `${path}: closed after ${r.closedMs} ms`)
      }
    })
  })

  describe('the download of an empty view', () => {
    it('is pinned to the newest line there was when the view was read', async () => {
      const page = (await w.callWeb(adminWeb, 'GET', '/v1/admin/audit?action=branding.')).body
      assert.deepEqual(page.items, [])
      const top = String(page.upTo)
      assert.match(top, /^\d+$/)
      await w.callWeb(adminWeb, 'DELETE', '/v1/admin/branding/logo')
      const csv = await (
        await fetch(`${w.base}/v1/admin/audit/export?action=branding.&upTo=${top}`, {
          headers: { cookie: `rscb_session=${adminWeb}` },
        })
      ).text()
      assert.equal(csv.trim().split('\r\n').length, 1, csv)
    })
  })
})
