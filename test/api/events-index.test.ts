// Review of PR23 (security): Activity opens the stream from the start (lastEventId=0), so the replay asks
// for one brain's events of the last 24 hours, and the gap check asks for older ones. On a large installation
// neither may read the whole events table: the plan must use an index, never a sequential scan of events.
// Also: migration 0017 fills the client of events written before 0016 from their key.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { after, before, describe, it } from 'node:test'
import type { Db } from '../../src/db/db.ts'
import { eventsOfBrain, missedBefore } from '../../src/domain/events.ts'
import { skipPg } from '../helpers/pg.ts'
import { type World, world } from '../helpers/world.ts'

type Captured = { text: string; params: unknown[] }

// A Db that only records the statements a function sends.
function recorder(): { db: Db; sent: Captured[] } {
  const sent: Captured[] = []
  const query = async (text: string, params: unknown[] = []) => {
    sent.push({ text, params })
    return []
  }
  const db = {
    query,
    one: async (text: string, params: unknown[] = []) => {
      sent.push({ text, params })
      return undefined
    },
    tx: async (f: (d: Db) => Promise<unknown>) => f(db as unknown as Db),
  } as unknown as Db
  return { db, sent }
}

async function plan(db: Db, c: Captured): Promise<string> {
  const rows = await db.query<{ 'QUERY PLAN': unknown }>(`EXPLAIN (FORMAT JSON) ${c.text}`, c.params)
  return JSON.stringify(rows[0]?.['QUERY PLAN'])
}

describe('reading events stays on indexes', { skip: skipPg }, () => {
  let w: World
  const ids: string[] = []
  let eric: { id: string; key: string }

  before(async () => {
    w = await world()
    eric = await w.person('Eric')
    for (let i = 0; i < 40; i++) {
      const slug = `b${i}`
      await w.call(eric.key, 'POST', '/v1/brains', { slug })
      const b = await w.db.one<{ id: string }>('SELECT id FROM brains WHERE slug = $1', [slug])
      ids.push((b as { id: string }).id)
    }
    // 200 000 events over 40 brains and 60 days, numbered in order.
    await w.db.query(
      `INSERT INTO events (brain_id, at, kind, label, seq)
       SELECT ($1::text[])[1 + (g % 40)], now() - (g || ' seconds')::interval * 26, 'entry.saved', 'x', nextval('events_seq')
         FROM generate_series(1, 200000) g`,
      [ids],
    )
    await w.db.query('ANALYZE events')
  })
  after(async () => w.close())

  it('the replay of the last 24 hours and the gap check use an index, not a scan of the table', async (t) => {
    const r = recorder()
    const now = new Date()
    const since = new Date(now.getTime() - 24 * 3_600_000)
    await eventsOfBrain(r.db, ids[3] as string, 0, Number.MAX_SAFE_INTEGER, since, 500)
    await missedBefore(r.db, ids[3] as string, 0, since, {
      curator: false,
      accountId: eric.id,
      credentialId: 'x',
      short: false,
    })
    assert.ok(r.sent.length >= 2)
    for (const c of r.sent) {
      const p = await plan(w.db, c)
      const nodes = [...p.matchAll(/"Node Type":"([^"]+)"(?:[^{}]*?"Index Name":"([^"]+)")?/g)].map((m) =>
        m[2] ? `${m[1]} (${m[2]})` : m[1],
      )
      t.diagnostic(`plan of ${c.text.trim().split(/\s+/).slice(0, 4).join(' ')}…: ${nodes.join(' → ')}`)
      assert.doesNotMatch(
        p,
        /"Node Type":"Seq Scan","Parallel Aware":(true|false),"Async Capable":(true|false),"Relation Name":"events"/,
        c.text,
      )
      assert.doesNotMatch(p, /Seq Scan[^}]*"Relation Name":"events"/, c.text)
    }
  })

  it('migration 0017 fills the client of older events from their key', async () => {
    const token = await w.token(eric.id)
    const saved = await fetch(`${w.base}/v1/brains/b1/entries`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': 'application/json',
        'user-agent': 'codex/2.0',
      },
      body: JSON.stringify({ type: 'note', title: 'Before 0016', content: 'x' }),
    })
    assert.equal(saved.status, 201)
    await w.db.query("UPDATE events SET client = NULL WHERE label = 'Before 0016'")
    const sql = readFileSync(new URL('../../migrations/0017_event_reads.sql', import.meta.url), 'utf8')
    await w.db.query(sql.replace(/CREATE INDEX(?! IF NOT EXISTS)/g, 'CREATE INDEX IF NOT EXISTS'))
    const row = await w.db.one<{ client: string | null }>(
      "SELECT client FROM events WHERE label = 'Before 0016'",
    )
    assert.equal(row?.client, 'codex/2.0')
  })
})
