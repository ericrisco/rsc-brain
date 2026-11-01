// B6 PR25b: the rest of the administration over v1. The settings of the installation (name, limit per key,
// the address of RSC Factory) saved field by field on what was read; mail with a password that is never
// given back; the key of a meaning provider, sealed and never given back; the health of the service (G14);
// the logo (G3) and its use on every screen and in every mail (G1, G2, G15); the download of the audit.
import assert from 'node:assert/strict'
import { after, before, describe, it } from 'node:test'
import { VERSION } from '../../src/core/version.ts'
import { csvCell } from '../../src/domain/auditlog.ts'
import { MAX_RATE_LIMIT, MIN_RATE_LIMIT } from '../../src/domain/installation.ts'
import { jpeg, png, SVG, webp } from '../helpers/images.ts'
import { skipPg } from '../helpers/pg.ts'
import { type World, world } from '../helpers/world.ts'

type Json = Record<string, unknown>
const b64 = (b: Buffer) => b.toString('base64')

describe('the administration of the installation (PR25b)', { skip: skipPg }, () => {
  let w: World
  let admin: { id: string; key: string }
  let other: { id: string; key: string }
  let ana: { id: string; key: string }
  let adminWeb: string
  let otherWeb: string
  let anaWeb: string

  before(async () => {
    w = await world()
    admin = await w.person('Admin', { isAdmin: true })
    other = await w.person('Other', { isAdmin: true })
    ana = await w.person('Ana')
    adminWeb = await w.web(admin.id)
    otherWeb = await w.web(other.id)
    anaWeb = await w.web(ana.id)
  })
  after(async () => w.close())

  describe('G4: the settings of the installation, field by field', () => {
    const get = async (s = adminWeb) => (await w.callWeb(s, 'GET', '/v1/admin/settings')).body
    const put = (body: Json, s = adminWeb) => w.callWeb(s, 'PUT', '/v1/admin/settings', body)

    it('gives the address of RSC Factory (none yet) and the bounds of the limit per key', async () => {
      const s = await get()
      assert.equal(s.factoryUrl, null)
      assert.equal(s.rateLimit, 600)
      assert.deepEqual(
        [s.rateLimitDefault, s.rateLimitMin, s.rateLimitMax],
        [600, MIN_RATE_LIMIT, MAX_RATE_LIMIT],
      )
    })

    it('takes an https address of Factory, or a local http one, and /v1/me gives it to everyone', async () => {
      for (const ok of ['https://factory.example.com', 'http://localhost:4000', 'http://127.0.0.1:4000/f']) {
        const r = await put({ factoryUrl: ok })
        assert.equal(r.status, 200, `${ok}: ${r.text}`)
        assert.equal(r.body.factoryUrl, ok)
      }
      await put({ factoryUrl: 'https://factory.example.com/' })
      assert.equal((await get()).factoryUrl, 'https://factory.example.com')
      const me = await w.call(ana.key, 'GET', '/v1/me')
      assert.deepEqual((me.body.installation as Json).factoryUrl, 'https://factory.example.com')
      const off = await put({ factoryUrl: null })
      assert.equal(off.body.factoryUrl, null)
      assert.equal(((await w.call(ana.key, 'GET', '/v1/me')).body.installation as Json).factoryUrl, null)
    })

    it('refuses an address that is not plain https (or local http), or that carries credentials, a query or a fragment', async () => {
      for (const bad of [
        'http://factory.example.com',
        'ftp://factory.example.com',
        'javascript:alert(1)',
        'https://user:pw@factory.example.com',
        'https://factory.example.com/#x',
        'https://factory.example.com/?a=1',
        'https://factory.example.com/$(rm)',
        'https://factory.example.com/a b',
        'factory.example.com',
        '',
        42,
        `https://f.example.com/${'a'.repeat(300)}`,
      ]) {
        const r = await put({ factoryUrl: bad })
        assert.equal(r.status, 400, `${String(bad)}: ${r.text}`)
        assert.equal(r.body.error?.code, 'invalid_request')
      }
      assert.equal((await get()).factoryUrl, null)
    })

    it('the limit per key stays between sensible bounds', async () => {
      for (const bad of [0, 1, MIN_RATE_LIMIT - 1, MAX_RATE_LIMIT + 1, 1.5, '600']) {
        const r = await put({ rateLimit: bad })
        assert.equal(r.status, 400, `${String(bad)}: ${r.text}`)
        assert.match(r.body.error?.message ?? '', new RegExp(`${MIN_RATE_LIMIT}.+${MAX_RATE_LIMIT}`))
      }
      for (const ok of [MIN_RATE_LIMIT, MAX_RATE_LIMIT, 600]) {
        assert.equal((await put({ rateLimit: ok })).body.rateLimit, ok)
      }
    })

    it('a save based on values someone changed since is refused with the values now, and changes nothing', async () => {
      const read = await get()
      await put({ base: { rateLimit: read.rateLimit }, rateLimit: 900 }, otherWeb)
      const r = await put({
        base: { rateLimit: read.rateLimit, name: read.name },
        rateLimit: 1200,
        name: 'Mine',
      })
      assert.equal(r.status, 409, r.text)
      assert.equal(r.body.error?.code, 'settings_changed')
      assert.equal(((r.body.error as unknown as Json).current as Json).rateLimit, 900)
      const now = await get()
      assert.deepEqual([now.rateLimit, now.name], [900, read.name])
      // Fields not in the base, nor sent, are not looked at: a save of the name alone passes.
      const name = await put({ base: { name: read.name }, name: 'Acme brain' })
      assert.equal(name.status, 200, name.text)
      assert.deepEqual([name.body.name, name.body.rateLimit], ['Acme brain', 900])
      await put({ rateLimit: 600, name: read.name })
    })

    it('nothing changed still asks: the same base gives «unchanged», a moved one gives 409', async () => {
      const read = await get()
      const same = await put({ base: { rateLimit: read.rateLimit, factoryUrl: read.factoryUrl } })
      assert.equal(same.status, 200, same.text)
      assert.equal(same.body.unchanged, true)
      await put({ factoryUrl: 'https://f.example.com' }, otherWeb)
      const moved = await put({ base: { rateLimit: read.rateLimit, factoryUrl: read.factoryUrl } })
      assert.deepEqual([moved.status, moved.body.error?.code], [409, 'settings_changed'])
      await put({ factoryUrl: null })
    })

    it('a base that is not an object of known fields is refused', async () => {
      for (const bad of [[], 'x', { colour: 'red' }]) {
        const r = await put({ base: bad, rateLimit: 600 })
        assert.equal(r.status, 400, `${JSON.stringify(bad)}: ${r.text}`)
      }
    })

    it('two administrators saving the same field on the same base: exactly one wins, every time', async () => {
      for (let round = 0; round < 25; round += 1) {
        const read = await get()
        const [a, b] = await Promise.all([
          put({ base: { rateLimit: read.rateLimit }, rateLimit: 1000 + round * 2 }),
          put({ base: { rateLimit: read.rateLimit }, rateLimit: 1001 + round * 2 }, otherWeb),
        ])
        assert.deepEqual([a.status, b.status].sort(), [200, 409], `round ${round}: ${a.text} ${b.text}`)
      }
      await put({ rateLimit: 600 })
    })

    it('only the administration reads or changes them', async () => {
      assert.equal((await w.callWeb(anaWeb, 'GET', '/v1/admin/settings')).status, 403)
      assert.equal((await put({ factoryUrl: 'https://evil.example.com' }, anaWeb)).status, 403)
    })
  })

  describe('mail: the password is never given back', () => {
    const mail = (s = adminWeb) => w.callWeb(s, 'GET', '/v1/admin/mail')
    const SMTP = {
      host: 'smtp.example.com',
      port: 587,
      secure: false,
      user: 'brain',
      fromName: 'Acme',
      fromAddress: 'brain@example.com',
    }

    it('after saving, says the password is set and its last 4 characters, never the password', async () => {
      const r = await w.callWeb(adminWeb, 'PUT', '/v1/admin/mail', { ...SMTP, password: 'smtp-pass-wxyz' })
      assert.equal(r.status, 200, r.text)
      assert.ok(!r.text.includes('smtp-pass-wxyz'))
      const s = (await mail()).body.settings as Json
      assert.deepEqual([s.hasPassword, s.passwordLast4], [true, 'wxyz'])
      assert.ok(!(await mail()).text.includes('smtp-pass'))
      // Stored sealed, not in clear.
      const row = await w.db.one<{ mail: Json }>('SELECT mail FROM installation WHERE id = 1')
      assert.ok(!JSON.stringify(row?.mail).includes('smtp-pass-wxyz'))
      // Nor in the audit.
      const audit = await w.db.query("SELECT detail FROM audit WHERE action = 'settings.mail'")
      assert.ok(audit.every((a) => !String(a.detail).includes('smtp-pass')))
    })

    it('a save without a password keeps the one set; an empty one removes it', async () => {
      await w.callWeb(adminWeb, 'PUT', '/v1/admin/mail', { ...SMTP, port: 2525 })
      assert.equal(((await mail()).body.settings as Json).passwordLast4, 'wxyz')
      await w.callWeb(adminWeb, 'PUT', '/v1/admin/mail', { ...SMTP, password: '' })
      const s = (await mail()).body.settings as Json
      assert.deepEqual([s.hasPassword, s.passwordLast4], [false, null])
    })

    it('a save based on settings someone changed since is refused, with what is there now, and changes nothing', async () => {
      await w.callWeb(adminWeb, 'PUT', '/v1/admin/mail', { ...SMTP, password: 'first-pass-1111' })
      const read = (await mail()).body.base as Json
      assert.equal(read.passwordLast4, '1111')
      await w.callWeb(otherWeb, 'PUT', '/v1/admin/mail', {
        ...SMTP,
        password: 'second-pass-2222',
        base: read,
      })
      const r = await w.callWeb(adminWeb, 'PUT', '/v1/admin/mail', {
        ...SMTP,
        host: 'smtp2.example.com',
        base: read,
      })
      assert.deepEqual([r.status, r.body.error?.code], [409, 'settings_changed'], r.text)
      assert.ok(!r.text.includes('second-pass'))
      const s = (await mail()).body.settings as Json
      assert.deepEqual([s.host, s.passwordLast4], ['smtp.example.com', '2222'])
      // The same base, nothing changed: «unchanged», nothing written.
      const now = (await mail()).body.base as Json
      const same = await w.callWeb(adminWeb, 'PUT', '/v1/admin/mail', { ...SMTP, base: now })
      assert.deepEqual([same.status, same.body.unchanged], [200, true], same.text)
    })

    it('the test mail goes to the administrator; a failure is shown among the recent failures, with the reason', async () => {
      const ok = await w.callWeb(adminWeb, 'POST', '/v1/admin/mail/test', {})
      assert.deepEqual(ok.body, { sent: true, error: null })
      assert.match((await w.mailTo('admin1@example.com', /Test mail/)).subject, /Test mail from Test/)
      w.mailFails = true
      try {
        const bad = await w.callWeb(adminWeb, 'POST', '/v1/admin/mail/test', {})
        assert.equal(bad.body.sent, false)
      } finally {
        w.mailFails = false
      }
      const failures = (await mail()).body.failures as Json[]
      assert.equal(failures[0]?.status, 'failed')
      assert.equal(failures[0]?.kind, 'test')
      assert.match(String(failures[0]?.error), /connection refused/)
      assert.ok(failures.every((f) => f.status !== 'sent'))
    })

    it('an error that would carry a secret is stored redacted', async () => {
      w.mailFails = true
      const real = w.mails.length
      try {
        // The test transport throws its own message; a server message is stored the same way.
        await w.db.query('DELETE FROM mail_log')
        const { send } = await import('../../src/mail/mail.ts')
        await send(
          w.db,
          w.clock,
          {
            secret: undefined,
            transport: () => ({
              send: async () => {
                throw new Error('535 auth failed for token sk-proj-ABCDEFGHIJKLMNOPQRSTUVWXYZ012345')
              },
            }),
          },
          'test',
          { to: 'x@example.com', subject: 's', text: 't' },
        )
      } finally {
        w.mailFails = false
      }
      assert.equal(w.mails.length, real)
      const f = ((await mail()).body.failures as Json[])[0]
      assert.ok(!String(f?.error).includes('ABCDEFGHIJKLMNOP'), String(f?.error))
    })

    it('only the administration sees or changes mail', async () => {
      assert.equal((await mail(anaWeb)).status, 403)
      assert.equal((await w.callWeb(anaWeb, 'POST', '/v1/admin/mail/test', {})).status, 403)
    })
  })

  describe('meaning search: the key of a provider, sealed and never given back', () => {
    const meaning = () => w.callWeb(adminWeb, 'GET', '/v1/admin/meaning')
    const KEY = 'sk-test-0123456789abcdefghij-k9Z2'

    it('lists the providers it knows, none with a key yet', async () => {
      const r = await meaning()
      assert.equal(r.status, 200, r.text)
      const ps = r.body.providers as Json[]
      assert.deepEqual(
        ps.map((p) => [p.name, p.needs, p.source]),
        [
          ['openai', 'key', null],
          ['ollama', 'url', null],
        ],
      )
      assert.deepEqual(r.body.available, [])
    })

    it('a key set in the web is sealed, said by its last 4 characters, and makes the provider available at once', async () => {
      const r = await w.callWeb(adminWeb, 'PUT', '/v1/admin/meaning/providers/openai', { key: KEY })
      assert.equal(r.status, 200, r.text)
      assert.ok(!r.text.includes(KEY))
      const back = await meaning()
      assert.ok(!back.text.includes(KEY))
      const openai = (back.body.providers as Json[]).find((p) => p.name === 'openai') as Json
      assert.deepEqual([openai.source, openai.last4], ['settings', 'k9Z2'])
      assert.deepEqual(back.body.available, ['openai'])
      const row = await w.db.one<Json>('SELECT * FROM meaning_settings WHERE id = 1')
      assert.ok(!JSON.stringify(row).includes(KEY))
      const audit = await w.db.query("SELECT detail FROM audit WHERE action LIKE 'meaning.%'")
      assert.ok(audit.every((a) => !String(a.detail).includes(KEY)))
    })

    it('an Ollama address is a plain http(s) address', async () => {
      const bad = await w.callWeb(adminWeb, 'PUT', '/v1/admin/meaning/providers/ollama', {
        url: 'file:///etc',
      })
      assert.equal(bad.status, 400, bad.text)
      const ok = await w.callWeb(adminWeb, 'PUT', '/v1/admin/meaning/providers/ollama', {
        url: 'http://localhost:11434',
      })
      assert.equal(ok.status, 200, ok.text)
      const o = (ok.body.providers as Json[]).find((p) => p.name === 'ollama') as Json
      assert.deepEqual([o.source, o.url], ['settings', 'http://localhost:11434'])
      assert.deepEqual(ok.body.available, ['openai', 'ollama'])
    })

    it('refuses a provider it does not know, and a key that is not one', async () => {
      assert.equal(
        (await w.callWeb(adminWeb, 'PUT', '/v1/admin/meaning/providers/acme', { key: KEY })).status,
        404,
      )
      for (const key of ['', 'short', 'has space in it 0123456789', 42]) {
        const r = await w.callWeb(adminWeb, 'PUT', '/v1/admin/meaning/providers/openai', { key })
        assert.equal(r.status, 400, `${String(key)}: ${r.text}`)
      }
    })

    it('the key of the provider in use cannot be removed while meaning search is on; once off, it can', async () => {
      const on = await w.callWeb(adminWeb, 'PUT', '/v1/admin/meaning', { provider: 'openai', accept: true })
      assert.equal(on.status, 200, on.text)
      const r = await w.callWeb(adminWeb, 'DELETE', '/v1/admin/meaning/providers/openai')
      assert.deepEqual([r.status, r.body.error?.code], [409, 'provider_in_use'], r.text)
      await w.callWeb(adminWeb, 'DELETE', '/v1/admin/meaning')
      const gone = await w.callWeb(adminWeb, 'DELETE', '/v1/admin/meaning/providers/openai')
      assert.equal(gone.status, 200, gone.text)
      assert.deepEqual(gone.body.available, ['ollama'])
      const row = await w.db.one<Json>('SELECT openai_key FROM meaning_settings WHERE id = 1')
      assert.equal(row?.openai_key, null)
    })

    it('only the administration, and only from the web', async () => {
      assert.equal(
        (await w.callWeb(anaWeb, 'PUT', '/v1/admin/meaning/providers/openai', { key: KEY })).status,
        403,
      )
      assert.equal(
        (await w.call(admin.key, 'PUT', '/v1/admin/meaning/providers/openai', { key: KEY })).status,
        403,
      )
    })
  })

  describe('G14: the health of the service', () => {
    it('gives the version, when it started, the database and its migration, meaning search, open streams and mail', async () => {
      const r = await w.callWeb(adminWeb, 'GET', '/v1/admin/system')
      assert.equal(r.status, 200, r.text)
      assert.equal(r.body.version, VERSION)
      assert.ok(!Number.isNaN(Date.parse(String(r.body.startedAt))))
      const db = r.body.database as Json
      assert.equal(db.ok, true)
      const last = await w.db.one<{ id: string }>('SELECT id FROM schema_migrations ORDER BY id DESC LIMIT 1')
      assert.equal(db.migration, last?.id)
      assert.deepEqual(Object.keys(r.body.meaning as Json).sort(), ['enabled', 'progress', 'provider'])
      assert.deepEqual(r.body.streams, { open: 0, max: 200 })
      assert.deepEqual(Object.keys(r.body.mail as Json).sort(), ['configured', 'lastFailureAt'])
    })

    it('only the administration', async () => {
      assert.equal((await w.callWeb(anaWeb, 'GET', '/v1/admin/system')).status, 403)
    })
  })

  describe('G3, G1, G2: the logo', () => {
    const upload = (contentType: string, data: Buffer, s = adminWeb) =>
      w.callWeb(s, 'PUT', '/v1/admin/branding/logo', { contentType, data: b64(data) })

    it('a PNG goes up; the branding gives its address, and the address serves it as an inert image', async () => {
      const img = png(64, 32)
      const r = await upload('image/png', img)
      assert.equal(r.status, 200, r.text)
      const logo = r.body.logo as { url: string; updatedAt: string }
      assert.match(logo.url, /^\/v1\/branding\/logo\?v=[0-9a-f]{12}$/)
      const b = await w.raw('GET', '/v1/branding')
      assert.deepEqual((b.body.logo as Json).url, logo.url)
      const res = await fetch(`${w.base}${logo.url}`)
      assert.equal(res.status, 200)
      assert.equal(res.headers.get('content-type'), 'image/png')
      assert.equal(res.headers.get('x-content-type-options'), 'nosniff')
      assert.match(String(res.headers.get('content-security-policy')), /sandbox/)
      assert.match(String(res.headers.get('content-security-policy')), /default-src 'none'/)
      const etag = String(res.headers.get('etag'))
      assert.match(etag, /^"[0-9a-f]{64}"$/)
      assert.deepEqual(Buffer.from(await res.arrayBuffer()), img)
      const again = await fetch(`${w.base}/v1/branding/logo`, { headers: { 'if-none-match': etag } })
      assert.equal(again.status, 304)
      assert.ok(await w.db.one("SELECT 1 FROM audit WHERE action = 'branding.logo'"))
    })

    it('a JPEG and a WebP go up too, typed by what the bytes are', async () => {
      assert.equal((await upload('image/jpeg', jpeg(300, 200))).status, 200)
      assert.equal((await fetch(`${w.base}/v1/branding/logo`)).headers.get('content-type'), 'image/jpeg')
      assert.equal((await upload('image/webp', webp(300, 200))).status, 200)
      assert.equal((await fetch(`${w.base}/v1/branding/logo`)).headers.get('content-type'), 'image/webp')
    })

    it('an SVG is refused (it can carry scripts), and so is anything that is not the image it says', async () => {
      for (const [type, data] of [
        ['image/svg+xml', SVG],
        ['image/png', SVG],
        ['image/png', jpeg(10, 10)],
        ['image/jpeg', png(10, 10)],
        ['text/html', Buffer.from('<html><script>alert(1)</script>')],
        ['image/png', Buffer.from([0x89, 0x50, 0x4e, 0x47])],
      ] as Array<[string, Buffer]>) {
        const r = await upload(type, data)
        assert.equal(r.status, 422, `${type}: ${r.text}`)
        assert.equal(r.body.error?.code, 'invalid_image')
      }
      assert.equal((await fetch(`${w.base}/v1/branding/logo`)).headers.get('content-type'), 'image/webp')
    })

    it('at most 4096 pixels a side, and 2 MB', async () => {
      const tall = await upload('image/png', png(10, 4097))
      assert.deepEqual([tall.status, tall.body.error?.code], [422, 'invalid_image'], tall.text)
      assert.equal((await upload('image/webp', webp(4097, 10))).status, 422)
      assert.equal((await upload('image/png', png(4096, 4096))).status, 200)
      const big = await upload('image/png', png(10, 10, { pad: 2 * 1024 * 1024 }))
      assert.deepEqual([big.status, big.body.error?.code], [413, 'image_too_large'], big.text)
    })

    it('its request may be bigger than other requests (3 MiB), and no bigger', async () => {
      const huge = await upload('image/png', png(10, 10, { pad: 2_500_000 }))
      assert.deepEqual([huge.status, huge.body.error?.code], [413, 'body_too_large'], huge.text)
      const other = await w.callWeb(adminWeb, 'PUT', '/v1/admin/settings', { name: 'x'.repeat(1_100_000) })
      assert.equal(other.status, 413)
    })

    it('only the administration changes it; removing it leaves the mark', async () => {
      assert.equal((await upload('image/png', png(5, 5), anaWeb)).status, 403)
      const del = await w.callWeb(adminWeb, 'DELETE', '/v1/admin/branding/logo')
      assert.deepEqual(del.body, { logo: null })
      assert.equal((await w.raw('GET', '/v1/branding')).body.logo, null)
      assert.equal((await fetch(`${w.base}/v1/branding/logo`)).status, 404)
    })
  })

  describe('G15: every mail carries the name and logo of the installation', () => {
    it('an invitation names the installation and holds its logo inline (cid:), never as an address', async () => {
      const img = png(20, 20)
      await w.callWeb(adminWeb, 'PUT', '/v1/admin/branding/logo', {
        contentType: 'image/png',
        data: b64(img),
      })
      await w.callWeb(adminWeb, 'PUT', '/v1/admin/settings', { name: 'Acme <Brain> & Co' })
      await w.setUpMail()
      const r = await w.callWeb(adminWeb, 'POST', '/v1/invitations', { emails: ['new@example.com'] })
      assert.equal(r.status, 201, r.text)
      const m = (await w.mailTo('new@example.com')) as Json
      assert.match(String(m.subject), /Acme <Brain> & Co/)
      assert.match(String(m.html), /Acme &lt;Brain&gt; &amp; Co/)
      assert.ok(!String(m.html).includes('<Brain>'))
      assert.match(String(m.html), /<img [^>]*src="cid:logo@rsc-brain"/)
      assert.ok(!/src="https?:/.test(String(m.html)))
      const att = (m.attachments as Array<Json>)[0] as Json
      assert.equal(att.cid, 'logo@rsc-brain')
      assert.equal(att.contentType, 'image/png')
      assert.deepEqual(Buffer.from(att.content as Buffer), img)
      // The link is in the html too, escaped.
      assert.match(String(m.html), /href="http:\/\/localhost\/invite#token=/)
    })

    it('without a logo, the mail still names the installation and attaches nothing', async () => {
      await w.callWeb(adminWeb, 'DELETE', '/v1/admin/branding/logo')
      await w.callWeb(adminWeb, 'POST', '/v1/invitations', { emails: ['plain@example.com'] })
      const m = (await w.mailTo('plain@example.com')) as Json
      assert.match(String(m.html), /Acme &lt;Brain&gt; &amp; Co/)
      assert.ok(!String(m.html).includes('cid:'))
      assert.equal((m.attachments as unknown[] | undefined)?.length ?? 0, 0)
      await w.callWeb(adminWeb, 'PUT', '/v1/admin/settings', { name: 'Test' })
    })
  })

  describe('the download of the audit', () => {
    it('no cell a spreadsheet would run, even after spaces or a line break', () => {
      for (const v of ['=1+1', '+1', '-1', '@SUM(A1)', '\t=1', '\r=1', ' =1', '  +1', '\n=1']) {
        const c = csvCell(v).replace(/^"/, '')
        assert.ok(c.startsWith("'"), `${JSON.stringify(v)} -> ${c}`)
      }
      assert.equal(csvCell('plain'), 'plain')
      assert.equal(csvCell('a "b", c'), '"a ""b"", c"')
      assert.equal(csvCell(null), '')
    })

    it('holds the same rows as the filtered view, in the same order', async () => {
      const evil = await w.person('=HYPERLINK("http://x")', { isAdmin: true })
      const evilWeb = await w.web(evil.id)
      await w.callWeb(evilWeb, 'PATCH', `/v1/admin/accounts/${ana.id}`, { canCreateBrains: false })
      await w.callWeb(evilWeb, 'PATCH', `/v1/admin/accounts/${ana.id}`, { canCreateBrains: true })
      const q = `action=account.&actor=${evil.id}`
      const res = await fetch(`${w.base}/v1/admin/audit/export?${q}`, {
        headers: { cookie: `rscb_session=${adminWeb}` },
      })
      const lines = (await res.text()).trim().split('\r\n').slice(1)
      assert.equal(lines.length, 2)
      assert.ok(
        lines.every((l) => l.includes(`,"'=HYPERLINK(""http://x"")"`)),
        lines.join('\n'),
      )
      const view = (await w.callWeb(adminWeb, 'GET', `/v1/admin/audit?${q}`)).body.items as Json[]
      assert.deepEqual(
        lines.map((l) => l.split(',')[0]),
        view.map((v) => v.id),
      )
    })
  })
})
