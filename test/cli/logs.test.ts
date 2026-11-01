// CA17 (spec B7 «Salud y registros»; plan §3.11, §5.2): a day of use of a real `rsc-brain serve` — entries,
// searches, signing in with a password, a new token, an agent over MCP — and nothing of it reaches the
// process's output: no content, no searched text, no password, no key, no authorization header, not even a
// prefix of one. What it does write is one JSON line per event with only the fields of src/core/log.ts.
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createServer } from 'node:net'
import { after, before, describe, it } from 'node:test'
import { hashPassword } from '../../src/auth/password.ts'
import { LOG_FIELDS } from '../../src/core/log.ts'
import { migrate } from '../../src/db/migrate.ts'
import { createAccount } from '../../src/domain/accounts.ts'
import { mintPersonToken } from '../../src/domain/keys.ts'
import { ROUTES } from '../../src/http/app.ts'
import { MODERN } from '../../src/mcp/server.ts'
import { freshDatabase, skipPg, type TestDb } from '../helpers/pg.ts'

const CLI = new URL('../../src/cli/main.ts', import.meta.url).pathname
const WEB = { 'x-requested-with': 'rsc-brain-web' }

const CANARY = {
  title: 'canary-title-5d1e7b',
  content: 'canary-content-7f3a91 our plan for the quarter',
  query: 'canary-query-b2c4d8',
  password: 'canary-password-91e7c0 horse battery',
  secret: 'canary-installation-secret-0123456789abcdef',
  slug: 'canary-slug-4e8f20',
  tokenName: 'canary-token-name-3a7c',
  agent: 'canary-agent-6b2d91',
}

const freePort = () =>
  new Promise<number>((resolve) => {
    const s = createServer()
    s.listen(0, '127.0.0.1', () => {
      const port = (s.address() as { port: number }).port
      s.close(() => resolve(port))
    })
  })

describe('CA17: the logs of a day of use', { skip: skipPg }, () => {
  let t: TestDb
  before(async () => {
    t = await freshDatabase()
  })
  after(async () => t.drop())

  it('hold no content, searched text, password, key or authorization header', async () => {
    await migrate(t.db)
    await t.db.query(
      "UPDATE installation SET name = 'T', public_url = 'http://localhost', setup_done_at = now()",
    )
    const clock = () => new Date()
    const id = await createAccount(t.db, clock, {
      kind: 'person',
      name: 'Eric',
      email: 'eric@example.com',
      canCreateBrains: true,
      isAdmin: true,
    })
    await t.db.query('UPDATE accounts SET password_hash = $2 WHERE id = $1', [
      id,
      await hashPassword(CANARY.password),
    ])
    const key = (
      await mintPersonToken(t.db, clock, {
        accountId: id,
        name: 't',
        perm: 'write',
        allBrains: true,
        days: 1,
      })
    ).secret
    const secrets: string[] = [key]
    const port = await freePort()
    const p = spawn(process.execPath, [CLI, 'serve'], {
      env: {
        ...process.env,
        RSC_BRAIN_DATABASE_URL: t.url,
        RSC_BRAIN_PORT: String(port),
        RSC_BRAIN_SECRET: CANARY.secret,
      },
    })
    let out = ''
    let err = ''
    p.stderr.on('data', (d) => {
      err += d
    })
    const exited = new Promise<void>((r) => p.on('exit', () => r()))
    await new Promise<void>((resolve, reject) => {
      p.stdout.on('data', (d) => {
        out += d
        if (out.includes('"listening"')) resolve()
      })
      p.on('exit', () => reject(new Error(`serve exited early: ${out}${err}`)))
    })
    const base = `http://127.0.0.1:${port}`
    const call = async (
      method: string,
      path: string,
      body?: unknown,
      headers: Record<string, string> = {},
    ) => {
      const res = await fetch(`${base}${path}`, {
        method,
        headers: {
          authorization: `Bearer ${key}`,
          ...(body === undefined ? {} : { 'content-type': 'application/json' }),
          ...headers,
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      })
      return {
        status: res.status,
        headers: res.headers,
        body: (await res.json().catch(() => ({}))) as Record<string, unknown>,
      }
    }
    try {
      assert.equal((await call('POST', '/v1/brains', { slug: CANARY.slug })).status, 201)
      const saved = await call('POST', `/v1/brains/${CANARY.slug}/entries`, {
        type: 'decision',
        title: CANARY.title,
        content: CANARY.content,
      })
      assert.equal(saved.status, 201)
      assert.equal((await call('GET', `/v1/search?q=${encodeURIComponent(CANARY.query)}`)).status, 200)
      // A short key for an agent, named with a canary; a key nobody issued, in the header.
      const short = await call('POST', '/v1/keys/short', {
        writeBrain: CANARY.slug,
        agent: CANARY.agent,
        ttlMinutes: 5,
      })
      if (typeof (short.body.key as { secret?: string } | undefined)?.secret === 'string')
        secrets.push((short.body.key as { secret: string }).secret)
      assert.equal(
        (
          await call('GET', '/v1/me', undefined, {
            authorization: 'Bearer rscb_canaryheaderthatisnokey0000000000',
          })
        ).status,
        401,
      )
      // Signing in with the password, a wrong one, and a new token from the web.
      const bad = await fetch(`${base}/v1/auth/login`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...WEB },
        body: JSON.stringify({ email: 'eric@example.com', password: `${CANARY.password} wrong` }),
      })
      assert.equal(bad.status, 401)
      const login = await fetch(`${base}/v1/auth/login`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...WEB },
        body: JSON.stringify({ email: 'eric@example.com', password: CANARY.password }),
      })
      assert.equal(login.status, 200, await login.clone().text())
      const cookie = /rscb_session=([^;]+)/.exec(login.headers.get('set-cookie') ?? '')?.[1] ?? ''
      assert.ok(cookie)
      secrets.push(cookie)
      const made = await fetch(`${base}/v1/me/tokens`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', cookie: `rscb_session=${cookie}`, ...WEB },
        body: JSON.stringify({ name: CANARY.tokenName, perm: 'read', allBrains: true, days: 30 }),
      })
      assert.equal(made.status, 201, await made.clone().text())
      const token = ((await made.json()) as { token?: { secret?: string } }).token?.secret
      assert.ok(token)
      secrets.push(token)
      // An agent searching over MCP.
      const mcp = await fetch(`${base}/mcp`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${key}`,
          'mcp-protocol-version': MODERN,
          'mcp-method': 'tools/call',
          'mcp-name': 'mem_search',
        },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'tools/call',
          params: {
            name: 'mem_search',
            arguments: { brain: CANARY.slug, query: CANARY.query },
            _meta: {
              'io.modelcontextprotocol/protocolVersion': MODERN,
              'io.modelcontextprotocol/clientInfo': { name: 'test', version: '1' },
              'io.modelcontextprotocol/clientCapabilities': {},
            },
          },
        }),
      })
      assert.equal(mcp.status, 200)
      await mcp.text()
    } finally {
      p.kill('SIGTERM')
      await Promise.race([exited, new Promise((r) => setTimeout(r, 8000))])
    }
    const all = out + err
    for (const [name, canary] of Object.entries(CANARY)) {
      assert.ok(!all.includes(canary), `the log holds the ${name}`)
    }
    for (const s of secrets) {
      assert.ok(!all.includes(s.slice(0, 16)), 'the log holds (a prefix of) a key or session')
    }
    assert.ok(!all.includes('rscb_'), 'the log holds something shaped like a key')
    // Only JSON lines with the fields of the list; routes are templates of the route table.
    const templates = new Set([...ROUTES.map((r) => r.path), '/v1/health'])
    const lines = out.trim().split('\n')
    assert.ok(lines.length >= 10, out)
    const allowed = new Set(['at', 'level', 'event', ...LOG_FIELDS])
    for (const l of lines) {
      const o = JSON.parse(l) as Record<string, unknown>
      for (const k of Object.keys(o)) assert.ok(allowed.has(k), `"${k}" in ${l}`)
      if (o.route !== undefined) assert.ok(templates.has(String(o.route)), l)
    }
    assert.ok(
      lines.some((l) => l.includes('"route":"/v1/brains/:slug/entries"') && l.includes('"status":201')),
    )
    assert.equal(err, '', 'nothing on standard error')
  })
})
