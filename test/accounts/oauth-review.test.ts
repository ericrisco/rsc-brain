// Review of B4 PR13: a connection never carries the administration's powers; the consent page tells the
// truth about where a code goes; the client document is refreshed hourly; refresh races are not leaks;
// the audit cannot be emptied, and a cut download says so; and the guards each test pins down.
import assert from 'node:assert/strict'
import { createHash, randomBytes } from 'node:crypto'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { after, before, describe, it } from 'node:test'
import { hashPassword } from '../../src/auth/password.ts'
import { hashSecret } from '../../src/auth/secrets.ts'
import { AUDIT_PAGE } from '../../src/domain/auditlog.ts'
import { forbiddenAddress } from '../../src/oauth/fetch.ts'
import { skipPg } from '../helpers/pg.ts'
import { type World, world } from '../helpers/world.ts'

const PW = 'a long enough password'
const RESOURCE = 'http://localhost/mcp'
const s256 = (v: string) => createHash('sha256').update(v).digest('base64url')
const field = (html: string, name: string) =>
  new RegExp(`name="${name}" value="([^"]*)"`).exec(html)?.[1]?.replace(/&amp;/g, '&') ?? ''

describe('connections: review', { skip: skipPg }, () => {
  let w: World
  let admin: { id: string; key: string }
  let session: string
  let docs: Server
  let docBase = ''
  const served: Record<string, unknown> = {}

  async function get(path: string, cookie = '') {
    const res = await fetch(`${w.base}${path}`, { redirect: 'manual', headers: cookie ? { cookie } : {} })
    return { status: res.status, text: await res.text(), headers: res.headers }
  }
  async function form(path: string, fields: Record<string, string>, cookie = '') {
    const res = await fetch(`${w.base}${path}`, {
      method: 'POST',
      redirect: 'manual',
      headers: { 'content-type': 'application/x-www-form-urlencoded', ...(cookie ? { cookie } : {}) },
      body: new URLSearchParams(fields).toString(),
    })
    const text = await res.text()
    return { status: res.status, text, headers: res.headers, json: () => JSON.parse(text) }
  }
  const register = async (redirect: string, name = 'App') =>
    String(
      (await w.raw('POST', '/oauth/register', { body: { client_name: name, redirect_uris: [redirect] } }))
        .body.client_id,
    )
  const query = (client: string, redirect: string, verifier: string) =>
    new URLSearchParams({
      response_type: 'code',
      client_id: client,
      redirect_uri: redirect,
      code_challenge: s256(verifier),
      code_challenge_method: 'S256',
      resource: RESOURCE,
    }).toString()
  // The consent page for the admin's web session, and the approval of the given brains.
  async function approve(
    client: string,
    redirect: string,
    verifier: string,
    brains: string[],
    perm = 'write',
  ) {
    const page = await get(`/oauth/authorize?${query(client, redirect, verifier)}`, `rscb_session=${session}`)
    const fields: Record<string, string> = {}
    for (const k of [
      'response_type',
      'client_id',
      'redirect_uri',
      'code_challenge',
      'code_challenge_method',
      'resource',
    ]) {
      fields[k] = field(page.text, k)
    }
    for (const slug of brains) {
      fields[`brain_${(await w.db.one('SELECT id FROM brains WHERE slug = $1', [slug]))?.id}`] = 'on'
    }
    const done = await form(
      '/oauth/authorize',
      { ...fields, csrf: field(page.text, 'csrf'), decision: 'approve', perm },
      `rscb_session=${session}`,
    )
    return {
      page,
      done,
      code: new URL(String(done.headers.get('location') ?? 'x:/')).searchParams.get('code') ?? '',
    }
  }
  async function connect(brains: string[], port: number) {
    const redirect = `http://127.0.0.1:${port}/cb`
    const client = await register(redirect)
    const verifier = randomBytes(40).toString('base64url')
    const { code } = await approve(client, redirect, verifier, brains)
    const t = await form('/oauth/token', {
      grant_type: 'authorization_code',
      code,
      code_verifier: verifier,
      redirect_uri: redirect,
      client_id: client,
    })
    return { ...(t.json() as { access_token: string; refresh_token: string }), client, redirect, verifier }
  }

  before(async () => {
    w = await world({ localClients: true })
    admin = await w.person('Admin', { isAdmin: true })
    await w.db.query('UPDATE accounts SET password_hash = $2 WHERE id = $1', [
      admin.id,
      await hashPassword(PW),
    ])
    session = await w.web(admin.id)
    await w.call(admin.key, 'POST', '/v1/brains', { slug: 'alpha' })
    const bob = await w.person('Bob')
    await w.call(bob.key, 'POST', '/v1/brains', { slug: 'gamma' })
    docs = createServer((req, res) => {
      const d = served[req.url ?? '']
      if (d === undefined) return void res.writeHead(404).end()
      res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(d))
    })
    await new Promise<void>((r) => docs.listen(0, '127.0.0.1', r))
    docBase = `http://127.0.0.1:${(docs.address() as AddressInfo).port}`
  })
  after(async () => {
    await new Promise<void>((r) => docs.close(() => r()))
    await w.close()
  })

  it("an administrator's connection to one brain cannot delete, purge, revoke or create elsewhere", async () => {
    const t = await connect(['alpha'], 44001)
    const bob = String((await w.db.one("SELECT id FROM accounts WHERE name = 'Bob'"))?.id)
    const bobToken = String(
      (await w.db.one("SELECT id FROM credentials WHERE account_id = $1 AND kind = 'token'", [bob]))?.id,
    )
    assert.ok(
      (await w.call(t.access_token, 'DELETE', '/v1/brains/gamma', { confirm: 'gamma' })).status >= 400,
    )
    assert.ok(await w.db.one("SELECT 1 FROM brains WHERE slug = 'gamma'"))
    assert.ok((await w.call(t.access_token, 'DELETE', `/v1/keys/${bobToken}`)).status >= 400)
    assert.equal(
      (await w.db.one('SELECT revoked_at FROM credentials WHERE id = $1', [bobToken]))?.revoked_at,
      null,
    )
    assert.ok((await w.call(t.access_token, 'POST', '/v1/brains', { slug: 'from-app' })).status >= 400)
    // A narrowed personal token of the administration does not carry them either.
    const narrow = await w.token(admin.id, {
      brainIds: [String((await w.db.one("SELECT id FROM brains WHERE slug = 'alpha'"))?.id)],
    })
    assert.ok((await w.call(narrow, 'DELETE', '/v1/brains/gamma', { confirm: 'gamma' })).status >= 400)
    assert.ok(await w.db.one("SELECT 1 FROM brains WHERE slug = 'gamma'"))
  })

  it('an app scheme shows as an app on this device, never as the domain written after it', async () => {
    const redirect = 'x-evil://claude.ai/callback'
    const client = await register(redirect, 'Claude')
    const page = await get(
      `/oauth/authorize?${query(client, redirect, 'v'.repeat(43))}`,
      `rscb_session=${session}`,
    )
    assert.equal(page.status, 200)
    assert.ok(!/<span class="domain">claude\.ai<\/span>/.test(page.text))
    assert.match(page.text, /x-evil: \(an app on this device\)/)
  })

  it('a client document is fetched again after an hour: a withdrawn return address stops working', async () => {
    const id = `${docBase}/c1.json`
    served['/c1.json'] = { client_id: id, client_name: 'One', redirect_uris: ['https://old.example/cb'] }
    assert.equal(
      (
        await get(
          `/oauth/authorize?${query(id, 'https://old.example/cb', 'v'.repeat(43))}`,
          `rscb_session=${session}`,
        )
      ).status,
      200,
    )
    served['/c1.json'] = { client_id: id, client_name: 'One', redirect_uris: ['https://new.example/cb'] }
    w.advance(61 * 60_000)
    assert.equal(
      (
        await get(
          `/oauth/authorize?${query(id, 'https://old.example/cb', 'v'.repeat(43))}`,
          `rscb_session=${session}`,
        )
      ).status,
      400,
    )
    w.advance(-61 * 60_000)
  })

  it('a client document with control characters or a NUL is not a server error', async () => {
    const id = `${docBase}/nul.json`
    served['/nul.json'] = {
      client_id: id,
      client_name: 'A\u0000B\u0007C',
      redirect_uris: ['http://127.0.0.1/callback'],
    }
    const r = await get(
      `/oauth/authorize?${query(id, 'http://127.0.0.1/callback', 'v'.repeat(43))}`,
      `rscb_session=${session}`,
    )
    assert.equal(r.status, 200, r.text)
    assert.match(r.text, /Connect “A B C”/)
    served['/nuluri.json'] = {
      client_id: `${docBase}/nuluri.json`,
      redirect_uris: ['http://127.0.0.1/c\u0000b'],
    }
    assert.equal(
      (
        await get(
          `/oauth/authorize?${query(`${docBase}/nuluri.json`, 'http://127.0.0.1/cb', 'v'.repeat(43))}`,
        )
      ).status,
      400,
    )
  })

  it('a network failure fetching a client document is not described to the caller', async () => {
    const r = await get(
      `/oauth/authorize?${query('http://127.0.0.1:1/x.json', 'http://127.0.0.1/cb', 'v'.repeat(43))}`,
    )
    assert.equal(r.status, 400)
    assert.ok(!/ECONNREFUSED|EHOSTUNREACH|socket|127\.0\.0\.1:1/i.test(r.text), r.text)
  })

  it('more IPv6 forms of inside addresses are refused', () => {
    for (const ip of ['::7f00:1', '::ffff:0:7f00:1', 'fec0::1', '::ffff:7f00:1'])
      assert.equal(forbiddenAddress(ip), true, ip)
  })

  it('two refreshes at once with one token: one wins, and the connection lives', async () => {
    const t = await connect(['alpha'], 44002)
    const both = await Promise.all(
      [1, 2].map(() =>
        form('/oauth/token', {
          grant_type: 'refresh_token',
          refresh_token: t.refresh_token,
          client_id: t.client,
        }),
      ),
    )
    const winner = both.find((b) => b.status === 200)?.json() as {
      access_token: string
      refresh_token: string
    }
    assert.ok(winner, both.map((b) => b.text).join(' | '))
    assert.equal((await w.call(winner.access_token, 'GET', '/v1/brains/alpha')).status, 200)
    const next = await form('/oauth/token', {
      grant_type: 'refresh_token',
      refresh_token: winner.refresh_token,
      client_id: t.client,
    })
    assert.equal(next.status, 200)
  })

  it('a refresh must name its client', async () => {
    const t = await connect(['alpha'], 44003)
    const none = await form('/oauth/token', { grant_type: 'refresh_token', refresh_token: t.refresh_token })
    assert.equal(none.json().error, 'invalid_grant')
  })

  it('malformed requests to the token endpoint answer in the standard shape', async () => {
    const r = await fetch(`${w.base}/oauth/token`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: 'grant_type=refresh_token&grant_type=refresh_token',
    })
    const body = (await r.json()) as { error: unknown }
    assert.deepEqual([r.status, body.error], [400, 'invalid_request'])
  })

  it('approving with no brain says why, on the page', async () => {
    const redirect = 'http://127.0.0.1:44004/cb'
    const client = await register(redirect)
    const { done } = await approve(client, redirect, 'w'.repeat(43), [])
    assert.equal(done.status, 200)
    assert.match(done.text, /class="error"[^>]*>Choose at least one brain/)
  })

  it('the consent token is for one request: it does not approve another client', async () => {
    const r1 = 'http://127.0.0.1:44005/cb'
    const c1 = await register(r1)
    const r2 = 'http://127.0.0.1:44006/cb'
    const c2 = await register(r2)
    const page = await get(`/oauth/authorize?${query(c1, r1, 'w'.repeat(43))}`, `rscb_session=${session}`)
    const alpha = String((await w.db.one("SELECT id FROM brains WHERE slug = 'alpha'"))?.id)
    const other = await form(
      '/oauth/authorize',
      {
        ...Object.fromEntries(new URLSearchParams(query(c2, r2, 'w'.repeat(43)))),
        csrf: field(page.text, 'csrf'),
        decision: 'approve',
        perm: 'write',
        [`brain_${alpha}`]: 'on',
      },
      `rscb_session=${session}`,
    )
    assert.equal(other.status, 403)
  })

  it('the code exchange checks the client and the resource; the code lasts exactly 60 seconds', async () => {
    const redirect = 'http://127.0.0.1:44007/cb'
    const client = await register(redirect)
    const other = await register('http://127.0.0.1:44008/cb')
    const v = randomBytes(40).toString('base64url')
    const ex = (code: string, extra: Record<string, string> = {}) =>
      form('/oauth/token', {
        grant_type: 'authorization_code',
        code,
        code_verifier: v,
        redirect_uri: redirect,
        client_id: client,
        ...extra,
      })
    assert.equal(
      (await ex((await approve(client, redirect, v, ['alpha'])).code, { client_id: other })).json().error,
      'invalid_grant',
    )
    assert.equal(
      (
        await ex((await approve(client, redirect, v, ['alpha'])).code, {
          resource: 'https://elsewhere.example/mcp',
        })
      ).json().error,
      'invalid_target',
    )
    const atEdge = (await approve(client, redirect, v, ['alpha'])).code
    w.advance(60_000)
    assert.equal((await ex(atEdge)).json().error, 'invalid_grant')
    w.advance(-60_000)
    const inTime = (await approve(client, redirect, v, ['alpha'])).code
    w.advance(59_000)
    assert.equal((await ex(inTime)).status, 200)
    w.advance(-59_000)
  })

  it('a key of an ended connection stops even if the key itself was not touched; using it keeps the connection alive', async () => {
    const t = await connect(['alpha'], 44009)
    const g = String(
      (
        await w.db.one('SELECT grant_id FROM credentials WHERE secret_hash = $1', [
          hashSecret(t.access_token),
        ])
      )?.grant_id,
    )
    w.advance(30 * 60_000)
    assert.equal((await w.call(t.access_token, 'GET', '/v1/brains/alpha')).status, 200)
    const used = await w.db.one<{ at: Date }>('SELECT last_used_at AS at FROM oauth_grants WHERE id = $1', [
      g,
    ])
    assert.equal(used?.at.getTime(), w.now.getTime())
    w.advance(-30 * 60_000)
    await w.db.query('UPDATE oauth_grants SET revoked_at = $2 WHERE id = $1', [g, w.now])
    assert.equal(
      (await w.call(t.access_token, 'GET', '/v1/brains/alpha')).body.error?.code,
      'connection_ended',
    )
  })

  it('a connection ends a year after it began, however often it is refreshed; a removed account cannot refresh', async () => {
    let t = await connect(['alpha'], 44010)
    for (let i = 0; i < 5; i++) {
      w.advance(80 * 86_400_000)
      const r = await form('/oauth/token', {
        grant_type: 'refresh_token',
        refresh_token: t.refresh_token,
        client_id: t.client,
      })
      if (i < 4) {
        assert.equal(r.status, 200, `refresh ${i}`)
        t = { ...t, ...(r.json() as { access_token: string; refresh_token: string }) }
      } else assert.equal(r.json().error, 'invalid_grant', 'past 365 days')
    }
    w.advance(-400 * 86_400_000)
    const u = await connect(['alpha'], 44011)
    const listed = (await w.callWeb(session, 'GET', '/v1/me/apps')).body.apps as unknown[]
    assert.ok(listed.length >= 1)
    await w.db.query("UPDATE accounts SET status = 'removed' WHERE id = $1", [admin.id])
    assert.equal(
      (
        await form('/oauth/token', {
          grant_type: 'refresh_token',
          refresh_token: u.refresh_token,
          client_id: u.client,
        })
      ).json().error,
      'invalid_grant',
    )
    await w.db.query("UPDATE accounts SET status = 'active' WHERE id = $1", [admin.id])
    // The connections refreshed in the future of the clock end here, so later tests start clean.
    await w.db.query('UPDATE oauth_grants SET revoked_at = $1 WHERE revoked_at IS NULL', [w.now])
  })

  it('connected apps lists only live connections: not idle ones, not those from before a restore', async () => {
    await connect(['alpha'], 44012)
    w.advance(91 * 86_400_000)
    const later = await w.web(admin.id)
    assert.equal(((await w.callWeb(later, 'GET', '/v1/me/apps')).body.apps as unknown[]).length, 0)
    w.advance(-91 * 86_400_000)
  })
})

describe('the audit: review', { skip: skipPg }, () => {
  let w: World
  let web: string

  before(async () => {
    w = await world()
    const admin = await w.person('Admin', { isAdmin: true })
    web = await w.web(admin.id)
  })
  after(async () => w.close())

  it('cannot be emptied either', async () => {
    await assert.rejects(w.db.query('TRUNCATE audit'), /append-only/)
  })

  it('pages with "before" without repeating or skipping a row, and filters by time', async () => {
    await w.db.query(
      `INSERT INTO audit (at, actor_id, credential_id, action, outcome, detail)
       SELECT $1::timestamptz + make_interval(secs => g), NULL, NULL, 'test.row', 'ok', g::text FROM generate_series(1, $2::int) g`,
      [w.now, AUDIT_PAGE + 20],
    )
    const p1 = (await w.callWeb(web, 'GET', '/v1/admin/audit?action=test.row')).body as {
      items: Array<{ id: string; detail: string }>
      next: string
    }
    const p2 = (await w.callWeb(web, 'GET', `/v1/admin/audit?action=test.row&before=${p1.next}`)).body as {
      items: Array<{ id: string }>
      next: string | null
    }
    assert.equal(p1.items.length, AUDIT_PAGE)
    assert.equal(p2.items.length, 20)
    assert.equal(p2.next, null)
    assert.equal(new Set([...p1.items, ...p2.items].map((x) => x.id)).size, AUDIT_PAGE + 20)
    const from = new Date(w.now.getTime() + 111_000).toISOString()
    const late = (await w.callWeb(web, 'GET', `/v1/admin/audit?action=test.row&from=${from}`)).body
      .items as unknown[]
    assert.equal(late.length, 10)
  })

  it('a download that does not hold everything says so, and is itself recorded', async () => {
    await w.db.query(
      `INSERT INTO audit (at, actor_id, credential_id, action, outcome) SELECT $1, NULL, NULL, 'bulk', 'ok' FROM generate_series(1, 100001)`,
      [w.now],
    )
    const res = await fetch(`${w.base}/v1/admin/audit/export`, { headers: { cookie: `rscb_session=${web}` } })
    assert.equal(res.headers.get('x-audit-truncated'), 'true')
    await res.text()
    assert.ok(await w.db.one("SELECT 1 FROM audit WHERE action = 'audit.export'"))
  })
})
