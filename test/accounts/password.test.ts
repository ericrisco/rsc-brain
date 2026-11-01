// Spec B6 «Profile» and plan §3.5 G6: POST /v1/me/password changes a person's password from the web. It
// needs the current password, follows the rules of B4 (12 to 200 characters), takes its turn at the same
// brake as signing in, ends every pending reset link, and signs the person out of every other web session
// (this one stays). Only a web session may do it: an agent's key never changes a password.
import assert from 'node:assert/strict'
import { after, before, describe, it } from 'node:test'
import { hashPassword } from '../../src/auth/password.ts'
import { stepOf, totpAt } from '../../src/auth/totp.ts'
import { BRAKE, newReset } from '../../src/domain/login.ts'
import { skipPg } from '../helpers/pg.ts'
import { type World, world } from '../helpers/world.ts'

const WEB = { 'x-requested-with': 'rsc-brain-web' }
const PW = 'correct horse battery staple'
const NEXT = 'a much longer passphrase now'

describe('changing a password from the profile (G6)', { skip: skipPg }, () => {
  let w: World
  before(async () => {
    w = await world()
  })
  after(async () => w.close())

  const person = async (name: string) => {
    const p = await w.person(name)
    await w.db.query('UPDATE accounts SET password_hash = $2 WHERE id = $1', [p.id, await hashPassword(PW)])
    const email = String((await w.db.one('SELECT email FROM accounts WHERE id = $1', [p.id]))?.email)
    return { ...p, email }
  }
  const login = (email: string, password: string) =>
    w.raw('POST', '/v1/auth/login', { headers: WEB, body: { email, password } })
  const change = (session: string, body: unknown) => w.callWeb(session, 'POST', '/v1/me/password', body)

  it('changes it: 204, the new one signs in, the old one does not', async () => {
    const p = await person('Pia')
    const here = await w.web(p.id)
    const r = await change(here, { current: PW, next: NEXT })
    assert.equal(r.status, 204, r.text)
    assert.equal(r.text, '')
    assert.equal((await login(p.email, PW)).status, 401)
    assert.equal((await login(p.email, NEXT)).status, 200)
    const audit = await w.db.one(
      "SELECT 1 FROM audit WHERE action = 'auth.password_change' AND actor_id = $1",
      [p.id],
    )
    assert.ok(audit, 'the change is audited')
  })

  it('signs out every other web session of the person, keeps this one, and leaves tokens alone', async () => {
    const p = await person('Oto')
    const here = await w.web(p.id)
    const there = await w.web(p.id)
    const other = await person('Una')
    const hers = await w.web(other.id)
    assert.equal((await change(here, { current: PW, next: NEXT })).status, 204)
    assert.equal((await w.callWeb(here, 'GET', '/v1/me')).status, 200, 'this session stays')
    assert.equal((await w.callWeb(there, 'GET', '/v1/me')).status, 401, 'the other session ended')
    assert.equal((await w.callWeb(hers, 'GET', '/v1/me')).status, 200, "someone else's session stays")
    assert.equal((await w.call(p.key, 'GET', '/v1/me')).status, 200, 'a token is not a web session')
  })

  it('ends every pending reset link of the account (endResets)', async () => {
    const p = await person('Rui')
    const token = await newReset(w.db, p.id, null, w.clock())
    const look = await w.raw('POST', '/v1/auth/reset/look', { body: { token } })
    assert.equal(look.status, 200, look.text)
    assert.equal((await change(await w.web(p.id), { current: PW, next: NEXT })).status, 204)
    const after = await w.raw('POST', '/v1/auth/reset/look', { body: { token } })
    assert.deepEqual([after.status, after.body.error?.code], [400, 'link_invalid'])
  })

  it('refuses a wrong current password without changing anything, and a new one out of the rules', async () => {
    const p = await person('Sol')
    const here = await w.web(p.id)
    const wrong = await change(here, { current: 'not the current one', next: NEXT })
    assert.deepEqual([wrong.status, wrong.body.error?.code], [400, 'wrong_password'], wrong.text)
    assert.match(String(wrong.body.error?.howToProceed), /reset/i)
    const short = await change(here, { current: PW, next: 'short' })
    assert.deepEqual([short.status, short.body.error?.code], [400, 'invalid_request'], short.text)
    assert.match(String(short.body.error?.message), /12 to 200/)
    const missing = await change(here, { next: NEXT })
    assert.equal(missing.status, 400)
    assert.equal((await login(p.email, PW)).status, 200, 'the password did not change')
    assert.equal((await w.callWeb(here, 'GET', '/v1/me')).status, 200, 'a refusal does not sign out')
  })

  it('takes its turn at the brake of signing in: after five wrong ones it waits, even with the right one', async () => {
    const p = await person('Teo')
    const here = await w.web(p.id)
    for (let i = 0; i < BRAKE.after; i++) {
      const r = await change(here, { current: `wrong guess number ${i}`, next: NEXT })
      assert.ok([400, 429].includes(r.status), r.text)
    }
    const held = await change(here, { current: PW, next: NEXT })
    assert.deepEqual([held.status, held.body.error?.code], [429, 'too_many_attempts'], held.text)
    // Signing in with the same email waits too: it is one brake.
    assert.equal((await login(p.email, PW)).status, 429)
    w.advance(BRAKE.firstS * 1000 + 1000)
    assert.equal((await change(here, { current: PW, next: NEXT })).status, 204)
    // The right password clears the brake.
    assert.equal((await login(p.email, NEXT)).status, 200)
  })

  it('the attempt that starts the wait says so: the fifth wrong current password is 429, not 400', async () => {
    const p = await person('Wes')
    const here = await w.web(p.id)
    const got: number[] = []
    for (let i = 0; i < BRAKE.after; i++)
      got.push((await change(here, { current: `wrong guess number ${i}`, next: NEXT })).status)
    assert.deepEqual(got, [400, 400, 400, 400, 429])
    // Outside sign-in, the wait does not send the person to reset a password they are signed in with.
    const held = await change(here, { current: PW, next: NEXT })
    assert.doesNotMatch(String(held.body.error?.howToProceed), /reset/i)
  })

  it('with a second factor on, it needs a right code too; a wrong one counts at the brake', async () => {
    const p = await person('Zoe')
    const here = await w.web(p.id)
    const seed = String((await w.callWeb(here, 'POST', '/v1/me/totp')).body.secret)
    await w.callWeb(here, 'POST', '/v1/me/totp/confirm', { code: totpAt(seed, stepOf(w.now)) })
    w.advance(30_000)
    const none = await change(here, { current: PW, next: NEXT })
    assert.deepEqual([none.status, none.body.error?.code], [400, 'invalid_request'], none.text)
    assert.match(String(none.body.error?.message), /code/i)
    const wrong = await change(here, { current: PW, next: NEXT, code: '000000' })
    assert.deepEqual([wrong.status, wrong.body.error?.code], [400, 'invalid_request'], wrong.text)
    const brake = await w.db.one<{ failures: number }>('SELECT failures FROM login_brakes WHERE email = $1', [
      p.email,
    ])
    assert.ok((brake?.failures ?? 0) >= 2, 'the missing and the wrong code took their turns')
    assert.equal((await login(p.email, NEXT)).status, 401, 'nothing changed')
    const ok = await change(here, { current: PW, next: NEXT, code: totpAt(seed, stepOf(w.now)) })
    assert.equal(ok.status, 204, ok.text)
    // The same code never works twice.
    const again = await change(here, { current: NEXT, next: PW, code: totpAt(seed, stepOf(w.now)) })
    assert.equal(again.status, 400, again.text)
  })

  it('only in the web: a token, or a web request without its header, cannot change a password', async () => {
    const p = await person('Vic')
    const byToken = await w.call(p.key, 'POST', '/v1/me/password', { current: PW, next: NEXT })
    assert.deepEqual([byToken.status, byToken.body.error?.code], [403, 'web_only'], byToken.text)
    const noHeader = await w.callWeb(
      await w.web(p.id),
      'POST',
      '/v1/me/password',
      { current: PW, next: NEXT },
      { csrf: false },
    )
    assert.deepEqual([noHeader.status, noHeader.body.error?.code], [403, 'csrf'])
    assert.equal((await login(p.email, PW)).status, 200, 'the password did not change')
  })
})
