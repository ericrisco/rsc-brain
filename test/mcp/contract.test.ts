// What the MCP server promises it enforces (E1, E2, E4, E6 of the end-to-end test of v0.7.8) and what it
// tells an agent about the wiki operations: arguments checked against the schema, one list of entry types,
// a curator's correction in mem_context, a check without a title, a compact review, and tools/list
// narrowed by what the key may do.
import assert from 'node:assert/strict'
import { after, before, describe, it } from 'node:test'
import { OP_EXAMPLES } from '../../src/domain/wiki/op-schema.ts'
import { MODERN } from '../../src/mcp/server.ts'
import { skipPg } from '../helpers/pg.ts'
import { type World, world } from '../helpers/world.ts'

// biome-ignore lint/suspicious/noExplicitAny: replies are read loosely in this test
type Json = Record<string, any>

describe('the MCP contract', { skip: skipPg }, () => {
  let w: World
  let eric: { id: string; key: string }
  let ericWeb: string
  let ana: { id: string; key: string }
  let anaWeb: string
  let agent: { id: string; secret: string } // may propose only
  let writer: { id: string; secret: string } // a curator let it write to the wiki
  let n = 0

  async function rpc(key: string, method: string, params: Json = {}) {
    n += 1
    const res = await fetch(`${w.base}/mcp`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${key}`,
        'content-type': 'application/json',
        'mcp-protocol-version': MODERN,
        'mcp-method': method,
        ...(typeof params.name === 'string' ? { 'mcp-name': params.name } : {}),
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: n,
        method,
        params: { ...params, _meta: { 'io.modelcontextprotocol/protocolVersion': MODERN } },
      }),
    })
    return (await res.json()) as Json
  }
  const call = async (key: string, name: string, args: Json = {}) => {
    const body = await rpc(key, 'tools/call', { name, arguments: args })
    const r = body.result as { isError: boolean; content: Array<{ text: string }>; structuredContent?: Json }
    return { isError: r.isError, text: r.content[0]?.text ?? '', data: r.structuredContent }
  }
  const tools = async (key: string) =>
    ((await rpc(key, 'tools/list')).result.tools as Array<{ name: string }>).map((t) => t.name)
  const token = async (name: string) =>
    (await w.callWeb(anaWeb, 'POST', '/v1/me/tokens', { name, perm: 'write', brains: ['yt'], days: 30 })).body
      .token as { id: string; secret: string }

  before(async () => {
    w = await world({ askFirst: true })
    eric = await w.person('Eric')
    ana = await w.person('Ana')
    await w.call(eric.key, 'POST', '/v1/brains', { slug: 'yt', purpose: 'Our channel.' })
    await w.member('yt', ana.id, 'contributor')
    ericWeb = await w.web(eric.id)
    anaWeb = await w.web(ana.id)
    agent = await token('Ana agent')
    writer = await token('Ana writer')
    assert.equal((await w.callWeb(ericWeb, 'PUT', `/v1/brains/yt/wiki/writers/${writer.id}`)).status, 200)
  })
  after(async () => w.close())

  it('E1: mem_search with the wrong field, none, or an unknown one is an error that names the field', async () => {
    for (const [args, field] of [
      [{ query: 'hooks' }, '"query"'],
      [{}, '"q"'],
      [{ bogus: 1 }, '"bogus"'],
    ] as const) {
      const r = await call(agent.secret, 'mem_search', args)
      assert.equal(r.isError, true, JSON.stringify(args))
      assert.match(r.text, /^invalid_request: mem_search: .+ How to proceed: .+/s)
      assert.ok(r.text.includes(field), r.text)
    }
    assert.equal((await call(agent.secret, 'mem_search', { q: 'hooks' })).isError, false)
  })

  it('E1: mem_session_start with "goal" (the field is "purpose") opens nothing', async () => {
    const before = Number((await w.db.one('SELECT count(*)::int AS n FROM sessions'))?.n)
    const r = await call(agent.secret, 'mem_session_start', { brain: 'yt', goal: 'ship' })
    assert.equal(r.isError, true)
    assert.match(r.text, /Unknown field "goal"/)
    assert.equal(Number((await w.db.one('SELECT count(*)::int AS n FROM sessions'))?.n), before)
    assert.equal(
      (await call(agent.secret, 'mem_session_start', { brain: 'yt', purpose: 'ship' })).isError,
      false,
    )
  })

  it('E1: a wrong type or value is refused before the route runs', async () => {
    const r = await call(agent.secret, 'mem_search', { q: 'x', limit: 'ten' })
    assert.match(r.text, /"limit" must be a whole number/)
    const e = await call(agent.secret, 'mem_session_summary', { session: 'ses_x' })
    assert.match(e.text, /"content" is required/)
  })

  it('E1: GET /v1/search without q is a 400; with q it answers', async () => {
    const none = await w.call(agent.secret, 'GET', '/v1/search')
    assert.equal(none.status, 400)
    assert.match(String((none.body.error as { message: string }).message), /"q" is required/)
    assert.equal((await w.call(agent.secret, 'GET', '/v1/search?brains=yt')).status, 400)
    assert.equal((await w.call(agent.secret, 'GET', '/v1/search?q=hooks')).status, 200)
  })

  it('E2: mem_save takes the types the server accepts, and says so; "discovery" and "correction" are refused', async () => {
    const save = (type: string) =>
      call(agent.secret, 'mem_save', { brain: 'yt', type, title: `T ${type}`, content: `About ${type}.` })
    for (const t of ['decision', 'learning', 'attempt', 'preference', 'fact', 'step', 'summary', 'note'])
      assert.equal((await save(t)).isError, false, t)
    for (const t of ['discovery', 'correction']) {
      const r = await save(t)
      assert.equal(r.isError, true, t)
      assert.match(
        r.text,
        /"type" must be one of: decision, learning, attempt, preference, fact, step, summary, note/,
      )
    }
    const listed = (await rpc(agent.secret, 'tools/list')).result.tools.find(
      (t: Json) => t.name === 'mem_save',
    )
    assert.deepEqual(listed.inputSchema.properties.type.enum, [
      'decision',
      'learning',
      'attempt',
      'preference',
      'fact',
      'step',
      'summary',
      'note',
    ])
  })

  it('E4: what a curator sent back with a comment is in mem_context for the agent that proposed', async () => {
    const e = await call(agent.secret, 'mem_save', {
      brain: 'yt',
      type: 'learning',
      title: 'Intros',
      content: 'Intros are short.',
    })
    const entryId = e.data?.receipt.entryId
    const p = await call(agent.secret, 'brain_propose', {
      brain: 'yt',
      title: 'Intros page',
      ops: [
        {
          ...OP_EXAMPLES.create,
          address: 'e4/intros',
          links: [],
          body: 'Short intros.',
          sources: [{ entryId }],
        },
      ],
    })
    assert.equal(p.isError, false, p.text)
    const id = p.data?.proposal.id
    const fp = (await w.callWeb(ericWeb, 'GET', `/v1/proposals/${id}/review`)).body.fingerprint
    const ret = await w.callWeb(ericWeb, 'POST', `/v1/proposals/${id}/return`, {
      fingerprint: fp,
      comment: 'Cite the video as well, and keep it to one paragraph.',
    })
    assert.equal(ret.status, 200, ret.text)
    const ctx = await call(agent.secret, 'mem_context', { brain: 'yt' })
    assert.equal(ctx.isError, false, ctx.text)
    assert.match(ctx.data?.text, /## Corrections for you/)
    assert.match(ctx.data?.text, /Cite the video as well/)
    // Someone else's key does not get it.
    const other = await w.call(eric.key, 'GET', '/v1/brains/yt/context')
    assert.doesNotMatch(String(other.body.text), /Cite the video as well/)
  })

  it('E6: brain_check asks no title, and still reports what is wrong', async () => {
    const ok = await call(agent.secret, 'brain_check', { brain: 'yt', ops: [OP_EXAMPLES.move] })
    assert.equal(ok.isError, false, ok.text)
    const bad = await call(agent.secret, 'brain_check', {
      brain: 'yt',
      ops: [{ address: 'a/b', reason: 'x' }],
    })
    assert.equal(bad.isError, true)
    assert.match(bad.text, /ops\[0\]\.op" is missing/)
    const noOps = await call(agent.secret, 'brain_check', { brain: 'yt' })
    assert.match(noOps.text, /"ops" is required/)
    // brain_propose still wants its title.
    assert.match(
      (await call(agent.secret, 'brain_propose', { brain: 'yt', ops: [OP_EXAMPLES.move] })).text,
      /"title" is required/,
    )
    // HTTP: the check route works without a title too.
    const http = await w.call(agent.secret, 'POST', '/v1/brains/yt/wiki/check', { ops: [OP_EXAMPLES.move] })
    assert.equal(http.status, 200, http.text)
  })

  it('the compile pack carries one example of each operation, and the ops schema is in tools/list', async () => {
    const r = await call(agent.secret, 'brain_compile_pack', { brain: 'yt' })
    assert.equal(r.isError, false, r.text)
    assert.deepEqual(Object.keys(r.data?.operations), [
      'create',
      'edit',
      'move',
      'link',
      'unlink',
      'status',
      'merge',
      'revert',
    ])
    assert.deepEqual(r.data?.operations.edit, OP_EXAMPLES.edit)
    const t = (await rpc(agent.secret, 'tools/list')).result.tools.find(
      (x: Json) => x.name === 'brain_propose',
    )
    assert.equal(t.inputSchema.properties.ops.items.oneOf.length, 8)
  })

  it('tools/list shows brain_write, brain_review and brain_decide only to a key a curator let write', async () => {
    const gated = ['brain_write', 'brain_review', 'brain_decide']
    const plain = await tools(agent.secret)
    for (const g of gated) assert.ok(!plain.includes(g), `${g} listed for a key without the permission`)
    assert.ok(plain.includes('brain_propose'))
    const full = await tools(writer.secret)
    for (const g of gated) assert.ok(full.includes(g), `${g} missing for the writer`)
    // A hidden tool called anyway is still refused by the route, saying what is missing.
    const r = await call(agent.secret, 'brain_write', { brain: 'yt', title: 'x', ops: [OP_EXAMPLES.move] })
    assert.equal(r.isError, true)
    assert.match(r.text, /wiki_write_not_allowed/)
    // Taken back: gone from the next list.
    assert.equal((await w.callWeb(ericWeb, 'DELETE', `/v1/brains/yt/wiki/writers/${writer.id}`)).status, 200)
    assert.ok(!(await tools(writer.secret)).includes('brain_write'))
    await w.callWeb(ericWeb, 'PUT', `/v1/brains/yt/wiki/writers/${writer.id}`)
  })

  describe('the review of a one-line change', () => {
    const lines = Array.from({ length: 60 }, (_, i) => `Line ${i} of the page, with some words in it.`)
    let proposalId: string
    let staleId: string

    before(async () => {
      const src = await call(agent.secret, 'mem_save', {
        brain: 'yt',
        type: 'fact',
        title: 'Long page',
        content: 'A long page exists.',
      })
      const entryId = src.data?.receipt.entryId
      const made = await call(writer.secret, 'brain_write', {
        brain: 'yt',
        title: 'A long page',
        ops: [
          {
            ...OP_EXAMPLES.create,
            address: 'rev/long',
            title: 'Long',
            body: lines.join('\n'),
            sources: [{ entryId }],
            links: [],
          },
        ],
      })
      assert.equal(made.isError, false, made.text)
      const changed = [...lines]
      changed[5] = 'Line 5 now says something else.'
      const p = await call(agent.secret, 'brain_propose', {
        brain: 'yt',
        title: 'Fix line 5',
        ops: [
          {
            op: 'edit',
            address: 'rev/long',
            baseRevision: 1,
            body: changed.join('\n'),
            reason: 'It was wrong.',
          },
        ],
      })
      assert.equal(p.isError, false, p.text)
      proposalId = p.data?.proposal.id
      // The page moves on after the proposal was written: a stale edit.
      const moved = [...lines]
      moved[40] = 'Line 40 changed by someone else.'
      const second = await call(writer.secret, 'brain_write', {
        brain: 'yt',
        title: 'Other change',
        ops: [{ op: 'edit', address: 'rev/long', baseRevision: 1, body: moved.join('\n'), reason: 'Other.' }],
      })
      assert.equal(second.isError, false, second.text)
      staleId = proposalId
    })

    it('returns a unified diff of the body and only the fields that changed, not three bodies', async () => {
      const r = await call(writer.secret, 'brain_review', { id: proposalId })
      assert.equal(r.isError, false, r.text)
      const op = r.data?.ops[0]
      assert.equal(op.changes.body.includes('-Line 5 of the page'), true, JSON.stringify(op.changes))
      assert.match(op.changes.body, /\+Line 5 now says something else\./)
      assert.match(op.changes.body, /^@@/)
      assert.deepEqual(Object.keys(op.changes), ['body'])
      assert.equal(op.before.revision, 2)
      assert.equal(op.stale.baseRevision, 1)
      assert.equal(op.stale.currentRevision, 2)
      assert.match(op.stale.changedSince.body, /\+Line 40 changed by someone else\./)
      // Line 20 is in no hunk: the unchanged text is not sent.
      assert.equal(r.text.includes('Line 20 of the page'), false)
      assert.match(r.data?.fingerprint, /^[0-9a-f]{64}$/)
      const full = await call(writer.secret, 'brain_review', { id: proposalId, full: true })
      assert.ok(r.text.length * 3 < full.text.length, `${r.text.length} vs ${full.text.length}`)
    })

    it('"full": true is the review the web shows, and view=compact is the same over HTTP', async () => {
      const web = await w.callWeb(ericWeb, 'GET', `/v1/proposals/${staleId}/review`)
      const full = await call(writer.secret, 'brain_review', { id: staleId, full: true })
      assert.deepEqual(full.data, web.body)
      const http = await w.call(writer.secret, 'GET', `/v1/proposals/${staleId}/review?view=compact`)
      assert.deepEqual(http.body, (await call(writer.secret, 'brain_review', { id: staleId })).data)
      assert.equal((await w.call(writer.secret, 'GET', `/v1/proposals/${staleId}/review?view=x`)).status, 400)
    })

    it('a new page shows its fields and its body as a diff from nothing', async () => {
      const saved = await call(agent.secret, 'mem_save', {
        brain: 'yt',
        type: 'fact',
        title: 'N',
        content: 'N',
      })
      const p = await call(agent.secret, 'brain_propose', {
        brain: 'yt',
        title: 'New page',
        ops: [
          {
            ...OP_EXAMPLES.create,
            address: 'rev/new',
            links: [],
            body: 'A new body.',
            sources: [{ entryId: saved.data?.receipt.entryId }],
          },
        ],
      })
      assert.equal(p.isError, false, p.text)
      const r = await call(writer.secret, 'brain_review', { id: p.data?.proposal.id })
      const op = r.data?.ops[0]
      assert.equal(op.before, null)
      assert.equal(op.changes.title, 'Audience retention')
      assert.match(op.changes.body, /^@@ -0,0 \+1/)
      assert.equal(op.op.body, undefined)
    })
  })
})
