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

  async function open(key: string) {
    const ac = new AbortController()
    const res = await fetch(`${w.base}/v1/brains/yt/events`, {
      headers: { authorization: `Bearer ${key}` },
      signal: ac.signal,
    })
    if (res.status === 200) held.push(ac)
    return {
      status: res.status,
      body:
        res.status === 200
          ? null
          : ((await res.json().catch(() => null)) as { error: { code: string } } | null),
      close: () => ac.abort(),
    }
  }
  const settle = () => new Promise((r) => setTimeout(r, 150))

  before(async () => {
    w = await world({
      events: { pollMs: 20, heartbeatMs: 100, recheckMs: 100, perKey: 2, total: 3 },
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
    await settle()
    const d = await open(token)
    assert.equal(d.status, 200)
    b.close()
    d.close()
    await settle()
  })

  it('the installation holds its share across keys', async () => {
    const keys = await Promise.all([w.token(eric.id), w.token(eric.id), w.token(eric.id)])
    const opened = [
      await open(keys[0] as string),
      await open(keys[0] as string),
      await open(keys[1] as string),
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
    await settle()
    const again = await open(keys[2] as string)
    assert.equal(again.status, 200)
    again.close()
  })
})
