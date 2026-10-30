// Event streams are held open, so they are counted: a key holds a few at a time and the installation a
// bounded number. Without that, one key could open streams faster than they close and starve the rest.
import assert from 'node:assert/strict'
import { after, before, describe, it } from 'node:test'
import { EVENT_TIMINGS } from '../../src/http/routes/events.ts'
import { skipPg } from '../helpers/pg.ts'
import { type World, world } from '../helpers/world.ts'

describe('open event streams are bounded', { skip: skipPg }, () => {
  let w: World
  let eric: { id: string; key: string }
  const held: AbortController[] = []

  // A stream counts as open once the server says it is following (": following"), not when its headers
  // arrive.
  async function open(key: string) {
    const ac = new AbortController()
    const res = await fetch(`${w.base}/v1/brains/yt/events`, {
      headers: { authorization: `Bearer ${key}` },
      signal: ac.signal,
    })
    if (res.status === 200) {
      held.push(ac)
      const reader = (res.body as ReadableStream<Uint8Array>).getReader()
      const text = new TextDecoder()
      let seen = ''
      while (!seen.includes(': following')) {
        const { value, done } = await reader.read()
        if (done) throw new Error('the stream ended before it was following')
        seen += text.decode(value, { stream: true })
      }
    }
    return {
      status: res.status,
      body:
        res.status === 200
          ? null
          : ((await res.json().catch(() => null)) as { error: { code: string } } | null),
      close: () => ac.abort(),
    }
  }
  // A closed stream frees its place once the server sees it go: asked again until it does (a fixed wait
  // was too short on a loaded machine), for a few seconds at most.
  async function openWhenFree(key: string) {
    const until = Date.now() + 5000
    for (;;) {
      const x = await open(key)
      if (x.status === 200 || Date.now() > until) return x
      await new Promise((r) => setTimeout(r, 25))
    }
  }

  before(async () => {
    w = await world({
      // No recheck of the key while counting: a database too busy to answer it would end a stream (as it
      // should), and the count would then be about the machine, not about the limits.
      events: { pollMs: 20, heartbeatMs: 100, recheckMs: 600_000, perKey: 2, total: 3 },
    })
    eric = await w.person('Eric')
    await w.call(eric.key, 'POST', '/v1/brains', { slug: 'yt' })
  })
  after(async () => {
    for (const ac of held) ac.abort()
    await w.close()
  })

  it('the defaults: five per key, two hundred in all', () => {
    assert.equal(EVENT_TIMINGS.perKey, 5)
    assert.equal(EVENT_TIMINGS.total, 200)
    assert.equal(EVENT_TIMINGS.bufferBytes, 1_000_000)
  })

  it('a key holds its share; closing one frees its place', async () => {
    const token = await w.token(eric.id)
    const a = await open(token)
    const b = await open(token)
    assert.deepEqual([a.status, b.status], [200, 200])
    const c = await open(token)
    assert.equal(c.status, 429)
    assert.equal(c.body?.error.code, 'too_many_streams')
    a.close()
    const d = await openWhenFree(token)
    assert.equal(d.status, 200)
    b.close()
    d.close()
    // Both places free again before the next test counts.
    const e = await openWhenFree(token)
    const f = await openWhenFree(token)
    assert.deepEqual([e.status, f.status], [200, 200])
    e.close()
    f.close()
  })

  it('the installation holds its share across keys', async () => {
    const keys = await Promise.all([w.token(eric.id), w.token(eric.id), w.token(eric.id)])
    // The places the last test used may still be on their way out.
    const opened = [
      await openWhenFree(keys[0] as string),
      await openWhenFree(keys[0] as string),
      await openWhenFree(keys[1] as string),
    ]
    assert.deepEqual(
      opened.map((x) => [x.status, x.body?.error.code]),
      [
        [200, undefined],
        [200, undefined],
        [200, undefined],
      ],
    )
    const late = await open(keys[2] as string)
    assert.equal(late.status, 503)
    assert.equal(late.body?.error.code, 'busy')
    for (const x of opened) x.close()
    const again = await openWhenFree(keys[2] as string)
    assert.equal(again.status, 200)
    again.close()
  })
})
