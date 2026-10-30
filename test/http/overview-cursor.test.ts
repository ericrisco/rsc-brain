// The overview says up to which event it is current (its cursor), so the web follows the brain from
// there and misses nothing that happened between the overview and the stream: a tab hidden before the
// first event, a brain opened again, or an event between the two requests (review of PR18, L1–L3).
import assert from 'node:assert/strict'
import http from 'node:http'
import { after, before, describe, it } from 'node:test'
import { skipPg } from '../helpers/pg.ts'
import { type World, world } from '../helpers/world.ts'

describe('the overview cursor', { skip: skipPg }, () => {
  let w: World
  let eric: { id: string; key: string }

  // Reads the stream from `from` until an event of `kind` comes, or 3 seconds pass.
  const kindsFrom = (from: string | undefined, until: string) =>
    new Promise<string[]>((resolve) => {
      const kinds: string[] = []
      const req = http.get(
        `${w.base}/v1/brains/cur/events`,
        { headers: { authorization: `Bearer ${eric.key}`, ...(from ? { 'last-event-id': from } : {}) } },
        (res) => {
          let buf = ''
          res.setEncoding('utf8')
          res.on('data', (c: string) => {
            buf += c
            let at = buf.indexOf('\n\n')
            while (at >= 0) {
              const data = /^data: (.*)$/m.exec(buf.slice(0, at))?.[1]
              if (data && /^id: /m.test(buf.slice(0, at))) kinds.push(String(JSON.parse(data).kind))
              buf = buf.slice(at + 2)
              at = buf.indexOf('\n\n')
            }
            if (kinds.includes(until)) {
              req.destroy()
              resolve(kinds)
            }
          })
        },
      )
      req.on('error', () => resolve(kinds))
      setTimeout(() => {
        req.destroy()
        resolve(kinds)
      }, 3000)
    })

  before(async () => {
    w = await world({ events: { pollMs: 20, heartbeatMs: 100_000, recheckMs: 100_000 } })
    eric = await w.person('Eric')
    assert.equal((await w.call(eric.key, 'POST', '/v1/brains', { slug: 'cur' })).status, 201)
  })
  after(async () => w.close())

  it('says up to which event it is current, as the id a stream resumes from', async () => {
    const r = await w.call(eric.key, 'GET', '/v1/brains/cur/overview')
    assert.equal(r.status, 200, r.text)
    assert.match(String(r.body.cursor), /^\d+$/)
  })

  it('a stream opened later from the cursor gets what happened after the overview', async () => {
    const cursor = String((await w.call(eric.key, 'GET', '/v1/brains/cur/overview')).body.cursor)
    // The agent writes before anyone follows the brain (a hidden tab, a brain left and opened again).
    const saved = await w.call(eric.key, 'POST', '/v1/brains/cur/entries', {
      type: 'learning',
      title: 'Written while nobody watched',
      content: 'It must still reach the web.',
    })
    assert.equal(saved.status, 201, saved.text)
    // Let the feed number it first: the stream must replay it, not only the live tail.
    await new Promise((r) => setTimeout(r, 200))
    assert.ok((await kindsFrom(cursor, 'entry.saved')).includes('entry.saved'))
  })

  it('the cursor never runs ahead of what the overview shows', async () => {
    // Every event at or before the cursor is already counted in the overview that carried it.
    for (let i = 0; i < 5; i++) {
      await w.call(eric.key, 'POST', '/v1/brains/cur/entries', {
        type: 'note',
        title: `Note ${i}`,
        content: `Number ${i}.`,
      })
      const ov = await w.call(eric.key, 'GET', '/v1/brains/cur/overview')
      const shown = (ov.body.stats as { entries: number }).entries
      const counted = await w.db.one<{ n: number }>(
        `SELECT count(*)::int AS n FROM events e JOIN brains b ON b.id = e.brain_id
          WHERE b.slug = 'cur' AND e.kind = 'entry.saved' AND e.seq <= $1`,
        [Number(ov.body.cursor)],
      )
      assert.ok((counted?.n ?? 0) <= shown, `cursor ${String(ov.body.cursor)}: ${counted?.n} > ${shown}`)
    }
  })
})
