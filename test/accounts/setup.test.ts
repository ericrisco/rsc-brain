// Spec B4 «Asistente de primera vez»: everything leads to the setup until it is done, then it is gone;
// it takes a password only over a safe connection; companion mode needs no setup.
import assert from 'node:assert/strict'
import { after, before, describe, it } from 'node:test'
import { bumpKeyEpoch, companionSetup } from '../../src/domain/installation.ts'
import { skipPg } from '../helpers/pg.ts'
import { type World, world } from '../helpers/world.ts'

const WEB = { 'x-requested-with': 'rsc-brain-web' }
const admin = { name: 'Eric', email: 'eric@example.com', password: 'a long enough password' }
const sessionOf = (h: Headers) => /rscb_session=([^;]+)/.exec(h.get('set-cookie') ?? '')?.[1] ?? ''

describe('first-time setup', { skip: skipPg }, () => {
  let w: World

  before(async () => {
    w = await world({ fresh: true })
  })
  after(async () => w.close())

  it('CA1: until it is done, every route answers "setup required"; health still answers', async () => {
    for (const [m, path] of [
      ['GET', '/v1/brains'],
      ['GET', '/v1/me'],
      ['POST', '/v1/auth/login'],
      ['GET', '/v1/search?q=x'],
    ] as const) {
      const r = await w.raw(m, path, { headers: WEB, ...(m === 'POST' ? { body: {} } : {}) })
      assert.deepEqual([r.status, r.body.error?.code], [503, 'setup_required'], path)
    }
    assert.equal((await w.raw('GET', '/v1/health')).status, 200)
    const state = await w.raw('GET', '/v1/setup')
    assert.deepEqual(
      [state.status, state.body.done, state.body.connection],
      [200, false, { encrypted: false, local: true }],
    )
  })

  it('an address with characters a shell would read is refused: it goes into commands people paste', async () => {
    for (const publicUrl of [
      'https://brain.example.com/x;touch$IFS$9pwned;',
      'https://brain.example.com/a|b',
      "https://brain.example.com/it's",
    ]) {
      const r = await w.raw('POST', '/v1/setup', {
        headers: WEB,
        body: { name: 'Risco Brain', publicUrl, admin },
      })
      assert.deepEqual([r.status, r.body.error?.code], [400, 'invalid_request'], publicUrl)
    }
    assert.equal((await w.raw('GET', '/v1/setup')).body.done, false)
  })

  it('CA2: a public address without encryption is warned about; a password over it is refused', async () => {
    const warn = await w.raw('GET', '/v1/setup?publicUrl=http%3A%2F%2Fbrain.example.com')
    assert.match(String(warn.body.warning), /not encrypted.*HTTPS.*local address.*tunnel/s)
    assert.equal(
      (await w.raw('GET', '/v1/setup?publicUrl=https%3A%2F%2Fbrain.example.com')).body.warning,
      null,
    )
    assert.equal((await w.raw('GET', '/v1/setup?publicUrl=http%3A%2F%2Flocalhost%3A8090')).body.warning, null)
    // From elsewhere, through the trusted proxy, over plain http: no password accepted.
    const viaHttp = await w.raw('POST', '/v1/setup', {
      headers: { ...WEB, 'x-forwarded-for': '203.0.113.7', 'x-forwarded-proto': 'http' },
      body: { name: 'Risco Brain', publicUrl: 'http://brain.example.com', admin },
    })
    assert.deepEqual([viaHttp.status, viaHttp.body.error?.code], [403, 'insecure_connection'])
    // A proxy Brain does not trust: not local, not encrypted.
    const untrusted = await w.raw('POST', '/v1/setup', {
      headers: { ...WEB, forwarded: 'for=203.0.113.7;proto=https' },
      body: { name: 'Risco Brain', publicUrl: 'https://brain.example.com', admin },
    })
    assert.equal(untrusted.status, 403)
    // Without the header of the web, a form on another site cannot run it.
    const csrf = await w.raw('POST', '/v1/setup', {
      body: { name: 'X', publicUrl: 'http://localhost', admin },
    })
    assert.deepEqual([csrf.status, csrf.body.error?.code], [403, 'csrf'])
  })

  it('CA1: the setup makes the administration, signs it in, and is then gone', async () => {
    // An address that grows past the limit once normalised is refused, not a 500.
    const long = await w.raw('POST', '/v1/setup', {
      headers: WEB,
      body: { name: 'Risco Brain', publicUrl: `https://brain.example.com/${'é'.repeat(100)}`, admin },
    })
    assert.equal(long.status, 400, long.text)
    const notText = await w.raw('POST', '/v1/setup', {
      headers: WEB,
      body: { name: 'Risco Brain', publicUrl: 'http://localhost', admin: { ...admin, name: {} } },
    })
    assert.equal(notText.status, 400)
    const weak = await w.raw('POST', '/v1/setup', {
      headers: WEB,
      body: {
        name: 'Risco Brain',
        publicUrl: 'http://localhost:8090',
        admin: { ...admin, password: 'short' },
      },
    })
    assert.equal(weak.status, 400)
    const r = await w.raw('POST', '/v1/setup', {
      headers: { ...WEB, 'x-forwarded-for': '203.0.113.7', 'x-forwarded-proto': 'https' },
      body: { name: 'Risco Brain', publicUrl: 'https://brain.example.com/', admin },
    })
    assert.equal(r.status, 201, r.text)
    assert.equal(r.body.publicUrl, 'https://brain.example.com')
    const cookie = r.headers.get('set-cookie') ?? ''
    assert.match(cookie, /HttpOnly; SameSite=Lax; Max-Age=1209600; Secure/)
    const me = await w.raw('GET', '/v1/me', { headers: { cookie: `rscb_session=${sessionOf(r.headers)}` } })
    assert.deepEqual([me.status, (me.body.account as { isAdmin: boolean }).isAdmin], [200, true])
    assert.equal((await w.raw('GET', '/v1/setup')).status, 404)
    const again = await w.raw('POST', '/v1/setup', {
      headers: WEB,
      body: { name: 'Other', publicUrl: 'http://localhost', admin },
    })
    assert.deepEqual([again.status, again.body.error?.code], [404, 'setup_done'])
    // Signing in works now; the setup gate is open.
    const login = await w.raw('POST', '/v1/auth/login', {
      headers: WEB,
      body: { email: admin.email, password: admin.password },
    })
    assert.equal(login.status, 200, login.text)
  })
})

describe('companion mode and the key epoch', { skip: skipPg }, () => {
  let w: World
  before(async () => {
    w = await world({ fresh: true })
  })
  after(async () => w.close())

  it('CA24: installed by Factory, no setup; the admin signs in and Factory has its service account', async () => {
    const out = await companionSetup(w.db, w.clock, {
      name: 'Risco Brain',
      publicUrl: 'http://localhost:8090',
      admin: { name: 'Eric', email: 'eric@example.com', password: 'a long enough password' },
      serviceName: 'RSC Factory',
    })
    assert.equal((await w.raw('GET', '/v1/setup')).status, 404)
    const login = await w.raw('POST', '/v1/auth/login', {
      headers: WEB,
      body: { email: 'eric@example.com', password: 'a long enough password' },
    })
    assert.equal(login.status, 200, login.text)
    const me = await w.call(out.serviceKey, 'GET', '/v1/me')
    assert.deepEqual(
      [me.status, me.body.account],
      [200, { ...(me.body.account as object), kind: 'service', name: 'RSC Factory' }],
    )
    await assert.rejects(
      companionSetup(w.db, w.clock, {
        name: 'Again',
        publicUrl: 'http://localhost',
        admin: { name: 'X', email: 'x@example.com', password: 'a long enough password' },
      }),
      /already set up/,
    )
  })

  it('CA33: moving the key epoch (a restore) invalidates every key, session and service key made before', async () => {
    const eric = await w.person('Ana')
    const svc = await w.service('Other')
    const web = await w.web(eric.id)
    await bumpKeyEpoch(w.db)
    for (const r of [
      await w.call(eric.key, 'GET', '/v1/me'),
      await w.call(svc.key, 'GET', '/v1/me'),
      await w.callWeb(web, 'GET', '/v1/me'),
    ]) {
      assert.deepEqual([r.status, r.body.error?.code], [401, 'key_invalidated'])
    }
    // What is made after works.
    assert.equal((await w.call(await w.token(eric.id), 'GET', '/v1/me')).status, 200)
  })
})
