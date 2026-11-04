// Companion mode (plan F1 §3.1, T047; spec F1 C24, CA1): rsc-factory's installer leaves rsc-brain installed but not
// set up, with a one-time key both share. While it waits, rsc-brain's own setup says to finish in rsc-factory; when
// rsc-factory's setup is done, it calls POST /v1/setup/companion with that key from the shared network and gets the
// main key of its service account. Once set up, the key serves nothing.
import assert from 'node:assert/strict'
import { after, before, describe, it } from 'node:test'
import pg from 'pg'
import { hashPassword } from '../../src/auth/password.ts'
import type { CompanionConfig } from '../../src/config.ts'
import { bumpKeyEpoch } from '../../src/domain/installation.ts'
import { skipPg } from '../helpers/pg.ts'
import { type World, world } from '../helpers/world.ts'

const WEB = { 'x-requested-with': 'rsc-brain-web' }
const TOKEN = 'c0ffee'.repeat(11)
const FACTORY = 'https://factory.example.com'
const admin = { name: 'Eric', email: 'eric@example.com', password: 'a long enough password' }
const body = {
  publicUrl: 'https://brain.example.com',
  factoryUrl: FACTORY,
  admin,
  serviceName: 'rsc-factory',
}
// The test server listens on 127.0.0.1: here that is «the shared network».
const SHARED: CompanionConfig = {
  token: TOKEN,
  network: '127.0.0.0/8',
  gateway: null,
  factoryUrl: FACTORY,
  publicUrl: null,
}
const auth = (t = TOKEN) => ({ authorization: `Bearer ${t}` })

const companionWorld = (o: { companion?: Partial<CompanionConfig>; trustedProxies?: string[] } = {}) =>
  world({
    fresh: true,
    companion: { ...SHARED, ...(o.companion ?? {}) },
    trustedProxies: o.trustedProxies ?? [],
  })

type Me = { account: { kind: string; name: string }; installation: { factoryUrl: string | null } }
const meOf = async (w: World, key: unknown) => {
  const r = await w.call(String(key), 'GET', '/v1/me')
  assert.equal(r.status, 200, r.text)
  return r.body as unknown as Me
}
const errorOf = (r: { body: Record<string, unknown> }) =>
  (r.body.error ?? {}) as { code?: string; message?: string; howToProceed?: string; factoryUrl?: string }

const setUp = async (w: World) => (await w.raw('GET', '/v1/branding')).body.setupRequired === false
const counts = async (w: World) =>
  (await w.db.one<{ people: number; services: number }>(
    "SELECT count(*) FILTER (WHERE kind = 'person')::int AS people, count(*) FILTER (WHERE kind = 'service')::int AS services FROM accounts",
  )) ?? { people: -1, services: -1 }

describe('companion mode: waiting for rsc-factory', { skip: skipPg }, () => {
  let w: World
  before(async () => {
    w = await companionWorld()
  })
  after(async () => w.close())

  it('the setup of rsc-brain says to finish in rsc-factory, with its address, and takes no password', async () => {
    const state = await w.raw('GET', '/v1/setup')
    assert.deepEqual([state.status, state.body.error?.code], [409, 'companion_pending'], state.text)
    assert.equal(errorOf(state).message, 'Finish the setup in rsc-factory.')
    assert.equal(errorOf(state).factoryUrl, FACTORY)
    assert.match(errorOf(state).howToProceed ?? '', /factory\.example\.com/)
    const post = await w.raw('POST', '/v1/setup', {
      headers: WEB,
      body: { name: 'Mine', publicUrl: 'http://localhost', admin },
    })
    assert.deepEqual([post.status, post.body.error?.code], [409, 'companion_pending'])
    // Reconnecting is for after the setup.
    const early = await w.raw('POST', '/v1/setup/companion/reconnect', {
      headers: auth(),
      body: { email: admin.email, password: admin.password },
    })
    assert.deepEqual([early.status, early.body.error?.code], [409, 'companion_pending'])
    assert.equal(await setUp(w), false)
    assert.deepEqual(await counts(w), { people: 0, services: 0 })
  })

  it('401 without the key, with another key, or with part of it; each refusal audited, nothing set up', async () => {
    for (const headers of [{}, auth('f'.repeat(66)), auth(TOKEN.slice(0, 32)), { authorization: TOKEN }]) {
      const r = await w.raw('POST', '/v1/setup/companion', { headers, body })
      assert.deepEqual([r.status, r.body.error?.code], [401, 'unauthorized'], r.text)
    }
    assert.equal(await setUp(w), false)
    const denied = await w.db.one<{ n: number }>(
      "SELECT count(*)::int AS n FROM audit WHERE action = 'installation.companion' AND outcome = 'denied'",
    )
    assert.equal(denied?.n, 4)
  })

  it('through a proxy (X-Forwarded-*, Forwarded) it is not there, even with the key', async () => {
    for (const h of [
      { 'x-forwarded-for': '203.0.113.7' },
      { 'x-forwarded-proto': 'https' },
      { forwarded: 'for=1.2.3.4' },
    ]) {
      const r = await w.raw('POST', '/v1/setup/companion', { headers: { ...auth(), ...h }, body })
      assert.deepEqual([r.status, r.body.error?.code], [404, 'no_such_route'], r.text)
    }
    assert.equal(await setUp(w), false)
  })

  it('400 with the password rule of rsc-brain, or an address of rsc-factory it cannot keep; nothing set up', async () => {
    const weak = await w.raw('POST', '/v1/setup/companion', {
      headers: auth(),
      body: { ...body, admin: { ...admin, password: 'short' } },
    })
    assert.deepEqual([weak.status, weak.body.error?.code], [400, 'invalid_request'])
    assert.match(errorOf(weak).message ?? '', /12/)
    const factory = await w.raw('POST', '/v1/setup/companion', {
      headers: auth(),
      body: { ...body, factoryUrl: 'http://factory.example.com' },
    })
    assert.deepEqual([factory.status, factory.body.error?.code], [400, 'invalid_request'])
    assert.equal(await setUp(w), false)
  })

  it('CA1: with the key, the administration and the service account of rsc-factory, in one go; then the key serves nothing', async () => {
    const r = await w.raw('POST', '/v1/setup/companion', { headers: auth(), body })
    assert.equal(r.status, 201, r.text)
    assert.deepEqual(Object.keys(r.body).sort(), ['adminId', 'serviceId', 'serviceKey'])
    // The main key of the service account works, and the installation links runs to rsc-factory.
    const me = await meOf(w, r.body.serviceKey)
    assert.deepEqual([me.account.kind, me.account.name], ['service', 'rsc-factory'])
    assert.equal(me.installation.factoryUrl, FACTORY)
    // It may create brains and invite their first curator (spec F1: projects, approvers).
    const svc = await w.db.one<{ c: boolean; i: boolean }>(
      "SELECT can_create_brains AS c, can_invite AS i FROM accounts WHERE id = $1 AND kind = 'service'",
      [r.body.serviceId],
    )
    assert.deepEqual([svc?.c, svc?.i], [true, true])
    // The administration signs in with rsc-factory's email and password.
    const login = await w.raw('POST', '/v1/auth/login', {
      headers: WEB,
      body: { email: admin.email, password: admin.password },
    })
    assert.equal(login.status, 200, login.text)
    assert.equal(await setUp(w), true)
    // One use: the same key again, and the setup of the web, are gone.
    const again = await w.raw('POST', '/v1/setup/companion', { headers: auth(), body })
    assert.deepEqual([again.status, again.body.error?.code], [404, 'setup_done'])
    // Whatever key comes: once set up, there is nothing to guess.
    const wrong = await w.raw('POST', '/v1/setup/companion', { headers: auth('f'.repeat(66)), body })
    assert.deepEqual([wrong.status, wrong.body.error?.code], [404, 'setup_done'])
    assert.deepEqual([(await w.raw('GET', '/v1/setup')).status], [404])
    assert.deepEqual(await counts(w), { people: 1, services: 1 })
    const audited = await w.db.one<{ detail: string }>(
      "SELECT detail FROM audit WHERE action = 'installation.setup' AND outcome = 'ok'",
    )
    assert.match(audited?.detail ?? '', /^companion from 127\.0\.0\.1: /)
  })
})

describe('companion mode: two calls at once', { skip: skipPg }, () => {
  let w: World
  before(async () => {
    w = await companionWorld()
  })
  after(async () => w.close())

  it('exactly one sets up; the other is told it is done; one administration, one service account', async () => {
    const calls = await Promise.all(
      Array.from({ length: 4 }, (_, i) =>
        w.raw('POST', '/v1/setup/companion', {
          headers: auth(),
          body: { ...body, admin: { ...admin, email: `eric${i}@example.com` } },
        }),
      ),
    )
    const statuses = calls.map((c) => c.status).sort()
    assert.deepEqual(statuses, [201, 404, 404, 404], calls.map((c) => c.text).join('\n'))
    for (const c of calls.filter((x) => x.status === 404)) assert.equal(c.body.error?.code, 'setup_done')
    assert.deepEqual(await counts(w), { people: 1, services: 1 })
  })
})

describe('companion mode: defaults from the launcher', { skip: skipPg }, () => {
  let w: World
  before(async () => {
    w = await companionWorld({ companion: { publicUrl: 'http://localhost:8090' } })
  })
  after(async () => w.close())

  it('without publicUrl, factoryUrl or serviceName in the body: those the launcher set, and «rsc-factory»', async () => {
    const r = await w.raw('POST', '/v1/setup/companion', { headers: auth(), body: { admin } })
    assert.equal(r.status, 201, r.text)
    const me = await meOf(w, r.body.serviceKey)
    assert.deepEqual([me.account.name, me.installation.factoryUrl], ['rsc-factory', FACTORY])
    const row = await w.db.one<{ public_url: string; name: string }>(
      'SELECT public_url, name FROM installation',
    )
    assert.deepEqual([row?.public_url, row?.name], ['http://localhost:8090', 'rsc-brain'])
  })
})

describe('companion mode: only where it is meant to be', { skip: skipPg }, () => {
  const call = (w: World) => w.raw('POST', '/v1/setup/companion', { headers: auth(), body })
  const cases: Array<[string, Parameters<typeof companionWorld>[0]]> = [
    ['from outside the shared network', { companion: { network: '10.99.0.0/16' } }],
    ['from the shared network’s gateway (this machine)', { companion: { gateway: '127.0.0.1' } }],
    ['from the trusted proxy, even without its headers', { trustedProxies: ['127.0.0.1'] }],
  ]
  for (const [what, o] of cases) {
    it(`${what}: not there, even with the key; nothing set up`, async () => {
      const w = await companionWorld(o)
      try {
        const r = await call(w)
        assert.deepEqual([r.status, r.body.error?.code], [404, 'no_such_route'], r.text)
        assert.equal(await setUp(w), false)
      } finally {
        await w.close()
      }
    })
  }

  it('an installation not in companion mode: the route is not there, and the setup of the web is as always', async () => {
    const w = await world({ fresh: true, trustedProxies: [] })
    try {
      const r = await call(w)
      assert.deepEqual([r.status, r.body.error?.code], [404, 'no_such_route'])
      assert.equal((await w.raw('GET', '/v1/setup')).status, 200)
    } finally {
      await w.close()
    }
  })
})

// Without the row lock of the setup, two calls that both read «not set up» would both set up. Made deterministic: the
// accounts table is held in SHARE mode, so each call stops at its first INSERT (or, with the lock, the second at the
// lock itself); once both wait, the table is let go.
describe('companion mode: the setup takes its row lock (deterministic)', { skip: skipPg }, () => {
  let w: World
  before(async () => {
    w = await companionWorld()
  })
  after(async () => w.close())

  it('two calls held at the same point: one sets up, the other is told it is done', async () => {
    // One connection holds the table; another watches (pg_stat_activity is a snapshot frozen within a transaction).
    const hold = new pg.Client({ connectionString: w.url })
    const watch = new pg.Client({ connectionString: w.url })
    await hold.connect()
    await watch.connect()
    try {
      await hold.query('BEGIN')
      await hold.query('LOCK TABLE accounts IN SHARE MODE')
      const calls = [0, 1].map((i) =>
        w.raw('POST', '/v1/setup/companion', {
          headers: auth(),
          body: { ...body, admin: { ...admin, email: `held${i}@example.com` } },
        }),
      )
      const end = Date.now() + 20_000
      for (;;) {
        const r = await watch.query(
          "SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname = current_database() AND wait_event_type = 'Lock'",
        )
        if (r.rows[0].n >= 2) break
        if (Date.now() > end) throw new Error('the two calls never both waited')
        await new Promise((res) => setTimeout(res, 20))
      }
      await hold.query('COMMIT')
      const got = await Promise.all(calls)
      assert.deepEqual(got.map((c) => c.status).sort(), [201, 404], got.map((c) => c.text).join('\n'))
      assert.deepEqual(await counts(w), { people: 1, services: 1 })
    } finally {
      await hold.query('ROLLBACK').catch(() => {})
      await hold.end()
      await watch.end()
    }
  })
})

// After the setup (spec F1 C24 «Finish connecting rsc-brain»): a lost answer, or a restore that killed every key,
// leaves rsc-factory without its main key. With the one-time key and an administrator's email and password it gets a
// new one; the one before stops working.
describe('companion mode: reconnecting rsc-factory', { skip: skipPg }, () => {
  let w: World
  let first = { serviceKey: '', serviceId: '', adminId: '' }
  const reconnect = (
    o: { token?: string; email?: string; password?: string; headers?: Record<string, string> } = {},
  ) =>
    w.raw('POST', '/v1/setup/companion/reconnect', {
      headers: { ...auth(o.token), ...(o.headers ?? {}) },
      body: { email: o.email ?? admin.email, password: o.password ?? admin.password },
    })
  before(async () => {
    w = await companionWorld()
    const r = await w.raw('POST', '/v1/setup/companion', { headers: auth(), body })
    assert.equal(r.status, 201, r.text)
    first = r.body as typeof first
  })
  after(async () => w.close())

  it('a new main key for the same service account; the one before (and what hangs from it) stops working', async () => {
    // A short key made from the main key before (an agent's step): it goes with it.
    const brain = await w.call(first.serviceKey, 'POST', '/v1/brains', {
      slug: 'project',
      firstCurator: admin.email,
    })
    assert.equal(brain.status, 201, brain.text)
    const short = await w.call(first.serviceKey, 'POST', '/v1/keys/short', {
      writeBrain: 'project',
      ref: 'run r_0000abcd step 1',
      ttlMinutes: 60,
    })
    assert.equal(short.status, 201, short.text)
    const shortKey = (short.body.key as { secret: string }).secret
    assert.equal((await w.call(shortKey, 'GET', '/v1/me')).status, 200)
    const r = await reconnect()
    assert.equal(r.status, 201, r.text)
    assert.deepEqual(Object.keys(r.body).sort(), ['adminId', 'serviceId', 'serviceKey'])
    assert.equal(r.body.serviceId, first.serviceId)
    assert.equal(r.body.adminId, first.adminId)
    assert.notEqual(r.body.serviceKey, first.serviceKey)
    assert.equal((await w.call(String(r.body.serviceKey), 'GET', '/v1/me')).status, 200)
    assert.equal((await w.call(first.serviceKey, 'GET', '/v1/me')).status, 401)
    assert.equal((await w.call(shortKey, 'GET', '/v1/me')).status, 401)
    const live = await w.db.one<{ n: number }>(
      'SELECT count(*)::int AS n FROM credentials WHERE account_id = $1 AND revoked_at IS NULL',
      [first.serviceId],
    )
    assert.equal(live?.n, 1)
    const audited = await w.db.one<{ actor_id: string }>(
      "SELECT actor_id FROM audit WHERE action = 'installation.companion.reconnect' AND outcome = 'ok'",
    )
    assert.equal(audited?.actor_id, first.adminId)
    first.serviceKey = String(r.body.serviceKey)
  })

  it('after a restore killed every key: reconnecting gives one that works', async () => {
    await bumpKeyEpoch(w.db)
    assert.equal((await w.call(first.serviceKey, 'GET', '/v1/me')).status, 401)
    const r = await reconnect()
    assert.equal(r.status, 201, r.text)
    assert.equal((await w.call(String(r.body.serviceKey), 'GET', '/v1/me')).status, 200)
  })

  it('the service account gone (renamed by hand): a new rsc-factory account that may create brains and invite', async () => {
    await w.db.query("UPDATE accounts SET name = 'old factory' WHERE id = $1", [first.serviceId])
    const r = await reconnect()
    assert.equal(r.status, 201, r.text)
    assert.notEqual(r.body.serviceId, first.serviceId)
    const svc = await w.db.one<{ name: string; c: boolean; i: boolean }>(
      'SELECT name, can_create_brains AS c, can_invite AS i FROM accounts WHERE id = $1',
      [r.body.serviceId],
    )
    assert.deepEqual([svc?.name, svc?.c, svc?.i], ['rsc-factory', true, true])
  })

  it('refused: without the one-time key (401, audited), through a proxy (404), by someone who is not an administrator (403)', async () => {
    const before = await w.db.one<{ n: number }>(
      "SELECT count(*)::int AS n FROM credentials WHERE kind = 'main' AND revoked_at IS NULL",
    )
    const wrongKey = await reconnect({ token: 'f'.repeat(66) })
    assert.deepEqual([wrongKey.status, wrongKey.body.error?.code], [401, 'unauthorized'])
    const proxied = await reconnect({ headers: { 'x-forwarded-for': '203.0.113.7' } })
    assert.deepEqual([proxied.status, proxied.body.error?.code], [404, 'no_such_route'])
    const ana = await w.person('Ana', { email: 'ana@example.com' })
    await w.db.query('UPDATE accounts SET password_hash = $2 WHERE id = $1', [
      ana.id,
      await hashPassword('ana long password'),
    ])
    const notAdmin = await reconnect({ email: 'ana@example.com', password: 'ana long password' })
    assert.deepEqual([notAdmin.status, notAdmin.body.error?.code], [403, 'forbidden'])
    const after = await w.db.one<{ n: number }>(
      "SELECT count(*)::int AS n FROM credentials WHERE kind = 'main' AND revoked_at IS NULL",
    )
    assert.equal(after?.n, before?.n)
    const denied = await w.db.one<{ n: number }>(
      "SELECT count(*)::int AS n FROM audit WHERE action LIKE 'installation.companion%' AND outcome = 'denied'",
    )
    assert.equal(denied?.n, 2)
  })

  it('wrong passwords: the brake of signing in, shared with signing in', async () => {
    // As signing in: four wrong ones are told so; the fifth starts the wait; then even the right one waits.
    for (let i = 0; i < 4; i++) {
      const r = await reconnect({ password: 'not the password at all' })
      assert.deepEqual([r.status, r.body.error?.code], [401, 'bad_credentials'], r.text)
    }
    const fifth = await reconnect({ password: 'not the password at all' })
    assert.deepEqual([fifth.status, fifth.body.error?.code], [429, 'too_many_attempts'])
    const braked = await reconnect()
    assert.deepEqual([braked.status, braked.body.error?.code], [429, 'too_many_attempts'])
    const login = await w.raw('POST', '/v1/auth/login', {
      headers: WEB,
      body: { email: admin.email, password: admin.password },
    })
    assert.deepEqual([login.status, login.body.error?.code], [429, 'too_many_attempts'])
  })
})
