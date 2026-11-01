// Spec B4 «Conexiones con el inicio de sesión estándar de MCP» (CA12–CA14, CA27–CA29) and «Auditoría»
// (CA23): an agent's browser signs in and consents; the agent exchanges the code with its proof; a
// connection never does more than consented nor than the person's role; it ends when revoked, idle or
// old. The audit shows what happened and cannot be edited.
import assert from 'node:assert/strict'
import { createHash, randomBytes } from 'node:crypto'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { after, before, describe, it } from 'node:test'
import { hashPassword } from '../../src/auth/password.ts'
import { bumpKeyEpoch } from '../../src/domain/installation.ts'
import { FetchRefused, fetchJson, forbiddenAddress } from '../../src/oauth/fetch.ts'
import { skipPg } from '../helpers/pg.ts'
import { type World, world } from '../helpers/world.ts'

const PW = 'a long enough password'
const RESOURCE = 'http://localhost/mcp'
const s256 = (v: string) => createHash('sha256').update(v).digest('base64url')
const field = (html: string, name: string) =>
  new RegExp(`name="${name}" value="([^"]*)"`).exec(html)?.[1]?.replace(/&amp;/g, '&') ?? ''

describe('connections with the standard sign-in', { skip: skipPg }, () => {
  let w: World
  let eric: { id: string; key: string }
  let email: string
  let docs: Server
  let docBase = ''
  const docsServed: Record<string, unknown> = {}

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
  const register = async (redirect: string, name = 'Claude Code') => {
    const r = await w.raw('POST', '/oauth/register', {
      body: { client_name: name, redirect_uris: [redirect], token_endpoint_auth_method: 'none' },
    })
    return { status: r.status, body: r.body as Record<string, unknown> }
  }
  const authzQuery = (
    clientId: string,
    redirect: string,
    challenge: string,
    extra: Record<string, string> = {},
  ) =>
    new URLSearchParams({
      response_type: 'code',
      client_id: clientId,
      redirect_uri: redirect,
      code_challenge: challenge,
      code_challenge_method: 'S256',
      state: 'st-123',
      resource: RESOURCE,
      scope: 'brain:read brain:write',
      ...extra,
    }).toString()

  // Signs Eric in through the page, then approves the chosen brains: returns the code and the session.
  async function consent(
    clientId: string,
    redirect: string,
    verifier: string,
    o: { brains: string[]; perm: 'read' | 'write' },
  ) {
    const q = authzQuery(clientId, redirect, s256(verifier))
    const login = await get(`/oauth/authorize?${q}`)
    assert.equal(login.status, 200, login.text)
    const nonceCookie = /rscb_form=([^;]+)/.exec(login.headers.get('set-cookie') ?? '')?.[1] ?? ''
    const signed = await form(
      '/oauth/login',
      {
        email,
        password: PW,
        nonce: field(login.text, 'nonce'),
        csrf: field(login.text, 'csrf'),
        continue: field(login.text, 'continue'),
      },
      `rscb_form=${nonceCookie}`,
    )
    assert.equal(signed.status, 303, signed.text)
    const session = /rscb_session=([^;]+)/.exec(signed.headers.get('set-cookie') ?? '')?.[1] ?? ''
    const page = await get(String(signed.headers.get('location')), `rscb_session=${session}`)
    assert.equal(page.status, 200)
    const fields: Record<string, string> = {}
    for (const k of [
      'response_type',
      'client_id',
      'redirect_uri',
      'state',
      'code_challenge',
      'code_challenge_method',
      'resource',
      'scope',
    ]) {
      fields[k] = field(page.text, k)
    }
    for (const slug of o.brains) {
      const id = String((await w.db.one('SELECT id FROM brains WHERE slug = $1', [slug]))?.id)
      fields[`brain_${id}`] = 'on'
    }
    const done = await form(
      '/oauth/authorize',
      { ...fields, csrf: field(page.text, 'csrf'), decision: 'approve', perm: o.perm },
      `rscb_session=${session}`,
    )
    assert.equal(done.status, 303, done.text)
    const back = new URL(String(done.headers.get('location')))
    return { code: back.searchParams.get('code') ?? '', back, session, page: page.text }
  }
  const exchange = (fields: Record<string, string>) =>
    form('/oauth/token', { grant_type: 'authorization_code', ...fields })

  before(async () => {
    w = await world({ localClients: true })
    eric = await w.person('Eric')
    email = String((await w.db.one('SELECT email FROM accounts WHERE id = $1', [eric.id]))?.email)
    await w.db.query('UPDATE accounts SET password_hash = $2 WHERE id = $1', [
      eric.id,
      await hashPassword(PW),
    ])
    await w.call(eric.key, 'POST', '/v1/brains', { slug: 'alpha' })
    await w.call(eric.key, 'POST', '/v1/brains', { slug: 'beta' })
    docs = createServer((req, res) => {
      const doc = docsServed[req.url ?? '']
      if (doc === undefined) {
        res.writeHead(404).end()
        return
      }
      res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(doc))
    })
    await new Promise<void>((r) => docs.listen(0, '127.0.0.1', r))
    docBase = `http://127.0.0.1:${(docs.address() as AddressInfo).port}`
  })
  after(async () => {
    await new Promise<void>((r) => docs.close(() => r()))
    await w.close()
  })

  it('publishes where to sign in, as the standard asks', async () => {
    const prm = await w.raw('GET', '/.well-known/oauth-protected-resource/mcp')
    assert.deepEqual([prm.body.resource, prm.body.authorization_servers], [RESOURCE, ['http://localhost']])
    const as = await w.raw('GET', '/.well-known/oauth-authorization-server')
    assert.equal(as.body.issuer, 'http://localhost')
    assert.deepEqual(as.body.code_challenge_methods_supported, ['S256'])
    assert.equal(as.body.client_id_metadata_document_supported, true)
    assert.equal(as.body.authorization_response_iss_parameter_supported, true)
  })

  it('CA12 and CA13: consenting read + write to alpha only: the agent writes alpha, does not see beta, and is listed', async () => {
    const redirect = 'http://127.0.0.1:43123/callback'
    const client = String((await register(redirect)).body.client_id)
    const verifier = randomBytes(40).toString('base64url')
    const { code, back, session, page } = await consent(client, redirect, verifier, {
      brains: ['alpha'],
      perm: 'write',
    })
    assert.match(page, /declared by the app, not verified/)
    assert.deepEqual(
      [back.searchParams.get('state'), back.searchParams.get('iss')],
      ['st-123', 'http://localhost'],
    )
    const t = await exchange({
      code,
      code_verifier: verifier,
      redirect_uri: redirect,
      client_id: client,
      resource: RESOURCE,
    })
    assert.equal(t.status, 200, t.text)
    const tok = t.json() as { access_token: string; refresh_token: string; expires_in: number }
    assert.equal(tok.expires_in, 3600)
    const wrote = await w.call(tok.access_token, 'POST', '/v1/brains/alpha/entries', {
      type: 'learning',
      title: 'From the agent',
      content: 'Connected.',
    })
    assert.equal(wrote.status, 201, wrote.text)
    assert.equal((await w.call(tok.access_token, 'GET', '/v1/brains/beta')).status, 404)
    const apps = (await w.callWeb(session, 'GET', '/v1/me/apps')).body.apps as Array<{
      name: string
      brains: string[]
      perm: string
      returnsTo: string
    }>
    assert.deepEqual(
      apps.map((a) => [a.name, a.brains, a.perm, a.returnsTo]),
      [['Claude Code', ['alpha'], 'write', '127.0.0.1:43123 (this computer)']],
    )
    // A role lower than consented wins: as a reader of alpha, the connection cannot write.
    const ana = await w.person('Ana')
    await w.member('alpha', ana.id, 'curator')
    await w.db.query("UPDATE memberships SET role = 'reader' WHERE account_id = $1", [eric.id])
    const lower = await w.call(tok.access_token, 'POST', '/v1/brains/alpha/entries', {
      type: 'learning',
      title: 'x',
      content: 'y',
    })
    assert.equal(lower.status, 403)
    await w.db.query("UPDATE memberships SET role = 'curator' WHERE account_id = $1", [eric.id])
    // An access key is not a web session and manages nothing.
    assert.equal((await w.call(tok.access_token, 'GET', '/v1/me/tokens')).status, 403)
  })

  it('CA27: without the proof, with another return address, or a second time, the code gives nothing', async () => {
    const redirect = 'http://127.0.0.1:43124/cb'
    const client = String((await register(redirect)).body.client_id)
    const verifier = randomBytes(40).toString('base64url')
    const { code } = await consent(client, redirect, verifier, { brains: ['alpha'], perm: 'read' })
    const noProof = await exchange({ code, redirect_uri: redirect, client_id: client })
    assert.deepEqual([noProof.status, noProof.json().error], [400, 'invalid_grant'])
    const second = await consent(client, redirect, verifier, { brains: ['alpha'], perm: 'read' })
    const otherReturn = await exchange({
      code: second.code,
      code_verifier: verifier,
      redirect_uri: 'http://127.0.0.1:43124/other',
      client_id: client,
    })
    assert.equal(otherReturn.json().error, 'invalid_grant')
    // The code was spent by that failed try: it never works again.
    const again = await exchange({
      code: second.code,
      code_verifier: verifier,
      redirect_uri: redirect,
      client_id: client,
    })
    assert.equal(again.json().error, 'invalid_grant')
    const third = await consent(client, redirect, verifier, { brains: ['alpha'], perm: 'read' })
    const wrongProof = await exchange({
      code: third.code,
      code_verifier: randomBytes(40).toString('base64url'),
      redirect_uri: redirect,
      client_id: client,
    })
    assert.equal(wrongProof.json().error, 'invalid_grant')
    // A code lasts 60 seconds.
    const fourth = await consent(client, redirect, verifier, { brains: ['alpha'], perm: 'read' })
    w.advance(61_000)
    const late = await exchange({
      code: fourth.code,
      code_verifier: verifier,
      redirect_uri: redirect,
      client_id: client,
    })
    assert.equal(late.json().error, 'invalid_grant')
    // The return address must be one the client registered: otherwise nothing is sent back.
    const unregistered = await get(
      `/oauth/authorize?${authzQuery(client, 'http://127.0.0.1:43124/elsewhere', s256(verifier))}`,
    )
    assert.equal(unregistered.status, 400)
    assert.equal(unregistered.headers.get('location'), null)
  })

  it('CA28: the consent page shows the domain it goes back to, beside the declared name', async () => {
    const redirect = 'https://evil.example/cb'
    const client = String((await register(redirect, 'Claude')).body.client_id)
    const { page } = await consent(client, redirect, randomBytes(40).toString('base64url'), {
      brains: ['alpha'],
      perm: 'read',
    })
    assert.match(page, /Connect “Claude”/)
    assert.match(page, /<span class="domain">evil\.example<\/span>/)
  })

  it('PR24: the consent page starts from the brain of the invitation (or the one the web named) and the permission asked', async () => {
    const redirect = 'http://127.0.0.1:9/cb'
    const client = String((await register(redirect)).body.client_id)
    const idOf = async (slug: string) =>
      String((await w.db.one('SELECT id FROM brains WHERE slug = $1', [slug]))?.id)
    await w.call(eric.key, 'POST', '/v1/brains', { slug: 'gamma' })
    await w.call(eric.key, 'POST', '/v1/brains', { slug: 'delta' })
    const nia = await w.person('Nia')
    await w.member('gamma', nia.id, 'contributor')
    await w.member('delta', nia.id, 'contributor')
    await w.member('alpha', nia.id, 'reader')
    // Nia joined through an invitation to gamma.
    await w.db.query(
      `INSERT INTO invitations (id, email, token_hash, grants, invited_by, created_at, expires_at, used_at, account_id)
       VALUES ('inv_nia', 'nia@example.com', 'h-nia', $1, $2, $3, $3, $3, $4)`,
      [JSON.stringify([{ brainId: await idOf('gamma'), role: 'contributor' }]), eric.id, w.now, nia.id],
    )
    const web = await w.web(nia.id)
    const page = async (cookie: string, scope = 'brain:read brain:write') =>
      (await get(`/oauth/authorize?${authzQuery(client, redirect, s256('v'.repeat(43)), { scope })}`, cookie))
        .text
    const checked = (html: string, name: string, value = 'on') =>
      new RegExp(`name="${name}" value="${value}" checked`).test(html)
    const plain = await page(`rscb_session=${web}`)
    assert.ok(checked(plain, `brain_${await idOf('gamma')}`), 'the brain of the invitation is chosen')
    assert.ok(!checked(plain, `brain_${await idOf('delta')}`))
    assert.ok(checked(plain, 'perm', 'write'), 'read and write, as the app asked and her role allows')
    // «Connect your agent» for a brain names it: that one, instead.
    const named = await page(`rscb_session=${web}; rscb_connect=delta`)
    assert.ok(checked(named, `brain_${await idOf('delta')}`))
    assert.ok(!checked(named, `brain_${await idOf('gamma')}`))
    // A brain she is not in is never chosen for her.
    const stranger = await page(`rscb_session=${web}; rscb_connect=beta`)
    assert.ok(checked(stranger, `brain_${await idOf('gamma')}`))
    assert.doesNotMatch(stranger, new RegExp(await idOf('beta')))
    // Capped by her role: a reader there gets Read.
    const reading = await page(`rscb_session=${web}; rscb_connect=alpha`)
    assert.ok(checked(reading, 'perm', 'read'))
    // An app that asks only to read gets Read.
    assert.ok(checked(await page(`rscb_session=${web}`, 'brain:read'), 'perm', 'read'))
    // An app that asks for no scope at all gets Read: write is given only when asked for.
    assert.ok(checked(await page(`rscb_session=${web}`, ''), 'perm', 'read'))
  })

  it('CA14: a return address that is not local and not encrypted is refused, and nothing is granted', async () => {
    const r = await register('http://evil.example/cb')
    assert.deepEqual([r.status, r.body.error], [400, 'invalid_redirect_uri'])
    // A client document that lists one is refused too.
    docsServed['/bad-client'] = {
      client_id: `${docBase}/bad-client`,
      client_name: 'Bad',
      redirect_uris: ['http://evil.example/cb'],
    }
    const page = await get(
      `/oauth/authorize?${authzQuery(`${docBase}/bad-client`, 'http://evil.example/cb', s256('x'.repeat(43)))}`,
    )
    assert.equal(page.status, 400)
    assert.match(page.text, /cannot connect/)
    const codes = await w.db.one<{ n: number }>(
      "SELECT count(*)::int AS n FROM oauth_codes WHERE client_id LIKE '%bad-client'",
    )
    assert.equal(codes?.n, 0)
  })

  it('a client document is fetched, checked, and used; a document naming another address is refused', async () => {
    const id = `${docBase}/claude.json`
    docsServed['/claude.json'] = {
      client_id: id,
      client_name: 'Claude Desktop',
      redirect_uris: ['http://127.0.0.1/callback'],
    }
    const verifier = randomBytes(40).toString('base64url')
    // Any port on this machine (an app picks a free one).
    const { code } = await consent(id, 'http://127.0.0.1:50999/callback', verifier, {
      brains: ['beta'],
      perm: 'read',
    })
    const t = await exchange({
      code,
      code_verifier: verifier,
      redirect_uri: 'http://127.0.0.1:50999/callback',
      client_id: id,
    })
    assert.equal(t.status, 200, t.text)
    docsServed['/liar.json'] = {
      client_id: 'https://claude.ai/real',
      redirect_uris: ['http://127.0.0.1/callback'],
    }
    const liar = await get(
      `/oauth/authorize?${authzQuery(`${docBase}/liar.json`, 'http://127.0.0.1/callback', s256(verifier))}`,
    )
    assert.equal(liar.status, 400)
  })

  it('fetching a client document never reaches inside: private, local and link addresses are refused', async () => {
    for (const ip of [
      '10.0.0.1',
      '127.0.0.1',
      '169.254.169.254',
      '192.168.1.1',
      '100.64.0.1',
      '::1',
      '::ffff:10.0.0.1',
      '::ffff:a00:1',
      'fd00::1',
      'fe80::1',
    ]) {
      assert.equal(forbiddenAddress(ip), true, ip)
    }
    assert.equal(forbiddenAddress('8.8.8.8'), false)
    assert.equal(forbiddenAddress('::ffff:8.8.8.8'), false)
    assert.equal(forbiddenAddress('2606:4700:4700::1111'), false)
    for (const url of [
      `${docBase}/claude.json`,
      'https://127.0.0.1/x',
      'https://[::1]/x',
      'https://localhost/x',
      'http://example.com/x',
    ]) {
      await assert.rejects(fetchJson(url), FetchRefused, url)
    }
    // A server without the tests' permission refuses a client served from this machine.
    const strict = await world()
    try {
      const res = await fetch(
        `${strict.base}/oauth/authorize?${authzQuery(`${docBase}/claude.json`, 'http://127.0.0.1/callback', s256('y'.repeat(43)))}`,
      )
      assert.equal(res.status, 400)
      assert.match(await res.text(), /only https|does not reach/i)
    } finally {
      await strict.close()
    }
  })

  it('refresh rotates; an old refresh token used again ends the connection', async () => {
    const redirect = 'http://127.0.0.1:43125/cb'
    const client = String((await register(redirect)).body.client_id)
    const verifier = randomBytes(40).toString('base64url')
    const { code } = await consent(client, redirect, verifier, { brains: ['alpha'], perm: 'read' })
    const first = (
      await exchange({ code, code_verifier: verifier, redirect_uri: redirect, client_id: client })
    ).json()
    const second = (
      await form('/oauth/token', {
        grant_type: 'refresh_token',
        refresh_token: first.refresh_token,
        client_id: client,
      })
    ).json()
    assert.ok(second.access_token && second.refresh_token !== first.refresh_token)
    // Past the moment two requests could be racing, the old token again is a leak.
    w.advance(31_000)
    const replay = await form('/oauth/token', {
      grant_type: 'refresh_token',
      refresh_token: first.refresh_token,
      client_id: client,
    })
    assert.equal(replay.json().error, 'invalid_grant')
    assert.equal((await w.call(second.access_token, 'GET', '/v1/brains/alpha')).status, 401)
    const after = await form('/oauth/token', {
      grant_type: 'refresh_token',
      refresh_token: second.refresh_token,
      client_id: client,
    })
    assert.equal(after.json().error, 'invalid_grant')
  })

  it('an app that names itself with a secret never gets it stored: not as the app, the connection, its key or the audit', async () => {
    const SECRET = 'sk-live-0123456789abcdefghijklmnopqrstuv'
    const leaked = '%0123456789abcdefghij%'
    const redirect = 'http://127.0.0.1:43126/cb'
    const reg = await register(redirect, `Notes ${SECRET}`)
    assert.equal(reg.status, 201, JSON.stringify(reg.body))
    const client = String(reg.body.client_id)
    assert.doesNotMatch(String(reg.body.client_name), /0123456789abcdefghij/)
    const verifier = randomBytes(40).toString('base64url')
    const { code, page } = await consent(client, redirect, verifier, { brains: ['alpha'], perm: 'read' })
    assert.doesNotMatch(page, /0123456789abcdefghij/)
    const t = await exchange({ code, code_verifier: verifier, redirect_uri: redirect, client_id: client })
    assert.equal(t.status, 200, t.text)
    const stored = await w.db.query(
      `SELECT 'client' AS t FROM oauth_clients WHERE name LIKE $1
       UNION ALL SELECT 'grant' FROM oauth_grants WHERE client_name LIKE $1
       UNION ALL SELECT 'key' FROM credentials WHERE name LIKE $1
       UNION ALL SELECT 'audit' FROM audit WHERE detail LIKE $1`,
      [leaked],
    )
    assert.deepEqual(stored, [])
    // A connection stored before names were redacted: its next key is still named clean.
    await w.db.query('UPDATE oauth_grants SET client_name = $2 WHERE client_id = $1', [
      client,
      `Notes ${SECRET}`,
    ])
    const next = await form('/oauth/token', {
      grant_type: 'refresh_token',
      refresh_token: t.json().refresh_token,
      client_id: client,
    })
    assert.equal(next.status, 200, next.text)
    assert.deepEqual(await w.db.query('SELECT 1 FROM credentials WHERE name LIKE $1', [leaked]), [])
    // An app stored before names were redacted: a new connection to it copies its name clean.
    await w.db.query("UPDATE oauth_grants SET client_name = 'Notes' WHERE client_id = $1", [client])
    await w.db.query('UPDATE oauth_clients SET name = $2 WHERE client_id = $1', [client, `Notes ${SECRET}`])
    const v2 = randomBytes(40).toString('base64url')
    const again = await consent(client, redirect, v2, { brains: ['alpha'], perm: 'read' })
    const t2 = await exchange({
      code: again.code,
      code_verifier: v2,
      redirect_uri: redirect,
      client_id: client,
    })
    assert.equal(t2.status, 200, t2.text)
    assert.deepEqual(
      await w.db.query(
        `SELECT 1 FROM oauth_grants WHERE client_name LIKE $1 UNION ALL SELECT 1 FROM audit WHERE detail LIKE $1
         UNION ALL SELECT 1 FROM credentials WHERE name LIKE $1`,
        [leaked],
      ),
      [],
    )
  })

  it('CA29: a connection unused for 90 days asks to sign in again; an access key lasts an hour', async () => {
    const redirect = 'http://127.0.0.1:43126/cb'
    const client = String((await register(redirect)).body.client_id)
    const verifier = randomBytes(40).toString('base64url')
    const { code } = await consent(client, redirect, verifier, { brains: ['alpha'], perm: 'read' })
    const t = (
      await exchange({ code, code_verifier: verifier, redirect_uri: redirect, client_id: client })
    ).json()
    w.advance(3_601_000)
    assert.equal((await w.call(t.access_token, 'GET', '/v1/brains/alpha')).body.error?.code, 'key_expired')
    const fresh = (
      await form('/oauth/token', {
        grant_type: 'refresh_token',
        refresh_token: t.refresh_token,
        client_id: client,
      })
    ).json()
    assert.ok(fresh.access_token)
    w.advance(91 * 86_400_000)
    const old = await form('/oauth/token', {
      grant_type: 'refresh_token',
      refresh_token: fresh.refresh_token,
      client_id: client,
    })
    assert.equal(old.json().error, 'invalid_grant')
    assert.match(old.json().error_description, /Sign in again/)
  })

  it('revoking in the profile, removing the person, or restoring a copy ends a connection at once', async () => {
    const mk = async (port: number) => {
      const redirect = `http://127.0.0.1:${port}/cb`
      const client = String((await register(redirect)).body.client_id)
      const verifier = randomBytes(40).toString('base64url')
      const c = await consent(client, redirect, verifier, { brains: ['alpha'], perm: 'read' })
      const t = (
        await exchange({ code: c.code, code_verifier: verifier, redirect_uri: redirect, client_id: client })
      ).json()
      return { ...t, session: c.session, client }
    }
    const a = await mk(43127)
    const apps = (await w.callWeb(a.session, 'GET', '/v1/me/apps')).body.apps as Array<{ id: string }>
    for (const app of apps)
      assert.equal((await w.callWeb(a.session, 'DELETE', `/v1/me/apps/${app.id}`)).status, 200)
    const cut = await w.call(a.access_token, 'GET', '/v1/brains/alpha')
    assert.equal(cut.status, 401)
    assert.equal(
      (
        await form('/oauth/token', {
          grant_type: 'refresh_token',
          refresh_token: a.refresh_token,
          client_id: a.client,
        })
      ).json().error,
      'invalid_grant',
    )
    const b = await mk(43128)
    await bumpKeyEpoch(w.db)
    assert.equal((await w.call(b.access_token, 'GET', '/v1/brains/alpha')).status, 401)
    assert.equal(
      (
        await form('/oauth/token', {
          grant_type: 'refresh_token',
          refresh_token: b.refresh_token,
          client_id: b.client,
        })
      ).json().error,
      'invalid_grant',
    )
  })

  it('the consent cannot be made by another site: no form token, no approval; the page cannot be framed', async () => {
    const redirect = 'http://127.0.0.1:43129/cb'
    const client = String((await register(redirect)).body.client_id)
    const session = await w.web(eric.id)
    const q = authzQuery(client, redirect, s256('z'.repeat(43)))
    const page = await get(`/oauth/authorize?${q}`, `rscb_session=${session}`)
    assert.equal(page.headers.get('x-frame-options'), 'DENY')
    assert.match(String(page.headers.get('content-security-policy')), /frame-ancestors 'none'/)
    const alphaId = String((await w.db.one("SELECT id FROM brains WHERE slug = 'alpha'"))?.id)
    const forged = await form(
      '/oauth/authorize',
      {
        ...Object.fromEntries(new URLSearchParams(q)),
        decision: 'approve',
        perm: 'write',
        [`brain_${alphaId}`]: 'on',
      },
      `rscb_session=${session}`,
    )
    assert.equal(forged.status, 403)
    assert.equal(forged.headers.get('location'), null)
  })
})

describe('the audit', { skip: skipPg }, () => {
  let w: World
  let admin: { id: string; key: string }
  let adminWeb: string

  before(async () => {
    w = await world()
    admin = await w.person('Admin', { isAdmin: true })
    adminWeb = await w.web(admin.id)
  })
  after(async () => w.close())

  it('CA23: an invitation, a role change, a revocation and a purge show with person and time; nothing edits them', async () => {
    const cur = await w.person('Cura')
    await w.call(cur.key, 'POST', '/v1/brains', { slug: 'aud' })
    const curWeb = await w.web(cur.id)
    await w.callWeb(adminWeb, 'POST', '/v1/invitations', {
      emails: ['new@example.com'],
      brains: [{ slug: 'aud', role: 'reader' }],
    })
    const bea = await w.person('Bea')
    await w.callWeb(curWeb, 'POST', '/v1/brains/aud/members', { account: bea.id, role: 'contributor' })
    const t = await w.callWeb(curWeb, 'POST', '/v1/me/tokens', { name: 'tmp', perm: 'read', allBrains: true })
    await w.callWeb(curWeb, 'DELETE', `/v1/me/tokens/${(t.body.token as { id: string }).id}`)
    const e = await w.call(cur.key, 'POST', '/v1/brains/aud/entries', {
      type: 'learning',
      title: 'Oops',
      content: '=cmd|calc',
    })
    const entryId = (e.body.receipt as { entryId: string }).entryId
    assert.equal(
      (await w.call(admin.key, 'POST', `/v1/entries/${entryId}/purge`, { reason: '=HYPERLINK("x")' })).status,
      200,
    )
    const all = (await w.callWeb(adminWeb, 'GET', '/v1/admin/audit')).body.items as Array<{
      action: string
      actor: { name: string } | null
      at: string
    }>
    for (const action of ['invitation.create', 'member.add', 'token.revoke', 'entry.purge']) {
      const row = all.find((x) => x.action === action)
      assert.ok(row?.actor?.name && row.at, action)
    }
    const filtered = (await w.callWeb(adminWeb, 'GET', '/v1/admin/audit?action=member.')).body
      .items as Array<{ action: string }>
    assert.ok(filtered.length > 0 && filtered.every((x) => x.action.startsWith('member.')))
    // Download: a CSV a spreadsheet will not run.
    const csv = await fetch(`${w.base}/v1/admin/audit/export`, {
      headers: { cookie: `rscb_session=${adminWeb}` },
    })
    assert.match(String(csv.headers.get('content-type')), /text\/csv/)
    const text = await csv.text()
    assert.match(text, /'=HYPERLINK/)
    assert.ok(!/,=HYPERLINK/.test(text))
    // No route edits it, and the database refuses.
    for (const m of ['PUT', 'DELETE', 'PATCH']) {
      assert.ok([404, 405].includes((await w.callWeb(adminWeb, m, '/v1/admin/audit', {})).status), m)
    }
    await assert.rejects(w.db.query("UPDATE audit SET detail = 'x'"), /append-only/)
    await assert.rejects(w.db.query('DELETE FROM audit'), /append-only/)
    // A curator sees the part of their brain; a reader does not see it; only the administration sees all.
    const part = (await w.callWeb(curWeb, 'GET', '/v1/brains/aud/audit')).body.items as Array<{
      brain: string
    }>
    assert.ok(part.length > 0 && part.every((x) => x.brain === 'aud'))
    const reader = await w.person('Reader')
    await w.member('aud', reader.id, 'reader')
    assert.equal((await w.callWeb(await w.web(reader.id), 'GET', '/v1/brains/aud/audit')).status, 404)
    assert.equal((await w.callWeb(curWeb, 'GET', '/v1/admin/audit')).status, 403)
    assert.equal((await w.call(admin.key, 'GET', '/v1/admin/audit')).status, 403)
  })
})
