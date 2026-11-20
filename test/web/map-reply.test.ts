import assert from 'node:assert/strict'
import { it } from 'node:test'
import { MAX_REPLY_CHARS } from '../../src/http/bounds.ts'
import { chunkedReply } from '../../src/http/chunked-reply.ts'
import { MAX_ID_CHARS, toolResult } from '../../src/mcp/server.ts'

it('a map fitting HTTP stays whole up to the exact limit, and every MCP part fits its envelope', () => {
  const page = { address: 'test/page', title: 'Page', summary: '', tags: [], status: 'current' }
  const map = { count: 1, intro: '', groups: [{ type: 'topic', area: 'test', pages: [page] }] }
  const params = new URLSearchParams()
  page.summary = 'x'.repeat(MAX_REPLY_CHARS - JSON.stringify(map).length)
  assert.equal(chunkedReply('map', map, params, false), map)
  const mcp = chunkedReply('map', map, params, true) as { mapChunk: { next: number } }
  assert.ok(mcp.mapChunk.next > 0)
  const message = toolResult(mcp, MAX_ID_CHARS)
  const encoded = (message.content as { text: string }[])[0]?.text
  assert.ok(encoded)
  assert.deepEqual(JSON.parse(encoded), mcp)
  page.summary += 'x'
  assert.ok('mapChunk' in (chunkedReply('map', map, params, false) as object))
})
