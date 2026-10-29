// Catching up after a busy day: the missed events can weigh megabytes. The stream waits for a slow
// client between batches; it does not cut it for being behind while it is still reading.
import assert from 'node:assert/strict'
import http from 'node:http'
import { after, before, describe, it } from 'node:test'
import { skipPg } from '../helpers/pg.ts'
import { type World, world } from '../helpers/world.ts'

describe('resuming a large backlog', { skip: skipPg }, () => {
  let w: World
  let eric: { id: string; key: string }

  before(async () => {
    w = await world({ events: { pollMs: 20, heartbeatMs: 100_000, recheckMs: 100_000 } })
    eric = await w.person('Eric')
    await w.call(eric.key, 'POST', '/v1/brains', { slug: 'yt' })
  })
  after(async () => w.close())

  it('a client reading at a few hundred KB/s gets every missed event', async () => {
    const brain = await w.db.one<{ id: string }>('SELECT id FROM brains WHERE slug = $1', ['yt'])
    const base = (await w.db.one<{ m: string }>('SELECT coalesce(max(seq), 0) AS m FROM events'))?.m ?? '0'
    const N = 3000 // about 3.9 MB of events: several times what a stream may keep waiting
    await w.db.query(
      `INSERT INTO events (brain_id, at, kind, account_id, label, query)
       SELECT $1, $2, 'search', $3, 'q', repeat('x', 1000) FROM generate_series(1, ${N})`,
      [brain?.id, w.clock(), eric.id],
    )
    const got = await new Promise<{ n: number; how: string }>((resolve) => {
      let n = 0
      const req = http.get(
        `${w.base}/v1/brains/yt/events`,
        { headers: { authorization: `Bearer ${eric.key}`, 'last-event-id': String(base) } },
        (res) => {
          let buf = ''
          res.setEncoding('utf8')
          res.on('data', (c: string) => {
            buf += c
            let at = buf.indexOf('\n\n')
            while (at >= 0) {
              if (/^id: /m.test(buf.slice(0, at))) n++
              buf = buf.slice(at + 2)
              at = buf.indexOf('\n\n')
            }
            if (n >= N) {
              req.destroy()
              resolve({ n, how: 'complete' })
              return
            }
            // A slow reader: a pause after every chunk.
            res.pause()
            setTimeout(() => res.resume(), 2)
          })
          res.on('close', () => resolve({ n, how: 'closed by the server' }))
        },
      )
      req.on('error', () => resolve({ n, how: 'error' }))
    })
    assert.deepEqual(got, { n: N, how: 'complete' })
  })
})
