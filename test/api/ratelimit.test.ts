// Spec B5 «Errores, límites y recibos»: 600 requests per minute per key by default, refused with when
// to retry (CA14); the same refusal on the MCP endpoint in its own shape (CA9); the administration
// adjusts the limit in the settings.
import assert from 'node:assert/strict'
import { after, before, describe, it } from 'node:test'
import { MODERN } from '../../src/mcp/server.ts'
import { skipPg } from '../helpers/pg.ts'
import { type World, world } from '../helpers/world.ts'

describe('the rate limit per key', { skip: skipPg }, () => {
  let w: World
  let admin: { id: string; key: string }
  let adminWeb: string

  before(async () => {
    w = await world()
    admin = await w.person('Admin', { isAdmin: true })
    adminWeb = await w.web(admin.id)
  })
  after(async () => w.close())

  const mcpList = (key: string) =>
    w.raw('POST', '/mcp', {
      body: {
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/list',
        params: { _meta: { 'io.modelcontextprotocol/protocolVersion': MODERN } },
      },
      headers: {
        authorization: `Bearer ${key}`,
        'mcp-protocol-version': MODERN,
        'mcp-method': 'tools/list',
      },
    })

  it('CA14: the 601st request in a minute is refused with when to retry; other keys go on', async () => {
    const eric = await w.person('Eric')
    const other = await w.person('Other')
    for (let i = 0; i < 600; i += 1) {
      const r = await w.call(eric.key, 'GET', '/v1/me')
      assert.equal(r.status, 200, `request ${i + 1}: ${r.text}`)
    }
    const r = await w.raw('GET', '/v1/me', { headers: { authorization: `Bearer ${eric.key}` } })
    assert.equal(r.status, 429)
    assert.equal(r.headers.get('retry-after'), '60')
    const e = r.body.error as unknown as {
      code: string
      message: string
      howToProceed: string
      retryAfter: number
    }
    assert.equal(e.code, 'rate_limited')
    assert.match(e.message, /600 requests per minute/)
    assert.match(e.howToProceed, /60 seconds/)
    assert.equal(e.retryAfter, 60)
    // Another key is not slowed down by this one.
    assert.equal((await w.call(other.key, 'GET', '/v1/me')).status, 200)
    // Half a minute later the window still holds the 600; a minute later it has passed.
    w.advance(30_000)
    const later = await w.raw('GET', '/v1/me', { headers: { authorization: `Bearer ${eric.key}` } })
    assert.equal(later.status, 429)
    assert.equal(later.headers.get('retry-after'), '30')
    w.advance(30_000)
    assert.equal((await w.call(eric.key, 'GET', '/v1/me')).status, 200)
  })

  it('CA9: on the MCP endpoint the refusal comes as JSON-RPC, with what happened and how to proceed', async () => {
    const set = await w.callWeb(adminWeb, 'PUT', '/v1/admin/settings', { rateLimit: 3 })
    assert.equal(set.status, 200, set.text)
    try {
      const agent = await w.person('Agent')
      for (let i = 0; i < 3; i += 1) assert.equal((await mcpList(agent.key)).status, 200)
      const r = await mcpList(agent.key)
      assert.equal(r.status, 429)
      assert.ok(Number(r.headers.get('retry-after')) > 0)
      const err = r.body.error as unknown as { code: number; message: string; data: Record<string, unknown> }
      assert.equal(typeof err.code, 'number')
      assert.match(err.message, /^rate_limited: .+ How to proceed: .+/)
      assert.equal(err.data.code, 'rate_limited')
      assert.equal(err.data.retryAfter, 60)
    } finally {
      w.advance(60_000)
      await w.callWeb(adminWeb, 'PUT', '/v1/admin/settings', { rateLimit: 600 })
    }
  })

  it('the administration adjusts the limit in the settings; only the administration, only sensible values', async () => {
    const before = await w.callWeb(adminWeb, 'GET', '/v1/admin/settings')
    assert.equal(before.body.rateLimit, 600)
    for (const bad of [0, -1, 1.5, 'many', 1_000_001]) {
      const r = await w.callWeb(adminWeb, 'PUT', '/v1/admin/settings', { rateLimit: bad })
      assert.equal(r.status, 400, `${bad}: ${r.text}`)
      assert.equal(r.body.error?.code, 'invalid_request')
    }
    const nobody = await w.person('Nobody')
    assert.equal(
      (await w.callWeb(await w.web(nobody.id), 'PUT', '/v1/admin/settings', { rateLimit: 2 })).status,
      403,
    )
    const set = await w.callWeb(adminWeb, 'PUT', '/v1/admin/settings', { rateLimit: 2 })
    assert.equal(set.body.rateLimit, 2)
    try {
      const k = await w.person('Kay')
      assert.equal((await w.call(k.key, 'GET', '/v1/me')).status, 200)
      assert.equal((await w.call(k.key, 'GET', '/v1/me')).status, 200)
      const r = await w.call(k.key, 'GET', '/v1/me')
      assert.equal(r.status, 429)
      assert.match(r.body.error?.message ?? '', /2 requests per minute/)
    } finally {
      w.advance(60_000)
      await w.callWeb(adminWeb, 'PUT', '/v1/admin/settings', { rateLimit: 600 })
    }
  })

  it('lowering the limit counts what a key already did: Retry-After says when enough of it has passed', async () => {
    const k = await w.person('Busy')
    // Five requests, ten seconds apart; then the administration lowers the limit to two.
    for (let i = 0; i < 5; i += 1) {
      assert.equal((await w.call(k.key, 'GET', '/v1/me')).status, 200)
      w.advance(10_000)
    }
    await w.callWeb(adminWeb, 'PUT', '/v1/admin/settings', { rateLimit: 2 })
    try {
      const r = await w.raw('GET', '/v1/me', { headers: { authorization: `Bearer ${k.key}` } })
      assert.equal(r.status, 429)
      // The requests were at 0, 10, 20, 30 and 40 s; it is 50 s. For fewer than two to stand in the
      // minute, the one at 30 s must leave it: at 90 s, 40 s from now.
      assert.equal(r.headers.get('retry-after'), '40')
      w.advance(39_000)
      assert.equal((await w.call(k.key, 'GET', '/v1/me')).status, 429)
      w.advance(1_000)
      assert.equal((await w.call(k.key, 'GET', '/v1/me')).status, 200)
    } finally {
      w.advance(60_000)
      await w.callWeb(adminWeb, 'PUT', '/v1/admin/settings', { rateLimit: 600 })
    }
  })

  it('a refused request does not count: a client that keeps knocking gets in once the minute has passed', async () => {
    await w.callWeb(adminWeb, 'PUT', '/v1/admin/settings', { rateLimit: 2 })
    try {
      const k = await w.person('Knock')
      await w.call(k.key, 'GET', '/v1/me')
      await w.call(k.key, 'GET', '/v1/me')
      for (let i = 0; i < 5; i += 1) {
        w.advance(10_000)
        assert.equal((await w.call(k.key, 'GET', '/v1/me')).status, 429)
      }
      w.advance(10_001)
      assert.equal((await w.call(k.key, 'GET', '/v1/me')).status, 200)
    } finally {
      w.advance(60_000)
      await w.callWeb(adminWeb, 'PUT', '/v1/admin/settings', { rateLimit: 600 })
    }
  })
})
