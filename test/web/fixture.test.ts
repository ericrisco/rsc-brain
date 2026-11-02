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
import { validate, validateSchema } from './fixture/schema.ts'

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
        name: 'rsc-brain',
        publicUrl: 'http://localhost',
        admin: { name: 'Eric', email: 'e@example.test', password: 'short' },
      },
    })
    assert.equal(short.status, 400)
    const done = await call('POST', '/v1/setup', {
      scenario: s.id,
      body: {
        name: 'rsc-brain',
        publicUrl: 'http://localhost',
        admin: { name: 'Eric', email: 'e@example.test', password: fx.password },
      },
    })
    assert.equal(done.status, 201)
    assert.deepEqual((await call('GET', '/v1/branding', { scenario: s.id })).body, {
      name: 'rsc-brain',
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

  it('home and overview: brains with their numbers, a new brain and its first steps (G5, G7, G8)', async () => {
    const s = fx.scenario('signed-in')
    const cookie = s.cookie
    const me = (await call('GET', '/v1/me', { scenario: s.id, cookie })).body as {
      account: { canCreateBrains: boolean; canInvite: boolean }
    }
    assert.deepEqual([me.account.canCreateBrains, me.account.canInvite], [true, true])
    const list = (await call('GET', '/v1/brains', { scenario: s.id, cookie })).body as {
      brains: Array<{ slug: string; stats: { pendingProposals: number } }>
    }
    assert.equal(list.brains.find((b) => b.slug === 'growth')?.stats.pendingProposals, 3)
    const growth = await call('GET', '/v1/brains/growth/overview', { scenario: s.id, cookie })
    assert.equal((growth.body as { todaySessions: unknown[] }).todaySessions.length, 3)
    const made = await call('POST', '/v1/brains', {
      scenario: s.id,
      cookie,
      body: { slug: 'onboarding', name: 'Onboarding', purpose: 'First days.' },
    })
    assert.equal(made.status, 201)
    const again = await call('POST', '/v1/brains', { scenario: s.id, cookie, body: { slug: 'onboarding' } })
    assert.equal((again.body as { error: { code: string } }).error.code, 'brain_exists')
    const bad = await call('POST', '/v1/brains', { scenario: s.id, cookie, body: { slug: 'Not ok' } })
    assert.equal(bad.status, 400)
    const fresh = await call('GET', '/v1/brains/onboarding/overview', { scenario: s.id, cookie })
    assert.deepEqual((fresh.body as { firstSteps: unknown }).firstSteps, {
      agentConnected: false,
      firstEntry: false,
      imported: false,
    })
    assert.equal((await call('GET', '/v1/brains/nowhere/overview', { scenario: s.id, cookie })).status, 404)
  })

  it('inviting people and making a reset link: the administration may, a member may not', async () => {
    const s = fx.scenario('signed-in')
    const cookie = s.cookie
    const made = await call('POST', '/v1/invitations', {
      scenario: s.id,
      cookie,
      body: { emails: ['zoe@example.test'], brains: [{ slug: 'growth', role: 'reader' }] },
    })
    assert.equal(made.status, 201)
    const inv = (made.body as { invitations: Array<{ id: string; link: string; mailed: boolean }> })
      .invitations[0]
    assert.match(inv?.link ?? '', /\/invite#token=/)
    const taken = await call('POST', '/v1/invitations', {
      scenario: s.id,
      cookie,
      body: { emails: ['ana@example.test'] },
    })
    assert.equal((taken.body as { error: { code: string } }).error.code, 'email_taken')
    const listed = await call('GET', '/v1/invitations', { scenario: s.id, cookie })
    assert.ok((listed.body as { invitations: unknown[] }).invitations.length >= 2)
    assert.equal(
      (await call('POST', `/v1/invitations/${inv?.id}/resend`, { scenario: s.id, cookie, body: {} })).status,
      200,
    )
    // One new link a minute per invitation.
    const soon = await call('POST', `/v1/invitations/${inv?.id}/resend`, { scenario: s.id, cookie, body: {} })
    assert.equal((soon.body as { error: { code: string } }).error.code, 'too_soon')
    assert.equal((await call('DELETE', `/v1/invitations/${inv?.id}`, { scenario: s.id, cookie })).status, 200)
    const closed = await call('POST', `/v1/invitations/${inv?.id}/resend`, {
      scenario: s.id,
      cookie,
      body: {},
    })
    assert.equal((closed.body as { error: { code: string } }).error.code, 'invitation_closed')
    assert.equal(
      (await call('POST', '/v1/invitations/inv_nope/resend', { scenario: s.id, cookie, body: {} })).status,
      404,
    )
    assert.equal((await call('GET', '/v1/admin/accounts', { scenario: s.id, cookie })).status, 200)
    assert.equal((await call('GET', '/v1/admin/brains', { scenario: s.id, cookie })).status, 200)
    const link = await call('POST', '/v1/admin/accounts/acc_ana/reset-link', {
      scenario: s.id,
      cookie,
      body: {},
    })
    assert.equal(link.status, 201)
    const token = await call('POST', '/v1/me/tokens', {
      scenario: s.id,
      cookie,
      body: { name: 'Codex', perm: 'write', brains: ['growth'], days: 90 },
    })
    assert.equal(token.status, 201)
    assert.match(String((token.body as { token: { secret: string } }).token.secret), /^rscb_/)
    const member = fx.scenario('member')
    const ana = 'rscb_session=fx.acc_ana'
    assert.equal((await call('GET', '/v1/invitations', { scenario: member.id, cookie: ana })).status, 403)
    assert.equal((await call('GET', '/v1/admin/accounts', { scenario: member.id, cookie: ana })).status, 403)
    assert.equal(
      (
        await call('POST', '/v1/admin/accounts/acc_eric/reset-link', {
          scenario: member.id,
          cookie: ana,
          body: {},
        })
      ).status,
      403,
    )
  })

  it('streams the live events of a brain, and an emitted entry marks its first steps', async () => {
    const s = fx.scenario('signed-in')
    const cookie = s.cookie
    await call('POST', '/v1/brains', { scenario: s.id, cookie, body: { slug: 'live-one' } })
    const ctrl = new AbortController()
    const res = await fetch(`${fx.url}/v1/brains/live-one/events`, {
      headers: { 'x-fixture-scenario': s.id, cookie },
      signal: ctrl.signal,
    })
    assert.equal(res.status, 200)
    assert.match(res.headers.get('content-type') ?? '', /text\/event-stream/)
    const reader = (res.body as ReadableStream<Uint8Array>).getReader()
    await reader.read()
    await fetch(`${fx.url}/__fixture/scenarios/${s.id}/emit`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ brain: 'live-one', kind: 'entry.saved' }),
    })
    const chunk = new TextDecoder().decode((await reader.read()).value)
    assert.match(chunk, /"kind":"entry.saved"/)
    ctrl.abort()
    const steps = await call('GET', '/v1/brains/live-one/overview', { scenario: s.id, cookie })
    assert.deepEqual((steps.body as { firstSteps: unknown }).firstSteps, {
      agentConnected: true,
      firstEntry: true,
      imported: false,
    })
    assert.equal(
      (await fetch(`${fx.url}/v1/brains/live-one/events`, { headers: { 'x-fixture-scenario': s.id } }))
        .status,
      401,
    )
  })

  // PR23: Activity, Health and Search answer like the server: events name their client and follow pack
  // rule 7 (live and replayed), the health of a wiki has the sections of B2, and every result says why.
  it('activity, health and search (PR23): rule 7 on the events, the sections of health, a reason per result', async () => {
    const s = fx.scenario('member')
    const cookie = 'rscb_session=fx.acc_ana'
    const emit = (b: Record<string, unknown>) =>
      fetch(`${fx.url}/__fixture/scenarios/${s.id}/emit`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ brain: 'growth', ...b }),
      })
    // Ana is a contributor of growth: Eric's search is not hers to see; his write and her own search are.
    await emit({ kind: 'search', who: { id: 'acc_eric', name: 'Eric' }, query: 'eric-looks' })
    await emit({ kind: 'search', who: { id: 'acc_ana', name: 'Ana' }, query: 'ana-looks' })
    await emit({
      kind: 'entry.saved',
      who: { id: 'acc_eric', name: 'Eric' },
      client: 'codex',
      ref: 'run r_abc',
    })
    const res = await fetch(`${fx.url}/v1/brains/growth/events?lastEventId=0`, {
      headers: { 'x-fixture-scenario': s.id, cookie },
    })
    const reader = (res.body as ReadableStream<Uint8Array>).getReader()
    let text = ''
    while (!text.includes('run r_abc')) text += new TextDecoder().decode((await reader.read()).value)
    await reader.cancel()
    assert.doesNotMatch(text, /eric-looks/)
    assert.match(text, /ana-looks/)
    const saved = JSON.parse(/data: (.*run r_abc.*)/.exec(text)?.[1] ?? '{}') as Record<string, unknown>
    assert.deepEqual(validateSchema(doc, 'Event', saved), [])
    assert.equal(saved.client, 'codex')

    const h = await call('GET', '/v1/brains/growth/wiki/health', { scenario: s.id, cookie })
    assert.equal((h.body as { broken: unknown[] }).broken.length, 3)
    s.set('health', 'empty')
    assert.equal((await call('GET', '/v1/brains/growth/wiki/health', { scenario: s.id, cookie })).status, 200)
    s.set('health', 'much-data')
    const many = await call('GET', '/v1/brains/growth/wiki/health', { scenario: s.id, cookie })
    assert.equal((many.body as { orphans: unknown[] }).orphans.length, 60)
    assert.equal(
      (await call('GET', '/v1/brains/nowhere/wiki/health', { scenario: s.id, cookie })).status,
      404,
    )

    const r = await call('GET', '/v1/search?q=intro&brains=growth', { scenario: s.id, cookie })
    const items = (r.body as { items: Array<{ brain: string; reason: string }> }).items
    assert.ok(items.length > 0)
    assert.ok(items.every((i) => i.brain === 'growth' && i.reason))
  })

  it('the wiki: map, pages, a page with its links, sources, history and readers, decisions and the log', async () => {
    const s = fx.scenario('signed-in')
    const cookie = s.cookie
    const get = async (path: string) => call('GET', path, { scenario: s.id, cookie })
    const map = (await get('/v1/brains/growth/wiki/map')).body as { groups: Array<{ pages: unknown[] }> }
    assert.ok(map.groups.length > 1)
    const pages = (await get('/v1/brains/growth/wiki/pages?q=intro&limit=5')).body as {
      items: Array<{ address: string }>
      total: number
    }
    assert.ok(pages.items.some((p) => p.address === 'audience/intros'))
    const reading = (await get('/v1/brains/growth/pages/audience/retention')).body as {
      page: { revision: number; body: string }
      links: { out: Array<{ state: string }>; in: unknown[] }
      sources: Array<{ entryId?: string }>
    }
    assert.ok(reading.page.revision >= 3)
    assert.ok(reading.links.out.some((l) => l.state === 'broken'))
    assert.equal(reading.sources.filter((x) => x.entryId).length >= 2, true)
    assert.equal((await get('/v1/brains/growth/pages/no/such-page')).status, 404)
    const history = (await get('/v1/brains/growth/pages/audience/retention?history=1')).body as {
      history: unknown[]
    }
    assert.equal(history.history.length, reading.page.revision)
    const pair = (await get('/v1/brains/growth/pages/audience/retention?compare=1,3')).body as {
      a: { body: string }
      b: { body: string }
    }
    assert.notEqual(pair.a.body, pair.b.body)
    assert.equal((await get('/v1/brains/growth/pages/audience/retention?revision=1')).status, 200)
    const entry = reading.sources.find((x) => x.entryId)?.entryId as string
    assert.equal((await get(`/v1/entries/${entry}`)).status, 200)
    const readers = (await get('/v1/brains/growth/trail?page=audience/retention')).body as {
      items: unknown[]
    }
    assert.ok(readers.items.length > 0)
    assert.ok(
      ((await get('/v1/brains/growth/wiki/decisions')).body as { decisions: unknown[] }).decisions.length,
    )
    const log = (await get('/v1/brains/growth/wiki/log?kind=direct')).body as {
      items: Array<{ kind: string }>
    }
    for (const l of log.items) assert.equal(l.kind, 'direct')
    s.set('log', 'much-data')
    const first = (await get('/v1/brains/growth/wiki/log')).body as { next: string | null }
    assert.ok(first.next)
    assert.equal((await get(`/v1/brains/growth/wiki/log?cursor=${first.next}`)).status, 200)
  })

  it('a curator edits a page by hand, and an edit on a revision that moved on keeps nothing', async () => {
    const s = fx.scenario('signed-in')
    const cookie = s.cookie
    const at = '/v1/brains/growth/pages/audience/intros'
    const now = (await call('GET', at, { scenario: s.id, cookie })).body as { page: { revision: number } }
    const r = now.page.revision
    const ok = await call('PATCH', at, {
      scenario: s.id,
      cookie,
      body: { baseRevision: r, body: 'Shorter.' },
    })
    assert.equal(ok.status, 200)
    const late = await call('PATCH', at, { scenario: s.id, cookie, body: { baseRevision: r, body: 'Mine.' } })
    assert.equal(late.status, 409)
    const e = (
      late.body as { error: { code: string; current: { page: { revision: number; body: string } } } }
    ).error
    assert.equal(e.code, 'page_changed')
    assert.deepEqual([e.current.page.revision, e.current.page.body], [r + 1, 'Shorter.'])
    // Another curator edits meanwhile (a control route of the tests).
    await fetch(`${fx.url}/__fixture/scenarios/${s.id}/wiki-edit`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ brain: 'growth', address: 'audience/intros', body: 'By Eva.' }),
    })
    const moved = (await call('GET', at, { scenario: s.id, cookie })).body as { page: { revision: number } }
    assert.equal(moved.page.revision, r + 2)
    for (const op of [
      { op: 'link', address: 'audience/intros', kind: 'related', to: 'product/pricing' },
      { op: 'unlink', address: 'audience/intros', kind: 'related', to: 'product/pricing' },
      { op: 'status', address: 'audience/intros', status: 'stale' },
      { op: 'revert', address: 'audience/intros', toRevision: 1 },
      { op: 'move', address: 'audience/intros', to: 'audience/openings' },
    ]) {
      const c = await call('POST', '/v1/brains/growth/wiki/changes', {
        scenario: s.id,
        cookie,
        body: { ...op, reason: 'By hand.' },
      })
      assert.equal(c.status, 201, JSON.stringify(op))
    }
    const old = (await call('GET', at, { scenario: s.id, cookie })).body as {
      page: { address: string }
      redirectedFrom: string
    }
    assert.deepEqual([old.page.address, old.redirectedFrom], ['audience/openings', 'audience/intros'])
    const bad = await call('POST', '/v1/brains/growth/wiki/changes', {
      scenario: s.id,
      cookie,
      body: { op: 'link', address: 'audience/openings', kind: 'related', to: 'no/such', reason: 'x' },
    })
    assert.equal(bad.status, 400)
    // Someone who is not a curator of the brain is told who to ask.
    const ana = 'rscb_session=fx.acc_ana'
    const member = fx.scenario('member')
    const no = await call('PATCH', '/v1/brains/growth/pages/product/pricing', {
      scenario: member.id,
      cookie: ana,
      body: { baseRevision: 1, body: 'x' },
    })
    assert.equal(no.status, 403)
    assert.match((no.body as { error: { howToProceed: string } }).error.howToProceed, /Eric/)
  })

  it('answers the journal like the server: sessions, entries, corrections, actions and lists', async () => {
    const s = fx.scenario('signed-in')
    const cookie = 'rscb_session=fx.acc_eric'
    const go = (method: string, path: string, body?: unknown) =>
      call(method, path, { scenario: s.id, cookie, body })
    const list = (await go('GET', '/v1/brains/growth/sessions')).body as {
      items: Array<{ id: string; client: string }>
      facets: { clients: string[] }
    }
    assert.ok(list.items.length >= 4)
    assert.ok(list.facets.clients.includes('Claude Code'))
    assert.equal(
      ((await go('GET', '/v1/brains/growth/sessions?status=open&client=Codex')).body as { total: number })
        .total,
      1,
    )
    assert.equal((await go('GET', '/v1/brains/growth/sessions?status=done')).status, 400)
    assert.equal((await go('GET', '/v1/sessions/ses_fx_1')).status, 200)
    assert.equal((await go('GET', '/v1/sessions/ses_nope')).status, 404)
    assert.equal((await go('GET', '/v1/brains/growth/entries?session=ses_fx_1&limit=20')).status, 200)
    assert.equal((await go('GET', '/v1/brains/growth/members')).status, 200)
    assert.equal((await go('GET', '/v1/entries/ent_fx_intros?history=1')).status, 200)
    assert.equal((await go('GET', '/v1/entries/ent_fx_gone')).status, 200, 'a curator reads a forgotten one')
    assert.equal((await go('GET', '/v1/entries/ent_nope')).status, 404)
    const edited = await go('PATCH', '/v1/entries/ent_fx_hooks', {
      baseRevision: 1,
      content: 'The hook first.',
    })
    assert.equal(edited.status, 200)
    const stale = await go('PATCH', '/v1/entries/ent_fx_hooks', { baseRevision: 1, content: 'x' })
    assert.equal(stale.status, 409)
    assert.equal((await go('POST', '/v1/entries/ent_fx_hooks/pin')).status, 200)
    assert.equal((await go('POST', '/v1/entries/ent_fx_hooks/unpin')).status, 200)
    assert.equal(
      (await go('POST', '/v1/entries/ent_fx_hooks/schedule', { reviewAfter: '2026-11-30' })).status,
      200,
    )
    assert.equal((await go('POST', '/v1/entries/ent_fx_plain/forget', { reason: '' })).status, 400)
    assert.equal((await go('POST', '/v1/entries/ent_fx_plain/forget', { reason: 'Wrong.' })).status, 200)
    assert.equal((await go('GET', '/v1/brains/growth/forgotten')).status, 200)
    assert.equal((await go('POST', '/v1/entries/ent_fx_plain/recover')).status, 200)
    assert.equal((await go('GET', '/v1/brains/growth/to-review')).status, 200)
    const conflicts = (await go('GET', '/v1/brains/growth/conflicts?limit=1')).body as {
      total: number
      next: string
    }
    assert.equal(conflicts.total, 2)
    assert.equal(conflicts.next, '1')
    const rel = await go('POST', '/v1/brains/growth/relations', {
      from: 'ent_fx_intros',
      to: 'ent_fx_30s',
      kind: 'supersedes',
    })
    assert.equal(rel.status, 201)
    assert.equal(((await go('GET', '/v1/brains/growth/conflicts')).body as { total: number }).total, 1)
    assert.equal(
      (
        await go('POST', '/v1/brains/growth/relations', {
          from: 'ent_fx_30s',
          to: 'ent_fx_intros',
          kind: 'x',
        })
      ).status,
      400,
    )
    const made = await go('POST', '/v1/brains/growth/corrections', {
      title: 'Short',
      content: 'Keep it short.',
      page: 'audience/intros',
    })
    assert.equal(made.status, 201)
    assert.equal(
      (await go('POST', '/v1/brains/growth/corrections', { title: 'x', content: 'y', page: 'no/page' }))
        .status,
      404,
    )
    // Ana reads support: no forgotten list, and no correction.
    const ana = 'rscb_session=fx.acc_ana'
    const m = fx.scenario('member')
    const asAna = (method: string, path: string, body?: unknown) =>
      call(method, path, { scenario: m.id, cookie: ana, body })
    assert.equal((await asAna('GET', '/v1/brains/support/forgotten')).status, 403)
    assert.equal(
      (await asAna('POST', '/v1/brains/support/corrections', { title: 'x', content: 'y' })).status,
      403,
    )
    assert.equal((await asAna('GET', '/v1/entries/ent_fx_gone_support')).status, 404)
    // Much data, by pages.
    s.set('sessions', 'much-data')
    const big = (await go('GET', '/v1/brains/growth/sessions')).body as {
      items: unknown[]
      total: number
      next: string
    }
    assert.equal(big.items.length, 50)
    assert.ok(big.total > 500)
    assert.equal((await go('GET', `/v1/brains/growth/sessions?cursor=${big.next}`)).status, 200)
  })

  it('answers the proposals inbox like the server: list by status, review, approve all or part, return, 409', async () => {
    const s = fx.scenario('signed-in')
    const cookie = 'rscb_session=fx.acc_eric'
    const go = (method: string, path: string, body?: unknown) =>
      call(method, path, { scenario: s.id, cookie, body })
    const list = (await go('GET', '/v1/brains/growth/proposals')).body as {
      items: Array<{ id: string; old: boolean }>
      total: number
      counts: Record<string, number>
    }
    assert.equal(list.total, 3)
    assert.deepEqual(list.counts, {
      pending: 3,
      approved: 1,
      partially_approved: 1,
      returned: 1,
      withdrawn: 1,
      superseded: 1,
    })
    assert.ok(list.items.some((p) => p.old))
    assert.equal((await go('GET', '/v1/brains/growth/proposals?status=done')).status, 400)
    assert.equal((await go('GET', '/v1/brains/growth/proposals?status=returned')).status, 200)
    const review = async (id: string) =>
      (await go('GET', `/v1/proposals/${id}/review`)).body as {
        fingerprint: string
        canDecide: boolean
        ops: Array<{ stale: unknown; dependsOn: number[] }>
      }
    const one = await review('prp_growth1')
    assert.equal(one.canDecide, true)
    assert.equal(one.ops.length, 3)
    const three = await review('prp_growth3')
    assert.ok(three.ops[0]?.stale, 'an edit on an old base shows three versions')
    assert.equal((await go('GET', '/v1/proposals/prp_nope/review')).status, 404)
    // Part of it needs a comment; the fingerprint must be the one seen.
    const part = { fingerprint: one.fingerprint, approve: [0, 1] }
    assert.equal((await go('POST', '/v1/proposals/prp_growth1/approve', part)).status, 400)
    assert.equal(
      (await go('POST', '/v1/proposals/prp_growth1/approve', { ...part, fingerprint: 'fp_old' })).status,
      409,
    )
    const done = await go('POST', '/v1/proposals/prp_growth1/approve', { ...part, comment: 'Not the third.' })
    assert.equal(done.status, 200)
    assert.equal((done.body as { proposal: { status: string } }).proposal.status, 'partially_approved')
    assert.equal(
      (await go('POST', '/v1/proposals/prp_growth1/approve', { fingerprint: one.fingerprint })).status,
      409,
    )
    // An old base is approved only once reviewed; what needs another goes with it.
    assert.equal(
      (await go('POST', '/v1/proposals/prp_growth3/approve', { fingerprint: three.fingerprint })).status,
      409,
    )
    const two = await review('prp_growth2')
    assert.equal(
      (
        await go('POST', '/v1/proposals/prp_growth2/approve', {
          fingerprint: two.fingerprint,
          approve: [1],
          comment: 'x',
        })
      ).status,
      400,
    )
    assert.equal(
      (await go('POST', '/v1/proposals/prp_growth2/return', { fingerprint: two.fingerprint })).status,
      400,
    )
    assert.equal(
      (await go('POST', '/v1/proposals/prp_growth2/return', { fingerprint: two.fingerprint, comment: 'No.' }))
        .status,
      200,
    )
    assert.equal(
      (
        await go('POST', '/v1/proposals/prp_growth3/approve', {
          fingerprint: three.fingerprint,
          baseReviewed: [0],
        })
      ).status,
      200,
    )
    // Ana is a contributor in growth and a reader in support: she reads, she does not decide.
    const m = fx.scenario('member')
    const asAna = (method: string, path: string, body?: unknown) =>
      call(method, path, { scenario: m.id, cookie: 'rscb_session=fx.acc_ana', body })
    const hers = (await asAna('GET', '/v1/proposals/prp_support1/review')).body as {
      canDecide: boolean
      fingerprint: string
    }
    assert.equal(hers.canDecide, false)
    assert.equal(
      (await asAna('POST', '/v1/proposals/prp_support1/approve', { fingerprint: hers.fingerprint })).status,
      403,
    )
    assert.equal((await asAna('GET', '/v1/brains/support/proposals')).status, 200)
    // Much data, by pages.
    s.set('proposals', 'much-data')
    const big = (await go('GET', '/v1/brains/growth/proposals?limit=20')).body as {
      items: unknown[]
      total: number
      next: string
    }
    assert.equal(big.items.length, 20)
    assert.equal(big.total, 120)
    assert.equal((await go('GET', `/v1/brains/growth/proposals?limit=20&cursor=${big.next}`)).status, 200)
  })

  it('the graph and the full list (G9, G10): hand-made, 300 and 5 000 seeded pages, as the server answers', async () => {
    type Graph = {
      mode: string
      total: number
      nodes: Array<[string, string, string, string]>
      groups: Array<{ prefix: string; count: number }>
    }
    type Listing = {
      items: Array<{ address: string; in: number; status: string }>
      next: string | null
      total: number
    }
    const seededScenario = async (seeded?: number) => {
      const r = await fetch(`${fx.url}/__fixture/scenarios`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ preset: 'signed-in', ...(seeded ? { seeded } : {}) }),
      })
      return ((await r.json()) as { id: string }).id
    }
    const getIn = (id: string) => async (path: string) =>
      call('GET', path, { scenario: id, cookie: 'rscb_session=fx.acc_eric' })
    const hand = getIn(await seededScenario())
    const g = (await hand('/v1/brains/growth/wiki/graph')).body as Graph
    assert.equal(g.mode, 'pages')
    assert.ok(g.nodes.some((n) => n[0] === 'audience/retention'))
    assert.ok(g.nodes.every((n) => n[3] !== 'retired'))
    assert.equal((await hand('/v1/brains/growth/wiki/graph?prefix=a//b')).status, 400)
    assert.equal((await hand('/v1/brains/growth/wiki/graph?sort=title')).status, 400)

    const s300 = getIn(await seededScenario(300))
    const all = generate({ pages: 300, seed: 48291 }).pages
    const g300 = (await s300('/v1/brains/growth/wiki/graph')).body as Graph
    assert.equal(g300.mode, 'pages')
    assert.equal(g300.total, all.filter((p) => p.status !== 'retired').length)
    const byIn = (await s300('/v1/brains/growth/wiki/pages?sort=-in&limit=200')).body as Listing
    assert.equal(byIn.total, 300)
    assert.ok((byIn.items[0]?.in ?? 0) >= (byIn.items[199]?.in ?? 0))
    const rest = (await s300(`/v1/brains/growth/wiki/pages?sort=-in&limit=200&cursor=${byIn.next}`))
      .body as Listing
    assert.equal(rest.items.length, 100)
    assert.ok((await s300('/v1/brains/growth/wiki/pages?linkKind=contradicts')).status === 200)
    assert.equal((await s300('/v1/brains/growth/wiki/pages?sort=size')).status, 400)
    assert.equal((await s300('/v1/brains/growth/wiki/pages?sort=-status')).status, 200)
    const drawn = (await s300('/v1/brains/growth/wiki/pages?status=current,stale,superseded&limit=200'))
      .body as Listing
    assert.equal(drawn.total, g300.total)
    const filtered = (await s300('/v1/brains/growth/wiki/graph?type=decision')).body as Graph
    assert.ok(filtered.nodes.every((n) => n[2] === 'decision'))
    assert.equal((await s300(`/v1/brains/growth/pages/${all[0]?.address}`)).status, 200)

    const s5000 = getIn(await seededScenario(5000))
    const g5000 = (await s5000('/v1/brains/growth/wiki/graph')).body as Graph
    assert.equal(g5000.mode, 'groups')
    assert.equal(g5000.groups.length, 12)
    const one = (await s5000(`/v1/brains/growth/wiki/graph?prefix=${g5000.groups[0]?.prefix}`)).body as Graph
    assert.equal(one.mode, 'pages')
    assert.equal(one.total, g5000.groups[0]?.count)
    assert.equal(((await s5000('/v1/brains/growth/wiki/pages')).body as Listing).total, 5000)
    const byType = (await s5000('/v1/brains/growth/wiki/graph?type=decision')).body as Graph
    assert.equal(byType.mode, 'groups')
    assert.ok(byType.total < g5000.total)
  })

  it('the profile (PR24): tokens kept and revoked, apps, notices for curators, a new password, the second factor', async () => {
    const s = fx.scenario('signed-in')
    const o = { scenario: s.id, cookie: s.cookie }
    const made = await call('POST', '/v1/me/tokens', {
      ...o,
      body: { name: 'Laptop', perm: 'read', allBrains: true },
    })
    assert.equal(made.status, 201)
    const id = (made.body as { token: { id: string; secret: string } }).token.id
    const listed = (await call('GET', '/v1/me/tokens', o)).body as { tokens: Array<Record<string, unknown>> }
    assert.equal(listed.tokens[0]?.id, id)
    assert.equal(listed.tokens[0]?.lastUsedAt, null)
    // The list never carries the secret.
    assert.ok(!JSON.stringify(listed).includes((made.body as { token: { secret: string } }).token.secret))
    // An agent's first request with it (the live check).
    await fetch(`${fx.url}/__fixture/scenarios/${s.id}/agent`, { method: 'POST', body: '{"via":"token"}' })
    const used = (await call('GET', '/v1/me/tokens', o)).body as {
      tokens: Array<{ lastUsedAt: string | null }>
    }
    assert.ok(used.tokens[0]?.lastUsedAt)
    assert.equal((await call('DELETE', `/v1/me/tokens/${id}`, o)).status, 200)
    assert.equal((await call('DELETE', `/v1/me/tokens/${id}`, o)).status, 404)
    const apps = (await call('GET', '/v1/me/apps', o)).body as { apps: Array<{ id: string }> }
    assert.equal(apps.apps.length, 1)
    assert.equal((await call('DELETE', `/v1/me/apps/${apps.apps[0]?.id}`, o)).status, 200)
    assert.equal((await call('DELETE', '/v1/me/apps/app_nope', o)).status, 404)
    assert.deepEqual(
      (await call('PUT', '/v1/brains/growth/notify', { ...o, body: { notifyProposals: true } })).body,
      { notifyProposals: true },
    )
    const brains = (await call('GET', '/v1/brains', o)).body as {
      brains: Array<{ slug: string; notifyProposals: boolean }>
    }
    assert.equal(brains.brains.find((b) => b.slug === 'growth')?.notifyProposals, true)
    assert.equal(
      (await call('PUT', '/v1/brains/support/notify', { ...o, body: { notifyProposals: true } })).status,
      400,
    )
    const wrong = await call('POST', '/v1/me/password', {
      ...o,
      body: { current: 'nope nope nope', next: 'a newer passphrase' },
    })
    assert.equal(wrong.status, 400)
    assert.equal(
      (await call('POST', '/v1/me/password', { ...o, body: { current: fx.password, next: 'short' } })).status,
      400,
    )
    assert.equal(
      (
        await call('POST', '/v1/me/password', {
          ...o,
          body: { current: fx.password, next: 'a newer passphrase' },
        })
      ).status,
      204,
    )
    assert.equal((await call('POST', '/v1/me/totp/confirm', { ...o, body: { code: fx.code } })).status, 400)
    const started = (await call('POST', '/v1/me/totp', { ...o, body: {} })).body as { secret: string }
    assert.ok(started.secret)
    assert.equal((await call('POST', '/v1/me/totp/confirm', { ...o, body: { code: '000000' } })).status, 400)
    assert.deepEqual((await call('POST', '/v1/me/totp/confirm', { ...o, body: { code: fx.code } })).body, {
      enabled: true,
    })
    assert.equal(
      (await call('GET', '/v1/me', o)).body &&
        ((await call('GET', '/v1/me', o)).body as { account: { totp: boolean } }).account.totp,
      true,
    )
    assert.equal((await call('DELETE', '/v1/me/totp', { ...o, body: { code: '000000' } })).status, 400)
    assert.deepEqual((await call('DELETE', '/v1/me/totp', { ...o, body: { code: fx.code } })).body, {
      enabled: false,
    })
    for (const st of ['empty', 'much-data', 'error'] as const) {
      s.set('tokens', st)
      await call('GET', '/v1/me/tokens', o)
    }
    s.set('tokens', 'normal')
    assert.deepEqual((await call('POST', '/v1/me/revoke-all', { ...o, body: {} })).body, {
      tokens: 3,
      apps: 0,
    })
    const out = await call('POST', '/v1/auth/logout-everywhere', { ...o, body: {} })
    assert.deepEqual(out.body, { signedOut: 1 })
    assert.equal((await call('GET', '/v1/me', o)).status, 401)
  })

  it('brain settings and the administration (PR25a): members, repositories, settings, archive, people and service accounts', async () => {
    const s = fx.scenario('signed-in')
    const o = { scenario: s.id, cookie: s.cookie }
    type E = { error: { code: string } }
    const code = (a: Ans) => (a.body as E).error?.code
    // Settings: each field saved on the value it was read; another field never conflicts.
    const read = await call('GET', '/v1/brains/growth/wiki/settings', o)
    assert.equal(read.status, 200)
    const saved = await call('PUT', '/v1/brains/growth/wiki/settings', {
      ...o,
      body: { usageNote: 'Ids.', base: { usageNote: '' } },
    })
    assert.equal(saved.status, 200)
    assert.equal(
      (
        await call('PUT', '/v1/brains/growth/wiki/settings', {
          ...o,
          body: { staleDays: 5, base: { staleDays: 90 } },
        })
      ).status,
      200,
    )
    const late = await call('PUT', '/v1/brains/growth/wiki/settings', {
      ...o,
      body: { usageNote: 'Late.', base: { usageNote: '' } },
    })
    assert.equal(code(late), 'settings_changed')
    assert.equal((late.body as { error: { current: { usageNote: string } } }).error.current.usageNote, 'Ids.')
    assert.equal(
      code(
        await call('PUT', '/v1/brains/growth/wiki/settings', {
          ...o,
          body: { staleDays: 6, base: { nope: 1 } },
        }),
      ),
      'invalid_request',
    )
    assert.equal(
      code(await call('PUT', '/v1/brains/growth/wiki/settings', { ...o, body: { staleDays: 0 } })),
      'invalid_request',
    )
    assert.equal(
      code(await call('PUT', '/v1/brains/legal-archive/wiki/settings', { ...o, body: { staleDays: 9 } })),
      'forbidden',
    )
    // Members: add by email, change a role, remove; the last curator stays.
    // The administration manages who is in a brain without being its curator (B4).
    assert.equal(
      (
        await call('POST', '/v1/brains/support/members', {
          ...o,
          body: { account: 'acc_svc_factory', role: 'reader' },
        })
      ).status,
      201,
    )
    // Someone already in the brain is not added again: the role changes in the list.
    const again = await call('POST', '/v1/brains/growth/members', {
      ...o,
      body: { account: 'ana@example.test', role: 'reader' },
    })
    assert.equal(code(again), 'already_member')
    assert.equal(
      code(
        await call('POST', '/v1/brains/growth/members', {
          ...o,
          body: { account: 'nobody@example.test', role: 'reader' },
        }),
      ),
      'invalid_request',
    )
    assert.equal(
      code(
        await call('POST', '/v1/brains/growth/members', {
          ...o,
          body: { account: 'acc_svc_factory', role: 'curator' },
        }),
      ),
      'invalid_request',
    )
    assert.equal(
      (await call('PUT', '/v1/brains/growth/members/acc_ana', { ...o, body: { role: 'contributor' } }))
        .status,
      200,
    )
    assert.equal(
      code(await call('PUT', '/v1/brains/growth/members/acc_eric', { ...o, body: { role: 'reader' } })),
      'last_curator',
    )
    assert.equal(code(await call('DELETE', '/v1/brains/growth/members/acc_eric', o)), 'last_curator')
    assert.equal((await call('DELETE', '/v1/brains/growth/members/acc_ana', o)).status, 200)
    assert.equal((await call('GET', '/v1/brains/growth/members', o)).status, 200)
    // Repositories.
    assert.equal((await call('GET', '/v1/brains/growth/repos', o)).status, 200)
    const linked = await call('POST', '/v1/brains/growth/repos', {
      ...o,
      body: { repo: 'git@github.com:Acme/App.git' },
    })
    assert.deepEqual([linked.status, (linked.body as { repo: string }).repo], [201, 'github.com/acme/app'])
    assert.equal(
      code(await call('POST', '/v1/brains/growth/repos', { ...o, body: { repo: '~/code' } })),
      'invalid_request',
    )
    assert.equal(
      (await call('DELETE', '/v1/brains/growth/repos', { ...o, body: { repo: 'github.com/acme/app' } }))
        .status,
      200,
    )
    assert.equal(
      code(await call('DELETE', '/v1/brains/growth/repos', { ...o, body: { repo: 'github.com/acme/app' } })),
      'not_found',
    )
    // Archive and back; deleting asks for the name.
    assert.equal((await call('POST', '/v1/brains/growth/archive', { ...o, body: {} })).status, 200)
    assert.equal(
      code(await call('POST', '/v1/brains/growth/repos', { ...o, body: { repo: 'github.com/acme/late' } })),
      'forbidden',
    )
    assert.equal((await call('POST', '/v1/brains/growth/unarchive', { ...o, body: {} })).status, 200)
    assert.equal(code(await call('POST', '/v1/brains/support/archive', { ...o, body: {} })), 'forbidden')
    assert.equal(
      code(await call('DELETE', '/v1/brains/support', { ...o, body: { confirm: 'support' }, csrf: false })),
      'csrf',
    )
    assert.equal(
      code(await call('DELETE', '/v1/brains/support', { ...o, body: { confirm: 'nope' } })),
      'invalid_request',
    )
    assert.equal(
      (await call('DELETE', '/v1/brains/support', { ...o, body: { confirm: 'support' } })).status,
      200,
    )
    // People: rights, the last administrator, deactivate and back.
    assert.equal(
      (await call('PATCH', '/v1/admin/accounts/acc_ana', { ...o, body: { canCreateBrains: true } })).status,
      200,
    )
    assert.equal(
      code(await call('PATCH', '/v1/admin/accounts/acc_eric', { ...o, body: { isAdmin: false } })),
      'last_admin',
    )
    assert.equal(
      code(await call('POST', '/v1/admin/accounts/acc_eric/remove', { ...o, body: {} })),
      'invalid_request',
    )
    assert.equal((await call('POST', '/v1/admin/accounts/acc_ana/remove', { ...o, body: {} })).status, 200)
    assert.equal((await call('POST', '/v1/admin/accounts/acc_ana/restore', { ...o, body: {} })).status, 200)
    assert.equal(
      code(await call('PATCH', '/v1/admin/accounts/acc_nope', { ...o, body: { isAdmin: true } })),
      'not_found',
    )
    // Service accounts: create (the key once), rotate (two at most), revoke.
    const made = await call('POST', '/v1/admin/services', {
      ...o,
      body: { name: 'Nightly', brains: [{ slug: 'growth', role: 'contributor' }] },
    })
    assert.equal(made.status, 201)
    const sid = (made.body as { account: { id: string } }).account.id
    assert.match((made.body as { key: { secret: string } }).key.secret, /^rscb_/)
    assert.equal(
      code(
        await call('POST', '/v1/admin/services', {
          ...o,
          body: { name: 'X', brains: [{ slug: 'growth', role: 'curator' }] },
        }),
      ),
      'invalid_request',
    )
    assert.equal(
      (await call('POST', `/v1/admin/services/${sid}/keys`, { ...o, body: { name: 'next' } })).status,
      201,
    )
    assert.equal(
      code(await call('POST', `/v1/admin/services/${sid}/keys`, { ...o, body: {} })),
      'too_many_main_keys',
    )
    const keys = await call('GET', `/v1/admin/accounts/${sid}/keys`, o)
    const first = (keys.body as { keys: Array<{ id: string }> }).keys[0]?.id
    assert.ok(!JSON.stringify(keys.body).includes('rscb_'), 'no secret in the list')
    assert.equal((await call('DELETE', `/v1/keys/${first}`, o)).status, 200)
    assert.equal(code(await call('DELETE', '/v1/keys/crd_nope', o)), 'not_found')
    // A member is not the administration; programs do not manage people.
    const member = fx.scenario('member')
    const ana = { scenario: member.id, cookie: 'rscb_session=fx.acc_ana' }
    assert.equal(
      (await call('PATCH', '/v1/admin/accounts/acc_eric', { ...ana, body: { isAdmin: false } })).status,
      403,
    )
    assert.equal((await call('GET', '/v1/admin/accounts/acc_svc_factory/keys', ana)).status, 403)
    assert.equal(
      code(await call('POST', '/v1/admin/accounts/acc_ana/restore', { ...ana, body: {} })),
      'forbidden',
    )
    assert.equal(
      code(await call('POST', '/v1/admin/services/acc_svc_factory/keys', { ...ana, body: {} })),
      'forbidden',
    )
    assert.equal(code(await call('POST', '/v1/brains/growth/unarchive', { ...ana, body: {} })), 'forbidden')
    assert.equal(
      code(
        await call('POST', '/v1/brains/growth/members', {
          ...ana,
          body: { account: 'eric@example.test', role: 'reader' },
        }),
      ),
      'forbidden',
    )
    assert.equal(
      code(await call('POST', '/v1/brains/nowhere/repos', { ...o, body: { repo: 'github.com/a/b' } })),
      'brain_not_found',
    )
  })

  it('the rest of the administration (PR25b): settings, mail, meaning search, audit, system, logo', async () => {
    const admin = fx.scenario('signed-in')
    const o = { scenario: admin.id, cookie: 'rscb_session=fx.acc_eric' }
    const code = (a: Ans) => (a.body as { error?: { code: string } }).error?.code
    // The installation's settings, field by field.
    const read = (await call('GET', '/v1/admin/settings', o)).body as Record<string, unknown>
    assert.equal(read.rateLimit, 600)
    const saved = await call('PUT', '/v1/admin/settings', {
      ...o,
      body: { base: { factoryUrl: null }, factoryUrl: 'https://factory.example.test' },
    })
    assert.equal((saved.body as Record<string, unknown>).factoryUrl, 'https://factory.example.test')
    assert.equal(
      code(
        await call('PUT', '/v1/admin/settings', {
          ...o,
          body: { base: { factoryUrl: null }, factoryUrl: null },
        }),
      ),
      'settings_changed',
    )
    assert.equal(
      code(await call('PUT', '/v1/admin/settings', { ...o, body: { rateLimit: 5 } })),
      'invalid_request',
    )
    // Mail: the password never comes back; a test; its failures.
    const mail = (await call('GET', '/v1/admin/mail', o)).body as {
      base: unknown
      settings: Record<string, unknown>
    }
    assert.equal(mail.settings.hasPassword, true)
    const put = await call('PUT', '/v1/admin/mail', {
      ...o,
      body: {
        base: mail.base,
        host: 'down.example.test',
        port: 587,
        fromAddress: 'brain@example.test',
        password: 'new-secret-abcd',
      },
    })
    assert.ok(!JSON.stringify(put.body).includes('new-secret'))
    const test = await call('POST', '/v1/admin/mail/test', { ...o, body: {} })
    assert.equal((test.body as { sent: boolean }).sent, false)
    assert.equal((await call('DELETE', '/v1/admin/mail', o)).status, 200)
    assert.equal(code(await call('POST', '/v1/admin/mail/test', { ...o, body: {} })), 'mail_not_set_up')
    // Meaning search: a key set, on, in use, off.
    assert.equal(
      code(await call('PUT', '/v1/admin/meaning', { ...o, body: { provider: 'openai', accept: true } })),
      'invalid_request',
    )
    await call('PUT', '/v1/admin/meaning/providers/openai', {
      ...o,
      body: { key: 'sk-fixture-0123456789abcd' },
    })
    await call('PUT', '/v1/admin/meaning/providers/ollama', { ...o, body: { url: 'http://localhost:11434' } })
    assert.equal(
      code(await call('PUT', '/v1/admin/meaning/providers/openai', { ...o, body: { key: 'short' } })),
      'invalid_request',
    )
    assert.equal(
      (await call('PUT', '/v1/admin/meaning', { ...o, body: { provider: 'openai', accept: true } })).status,
      200,
    )
    assert.equal((await call('GET', '/v1/admin/meaning', o)).status, 200)
    assert.equal(code(await call('DELETE', '/v1/admin/meaning/providers/openai', o)), 'provider_in_use')
    assert.equal((await call('DELETE', '/v1/admin/meaning', o)).status, 200)
    assert.equal((await call('DELETE', '/v1/admin/meaning/providers/ollama', o)).status, 200)
    // The audit, paged, and its download.
    const first = (await call('GET', '/v1/admin/audit?action=member.', o)).body as {
      items: unknown[]
      next: string | null
    }
    assert.ok(first.items.length > 0)
    const res = await fetch(`${fx.url}/v1/admin/audit/export?action=member.`, {
      headers: { 'x-fixture-scenario': admin.id, cookie: o.cookie },
    })
    assert.match(String(res.headers.get('content-type')), /text\/csv/)
    assert.equal((await res.text()).trim().split('\r\n').length - 1, first.items.length)
    seen.add('GET /v1/admin/audit/export')
    assert.equal((await call('GET', '/v1/admin/system', o)).status, 200)
    // The logo.
    const png = Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGNgYGAAAAAEAAH2FzhVAAAAAElFTkSuQmCC',
      'base64',
    )
    assert.equal(
      code(
        await call('PUT', '/v1/admin/branding/logo', {
          ...o,
          body: { contentType: 'image/svg+xml', data: 'PHN2Zz4=' },
        }),
      ),
      'invalid_image',
    )
    const logo = await call('PUT', '/v1/admin/branding/logo', {
      ...o,
      body: { contentType: 'image/png', data: png.toString('base64') },
    })
    const url = (logo.body as { logo: { url: string } }).logo.url
    assert.equal(((await call('GET', '/v1/branding', o)).body as { logo: { url: string } }).logo.url, url)
    const img = await fetch(`${fx.url}${url}`, { headers: { 'x-fixture-scenario': admin.id } })
    assert.equal(img.headers.get('content-type'), 'image/png')
    assert.equal(img.headers.get('x-content-type-options'), 'nosniff')
    assert.equal((await call('DELETE', '/v1/admin/branding/logo', o)).status, 200)
    // Not the administration: refused.
    const member = fx.scenario('member')
    const ana = { scenario: member.id, cookie: 'rscb_session=fx.acc_ana' }
    for (const [m, p] of [
      ['GET', '/v1/admin/settings'],
      ['GET', '/v1/admin/mail'],
      ['GET', '/v1/admin/meaning'],
      ['GET', '/v1/admin/audit'],
      ['GET', '/v1/admin/system'],
    ] as const)
      assert.equal(code(await call(m, p, ana)), 'forbidden', p)
  })

  it('the copies, the installation key and restoring (B7 PR30), as the server answers them', async () => {
    const admin = fx.scenario('signed-in')
    const o = { scenario: admin.id, cookie: 'rscb_session=fx.acc_eric' }
    const code = (a: Ans) => (a.body as { error?: { code: string } }).error?.code
    type View = { items: Array<{ id: string; needsOldKey: boolean }>; running: boolean; lastFailure: unknown }
    const list = (await call('GET', '/v1/admin/backups', o)).body as View
    assert.equal(list.items.length, 3)
    assert.equal(list.items.filter((i) => i.needsOldKey).length, 1)
    const made = await call('POST', '/v1/admin/backups', { ...o, body: {} })
    assert.equal(made.status, 202)
    assert.equal(code(await call('POST', '/v1/admin/backups', { ...o, body: {} })), 'backup_running')
    await new Promise((r) => setTimeout(r, 800))
    const after = (await call('GET', '/v1/admin/backups', o)).body as View
    assert.equal(after.running, false)
    assert.equal(after.items[0]?.id, (made.body as { id: string }).id)
    const id = after.items[1]?.id as string
    const res = await fetch(`${fx.url}/v1/admin/backups/${id}/download`, {
      headers: { 'x-fixture-scenario': admin.id, cookie: o.cookie },
    })
    assert.match(String(res.headers.get('content-disposition')), /^attachment; filename=".+\.rscb"$/)
    assert.deepEqual(validate(doc, 'GET', `/v1/admin/backups/${id}/download`, res.status, null), [])
    seen.add('GET /v1/admin/backups/{id}/download')
    assert.equal(code(await call('GET', '/v1/admin/backups/nope/impact', o)), 'not_found')
    const impact = (await call('GET', `/v1/admin/backups/${id}/impact`, o)).body as { lostWrites: boolean }
    assert.equal(impact.lostWrites, true)
    // The key: only with the password again.
    assert.equal(code(await call('POST', '/v1/admin/installation-key', { ...o, body: {} })), 'reauth_failed')
    const key = (await call('POST', '/v1/admin/installation-key', { ...o, body: { password: fx.password } }))
      .body as { key: string }
    assert.match(key.key, /^fixture-installation-key-/)
    // Restoring: an older key, the name, the password; then every session is over.
    const old = after.items.find((i) => i.needsOldKey)?.id as string
    const restore = (copy: string, body: unknown) =>
      call('POST', `/v1/admin/backups/${copy}/restore`, { ...o, body })
    assert.equal(code(await restore(id, { confirm: 'rsc-brain' })), 'reauth_failed')
    assert.equal(code(await restore(id, { confirm: 'nope', password: fx.password })), 'confirm_mismatch')
    assert.equal(code(await restore(old, { confirm: 'rsc-brain', password: fx.password })), 'wrong_key')
    assert.equal((await restore(id, { confirm: 'rsc-brain', password: fx.password })).status, 200)
    assert.equal((await call('GET', '/v1/me', o)).status, 401)
    // No folder for copies.
    const off = fx.scenario('signed-in')
    await fetch(`${fx.url}/__fixture/scenarios/${off.id}/admin-edit`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ backupsOff: true }),
    })
    const offO = { scenario: off.id, cookie: 'rscb_session=fx.acc_eric' }
    assert.equal(code(await call('POST', '/v1/admin/backups', { ...offO, body: {} })), 'backups_not_set_up')
    // A member: refused.
    const member = fx.scenario('member')
    const ana = { scenario: member.id, cookie: 'rscb_session=fx.acc_ana' }
    assert.equal(code(await call('GET', '/v1/admin/backups', ana)), 'forbidden')
    // The key of the first-time setup: once, to whoever ran it.
    const fresh = fx.scenario('fresh')
    const done = await call('POST', '/v1/setup', {
      scenario: fresh.id,
      body: {
        name: 'Acme',
        publicUrl: 'http://localhost',
        admin: { name: 'Ada', email: 'ada@example.test', password: fx.password },
      },
    })
    const f = { scenario: fresh.id, cookie: cookieOf(done) }
    assert.match(
      ((await call('POST', '/v1/setup/key', { ...f, body: {} })).body as { key: string }).key,
      /^fixture-/,
    )
    assert.equal(code(await call('POST', '/v1/setup/key', { ...f, body: {} })), 'not_found')
  })

  it('every operation the fixture answers was checked against the description', () => {
    assert.deepEqual(
      [...fx.operations].filter((op) => !seen.has(op)),
      [],
    )
  })
})
