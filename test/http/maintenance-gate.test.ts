// CA7b and C12 (plan §3.1, risk 1): during maintenance every write is refused with 503 under_maintenance and a
// time to retry, and reads keep working without leaving a trail. The walk over ROUTES and the MCP catalog is
// what keeps it so: a new write route is a write unless it is pinned below as one that changes nothing, so it
// cannot slip past the gate unclassified.
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { after, before, describe, it } from 'node:test'
import { makeLog } from '../../src/core/log.ts'
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

// The only GET routes that write, so the gate refuses them (review of PR27): an export is not allowed without
// its audit record. The table-hash probe below finds any other.
const GET_WRITES: Record<string, 'writes'> = {
  'GET /v1/admin/audit/export': 'writes',
  // B7 PR30: downloading a copy records it.
  'GET /v1/admin/backups/:id/download': 'writes',
  // Exporting a brain (B7 PR31) records itself in the audit and the brain's activity.
  'GET /v1/brains/:slug/export': 'writes',
}

// The only routes other than GET that the gate lets through, and why. Adding one here is a decision.
const NOT_WRITES: Record<string, 'reads' | 'own'> = {
  // The sign-in and consent forms of the standard sign-in answer maintenance with a page of their own.
  'POST /oauth/login': 'own',
  'POST /oauth/authorize': 'own',
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
  it('every route other than GET is a write unless pinned here, and a GET only when pinned', () => {
    const passed: Record<string, string> = {}
    const gets: Record<string, string> = {}
    for (const r of ROUTES) {
      const op = `${r.method} ${r.path}`
      if (r.method === 'GET' || r.method === 'HEAD') {
        if (isWrite(r)) gets[op] = String(r.maintenance)
        continue
      }
      if (!isWrite(r)) passed[op] = String(r.maintenance)
    }
    assert.deepEqual(passed, NOT_WRITES)
    assert.deepEqual(gets, GET_WRITES)
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

// Revoking and signing out are refused too (a rollback would silently undo them); their refusal names the
// way out.
const ENDS_ACCESS = new Set([
  'POST /v1/auth/logout',
  'POST /v1/auth/logout-everywhere',
  'DELETE /v1/keys/:id',
  'DELETE /v1/me/tokens/:id',
  'POST /v1/me/revoke-all',
  'DELETE /v1/me/apps/:id',
  'DELETE /v1/admin/apps/:id',
  'POST /v1/admin/accounts/:id/remove',
  // Taking someone out of a brain; changing an account (it can drop the administration).
  'DELETE /v1/brains/:slug/members/:account',
  'PATCH /v1/admin/accounts/:id',
])

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
  let sessionId: string
  let proposalId: string
  let docs: Server
  let clientId: string
  let rita: { id: string; key: string }
  let ritaWeb: string
  const logged: string[] = []
  const count = async (table: string) =>
    Number((await w.db.one<{ n: string }>(`SELECT count(*) AS n FROM ${table}`))?.n)

  before(async () => {
    w = await world({ localClients: true, log: makeLog((l) => logged.push(l)) })
    // A client document of the standard sign-in, served from this machine.
    docs = createServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' }).end(
        JSON.stringify({
          client_id: clientId,
          client_name: 'Probe',
          redirect_uris: ['http://127.0.0.1/cb'],
        }),
      )
    })
    await new Promise<void>((r) => docs.listen(0, '127.0.0.1', r))
    clientId = `http://127.0.0.1:${(docs.address() as AddressInfo).port}/client.json`
    eric = await w.person('Eric', { isAdmin: true })
    web = await w.web(eric.id)
    await w.call(eric.key, 'POST', '/v1/brains', { slug: 'alpha', purpose: 'Gate.' })
    const saved = await w.call(eric.key, 'POST', '/v1/brains/alpha/entries', {
      type: 'decision',
      title: 'Retention first',
      content: 'We measure retention before anything else.',
    })
    entryId = String((saved.body.receipt as Record<string, unknown>).entryId)
    sessionId = String((await w.db.one<{ id: string }>('SELECT id FROM sessions LIMIT 1'))?.id)
    const proposed = await w.call(eric.key, 'POST', '/v1/brains/alpha/proposals', {
      title: 'Retention',
      reason: 'The journal says so.',
      ops: [
        {
          op: 'create',
          address: 'growth/retention',
          type: 'topic',
          title: 'Retention',
          summary: 'Retention first.',
          body: 'We measure retention before anything else.',
          sources: [{ entryId }],
          reason: 'One decision.',
        },
      ],
    })
    proposalId = String((proposed.body.proposal as Record<string, unknown>).id)
    await w.callWeb(web, 'POST', '/v1/brains/alpha/wiki/changes', {
      op: 'create',
      address: 'growth/intros',
      type: 'decision',
      title: 'Intros',
      summary: 'Short intros.',
      body: 'Keep them short.',
      tags: [],
      sources: [{ entryId }],
      reason: 'From the journal.',
    })
    await w.call(eric.key, 'POST', '/v1/brains', { slug: 'beta', purpose: 'Not Rita’s.' })
    rita = await w.person('Rita')
    ritaWeb = await w.web(rita.id)
    await w.member('alpha', rita.id, 'reader')
    await maintenance.on(w.db, w.clock(), { reason: 'update' })
  })
  after(async () => {
    await new Promise<void>((r) => docs.close(() => r()))
    await w.close()
  })

  // A fingerprint of every table of the database: any write anywhere changes it.
  async function fingerprint(): Promise<Record<string, string>> {
    const tables = await w.db.query<{ t: string }>(
      "SELECT tablename AS t FROM pg_tables WHERE schemaname = 'public' ORDER BY 1",
    )
    const out: Record<string, string> = {}
    for (const { t } of tables) {
      const r = await w.db.one<{ h: string | null }>(
        `SELECT md5(string_agg(x::text, '|' ORDER BY x::text)) AS h FROM "${t}" x`,
      )
      out[t] = r?.h ?? 'empty'
    }
    return out
  }

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
        ...(r.method === 'GET' ? {} : { body: {} }),
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
        // Ending access cannot wait silently: the way out is ending the maintenance (review of PR27).
        assert.equal(
          String(e.howToProceed).includes('`rsc-brain maintenance off`'),
          ENDS_ACCESS.has(op),
          `${op}: ${e.howToProceed}`,
        )
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

  // Every GET of ROUTES (event streams never end on their own: their reads are covered by the trail tests),
  // with a bearer key and with a web session, for each of these brains.
  async function probeGets(key: string, session: string, slugs: string[]): Promise<number> {
    const paramOf = (path: string, k: string, slug: string) => {
      if (k === 'slug') return slug
      if (k === 'address') return 'growth/intros'
      if (k === 'account') return eric.id
      if (k !== 'id') return 'x'
      if (path.startsWith('/v1/entries/')) return entryId
      if (path.startsWith('/v1/sessions/')) return sessionId
      if (path.startsWith('/v1/proposals/')) return proposalId
      if (path.startsWith('/v1/admin/accounts/')) return eric.id
      return 'x'
    }
    const query: Record<string, string> = {
      '/v1/search': '?q=retention',
      '/v1/brains/:slug/trail': '?ref=x',
      '/v1/brains/:slug/pages/*address': '?history=1',
      '/v1/entries/:id': '?history=1',
    }
    let probed = 0
    for (const slug of slugs) {
      for (const r of ROUTES) {
        if (r.method !== 'GET' || r.path.endsWith('/events')) continue
        if (slug !== slugs[0] && !r.path.includes(':slug')) continue
        const path = r.path.replace(/[:*](\w+)/g, (_, k) => paramOf(r.path, k, slug)) + (query[r.path] ?? '')
        for (const headers of [
          { authorization: `Bearer ${key}` },
          { cookie: `rscb_session=${session}`, 'x-requested-with': 'rsc-brain-web' },
        ]) {
          const res = await fetch(`${w.base}${path}`, { headers, redirect: 'manual' })
          await res.arrayBuffer()
          assert.ok(res.status < 500 || (isWrite(r) && res.status === 503), `${r.path}: ${res.status}`)
          probed += 1
        }
      }
    }
    return probed
  }

  it('every GET of ROUTES, with a key and in the web, leaves every table as it was (review of PR27)', async () => {
    const before = await fingerprint()
    assert.ok((await probeGets(eric.key, web, ['alpha'])) > 100)
    // The consent page fetches the client's document; it is not kept while maintenance lasts.
    const authz = new URLSearchParams({
      response_type: 'code',
      client_id: clientId,
      redirect_uri: 'http://127.0.0.1/cb',
      code_challenge: createHash('sha256').update('v'.repeat(43)).digest('base64url'),
      code_challenge_method: 'S256',
      state: 's',
      resource: 'http://localhost/mcp',
    })
    for (const cookie of ['', `rscb_session=${web}`]) {
      const page = await fetch(`${w.base}/oauth/authorize?${authz}`, { headers: cookie ? { cookie } : {} })
      const html = await page.text()
      assert.equal(page.status, 200, html)
      assert.match(html, /Probe/)
    }
    assert.deepEqual(await fingerprint(), before)
  })

  it('a reader, refused here and there, leaves every table as it was too; the refusals go to the log', async () => {
    const before = await fingerprint()
    logged.length = 0
    // Rita reads alpha and is not a member of beta; she is no administrator. Over the API, in the web and
    // through the MCP reading tools.
    assert.ok((await probeGets(rita.key, ritaWeb, ['alpha', 'beta'])) > 100)
    for (const t of TOOLS.filter((x) => !x.writes)) {
      for (const brain of ['alpha', 'beta']) {
        const res = await fetch(`${w.base}/mcp`, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            authorization: `Bearer ${rita.key}`,
            'mcp-protocol-version': MODERN,
            'mcp-method': 'tools/call',
            'mcp-name': t.name,
          },
          body: JSON.stringify({
            jsonrpc: '2.0',
            id: 1,
            method: 'tools/call',
            params: { name: t.name, arguments: { brain, query: 'retention', id: entryId }, _meta: META },
          }),
        })
        assert.equal(res.status, 200, `${t.name} ${brain}`)
        await res.text()
      }
    }
    assert.deepEqual(await fingerprint(), before)
    const denials = logged
      .map((l) => JSON.parse(l) as Record<string, unknown>)
      .filter((l) => l.event === 'access_denied')
    assert.ok(denials.length > 0, 'the refusals are in the log')
    for (const d of denials) {
      assert.equal(d.outcome, 'denied')
      assert.equal(d.account, rita.id)
      assert.match(String(d.action), /^[a-z_.]+$/)
    }
  })

  it('the audit export, a GET that writes its own record, is refused while maintenance lasts', async () => {
    const r = await w.callWeb(web, 'GET', '/v1/admin/audit/export')
    assert.equal(r.status, 503, r.text)
    assert.equal((r.body.error as Record<string, unknown>).code, 'under_maintenance')
  })

  it('exporting a brain, a GET that writes its record, is refused while maintenance lasts', async () => {
    const r = await w.call(eric.key, 'GET', '/v1/brains/alpha/export?format=readable')
    assert.equal(r.status, 503, r.text)
    assert.equal((r.body.error as Record<string, unknown>).code, 'under_maintenance')
  })

  it('the sign-in and consent forms answer a page in English with Retry-After and a way back', async () => {
    const q = new URLSearchParams({ response_type: 'code', client_id: clientId, state: 's<b>' })
    for (const [path, fields] of [
      ['/oauth/login', { continue: q.toString(), email: 'e@example.com', password: 'x' }],
      ['/oauth/authorize', { ...Object.fromEntries(q), decision: 'approve' }],
    ] as const) {
      const res = await fetch(`${w.base}${path}`, {
        method: 'POST',
        redirect: 'manual',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams(fields as Record<string, string>).toString(),
      })
      const html = await res.text()
      assert.equal(res.status, 503, `${path}: ${html}`)
      assert.equal(res.headers.get('retry-after'), '120', path)
      assert.match(res.headers.get('content-type') ?? '', /text\/html/, path)
      assert.match(html, /rsc-brain is updating\. Try again in 120 seconds\./, path)
      const back = /<a href="([^"]+)"/.exec(html)?.[1]?.replace(/&amp;/g, '&') ?? ''
      assert.ok(back.startsWith('/oauth/authorize?'), `${path}: ${back}`)
      assert.equal(new URLSearchParams(back.split('?')[1]).get('client_id'), clientId, path)
      assert.doesNotMatch(html, /<b>/, 'what came in is escaped')
    }
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
    // One line per brain searched (Eric reads alpha and beta).
    assert.equal(await count('trail'), trail + 2, 'the trail is written again')
  })
})
