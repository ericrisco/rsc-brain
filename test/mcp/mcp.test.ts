// Spec B5 «Las herramientas», «El protocolo que viaja con el servidor», «Errores»: the MCP endpoint for
// both eras of the protocol, the tools a key sees, the default brain, the protocol in the instructions,
// the curator's note in the context, resolving a repository, and errors that say how to proceed.
import assert from 'node:assert/strict'
import { after, before, describe, it } from 'node:test'
import { INSTRUCTIONS } from '../../src/mcp/instructions.ts'
import { MODERN } from '../../src/mcp/server.ts'
import { skipPg } from '../helpers/pg.ts'
import { type World, world } from '../helpers/world.ts'

type Rpc = {
  status: number
  headers: Headers
  body: Record<string, unknown> & {
    result?: Record<string, unknown>
    error?: { code: number; message: string; data?: unknown }
  }
}

const META = {
  'io.modelcontextprotocol/protocolVersion': MODERN,
  'io.modelcontextprotocol/clientInfo': { name: 'test-agent', version: '1.0.0' },
  'io.modelcontextprotocol/clientCapabilities': {},
}

describe('the MCP endpoint', { skip: skipPg }, () => {
  let w: World
  let eric: { id: string; key: string }
  let id = 0

  // A modern request: version and identity in _meta, mirrored in headers.
  async function mcp(
    key: string | null,
    method: string,
    params: Record<string, unknown> = {},
    o: { headers?: Record<string, string>; legacy?: boolean } = {},
  ): Promise<Rpc> {
    id += 1
    const body = { jsonrpc: '2.0', id, method, params: o.legacy ? params : { ...params, _meta: META } }
    const res = await fetch(`${w.base}/mcp`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        ...(key ? { authorization: `Bearer ${key}` } : {}),
        ...(o.legacy
          ? {}
          : {
              'mcp-protocol-version': MODERN,
              'mcp-method': method,
              ...(typeof params.name === 'string' ? { 'mcp-name': params.name } : {}),
            }),
        ...(o.headers ?? {}),
      },
      body: JSON.stringify(body),
    })
    const text = await res.text()
    return { status: res.status, headers: res.headers, body: text ? JSON.parse(text) : {} }
  }
  const call = async (key: string, name: string, args: Record<string, unknown> = {}) => {
    const r = await mcp(key, 'tools/call', { name, arguments: args })
    const result = r.body.result as {
      content: Array<{ text: string }>
      structuredContent?: Record<string, unknown>
      isError: boolean
    }
    return { ...result, rpc: r, text: result?.content?.[0]?.text ?? '' }
  }

  before(async () => {
    w = await world()
    eric = await w.person('Eric')
    await w.call(eric.key, 'POST', '/v1/brains', { slug: 'alpha', purpose: 'The channel.' })
    await w.call(eric.key, 'POST', '/v1/brains', { slug: 'beta' })
  })
  after(async () => w.close())

  it('without a key: 401 that points to the sign-in metadata', async () => {
    const r = await mcp(null, 'tools/list')
    assert.equal(r.status, 401)
    assert.match(
      String(r.headers.get('www-authenticate')),
      /resource_metadata="http:\/\/localhost\/\.well-known\/oauth-protected-resource\/mcp"/,
    )
    const bad = await mcp('rscb_nottherightkeyatall_nottherightkeyatall_xx', 'tools/list')
    assert.equal(bad.status, 401)
    assert.match(String(bad.headers.get('www-authenticate')), /error="invalid_token"/)
  })

  it('CA4: discovery carries the six points of the protocol, under 2 000 characters', async () => {
    const r = await mcp(eric.key, 'server/discover')
    assert.equal(r.status, 200, JSON.stringify(r.body))
    const res = r.body.result as { resultType: string; supportedVersions: string[]; instructions: string }
    assert.equal(res.resultType, 'complete')
    assert.ok(res.supportedVersions.includes(MODERN))
    assert.ok(res.instructions.length < 2000, String(res.instructions.length))
    for (const point of [
      'brain_resolve',
      'mem_context',
      'mem_search',
      'mem_save',
      '<private>',
      'mem_session_summary',
      'brain_compile_pack',
      'brain_propose',
    ]) {
      assert.ok(res.instructions.includes(point), point)
    }
    assert.equal(INSTRUCTIONS, res.instructions)
  })

  it('older clients: initialize, then requests without per-request metadata', async () => {
    const init = await mcp(
      eric.key,
      'initialize',
      { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'old', version: '1' } },
      { legacy: true },
    )
    assert.equal(init.status, 200)
    const res = init.body.result as {
      protocolVersion: string
      instructions: string
      serverInfo: { name: string }
    }
    assert.deepEqual([res.protocolVersion, res.serverInfo.name], ['2025-06-18', 'rsc-brain'])
    assert.ok(res.instructions.includes('mem_search'))
    const note = await fetch(`${w.base}/mcp`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${eric.key}` },
      body: JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }),
    })
    assert.equal(note.status, 202)
    const list = await mcp(
      eric.key,
      'tools/list',
      {},
      { legacy: true, headers: { 'mcp-protocol-version': '2025-06-18' } },
    )
    assert.ok((list.body.result as { tools: unknown[] }).tools.length > 10)
    assert.equal(
      (await fetch(`${w.base}/mcp`, { headers: { authorization: `Bearer ${eric.key}` } })).status,
      405,
    )
  })

  it('the transport checks its headers and versions, and refuses foreign origins', async () => {
    const mismatch = await mcp(eric.key, 'tools/list', {}, { headers: { 'mcp-method': 'tools/call' } })
    assert.deepEqual([mismatch.status, mismatch.body.error?.code], [400, -32020])
    const version = await mcp(
      eric.key,
      'tools/list',
      {},
      { headers: { 'mcp-protocol-version': '2025-06-18' } },
    )
    assert.deepEqual([version.status, version.body.error?.code], [400, -32020])
    id += 1
    const unknownVersion = await fetch(`${w.base}/mcp`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${eric.key}`,
        'mcp-protocol-version': '1900-01-01',
        'mcp-method': 'tools/list',
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id,
        method: 'tools/list',
        params: { _meta: { ...META, 'io.modelcontextprotocol/protocolVersion': '1900-01-01' } },
      }),
    })
    const uv = (await unknownVersion.json()) as { error: { code: number; data: { supported: string[] } } }
    assert.deepEqual([unknownVersion.status, uv.error.code], [400, -32022])
    assert.ok(uv.error.data.supported.includes(MODERN))
    const unknown = await mcp(eric.key, 'nope/never')
    assert.deepEqual([unknown.status, unknown.body.error?.code], [404, -32601])
    const name = await mcp(
      eric.key,
      'tools/call',
      { name: 'brain_list', arguments: {} },
      { headers: { 'mcp-name': 'mem_save' } },
    )
    assert.equal(name.body.error?.code, -32020)
    const encoded = await mcp(
      eric.key,
      'tools/call',
      { name: 'brain_list', arguments: {} },
      { headers: { 'mcp-name': `=?base64?${Buffer.from('brain_list').toString('base64')}?=` } },
    )
    assert.equal(encoded.status, 200)
    const foreign = await mcp(eric.key, 'tools/list', {}, { headers: { origin: 'https://evil.example' } })
    assert.equal(foreign.status, 403)
    const parse = await fetch(`${w.base}/mcp`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${eric.key}` },
      body: '{nope',
    })
    assert.equal(((await parse.json()) as { error: { code: number } }).error.code, -32700)
  })

  it('CA3: a read-only key does not see the write tools, and calling one says what is missing', async () => {
    const ro = await w.token(eric.id, { perm: 'read' })
    const names = ((await mcp(ro, 'tools/list')).body.result as { tools: Array<{ name: string }> }).tools.map(
      (t) => t.name,
    )
    for (const n of [
      'mem_save',
      'mem_update',
      'mem_forget',
      'mem_relate',
      'mem_session_start',
      'mem_session_summary',
      'mem_session_end',
      'brain_propose',
      'brain_withdraw',
      'brain_decide',
      'brain_create',
    ]) {
      assert.ok(!names.includes(n), n)
    }
    for (const n of ['mem_search', 'mem_context', 'brain_list', 'brain_page', 'brain_proposals'])
      assert.ok(names.includes(n), n)
    const tried = await call(ro, 'mem_save', { brain: 'alpha', type: 'learning', title: 'x', content: 'y' })
    assert.equal(tried.isError, true)
    assert.match(tried.text, /read-only.*read \+ write/)
  })

  it('CA1 (with a key) and CA8: save over MCP; a repeated request key gives the same receipt, one entry', async () => {
    const a = await call(eric.key, 'mem_save', {
      brain: 'alpha',
      type: 'decision',
      title: 'Hooks under 5s',
      content: 'Retention dropped.',
      requestKey: 'k-1',
    })
    assert.equal(a.isError, false, a.text)
    const b = await call(eric.key, 'mem_save', {
      brain: 'alpha',
      type: 'decision',
      title: 'Hooks under 5s',
      content: 'Retention dropped.',
      requestKey: 'k-1',
    })
    const ra = (a.structuredContent as { receipt: { entryId: string } }).receipt
    const rb = (b.structuredContent as { receipt: { entryId: string } }).receipt
    assert.equal(ra.entryId, rb.entryId)
    const n = await w.db.one<{ n: number }>(
      "SELECT count(*)::int AS n FROM entries WHERE title = 'Hooks under 5s'",
    )
    assert.equal(n?.n, 1)
    const found = await call(eric.key, 'mem_search', { q: 'hooks retention' })
    assert.match(found.text, /Hooks under 5s/)
  })

  it('CA7: a short key writes to its brain without naming it; a session sets the default for a token', async () => {
    const svc = await w.service('Factory')
    await w.member('alpha', svc.id, 'contributor')
    const short = await w.call(svc.key, 'POST', '/v1/keys/short', {
      writeBrain: 'alpha',
      ref: 'run r_1, step 2',
      ttlMinutes: 30,
    })
    const key = String((short.body.key as { secret: string }).secret)
    const saved = await call(key, 'mem_save', {
      type: 'learning',
      title: 'From a step',
      content: 'Learned it.',
    })
    assert.equal(saved.isError, false, saved.text)
    const where = await w.db.one(
      "SELECT b.slug FROM entries e JOIN brains b ON b.id = e.brain_id WHERE e.title = 'From a step'",
    )
    assert.equal(where?.slug, 'alpha')
    // A token reaching two brains must name one, or pass a session.
    const which = await call(eric.key, 'mem_save', { type: 'learning', title: 'Nowhere', content: 'x' })
    assert.equal(which.isError, true)
    assert.match(which.text, /Which brain\?.*alpha, beta/s)
    const s = await call(eric.key, 'mem_session_start', { brain: 'beta', purpose: 'Testing' })
    const session = (s.structuredContent as { session: { id: string } }).session.id
    const inSession = await call(eric.key, 'mem_save', {
      session,
      type: 'learning',
      title: 'In beta',
      content: 'x',
    })
    assert.equal(inSession.isError, false, inSession.text)
    assert.equal(
      (
        await w.db.one(
          "SELECT b.slug FROM entries e JOIN brains b ON b.id = e.brain_id WHERE e.title = 'In beta'",
        )
      )?.slug,
      'beta',
    )
    const closed = await call(eric.key, 'mem_session_summary', {
      session,
      content: 'Goal: test. Done: saved.',
    })
    assert.equal(closed.isError, false, closed.text)
  })

  it('CA5: the curator’s paragraph reaches the agent inside mem_context', async () => {
    const web = await w.web(eric.id)
    const set = await w.callWeb(web, 'PUT', '/v1/brains/alpha/wiki/settings', {
      usageNote: 'Always tag entries with the video id.',
    })
    assert.equal(set.status, 200, JSON.stringify(set.body))
    const ctx = await call(eric.key, 'mem_context', { brain: 'alpha' })
    assert.match(ctx.text, /Always tag entries with the video id\./)
  })

  it('CA6: a linked repository resolves to its brain; an unlinked one lists the brains and how to link', async () => {
    const web = await w.web(eric.id)
    assert.equal(
      (
        await w.callWeb(web, 'POST', '/v1/brains/alpha/repos', {
          repo: 'git@github.com:Risco/RSC-Factory.git',
        })
      ).status,
      201,
    )
    const hit = await call(eric.key, 'brain_resolve', { repos: ['https://github.com/risco/rsc-factory'] })
    assert.equal((hit.structuredContent as { brain: { slug: string } }).brain.slug, 'alpha')
    const miss = await call(eric.key, 'brain_resolve', { repos: ['https://github.com/risco/other'] })
    const m = miss.structuredContent as {
      brain: null
      candidates: Array<{ slug: string }>
      howToProceed: string
    }
    assert.equal(m.brain, null)
    assert.deepEqual(
      m.candidates.map((c) => c.slug),
      ['alpha', 'beta'],
    )
    assert.match(m.howToProceed, /curator can link/)
    // Someone who cannot see alpha gets no answer about it.
    const other = await w.person('Other')
    const theirs = await call(other.key, 'brain_resolve', { repos: ['github.com/risco/rsc-factory'] })
    assert.equal((theirs.structuredContent as { brain: unknown }).brain, null)
    // Only curators link, only in the web.
    assert.equal(
      (await w.call(eric.key, 'POST', '/v1/brains/alpha/repos', { repo: 'github.com/a/b' })).status,
      403,
    )
  })

  it('CA17 and CA19: an agent sees its proposals returned with the comment, and a replaced one as superseded', async () => {
    const e = await call(eric.key, 'mem_save', {
      brain: 'beta',
      type: 'learning',
      title: 'Source',
      content: 'Hooks matter.',
    })
    const entryId = (e.structuredContent as { receipt: { entryId: string } }).receipt.entryId
    const op = {
      op: 'create',
      address: 'audience/hooks',
      type: 'topic',
      title: 'Hooks',
      summary: 'Hooks.',
      body: 'Hooks matter.',
      sources: [{ entryId }],
      reason: 'From the journal.',
    }
    const p1 = await call(eric.key, 'brain_propose', { brain: 'beta', title: 'Hooks page', ops: [op] })
    assert.equal(p1.isError, false, p1.text)
    const id1 = (p1.structuredContent as { proposal: { id: string } }).proposal.id
    const p2 = await call(eric.key, 'brain_propose', {
      brain: 'beta',
      title: 'Hooks page v2',
      ops: [op],
      supersedes: id1,
    })
    const id2 = (p2.structuredContent as { proposal: { id: string } }).proposal.id
    const mine = (await call(eric.key, 'brain_proposals', { brain: 'beta' })).structuredContent as {
      items: Array<{ id: string; status: string }>
    }
    assert.equal(mine.items.find((x) => x.id === id1)?.status, 'superseded')
    assert.equal(mine.items.find((x) => x.id === id2)?.status, 'pending')
    const web = await w.web(eric.id)
    const review = await w.callWeb(web, 'GET', `/v1/proposals/${id2}/review`)
    const fp = String(
      (review.body as { fingerprint?: string }).fingerprint ??
        (review.body.review as { fingerprint: string })?.fingerprint,
    )
    const ret = await w.callWeb(web, 'POST', `/v1/proposals/${id2}/return`, {
      fingerprint: fp,
      comment: 'Cite the video too.',
    })
    assert.equal(ret.status, 200, JSON.stringify(ret.body))
    const after = (await call(eric.key, 'brain_proposals', { brain: 'beta' })).structuredContent as {
      items: Array<{ id: string; status: string; comment: string }>
    }
    const back = after.items.find((x) => x.id === id2) as { status: string; comment: string }
    assert.deepEqual([back.status, back.comment], ['returned', 'Cite the video too.'])
  })

  it('CA9: refusals through tools carry a code, what happened and how to proceed', async () => {
    const r1 = await call(eric.key, 'mem_get', { id: 'ent_000000000000' })
    const r2 = await call(eric.key, 'mem_save', { brain: 'nope', type: 'learning', title: 'x', content: 'y' })
    const r3 = await call(eric.key, 'mem_save', {
      brain: 'alpha',
      type: 'correction',
      title: 'x',
      content: 'y',
    })
    for (const r of [r1, r2, r3]) {
      assert.equal(r.isError, true)
      assert.match(r.text, /^[a-z_]+: .+ How to proceed: .+/s)
    }
    const unknownTool = await mcp(eric.key, 'tools/call', { name: 'no_such_tool', arguments: {} })
    assert.equal(unknownTool.body.error?.code, -32602)
  })

  it('the two guides are offered as prompts', async () => {
    const list = (await mcp(eric.key, 'prompts/list')).body.result as { prompts: Array<{ name: string }> }
    assert.deepEqual(
      list.prompts.map((p) => p.name),
      ['compile_brain', 'close_session'],
    )
    const got = (
      await mcp(eric.key, 'prompts/get', { name: 'close_session', arguments: { session: 'ses_x' } })
    ).body.result as {
      messages: Array<{ content: { text: string } }>
    }
    assert.match(got.messages[0]?.content.text ?? '', /mem_session_summary/)
  })
})
