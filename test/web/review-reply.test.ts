import assert from 'node:assert/strict'
import { it } from 'node:test'
import { MAX_REPLY_CHARS } from '../../src/http/bounds.ts'
import { reviewReply } from '../../src/http/review-reply.ts'
import { MAX_ID_CHARS, toolResult } from '../../src/mcp/server.ts'
import { ApiError, createClient } from '../../web/src/api/client.ts'

it('a cut response is a recoverable error, never successful screen data', async () => {
  const c = createClient({
    here: () => '/',
    onSignedOut: () => assert.fail('not an authentication error'),
    transport: async () => ({
      status: 200,
      text: async () =>
        JSON.stringify({ cut: { message: 'Too large', howToProceed: 'Ask for less' }, partial: '{"ops":' }),
    }),
  })
  await assert.rejects(
    c.call('proposalReview', { path: { id: 'proposal' } }),
    (e) => e instanceof ApiError && e.code === 'reply_cut',
  )
})

it('review parts survive JSON escaping and the maximum MCP envelope without losing a character', async () => {
  const review = { proposal: { id: 'p' }, fingerprint: 'seen', ops: [{ body: '😀 "\\\n'.repeat(80000) }] }
  const c = createClient({
    here: () => '/',
    onSignedOut: () => assert.fail('unexpected sign-out'),
    transport: async (url) => {
      const reply = reviewReply(review, new URL(url, 'https://example.test').searchParams) as Record<
        string,
        unknown
      >
      const mcp = toolResult(reply, MAX_ID_CHARS)
      const text = (mcp.content as { text: string }[])[0]?.text as string
      assert.deepEqual(JSON.parse(text), reply, 'MCP returns complete JSON rather than a cut text')
      assert.ok(
        JSON.stringify({ jsonrpc: '2.0', id: 'x'.repeat(MAX_ID_CHARS - 2), result: mcp }).length <=
          MAX_REPLY_CHARS,
      )
      const body = JSON.stringify(reply)
      assert.ok(body.length <= MAX_REPLY_CHARS)
      return { status: 200, text: async () => body }
    },
  })
  assert.deepEqual(await c.call('proposalReview', { path: { id: 'p' } }), review)
})

for (const bad of ['snapshot', 'offset', 'end', 'json'] as const) {
  it(`refuses a ${bad} mismatch before exposing a partial review`, async () => {
    const text = JSON.stringify({ proposal: {}, fingerprint: 'f', ops: [] })
    let calls = 0
    const c = createClient({
      here: () => '/',
      onSignedOut: () => assert.fail('unexpected sign-out'),
      transport: async () => {
        calls += 1
        const first = calls === 1
        const chunk = {
          text: first ? text.slice(0, 10) : text.slice(10),
          offset: first ? 0 : 10,
          next: first ? 10 : null,
          total: text.length,
          snapshot: 'a'.repeat(64),
        }
        if (!first) {
          if (bad === 'snapshot') chunk.snapshot = 'b'.repeat(64)
          if (bad === 'offset') chunk.offset = 0
          if (bad === 'end') chunk.next = text.length
          if (bad === 'json') chunk.text = 'x'.repeat(chunk.text.length)
        }
        return { status: 200, text: async () => JSON.stringify({ reviewChunk: chunk }) }
      },
    })
    await assert.rejects(
      c.call('proposalReview', { path: { id: 'p' } }),
      (e) => e instanceof ApiError && e.code === 'bad_answer',
    )
    assert.equal(calls, 2)
  })
}
