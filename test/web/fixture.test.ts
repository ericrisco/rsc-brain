// Plan §3.6 and §5.1 (T006): the browser tests in CI run against a fixture of the API, not against
// PostgreSQL. A fixture that drifts from the server would let CI pass with the web broken (plan risk 2),
// so every answer it gives must fit the description of v1 that the server generates from its own route
// table — the same description a program reads at /v1/openapi.json. The data it serves comes from a
// seeded generator: the same seed gives the same wiki, for the fixture and for the real server.
import assert from 'node:assert/strict'
import { after, before, describe, it } from 'node:test'
import { ROUTES } from '../../src/http/app.ts'
import { openapi } from '../../src/http/openapi.ts'
import { generate } from '../../web/test/data/generate.ts'
import { type Fixture, startFixture } from './fixture/fixture.ts'
import { validate } from './fixture/schema.ts'

const doc = openapi(ROUTES, 'http://localhost')

describe('the seeded data', () => {
  for (const pages of [300, 5000] as const) {
    it(`${pages} pages: the same seed gives the same wiki, with links that land`, () => {
      const a = generate({ pages, seed: 48291 })
      const b = generate({ pages, seed: 48291 })
      assert.deepEqual(a, b)
      assert.equal(a.pages.length, pages)
      const addresses = new Set(a.pages.map((p) => p.address))
      assert.equal(addresses.size, pages, 'addresses are unique')
      assert.ok(
        a.links.length >= pages * 2 && a.links.length <= pages * 4,
        `about 3 links a page: ${a.links.length}`,
      )
      for (const [from, to] of a.links) assert.ok(addresses.has(from) && addresses.has(to) && from !== to)
      assert.ok(a.sessions.length > 0 && a.entries.length > 0)
      for (const e of a.entries) assert.ok(a.sessions.some((s) => s.id === e.sessionId))
      for (const p of a.pages) assert.match(p.address, /^[a-z0-9-]+(\/[a-z0-9-]+){1,2}$/)
    })
  }

  it('another seed gives another wiki', () => {
    assert.notDeepEqual(generate({ pages: 300, seed: 1 }).pages, generate({ pages: 300, seed: 2 }).pages)
  })
})

describe('the validator', () => {
  it('accepts what the description says and refuses what it does not', () => {
    assert.deepEqual(
      validate(doc, 'GET', '/v1/branding', 200, {
        name: 'X',
        logo: null,
        setupRequired: false,
        canSendMail: true,
      }),
      [],
    )
    assert.notDeepEqual(
      validate(doc, 'GET', '/v1/branding', 200, {
        name: 1,
        logo: null,
        setupRequired: false,
        canSendMail: true,
      }),
      [],
    )
    assert.notDeepEqual(
      validate(doc, 'GET', '/v1/branding', 200, { name: 'X', setupRequired: false, canSendMail: true }),
      [],
    )
    assert.notDeepEqual(
      validate(doc, 'GET', '/v1/branding', 201, {
        name: 'X',
        logo: null,
        setupRequired: false,
        canSendMail: true,
      }),
      [],
    )
    assert.notDeepEqual(validate(doc, 'GET', '/v1/brains', 401, { error: { code: 'x', message: 'y' } }), [])
    assert.notDeepEqual(validate(doc, 'GET', '/v1/nowhere', 200, {}), [])
    // A refusal keeps the status the server gives its code, and its code is one the server gives.
    const refusal = (code: string) => ({ error: { code, message: 'm', howToProceed: 'h' } })
    assert.deepEqual(validate(doc, 'GET', '/v1/brains/x', 404, refusal('brain_not_found')), [])
    assert.notDeepEqual(validate(doc, 'GET', '/v1/brains/x', 403, refusal('brain_not_found')), [])
    assert.notDeepEqual(validate(doc, 'POST', '/v1/auth/login', 400, refusal('bad_credentials')), [])
    assert.notDeepEqual(validate(doc, 'POST', '/v1/auth/login', 400, refusal('made_up_code')), [])
  })
})

describe('the fixture API', () => {
  let fx: Fixture
  before(async () => {
    fx = await startFixture({ web: false, loadingMs: 30 })
  })
  after(async () => fx.close())

  type Ans = { status: number; body: unknown; headers: Headers }
  const seen = new Set<string>()
  async function call(
    method: string,
    path: string,
    o: { scenario?: string; body?: unknown; cookie?: string; csrf?: boolean } = {},
  ): Promise<Ans> {
    const res = await fetch(`${fx.url}${path}`, {
      method,
      headers: {
        ...(o.scenario ? { 'x-fixture-scenario': o.scenario } : {}),
        ...(o.cookie ? { cookie: o.cookie } : {}),
        ...(o.csrf === false || method === 'GET' ? {} : { 'x-requested-with': 'rsc-brain-web' }),
        ...(o.body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      ...(o.body === undefined ? {} : { body: JSON.stringify(o.body) }),
    })
    const text = await res.text()
    const body = text ? JSON.parse(text) : {}
    const problems = validate(doc, method, path.split('?')[0] as string, res.status, body)
    assert.deepEqual(problems, [], `${method} ${path} → ${res.status} ${text.slice(0, 300)}`)
    seen.add(fx.operationOf(method, path.split('?')[0] as string) ?? `? ${method} ${path}`)
    return { status: res.status, body, headers: res.headers }
  }
  const cookieOf = (a: Ans) => (a.headers.get('set-cookie') ?? '').split(';')[0] as string

  it('signs in, with and without the second factor, and refuses like the server', async () => {
    const s = fx.scenario()
    assert.equal((await call('GET', '/v1/me', { scenario: s.id })).status, 401)
    const wrong = await call('POST', '/v1/auth/login', {
      scenario: s.id,
      body: { email: 'eric@example.test', password: 'not it at all' },
    })
    assert.equal(wrong.status, 401)
    assert.equal((wrong.body as { error: { code: string } }).error.code, 'bad_credentials')
    const csrf = await call('POST', '/v1/auth/login', {
      scenario: s.id,
      body: { email: 'eric@example.test', password: fx.password },
      csrf: false,
    })
    assert.equal(csrf.status, 403)
    const ok = await call('POST', '/v1/auth/login', {
      scenario: s.id,
      body: { email: 'eric@example.test', password: fx.password },
    })
    assert.equal(ok.status, 200)
    const cookie = cookieOf(ok)
    assert.match(cookie, /^rscb_session=/)
    assert.equal((await call('GET', '/v1/me', { scenario: s.id, cookie })).status, 200)
    const brains = await call('GET', '/v1/brains', { scenario: s.id, cookie })
    assert.ok((brains.body as { brains: unknown[] }).brains.length > 0)
    assert.equal((await call('GET', '/v1/brains/growth', { scenario: s.id, cookie })).status, 200)
    assert.equal((await call('GET', '/v1/brains/nowhere', { scenario: s.id, cookie })).status, 404)
    assert.equal((await call('GET', '/v1/search?q=retention', { scenario: s.id, cookie })).status, 200)
    assert.equal((await call('POST', '/v1/auth/logout', { scenario: s.id, cookie, body: {} })).status, 200)
    const code = await call('POST', '/v1/auth/login', {
      scenario: s.id,
      body: { email: 'ana@example.test', password: fx.password },
    })
    assert.equal((code.body as { error: { code: string } }).error.code, 'code_required')
    const withCode = await call('POST', '/v1/auth/login', {
      scenario: s.id,
      body: { email: 'ana@example.test', password: fx.password, code: fx.code },
    })
    assert.equal(withCode.status, 200)
  })

  it('brakes after five failures in a row', async () => {
    const s = fx.scenario()
    let last: Ans | undefined
    for (let i = 0; i < 6; i++) {
      last = await call('POST', '/v1/auth/login', {
        scenario: s.id,
        body: { email: 'eric@example.test', password: 'wrong wrong wrong' },
      })
    }
    assert.equal(last?.status, 429)
  })

  it('runs the first-time setup once', async () => {
    const s = fx.scenario('fresh')
    assert.equal(
      ((await call('GET', '/v1/branding', { scenario: s.id })).body as { setupRequired: boolean })
        .setupRequired,
      true,
    )
    assert.equal(
      (await call('GET', '/v1/setup?publicUrl=http://localhost:4173', { scenario: s.id })).status,
      200,
    )
    const short = await call('POST', '/v1/setup', {
      scenario: s.id,
      body: {
        name: 'Risco Brain',
        publicUrl: 'http://localhost',
        admin: { name: 'Eric', email: 'e@example.test', password: 'short' },
      },
    })
    assert.equal(short.status, 400)
    const done = await call('POST', '/v1/setup', {
      scenario: s.id,
      body: {
        name: 'Risco Brain',
        publicUrl: 'http://localhost',
        admin: { name: 'Eric', email: 'e@example.test', password: fx.password },
      },
    })
    assert.equal(done.status, 201)
    assert.deepEqual((await call('GET', '/v1/branding', { scenario: s.id })).body, {
      name: 'Risco Brain',
      logo: null,
      setupRequired: false,
      canSendMail: true,
    })
    assert.equal((await call('GET', '/v1/setup', { scenario: s.id })).status, 404)
    assert.equal((await call('GET', '/v1/branding/logo', { scenario: s.id })).status, 404)
  })

  it('looks at and accepts an invitation; a bad token says how to get another', async () => {
    const s = fx.scenario()
    const bad = await call('POST', '/v1/invitations/look', {
      scenario: s.id,
      body: { token: 'nope-nope-nope' },
    })
    assert.equal((bad.body as { error: { code: string } }).error.code, 'invitation_invalid')
    const look = await call('POST', '/v1/invitations/look', {
      scenario: s.id,
      body: { token: fx.inviteToken },
    })
    assert.equal(look.status, 200)
    const accept = await call('POST', '/v1/invitations/accept', {
      scenario: s.id,
      body: { token: fx.inviteToken, name: 'Marta', password: fx.password },
    })
    assert.equal(accept.status, 201)
    assert.deepEqual((accept.body as { brains: unknown }).brains, [
      { slug: 'growth', name: 'Growth', role: 'contributor' },
      { slug: 'support', name: 'Support', role: 'reader' },
    ])
    assert.equal((await call('GET', '/v1/me', { scenario: s.id, cookie: cookieOf(accept) })).status, 200)
    assert.equal(
      (await call('POST', '/v1/invitations/look', { scenario: s.id, body: { token: fx.inviteToken } }))
        .status,
      400,
    )
  })

  it('asks for and confirms a password reset', async () => {
    const s = fx.scenario()
    assert.equal(
      (await call('POST', '/v1/auth/reset', { scenario: s.id, body: { email: 'x@example.test' } })).status,
      202,
    )
    assert.deepEqual(
      (await call('POST', '/v1/auth/reset/look', { scenario: s.id, body: { token: fx.resetToken } })).body,
      { valid: true },
    )
    assert.equal(
      (
        (await call('POST', '/v1/auth/reset/look', { scenario: s.id, body: { token: 'nope-nope-nope' } }))
          .body as { error: { code: string } }
      ).error.code,
      'link_invalid',
    )
    const bad = await call('POST', '/v1/auth/reset/confirm', {
      scenario: s.id,
      body: { token: 'nope-nope-nope', password: fx.password },
    })
    assert.equal((bad.body as { error: { code: string } }).error.code, 'link_invalid')
    assert.equal(
      (
        await call('POST', '/v1/auth/reset/confirm', {
          scenario: s.id,
          body: { token: fx.resetToken, password: fx.password },
        })
      ).status,
      200,
    ) // A used link no longer looks valid.
    assert.equal(
      (await call('POST', '/v1/auth/reset/look', { scenario: s.id, body: { token: fx.resetToken } })).status,
      400,
    )
  })

  it('gives the connection kit for the public address of the installation, never the address asked on', async () => {
    const s = fx.scenario('signed-in')
    assert.equal((await call('GET', '/v1/connect?agent=claude-code', { scenario: s.id })).status, 401)
    const kit = await call('GET', '/v1/connect?agent=claude-code', { scenario: s.id, cookie: s.cookie })
    assert.equal(kit.status, 200)
    const body = kit.body as {
      mcpUrl: string
      agents: Array<{ id: string; signIn: { blocks: Array<{ text: string }> } }>
    }
    assert.equal(body.mcpUrl, 'https://brain.example.test/mcp')
    assert.deepEqual(
      body.agents.map((a) => a.id),
      ['claude-code'],
    )
    assert.match(
      body.agents[0]?.signIn.blocks[0]?.text ?? '',
      /claude mcp add .* https:\/\/brain\.example\.test\/mcp/,
    )
  })

  it('ends every session of a scenario on demand (a session revoked while the web is open)', async () => {
    const s = fx.scenario('signed-in')
    assert.equal((await call('GET', '/v1/me', { scenario: s.id, cookie: s.cookie })).status, 200)
    await s.endSessions()
    assert.equal((await call('GET', '/v1/me', { scenario: s.id, cookie: s.cookie })).status, 401)
  })

  it('forces every state of plan §3.6, each still in the shape of v1', async () => {
    const s = fx.scenario('signed-in')
    const cookie = s.cookie
    s.set('home', 'empty')
    assert.deepEqual((await call('GET', '/v1/brains', { scenario: s.id, cookie })).body, { brains: [] })
    s.set('home', 'much-data')
    assert.ok(
      ((await call('GET', '/v1/brains', { scenario: s.id, cookie })).body as { brains: unknown[] }).brains
        .length >= 50,
    )
    s.set('home', 'error')
    assert.equal((await call('GET', '/v1/brains', { scenario: s.id, cookie })).status, 500)
    s.set('home', 'forbidden')
    assert.equal((await call('GET', '/v1/brains', { scenario: s.id, cookie })).status, 403)
    s.set('brain', 'forbidden')
    assert.equal((await call('GET', '/v1/brains/growth', { scenario: s.id, cookie })).status, 404)
    s.set('search', 'filtered-empty')
    assert.deepEqual(
      ((await call('GET', '/v1/search?q=x', { scenario: s.id, cookie })).body as { items: unknown[] }).items,
      [],
    )
    s.set('home', 'loading')
    const t0 = Date.now()
    assert.equal((await call('GET', '/v1/brains', { scenario: s.id, cookie })).status, 200)
    assert.ok(Date.now() - t0 >= 25, 'loading waits before answering')
  })

  it('every operation the fixture answers was checked against the description', () => {
    assert.deepEqual(
      [...fx.operations].filter((op) => !seen.has(op)),
      [],
    )
  })
})
