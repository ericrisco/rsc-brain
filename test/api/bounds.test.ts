// Spec B5 «Respuestas acotadas»: no answer of the API passes 256 000 characters; one that would is cut,
// says so, and says how to ask for the rest. The MCP endpoint cuts at the same size.
import assert from 'node:assert/strict'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { after, before, describe, it } from 'node:test'
import { createHandler, ROUTES } from '../../src/http/app.ts'
import { MAX_REPLY_CHARS } from '../../src/http/bounds.ts'
import { route } from '../../src/http/router.ts'
import { MAX_REPLY_CHARS as MCP_MAX, MODERN } from '../../src/mcp/server.ts'
import { skipPg } from '../helpers/pg.ts'
import { type World, world } from '../helpers/world.ts'

describe('bounded answers', { skip: skipPg }, () => {
  let w: World
  let server: Server
  let base: string
  let key: string

  before(async () => {
    w = await world()
    key = (await w.person('Eric')).key
    // The real routes, plus two that answer too much and just enough.
    const routes = [
      route('GET /v1/test/big', async () => ({ body: { items: ['é'.repeat(300_000)], next: null } })),
      route('GET /v1/test/fits', async () => ({ body: { text: 'x'.repeat(MAX_REPLY_CHARS - 20) } })),
      ...ROUTES,
    ]
    server = createServer(createHandler({ db: w.db, clock: w.clock, routes, log: () => {} }))
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  })
  after(async () => {
    await new Promise<void>((r) => server.close(() => r()))
    await w.close()
  })

  const get = async (path: string) => {
    const res = await fetch(`${base}${path}`, { headers: { authorization: `Bearer ${key}` } })
    const text = await res.text()
    return { status: res.status, headers: res.headers, text, body: JSON.parse(text) }
  }

  it('one limit for the API and the MCP endpoint: 256 000 characters', () => {
    assert.equal(MAX_REPLY_CHARS, 256_000)
    assert.equal(MCP_MAX, MAX_REPLY_CHARS)
  })

  it('an answer over the limit is cut: still JSON, within the limit, saying so and how to ask for the rest', async () => {
    const r = await get('/v1/test/big')
    assert.equal(r.status, 200)
    assert.ok(r.text.length <= MAX_REPLY_CHARS, `${r.text.length} characters`)
    assert.equal(r.headers.get('x-brain-cut'), 'true')
    const cut = r.body.cut as { at: number; chars: number; message: string; howToProceed: string }
    assert.equal(cut.at, MAX_REPLY_CHARS)
    assert.ok(cut.chars > MAX_REPLY_CHARS)
    assert.match(cut.message, /cut at 256000 characters/)
    assert.match(cut.howToProceed, /limit|filter|next page/)
    assert.equal(typeof r.body.partial, 'string')
    assert.ok((r.body.partial as string).startsWith('{"items":["éé'))
  })

  it('an answer within the limit is untouched', async () => {
    const r = await get('/v1/test/fits')
    assert.equal(r.headers.get('x-brain-cut'), null)
    assert.equal((r.body.text as string).length, MAX_REPLY_CHARS - 20)
  })

  it('a real answer: a compile pack of 400 000 characters, by the API and by MCP, both within the limit', async () => {
    await w.call(key, 'POST', '/v1/brains', { slug: 'big' })
    // Quotes double when written as JSON text: the limit holds for what is sent, not for the raw text.
    const content = '"quoted" '.repeat(3500)
    for (let i = 0; i < 13; i += 1) {
      const r = await w.call(key, 'POST', '/v1/brains/big/entries', {
        type: 'note',
        title: `Long ${i}`,
        content,
      })
      assert.equal(r.status, 201, r.text)
    }
    const api = await w.raw('GET', '/v1/brains/big/wiki/compile?maxChars=400000', {
      headers: { authorization: `Bearer ${key}` },
    })
    assert.equal(api.status, 200)
    assert.ok(api.text.length <= MAX_REPLY_CHARS, `${api.text.length}`)
    assert.equal(api.headers.get('x-brain-cut'), 'true')
    const res = await fetch(`${w.base}/mcp`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${key}`,
        'content-type': 'application/json',
        'mcp-protocol-version': MODERN,
        'mcp-method': 'tools/call',
        'mcp-name': 'brain_compile_pack',
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 7,
        method: 'tools/call',
        params: {
          name: 'brain_compile_pack',
          arguments: { brain: 'big', maxChars: 400000 },
          _meta: { 'io.modelcontextprotocol/protocolVersion': MODERN },
        },
      }),
    })
    const text = await res.text()
    assert.equal(res.status, 200)
    assert.ok(text.length <= MAX_REPLY_CHARS, `${text.length}`)
    const rpc = JSON.parse(text) as {
      id: number
      result: { isError: boolean; content: Array<{ text: string }> }
    }
    assert.equal(rpc.id, 7)
    assert.equal(rpc.result.isError, false)
    assert.match(rpc.result.content[0]?.text ?? '', /\[cut at 256000 characters\. Ask for less/)
  })
})
