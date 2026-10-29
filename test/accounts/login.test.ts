// Spec B4 «Entrar»: password and code, the brake after five failures, sessions that last 14 days from
// their last use, signing out here or everywhere, resetting a password, the second factor.
import assert from 'node:assert/strict'
import { after, before, describe, it } from 'node:test'
import { hashPassword } from '../../src/auth/password.ts'
import { stepOf, totpAt } from '../../src/auth/totp.ts'
import { skipPg } from '../helpers/pg.ts'
import { type World, world } from '../helpers/world.ts'

const WEB = { 'x-requested-with': 'rsc-brain-web' }
const PW = 'correct horse battery staple'
const sessionOf = (h: Headers) => /rscb_session=([^;]+)/.exec(h.get('set-cookie') ?? '')?.[1] ?? ''

describe('signing in', { skip: skipPg }, () => {
  let w: World
  let ana: { id: string; key: string }
  let admin: { id: string; key: string }

  const login = (email: string, password: string, extra: Record<string, unknown> = {}, headers = {}) =>
    w.raw('POST', '/v1/auth/login', { headers: { ...WEB, ...headers }, body: { email, password, ...extra } })
  const setPassword = async (id: string, pw = PW) =>
    w.db.query('UPDATE accounts SET password_hash = $2 WHERE id = $1', [id, await hashPassword(pw)])
  const emailOf = async (id: string) =>
    String((await w.db.one('SELECT email FROM accounts WHERE id = $1', [id]))?.email)

  before(async () => {
    w = await world()
    ana = await w.person('Ana')
    admin = await w.person('Admin', { isAdmin: true })
    await setPassword(ana.id)
    await setPassword(admin.id)
  })
  after(async () => w.close())

  it('signs in with email and password; a wrong one says nothing about which part was wrong', async () => {
    const ok = await login((await emailOf(ana.id)).toUpperCase(), PW)
    assert.equal(ok.status, 200, ok.text)
    assert.ok(sessionOf(ok.headers))
    const wrongPw = await login(await emailOf(ana.id), 'not the password at all')
    const noAccount = await login('nobody@example.com', PW)
    assert.deepEqual([wrongPw.status, wrongPw.body.error?.code], [401, 'bad_credentials'])
    assert.deepEqual([noAccount.status, noAccount.body.error?.message], [401, wrongPw.body.error?.message])
    // From elsewhere over plain http: no.
    const insecure = await login(
      await emailOf(ana.id),
      PW,
      {},
      { 'x-forwarded-for': '198.51.100.4', 'x-forwarded-proto': 'http' },
    )
    assert.equal(insecure.status, 403)
    // Without the web's header: no (a form on another site).
    const csrf = await w.raw('POST', '/v1/auth/login', {
      body: { email: await emailOf(ana.id), password: PW },
    })
    assert.equal(csrf.status, 403)
    await w.db.query('UPDATE accounts SET failed_logins = 0, locked_until = NULL WHERE id = $1', [ana.id])
  })

  it('CA21: after five failures in a row the sixth is refused until the wait, and says when', async () => {
    const bob = await w.person('Bob')
    await setPassword(bob.id)
    const email = await emailOf(bob.id)
    for (let i = 0; i < 4; i++) assert.equal((await login(email, 'wrong password number')).status, 401)
    const fifth = await login(email, 'wrong password number')
    assert.equal(fifth.status, 429)
    const sixth = await login(email, PW)
    assert.deepEqual([sixth.status, sixth.body.error?.code], [429, 'too_many_attempts'])
    assert.match(String(sixth.body.error?.message), /Try again in \d+ seconds \(at \d\d:\d\d:\d\d UTC\)/)
    assert.equal(
      sixth.headers.get('retry-after'),
      String((sixth.body.error as unknown as { retryAfter: number }).retryAfter),
    )
    w.advance(61_000)
    assert.equal((await login(email, PW)).status, 200)
    // A success starts the count again.
    assert.equal((await login(email, 'wrong password number')).status, 401)
  })

  it('a session lasts 14 days from its last use; sign out ends it; sign out everywhere ends them all', async () => {
    const one = sessionOf((await login(await emailOf(ana.id), PW)).headers)
    const two = sessionOf((await login(await emailOf(ana.id), PW)).headers)
    const me = (s: string) => w.callWeb(s, 'GET', '/v1/me')
    w.advance(13 * 86_400_000)
    assert.equal((await me(one)).status, 200)
    w.advance(13 * 86_400_000)
    assert.equal((await me(one)).status, 200, 'used within 14 days, still alive')
    assert.equal((await me(two)).status, 401, 'unused for 26 days')
    const out = await w.callWeb(one, 'POST', '/v1/auth/logout')
    assert.equal(out.status, 200)
    assert.equal((await me(one)).status, 401)
    const a = sessionOf((await login(await emailOf(ana.id), PW)).headers)
    const b = sessionOf((await login(await emailOf(ana.id), PW)).headers)
    const all = await w.callWeb(a, 'POST', '/v1/auth/logout-everywhere')
    assert.equal(all.body.signedOut, 2)
    assert.equal((await me(b)).status, 401)
    // A key cannot sign out a web session.
    assert.equal((await w.call(ana.key, 'POST', '/v1/auth/logout')).status, 403)
  })

  it('CA22 (by hand): the administration makes a single-use reset link that lasts an hour', async () => {
    const carl = await w.person('Carl')
    await setPassword(carl.id)
    const adminWeb = await w.web(admin.id)
    assert.equal(
      (await w.callWeb(await w.web(ana.id), 'POST', `/v1/admin/accounts/${carl.id}/reset-link`)).status,
      403,
    )
    const r = await w.callWeb(adminWeb, 'POST', `/v1/admin/accounts/${carl.id}/reset-link`)
    assert.equal(r.status, 201, r.text)
    const token = /token=([^&]+)$/.exec(String(r.body.link))?.[1] ?? ''
    assert.match(String(r.body.link), /^http:\/\/localhost\/reset#token=rscb_/)
    const sessions = sessionOf((await login(await emailOf(carl.id), PW)).headers)
    const weak = await w.raw('POST', '/v1/auth/reset/confirm', { body: { token, password: 'short' } })
    assert.equal(weak.status, 400)
    const ok = await w.raw('POST', '/v1/auth/reset/confirm', {
      body: { token, password: 'a brand new long password' },
    })
    assert.equal(ok.status, 200, ok.text)
    assert.equal(
      (await w.raw('POST', '/v1/auth/reset/confirm', { body: { token, password: 'another long password' } }))
        .body.error?.code,
      'link_invalid',
    )
    assert.equal((await w.callWeb(sessions, 'GET', '/v1/me')).status, 401, 'the old sessions ended')
    assert.equal((await login(await emailOf(carl.id), 'a brand new long password')).status, 200)
    const late = await w.callWeb(adminWeb, 'POST', `/v1/admin/accounts/${carl.id}/reset-link`)
    const lateToken = /token=([^&]+)$/.exec(String(late.body.link))?.[1] ?? ''
    w.advance(61 * 60_000)
    assert.equal(
      (
        await w.raw('POST', '/v1/auth/reset/confirm', {
          body: { token: lateToken, password: 'too late long password' },
        })
      ).status,
      400,
    )
    // Asking for a reset answers the same for any email.
    const a = await w.raw('POST', '/v1/auth/reset', { body: { email: await emailOf(carl.id) } })
    const b = await w.raw('POST', '/v1/auth/reset', { body: { email: 'nobody@example.com' } })
    assert.deepEqual([a.status, a.body], [b.status, b.body])
  })

  it('second factor: set up with a first code, then asked at sign-in, a code works once', async () => {
    const dana = await w.person('Dana')
    await setPassword(dana.id)
    const web = await w.web(dana.id)
    const start = await w.callWeb(web, 'POST', '/v1/me/totp')
    assert.equal(start.status, 200, start.text)
    const secret = String(start.body.secret)
    assert.match(String(start.body.otpauthUrl), /^otpauth:\/\/totp\/.*secret=/)
    assert.equal((await w.callWeb(web, 'POST', '/v1/me/totp/confirm', { code: '000000' })).status, 400)
    const first = totpAt(secret, stepOf(w.now))
    assert.equal((await w.callWeb(web, 'POST', '/v1/me/totp/confirm', { code: first })).status, 200)
    const email = await emailOf(dana.id)
    const noCode = await login(email, PW)
    assert.deepEqual([noCode.status, noCode.body.error?.code], [401, 'code_required'])
    // The code that confirmed it is used up.
    assert.equal((await login(email, PW, { code: first })).body.error?.code, 'bad_code')
    w.advance(30_000)
    const next = totpAt(secret, stepOf(w.now))
    assert.equal((await login(email, PW, { code: next })).status, 200)
    assert.equal((await login(email, PW, { code: next })).body.error?.code, 'bad_code', 'not twice')
    // A key cannot turn it off; the administration can reset it.
    assert.equal((await w.call(dana.key, 'DELETE', '/v1/me/totp', { code: next })).status, 403)
    const reset = await w.callWeb(await w.web(admin.id), 'DELETE', `/v1/admin/accounts/${dana.id}/totp`)
    assert.equal(reset.status, 200, reset.text)
    assert.equal((await login(email, PW)).status, 200)
    // The seed is sealed in the database, never in clear.
    const row = await w.db.one('SELECT totp_secret, totp_pending FROM accounts WHERE id = $1', [dana.id])
    assert.equal(row?.totp_secret, null)
    await w.callWeb(web, 'POST', '/v1/me/totp')
    const sealed = String(
      (await w.db.one('SELECT totp_pending FROM accounts WHERE id = $1', [dana.id]))?.totp_pending,
    )
    assert.ok(sealed.startsWith('v1.') && !sealed.includes(secret))
  })
})
