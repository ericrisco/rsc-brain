// CA7b and C12 (plan §3.1, risk 1): during maintenance every write is refused with 503 under_maintenance and a
// time to retry, and reads keep working without leaving a trail. The walk over ROUTES and the MCP catalog is
// what keeps it so: a new write route is a write unless it is pinned below as one that changes nothing, so it
// cannot slip past the gate unclassified.
import assert from 'node:assert/strict'
import { after, before, describe, it } from 'node:test'
import { closeIdle } from '../../src/domain/sessions.ts'
import { ROUTES } from '../../src/http/app.ts'
import {
  isWrite,
  MAINTENANCE_MESSAGE,
  maintenance,
  retryAfter,
  whenOpen,
} from '../../src/http/maintenance.ts'
import { MODERN } from '../../src/mcp/server.ts'
import { TOOLS } from '../../src/mcp/tools.ts'
import { skipPg } from '../helpers/pg.ts'
import { type World, world } from '../helpers/world.ts'

// The only routes other than GET that the gate lets through, and why. Adding one here is a decision.
const NOT_WRITES: Record<string, 'reads' | 'own'> = {
  // Look up what a repository resolves to; a topic suggestion; whether a reset link or an invitation is
  // still good. They change nothing.
  'POST /v1/resolve': 'reads',
  'POST /v1/brains/:slug/topics/suggest': 'reads',
  'POST /v1/auth/reset/look': 'reads',
  'POST /v1/invitations/look': 'reads',
  // The MCP endpoint gates each tool call itself (write tools are refused; reading tools answer).
  'POST /mcp': 'own',
  'DELETE /mcp': 'own',
}

describe('what the gate counts as a write', () => {
  it('every route other than GET is a write unless pinned here, and GET never is', () => {
    const passed: Record<string, string> = {}
    for (const r of ROUTES) {
      const op = `${r.method} ${r.path}`
      if (r.method === 'GET' || r.method === 'HEAD') {
        assert.equal(isWrite(r), false, op)
        continue
      }
      if (!isWrite(r)) passed[op] = String(r.maintenance)
    }
    assert.deepEqual(passed, NOT_WRITES)
  })

  it('every MCP tool says whether it writes, and its annotations agree', () => {
    for (const t of TOOLS) assert.equal(t.writes, !t.annotations.readOnlyHint, t.name)
    assert.ok(TOOLS.some((t) => t.writes) && TOOLS.some((t) => !t.writes))
  })

  it('retryAfter: what is left of the maintenance, at most 120 seconds and at least 5', () => {
    const now = new Date('2026-11-01T10:00:00Z')
    const m = (s: number) => ({ until: new Date(now.getTime() + s * 1000), reason: 'update' as const })
    assert.equal(retryAfter(m(1800), now), 120)
    assert.equal(retryAfter(m(121), now), 120)
    assert.equal(retryAfter(m(119), now), 119)
    assert.equal(retryAfter(m(30), now), 30)
    assert.equal(retryAfter(m(5), now), 5)
    assert.equal(retryAfter(m(4), now), 5)
    assert.equal(retryAfter({ ...m(0), until: new Date(now.getTime() + 30_500) }, now), 31)
    assert.equal(MAINTENANCE_MESSAGE(42), 'rsc-brain is under maintenance, retry after 42 seconds')
  })
})

const META = {
  'io.modelcontextprotocol/protocolVersion': MODERN,
  'io.modelcontextprotocol/clientInfo': { name: 'test-agent', version: '1.0.0' },
  'io.modelcontextprotocol/clientCapabilities': {},
}

describe('the maintenance gate', { skip: skipPg }, () => {
  let w: World
  let eric: { id: string; key: string }
  let web: string
  let entryId: string
  const count = async (table: string) =>
    Number((await w.db.one<{ n: string }>(`SELECT count(*) AS n FROM ${table}`))?.n)

  before(async () => {
    w = await world()
    eric = await w.person('Eric', { isAdmin: true })
    web = await w.web(eric.id)
    await w.call(eric.key, 'POST', '/v1/brains', { slug: 'alpha', purpose: 'Gate.' })
    const saved = await w.call(eric.key, 'POST', '/v1/brains/alpha/entries', {
      type: 'decision',
      title: 'Retention first',
      content: 'We measure retention before anything else.',
    })
    entryId = String((saved.body.receipt as Record<string, unknown>).entryId)
    await maintenance.on(w.db, w.clock(), { reason: 'update' })
  })
  after(async () => w.close())

  const refused = (
    op: string,
    r: { status: number; body: Record<string, unknown>; headers: Headers; text: string },
  ) => {
    assert.equal(r.status, 503, `${op}: ${r.text}`)
    assert.equal(r.headers.get('retry-after'), '120', op)
  }

  it('CA7b: every write of ROUTES answers 503 under_maintenance with Retry-After, before anything else', async () => {
    const before = await count('audit')
    let walked = 0
    for (const r of ROUTES) {
      if (!isWrite(r)) continue
      walked += 1
      const path = r.path.replace(/[:*](\w+)/g, (_, k) => (k === 'slug' ? 'alpha' : 'x'))
      const op = `${r.method} ${r.path}`
      const res = await w.raw(r.method, path, {
        body: {},
        headers: r.public
          ? { 'x-requested-with': 'rsc-brain-web' }
          : { cookie: `rscb_session=${web}`, 'x-requested-with': 'rsc-brain-web' },
      })
      refused(op, res)
      if (r.path.startsWith('/oauth/')) {
        assert.equal(res.body.error, 'temporarily_unavailable', op)
        assert.equal(res.body.error_description, MAINTENANCE_MESSAGE(120), op)
      } else {
        const e = res.body.error as Record<string, unknown>
        assert.equal(e.code, 'under_maintenance', op)
        assert.equal(e.message, MAINTENANCE_MESSAGE(120), op)
        assert.ok(String(e.howToProceed).length > 0, op)
        assert.equal(res.body.retryAfter, 120, op)
      }
    }
    assert.ok(walked > 60, `walked ${walked}`)
    assert.equal(await count('audit'), before, 'nothing was written')
  })

  it('a key over a bearer is refused the same: save, revoke a key, change a role', async () => {
    const ana = await w.person('Ana')
    for (const [method, path, body] of [
      ['POST', '/v1/brains/alpha/entries', { type: 'note', title: 'x', content: 'y' }],
      ['DELETE', `/v1/me/tokens/whatever`, undefined],
      ['PUT', `/v1/brains/alpha/members/${ana.id}`, { role: 'curator' }],
    ] as const) {
      const r = await w.raw(method, path, {
        ...(body ? { body } : {}),
        headers: { authorization: `Bearer ${eric.key}` },
      })
      refused(`${method} ${path}`, r)
    }
  })

  it('signing in and renewing a connection are writes (C12)', async () => {
    const login = await w.raw('POST', '/v1/auth/login', {
      body: { email: 'eric@example.com', password: 'whatever whatever' },
      headers: { 'x-requested-with': 'rsc-brain-web' },
    })
    refused('login', login)
    const res = await fetch(`${w.base}/oauth/token`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: 'rscb_x', client_id: 'x' }),
    })
    assert.equal(res.status, 503)
    assert.equal(res.headers.get('retry-after'), '120')
    assert.equal(((await res.json()) as Record<string, unknown>).error, 'temporarily_unavailable')
  })

  async function mcp(name: string, args: Record<string, unknown>) {
    const res = await fetch(`${w.base}/mcp`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${eric.key}`,
        'mcp-protocol-version': MODERN,
        'mcp-method': 'tools/call',
        'mcp-name': name,
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 7,
        method: 'tools/call',
        params: { name, arguments: args, _meta: META },
      }),
    })
    return { status: res.status, headers: res.headers, body: (await res.json()) as Record<string, unknown> }
  }

  it('every MCP tool that writes is refused with 503 and Retry-After; reading tools answer', async () => {
    for (const t of TOOLS) {
      const r = await mcp(t.name, { brain: 'alpha', query: 'retention', id: entryId })
      if (t.writes) {
        assert.equal(r.status, 503, `${t.name}: ${JSON.stringify(r.body)}`)
        assert.equal(r.headers.get('retry-after'), '120', t.name)
        const e = r.body.error as { code: number; message: string; data: Record<string, unknown> }
        assert.equal(e.data.code, 'under_maintenance', t.name)
        assert.equal(e.data.retryAfter, 120, t.name)
        assert.match(e.message, /under maintenance/, t.name)
      } else {
        assert.equal(r.status, 200, `${t.name}: ${JSON.stringify(r.body)}`)
        assert.doesNotMatch(JSON.stringify(r.body), /under_maintenance/, t.name)
      }
    }
  })

  it('reads answer 200 and leave no trail, no event and no last use behind', async () => {
    const trail = await count('trail')
    const events = await count('events')
    const used = await w.db.query('SELECT id, last_used_at FROM credentials ORDER BY id')
    w.advance(5 * 60_000)
    for (const path of [
      '/v1/search?q=retention',
      `/v1/entries/${entryId}`,
      '/v1/brains/alpha/context',
      '/v1/brains/alpha/sessions',
      '/v1/brains',
    ]) {
      const r = await w.call(eric.key, 'GET', path)
      assert.equal(r.status, 200, `${path}: ${r.text}`)
    }
    assert.equal((await w.callWeb(web, 'GET', '/v1/me')).status, 200)
    assert.equal(await count('trail'), trail, 'no trail')
    assert.equal(await count('events'), events, 'no events')
    assert.deepEqual(await w.db.query('SELECT id, last_used_at FROM credentials ORDER BY id'), used)
  })

  it('sweeps pause: idle sessions stay open, and the sweeps of serve do not run', async () => {
    await w.db.query("UPDATE sessions SET last_activity_at = $1::timestamptz - interval '2 days'", [
      w.clock(),
    ])
    assert.equal(await closeIdle(w.db, w.clock()), 0)
    const r = await w.call(eric.key, 'GET', '/v1/brains/alpha/sessions')
    assert.equal(r.status, 200)
    assert.equal(await count("sessions WHERE status = 'open'"), 1)
    let ran = 0
    await whenOpen(w.db, w.clock, async () => {
      ran += 1
    })
    assert.equal(ran, 0)
  })

  it('Retry-After shrinks as the end nears, and never goes under 5 seconds', async () => {
    await maintenance.on(w.db, w.clock(), { seconds: 60, reason: 'manual' })
    w.advance(30_000)
    const a = await w.call(eric.key, 'POST', '/v1/brains/alpha/entries', {
      type: 'note',
      title: 'a',
      content: 'b',
    })
    assert.equal(a.body.retryAfter, 30)
    w.advance(28_000)
    const b = await w.call(eric.key, 'POST', '/v1/brains/alpha/entries', {
      type: 'note',
      title: 'a',
      content: 'b',
    })
    assert.equal(b.body.retryAfter, 5)
  })

  it('once it ends (or expires), writes are taken again and sweeps run', async () => {
    w.advance(3_000)
    const saved = await w.call(eric.key, 'POST', '/v1/brains/alpha/entries', {
      type: 'note',
      title: 'After',
      content: 'Written after the maintenance expired.',
    })
    assert.equal(saved.status, 201, saved.text)
    await maintenance.on(w.db, w.clock(), { reason: 'manual' })
    await maintenance.off(w.db)
    const again = await w.call(eric.key, 'POST', '/v1/brains/alpha/entries', {
      type: 'note',
      title: 'Again',
      content: 'Written after the maintenance was turned off.',
    })
    assert.equal(again.status, 201, again.text)
    let ran = 0
    await whenOpen(w.db, w.clock, async () => {
      ran += 1
    })
    assert.equal(ran, 1)
    const trail = await count('trail')
    await w.call(eric.key, 'GET', '/v1/search?q=retention')
    assert.equal(await count('trail'), trail + 1, 'the trail is written again')
  })
})
