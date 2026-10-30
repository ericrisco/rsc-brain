// Spec B4 «Entrar»: password and code, the brake after five failures, sessions that last 14 days from
// their last use, signing out here or everywhere, resetting a password, the second factor.
import assert from 'node:assert/strict'
import { after, before, describe, it } from 'node:test'
import { hashPassword } from '../../src/auth/password.ts'
import { hashSecret, newSecret } from '../../src/auth/secrets.ts'
import { stepOf, totpAt } from '../../src/auth/totp.ts'
import { newReset } from '../../src/domain/login.ts'
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
    await w.db.query('DELETE FROM login_brakes')
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

  // Only the newest reset link of an account works: making another one (by hand or by email) and changing
  // the password both end every older link that was not used yet.
  it('a newer reset link, or a new password, ends every older unused link of that account', async () => {
    const dora = await w.person('Dora')
    await setPassword(dora.id)
    const adminWeb = await w.web(admin.id)
    const make = async () =>
      /token=([^&]+)$/.exec(
        String((await w.callWeb(adminWeb, 'POST', `/v1/admin/accounts/${dora.id}/reset-link`)).body.link),
      )?.[1] ?? ''
    const look = async (token: string) =>
      (await w.raw('POST', '/v1/auth/reset/look', { body: { token } })).status
    const confirm = (token: string, password: string) =>
      w.raw('POST', '/v1/auth/reset/confirm', { body: { token, password } })
    const first = await make()
    const second = await make()
    assert.equal(await look(first), 400, 'a newer link ends the older one')
    assert.equal(await look(second), 200)
    assert.equal((await confirm(first, 'first link long password')).status, 400)
    // A link by email ends the hand-made one too.
    const third = await make()
    w.mails.length = 0
    await w.setUpMail()
    await w.raw('POST', '/v1/auth/reset', { body: { email: await emailOf(dora.id) } })
    const mail = await w.mailTo(await emailOf(dora.id))
    assert.match(mail.text, /token=rscb_/)
    assert.equal(await look(third), 400, 'the mailed link ends the hand-made one')
    // A new password ends every link still waiting, even two that were alive together (a link made
    // before this rule, or two made at the same instant).
    const fourth = await make()
    const older = newSecret()
    await w.db.query(
      'INSERT INTO password_resets (token_hash, account_id, created_by, created_at, expires_at) VALUES ($1, $2, $3, $4, $5)',
      [hashSecret(older), dora.id, admin.id, w.clock(), new Date(w.clock().getTime() + 3_600_000)],
    )
    assert.equal(await look(older), 200)
    assert.equal((await confirm(fourth, 'second link long password')).status, 200)
    assert.equal(await look(older), 400, 'a new password ends the older link')
    assert.equal((await confirm(older, 'third link long password')).status, 400)
  })

  // An emailed request and a link made by hand at the same moment take turns on the same per-account
  // lock: whichever comes second ends the first, so exactly one link works.
  it('a link made by hand while an emailed one is being made: exactly one link works', async () => {
    const eve = await w.person('Eve')
    const adminWeb = await w.web(admin.id)
    let release = () => {}
    const gate = new Promise<void>((r) => {
      release = r
    })
    let made = () => {}
    const holding = new Promise<void>((r) => {
      made = r
    })
    // The emailed path, held between making its link and committing it.
    const emailed = w.db.tx(async (tx) => {
      await tx.query("SELECT pg_advisory_xact_lock(hashtext('rsc-brain reset ' || $1))", [eve.id])
      await newReset(tx, eve.id, null, w.clock())
      made()
      await gate
    })
    await holding
    const byHand = w.callWeb(adminWeb, 'POST', `/v1/admin/accounts/${eve.id}/reset-link`)
    await new Promise((r) => setTimeout(r, 300))
    release()
    await emailed
    assert.equal((await byHand).status, 201)
    const live = await w.db.one<{ n: number }>(
      'SELECT count(*)::int AS n FROM password_resets WHERE account_id = $1 AND used_at IS NULL',
      [eve.id],
    )
    assert.equal(live?.n, 1)
  })

  // Spec B6 «Reset»: the page checks the link when it opens, so a used or expired one says so before the
  // person types a new password. Checking does not spend the link and tells nothing about the account.
  it('a reset link can be checked without spending it, and says nothing about whose it is', async () => {
    const cora = await w.person('Cora')
    await setPassword(cora.id)
    const adminWeb = await w.web(admin.id)
    const make = async () =>
      /token=([^&]+)$/.exec(
        String((await w.callWeb(adminWeb, 'POST', `/v1/admin/accounts/${cora.id}/reset-link`)).body.link),
      )?.[1] ?? ''
    const look = (token: unknown) => w.raw('POST', '/v1/auth/reset/look', { body: { token } })
    const token = await make()
    const good = await look(token)
    assert.equal(good.status, 200, good.text)
    assert.deepEqual(good.body, { valid: true })
    assert.equal((await look(token)).status, 200, 'looking twice does not spend it')
    const used = await w.raw('POST', '/v1/auth/reset/confirm', {
      body: { token, password: 'a brand new long password' },
    })
    assert.equal(used.status, 200, used.text)
    for (const bad of [token, 'rscb_not_a_real_token', '', 42, undefined]) {
      const r = await look(bad)
      assert.deepEqual([r.status, r.body.error?.code], [400, 'link_invalid'], `${String(bad)}: ${r.text}`)
    }
    const late = await make()
    w.advance(61 * 60_000)
    assert.equal((await look(late)).body.error?.code, 'link_invalid')
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

  it('review: attempts sent at once cannot slip past the brake', async () => {
    const eve = await w.person('Eve')
    await setPassword(eve.id)
    const email = await emailOf(eve.id)
    const answers = await Promise.all([
      ...Array.from({ length: 30 }, () => login(email, 'a wrong guess here')),
      login(email, PW),
    ])
    const checked = await w.db.one<{ n: number }>(
      "SELECT count(*)::int AS n FROM audit WHERE action = 'auth.failed' AND actor_id = $1",
      [eve.id],
    )
    assert.ok((checked?.n ?? 99) <= 5, `${checked?.n} guesses were checked`)
    assert.ok(answers.filter((a) => a.status === 429).length >= 25)
  })

  it('review: the brake answers the same for an email with an account and one without', async () => {
    const fred = await w.person('Fred')
    await setPassword(fred.id)
    const real = await emailOf(fred.id)
    const seq = async (email: string) => {
      const out: number[] = []
      for (let i = 0; i < 6; i++) out.push((await login(email, 'a wrong guess here')).status)
      return out
    }
    assert.deepEqual(await seq('ghost@example.com'), await seq(real))
  })

  it('review: replacing a second factor needs its current code', async () => {
    const gus = await w.person('Gus')
    const web = await w.web(gus.id)
    const s1 = String((await w.callWeb(web, 'POST', '/v1/me/totp')).body.secret)
    await w.callWeb(web, 'POST', '/v1/me/totp/confirm', { code: totpAt(s1, stepOf(w.now)) })
    const swap = await w.callWeb(web, 'POST', '/v1/me/totp')
    assert.equal(swap.status, 400)
    w.advance(30_000)
    const ok = await w.callWeb(web, 'POST', '/v1/me/totp', { code: totpAt(s1, stepOf(w.now)) })
    assert.equal(ok.status, 200, ok.text)
  })

  it('review: wrong codes from the profile take turns at the same brake as signing in', async () => {
    const ida = await w.person('Ida')
    await setPassword(ida.id)
    const web = await w.web(ida.id)
    const s1 = String((await w.callWeb(web, 'POST', '/v1/me/totp')).body.secret)
    await w.callWeb(web, 'POST', '/v1/me/totp/confirm', { code: totpAt(s1, stepOf(w.now)) })
    w.advance(30_000)
    for (let i = 0; i < 3; i++) await w.callWeb(web, 'POST', '/v1/me/totp', { code: '000000' })
    for (let i = 0; i < 2; i++) await w.callWeb(web, 'DELETE', '/v1/me/totp', { code: '000000' })
    // A stolen session cannot keep guessing: even the right code now waits.
    const right = await w.callWeb(web, 'DELETE', '/v1/me/totp', { code: totpAt(s1, stepOf(w.now)) })
    assert.deepEqual([right.status, right.body.error?.code], [429, 'too_many_attempts'])
    const sign = await login(await emailOf(ida.id), PW, { code: totpAt(s1, stepOf(w.now)) })
    assert.equal(sign.status, 429)
  })

  it('review: a right password that is only asked for its code is not a failure', async () => {
    const jo = await w.person('Jo')
    await setPassword(jo.id)
    const web = await w.web(jo.id)
    const s1 = String((await w.callWeb(web, 'POST', '/v1/me/totp')).body.secret)
    await w.callWeb(web, 'POST', '/v1/me/totp/confirm', { code: totpAt(s1, stepOf(w.now)) })
    const email = await emailOf(jo.id)
    for (let i = 0; i < 3; i++) assert.equal((await login(email, PW)).body.error?.code, 'code_required')
    for (let i = 0; i < 2; i++) await login(email, PW, { code: '000000' })
    w.advance(30_000)
    const ok = await login(email, PW, { code: totpAt(s1, stepOf(w.now)) })
    assert.equal(ok.status, 200, ok.text)
  })

  it('review: behind the trusted proxy, its own last entry counts, not what the client wrote', async () => {
    const hal = await w.person('Hal')
    await setPassword(hal.id)
    const email = await emailOf(hal.id)
    const spoofed = await login(
      email,
      PW,
      {},
      { 'x-forwarded-for': '203.0.113.9, 198.51.100.4', 'x-forwarded-proto': 'https, http' },
    )
    assert.equal(spoofed.status, 403, 'the proxy saw http')
    const real = await login(
      email,
      PW,
      {},
      { 'x-forwarded-for': '203.0.113.9, 198.51.100.4', 'x-forwarded-proto': 'http, https' },
    )
    assert.equal(real.status, 200, real.text)
    const row = await w.db.one("SELECT detail FROM audit WHERE action = 'auth.signin' AND actor_id = $1", [
      hal.id,
    ])
    assert.equal(row?.detail, 'from 198.51.100.4')
  })
})
