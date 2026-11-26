// Spec learning-memory A1, A2 over MCP and in the description of the API (plan §4.1, §4.2, §8.3 H2, M2): brain_propose
// says changes apply at once and takes a request key; brain_changes reads «Review later» (curators' keys and keys with
// the wiki write permission); brain_undo undoes (keys with the permission); there is no MCP keep (a person's, in the
// web); brain_decide decides parts that wait. Who may do what, the same by the API and by MCP. OpenAPI documents the
// receipt and the statuses. CA-A1, A18, A21 (the MCP channel).
import assert from 'node:assert/strict'
import { after, before, describe, it } from 'node:test'
import { MODERN } from '../../src/mcp/server.ts'
import { skipPg } from '../helpers/pg.ts'
import { type World, world } from '../helpers/world.ts'

type Json = Record<string, unknown>

describe('Review later over MCP and in OpenAPI (spec learning-memory)', { skip: skipPg }, () => {
  let w: World
  let cora: { id: string; key: string }
  let cole: { id: string; key: string }
  let rita: { id: string; key: string }
  let otto: { id: string; key: string }
  let coraWeb: string
  let writer: string
  let writerId: string
  let source: string
  let n = 0

  const rpc = async (key: string, method: string, params: Json = {}, name?: string) => {
    n += 1
    const res = await fetch(`${w.base}/mcp`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${key}`,
        'content-type': 'application/json',
        'mcp-protocol-version': MODERN,
        'mcp-method': method,
        ...(name ? { 'mcp-name': name } : {}),
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: n,
        method,
        params: { ...params, _meta: { 'io.modelcontextprotocol/protocolVersion': MODERN } },
      }),
    })
    return { status: res.status, body: (await res.json().catch(() => ({}))) as Json }
  }
  const tool = async (
    key: string,
    name: string,
    args: Json,
  ): Promise<{ error?: string; result?: Json; status: number }> => {
    const r = await rpc(key, 'tools/call', { name, arguments: args }, name)
    const result = r.body.result as { isError: boolean; content: Array<{ text: string }> } | undefined
    if (!result) return { status: r.status, error: JSON.stringify(r.body) }
    const text = result.content[0]?.text ?? ''
    return result.isError
      ? { status: r.status, error: text }
      : { status: r.status, result: JSON.parse(text) as Json }
  }
  const tools = async (key: string) =>
    ((await rpc(key, 'tools/list')).body.result as { tools: Array<{ name: string; description: string }> })
      .tools
  const create = (address: string) => ({
    op: 'create',
    address,
    type: 'topic',
    title: `Page ${address}`,
    summary: `About ${address}.`,
    body: `Text of ${address}.`,
    sources: [{ entryId: source }],
    reason: 'From the journal.',
  })
  let change: string

  before(async () => {
    w = await world()
    cora = await w.person('Cora')
    cole = await w.person('Cole')
    rita = await w.person('Rita')
    otto = await w.person('Otto')
    await w.call(cora.key, 'POST', '/v1/brains', { slug: 'mc', purpose: 'MCP.' })
    await w.member('mc', cole.id, 'contributor')
    await w.member('mc', rita.id, 'reader')
    coraWeb = await w.web(cora.id)
    const coleWeb = await w.web(cole.id)
    const t = await w.callWeb(coleWeb, 'POST', '/v1/me/tokens', {
      name: 'Cole writer',
      perm: 'write',
      brains: ['mc'],
      days: 30,
    })
    const tok = t.body.token as { id: string; secret: string }
    writer = tok.secret
    writerId = tok.id
    assert.equal((await w.callWeb(coraWeb, 'PUT', `/v1/brains/mc/wiki/writers/${tok.id}`)).status, 200)
    const e = await w.call(cole.key, 'POST', '/v1/brains/mc/entries', {
      type: 'learning',
      title: 'H',
      content: 'H.',
    })
    source = (e.body.receipt as { entryId: string }).entryId
    const p = await tool(cole.key, 'brain_propose', { brain: 'mc', title: 'First', ops: [create('first')] })
    change = String(p.result?.undo)
  })
  after(async () => w.close())

  it('brain_propose says changes apply at once, what waits and what comes back, and takes a request key', async () => {
    const t = (await tools(cole.key)).find((x) => x.name === 'brain_propose')
    assert.ok(t)
    assert.match(t.description, /apply at once/)
    assert.match(t.description, /protected pages/)
    assert.match(t.description, /ask first/)
    assert.match(t.description, /old revision come back/)
    assert.match(change, /^chg_/)
  })

  it('tools by permission: brain_changes for curators’ keys and keys with the permission; brain_undo for the latter; no keep', async () => {
    const curator = (await tools(cora.key)).map((x) => x.name)
    const writerTools = (await tools(writer)).map((x) => x.name)
    const plain = (await tools(cole.key)).map((x) => x.name)
    assert.ok(curator.includes('brain_changes'))
    assert.ok(!curator.includes('brain_undo'), 'a curator’s key undoes only with the permission')
    assert.ok(writerTools.includes('brain_changes') && writerTools.includes('brain_undo'))
    assert.ok(!plain.includes('brain_changes') && !plain.includes('brain_undo'))
    for (const list of [curator, writerTools, plain]) assert.ok(!list.some((x) => /keep/.test(x)))
  })

  it('brain_changes lists and opens «Review later» like the API', async () => {
    const m = await tool(writer, 'brain_changes', { brain: 'mc' })
    const a = await w.call(writer, 'GET', '/v1/brains/mc/wiki/changes')
    assert.equal(m.error, undefined, m.error)
    assert.deepEqual(m.result, a.body)
    const md = await tool(cora.key, 'brain_changes', { id: change })
    const ad = await w.call(cora.key, 'GET', `/v1/wiki/changes/${change}`)
    assert.deepEqual(md.result, ad.body)
  })

  it('brain_decide decides a part that waits; brain_undo undoes, with a comment, and twice says it is undone', async () => {
    await w.callWeb(coraWeb, 'POST', '/v1/brains/mc/wiki/changes', {
      op: 'create',
      address: 'guide',
      type: 'guide',
      title: 'Guide',
      summary: 'Guide.',
      body: 'Guide.',
    })
    await w.callWeb(coraWeb, 'PUT', '/v1/brains/mc/protection/guide', { protected: true })
    const p = await tool(cole.key, 'brain_propose', {
      brain: 'mc',
      title: 'Guide and more',
      ops: [{ op: 'edit', address: 'guide', baseRevision: 1, body: 'Agent.', reason: 'R.' }, create('more')],
    })
    const id = (p.result?.proposal as { id: string } | undefined)?.id as string
    assert.deepEqual(
      ((p.result?.held ?? []) as Array<{ reason: string }>).map((h) => h.reason),
      ['protected'],
    )
    const review = await tool(writer, 'brain_review', { id })
    const d = await tool(writer, 'brain_decide', {
      id,
      decision: 'approve',
      fingerprint: review.result?.fingerprint,
    })
    assert.equal(d.error, undefined, d.error)
    assert.match(String(d.result?.undo), /^chg_/)
    const u = await tool(writer, 'brain_undo', { id: String(d.result?.undo), comment: 'Leave the guide.' })
    assert.equal(u.error, undefined, u.error)
    assert.equal((u.result?.change as { state: string } | undefined)?.state, 'undone')
    assert.match(String(u.result?.correction), /^ent_/)
    const again = await tool(writer, 'brain_undo', { id: String(d.result?.undo) })
    assert.equal(again.result?.alreadyUndone, true)
  })

  describe('H2: the same refusals by the API and by MCP', () => {
    it('outside the brain and an id that does not exist: the same 404', async () => {
      for (const path of [`/v1/wiki/changes/${change}`]) {
        const outsider = await w.call(otto.key, 'GET', path)
        const invented = await w.call(cora.key, 'GET', '/v1/wiki/changes/chg_000000000000')
        assert.deepEqual([outsider.status, outsider.body.error], [404, invented.body.error])
      }
      for (const verb of ['undo', 'keep']) {
        const outsider = await w.call(otto.key, 'POST', `/v1/wiki/changes/${change}/${verb}`, {})
        const invented = await w.call(cora.key, 'POST', `/v1/wiki/changes/chg_000000000000/${verb}`, {})
        assert.deepEqual([outsider.status, outsider.body.error], [404, invented.body.error], verb)
      }
      const outsiderDecide = await w.call(otto.key, 'POST', '/v1/proposals/prp_000000000000/approve', {
        fingerprint: 'x',
      })
      assert.equal(outsiderDecide.status, 404)
      // By MCP, through the same routes.
      const om = await tool(otto.key, 'brain_changes', { id: change })
      const im = await tool(cora.key, 'brain_changes', { id: 'chg_000000000000' })
      assert.equal(om.error, im.error)
      assert.match(String(om.error), /not_found/)
      const ou = await tool(otto.key, 'brain_undo', { id: change })
      const iu = await tool(writer, 'brain_undo', { id: 'chg_000000000000' })
      assert.equal(ou.error, iu.error)
    })

    it('a reader: 403 on reading, undoing, keeping and deciding', async () => {
      for (const [label, r] of [
        ['list', await w.call(rita.key, 'GET', '/v1/brains/mc/wiki/changes')],
        ['detail', await w.call(rita.key, 'GET', `/v1/wiki/changes/${change}`)],
        ['undo', await w.call(rita.key, 'POST', `/v1/wiki/changes/${change}/undo`, {})],
        ['keep', await w.call(rita.key, 'POST', `/v1/wiki/changes/${change}/keep`)],
      ] as const)
        assert.equal(r.status, 403, `${label}: ${r.text}`)
      for (const [name, args] of [
        ['brain_changes', { brain: 'mc' }],
        ['brain_changes', { id: change }],
        ['brain_undo', { id: change }],
      ] as const) {
        const m = await tool(rita.key, name, args)
        assert.match(String(m.error), /forbidden|web_only|read_only/, `${name}: ${m.error}`)
      }
    })

    it('a contributor without the permission: 403 on keep, undo and decide, by the API and by MCP', async () => {
      const coleWeb = await w.web(cole.id)
      assert.equal((await w.callWeb(coleWeb, 'POST', `/v1/wiki/changes/${change}/keep`)).status, 403)
      assert.equal((await w.callWeb(coleWeb, 'POST', `/v1/wiki/changes/${change}/undo`, {})).status, 403)
      assert.equal((await w.call(cole.key, 'POST', `/v1/wiki/changes/${change}/undo`, {})).status, 403)
      const p = await w.call(cole.key, 'POST', '/v1/brains/mc/proposals', {
        title: 'Guide again',
        ops: [{ op: 'edit', address: 'guide', baseRevision: 1, body: 'Again.', reason: 'R.' }],
      })
      const id = (p.body.proposal as { id: string }).id
      const review = await w.callWeb(coraWeb, 'GET', `/v1/proposals/${id}/review`)
      const fp = review.body.fingerprint
      assert.equal(
        (await w.call(cole.key, 'POST', `/v1/proposals/${id}/approve`, { fingerprint: fp })).status,
        403,
      )
      const mu = await tool(cole.key, 'brain_undo', { id: change })
      assert.match(String(mu.error), /web_only/)
      const md = await tool(cole.key, 'brain_decide', { id, decision: 'approve', fingerprint: fp })
      assert.match(String(md.error), /web_only/)
    })

    it('a revoked key: 401 on the next request, by the API and by MCP', async () => {
      const coleWeb = await w.web(cole.id)
      assert.ok((await w.callWeb(coleWeb, 'DELETE', `/v1/me/tokens/${writerId}`)).status < 300)
      assert.equal((await w.call(writer, 'GET', '/v1/brains/mc/wiki/changes')).status, 401)
      assert.equal((await w.call(writer, 'POST', `/v1/wiki/changes/${change}/undo`, {})).status, 401)
      const m = await rpc(
        writer,
        'tools/call',
        { name: 'brain_changes', arguments: { brain: 'mc' } },
        'brain_changes',
      )
      assert.equal(m.status, 401)
    })
  })

  it('OpenAPI documents the receipt of a proposal, the statuses (M2) and the parts that wait', async () => {
    const doc = (await w.call(null, 'GET', '/v1/openapi.json')).body as Json
    const op = (doc.paths as Json)['/v1/brains/{slug}/proposals'] as Json
    const post = op.post as Json
    const reply = JSON.stringify(post.responses)
    for (const k of ['status', 'review', 'pages', 'undo', 'held', 'returned', 'requestKey'])
      assert.match(JSON.stringify(post), new RegExp(`"${k}"`), k)
    assert.match(String(post.summary), /apply at once|applies at once/i)
    assert.match(reply, /partially_applied/)
    assert.match(reply, /a curator returning/i)
    assert.match(reply, /holdReason/)
    assert.match(reply, /staleCurrent/)
    const ops = JSON.stringify(doc)
    for (const s of ['"applied"', '"partially_applied"', '"stale"', '"undone"']) assert.ok(ops.includes(s), s)
  })
})
