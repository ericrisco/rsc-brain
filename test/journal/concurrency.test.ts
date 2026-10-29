// CA20 and CA21: all or nothing, and nothing lost under load — with real concurrent connections.
import assert from 'node:assert/strict'
import { after, before, describe, it } from 'node:test'
import { skipPg } from '../helpers/pg.ts'
import { type World, world } from '../helpers/world.ts'

describe('concurrency', { skip: skipPg }, () => {
  let w: World
  let keys: string[]
  before(async () => {
    w = await world()
    const owner = await w.person('Owner')
    await w.call(owner.key, 'POST', '/v1/brains', { slug: 'load' })
    keys = []
    for (let i = 0; i < 20; i += 1) {
      const p = await w.person(`Writer${i}`)
      await w.member('load', p.id, 'contributor')
      keys.push(p.key)
    }
  })
  after(async () => w.close())

  it('CA21: 20 clients × 50 entries at once give exactly 1 000 entries, each with its receipt', async () => {
    const results = await Promise.all(
      keys.map(async (key, i) => {
        const receipts: string[] = []
        for (let n = 0; n < 50; n += 1) {
          const r = await w.call(key, 'POST', '/v1/brains/load/entries', {
            type: 'note',
            title: `w${i} n${n}`,
            content: `writer ${i} entry ${n} unique`,
          })
          assert.equal(r.status, 201)
          receipts.push((r.body.receipt as { entryId: string }).entryId)
        }
        return receipts
      }),
    )
    const all = results.flat()
    assert.equal(new Set(all).size, 1000)
    const n = await w.db.one<{ n: number }>(
      "SELECT count(*)::int AS n FROM entries WHERE brain_id = (SELECT id FROM brains WHERE slug = 'load')",
    )
    assert.equal(n?.n, 1000)
  })

  it('the same topic saved by 10 clients at once gives one entry with 10 revisions', async () => {
    const rs = await Promise.all(
      keys.slice(0, 10).map((key, i) =>
        w.call(key, 'POST', '/v1/brains/load/entries', {
          type: 'learning',
          title: 'Race',
          content: `version ${i}`,
          topic: 'race/topic',
        }),
      ),
    )
    assert.deepEqual([...new Set(rs.map((r) => r.status))], [201])
    const ids = new Set(rs.map((r) => (r.body.receipt as { entryId: string }).entryId))
    assert.equal(ids.size, 1)
    const revs = rs.map((r) => (r.body.receipt as { revision: number }).revision).sort((a, b) => a - b)
    assert.deepEqual(revs, [1, 2, 3, 4, 5, 6, 7, 8, 9, 10])
  })

  it('the same request key retried 10 times at once writes once and gives one receipt', async () => {
    const body = { type: 'note', title: 'Retry', content: 'retried many times', requestKey: 'storm-1' }
    const rs = await Promise.all(
      Array.from({ length: 10 }, () => w.call(keys[0] as string, 'POST', '/v1/brains/load/entries', body)),
    )
    const ids = new Set(rs.map((r) => (r.body.receipt as { entryId: string }).entryId))
    assert.equal(ids.size, 1)
    const n = await w.db.one<{ n: number }>("SELECT count(*)::int AS n FROM entries WHERE title = 'Retry'")
    assert.equal(n?.n, 1)
  })

  it('CA20: a failure in the middle of a save leaves nothing behind', async () => {
    await w.db.query(`CREATE FUNCTION fail_receipt() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN IF NEW.key = encode(sha256('boom'::bytea), 'hex') THEN RAISE EXCEPTION 'injected failure'; END IF; RETURN NEW; END $$`)
    await w.db.query(
      'CREATE TRIGGER fail_receipt BEFORE INSERT ON request_keys FOR EACH ROW EXECUTE FUNCTION fail_receipt()',
    )
    const before = await w.db.one<{ e: number; r: number; v: number }>(
      'SELECT (SELECT count(*) FROM entries)::int AS e, (SELECT count(*) FROM entry_revisions)::int AS r, (SELECT count(*) FROM events)::int AS v',
    )
    const r = await w.call(keys[1] as string, 'POST', '/v1/brains/load/entries', {
      type: 'note',
      title: 'Doomed',
      content: 'this save fails at its last step',
      requestKey: 'boom',
    })
    assert.equal(r.status, 500)
    const afterCounts = await w.db.one<{ e: number; r: number; v: number }>(
      'SELECT (SELECT count(*) FROM entries)::int AS e, (SELECT count(*) FROM entry_revisions)::int AS r, (SELECT count(*) FROM events)::int AS v',
    )
    assert.deepEqual(afterCounts, before)
    await w.db.query('DROP TRIGGER fail_receipt ON request_keys')
  })
})
