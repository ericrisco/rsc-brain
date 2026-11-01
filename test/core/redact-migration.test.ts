// Third review of PR23: migration 0018 redacts the stored clients of a large installation without holding a
// table in memory. SQL picks the rows that may hold a secret, a batch at a time in key order, and each change
// is written by key. The SQL test must never miss a text the rules would change: a minimal sample of every
// rule goes through it.
import assert from 'node:assert/strict'
import { after, before, describe, it } from 'node:test'
import type { Db, Params, Row } from '../../src/db/db.ts'
import { REDACT_BATCH, STEPS } from '../../src/db/migrate.ts'
import { mayHoldSecret, RULE_NAMES, redact } from '../../src/privacy/redact.ts'
import { skipPg } from '../helpers/pg.ts'
import { type World, world } from '../helpers/world.ts'

const SECRET = 'sk-live-0123456789abcdefghijklmnopqrstuv'

// The shortest text each rule redacts, so the SQL test is checked at its edge.
const MINIMAL: Record<string, string> = {
  'private-key': '-----BEGIN PRIVATE KEY-----',
  anthropic: `sk-ant-${'a'.repeat(20)}`,
  openai: `sk-${'a'.repeat(20)}`,
  github: `ghp_${'a'.repeat(36)}`,
  'github-pat': `github_pat_${'a'.repeat(50)}`,
  gitlab: `glpat-${'a'.repeat(20)}`,
  slack: 'xoxb-1234567890',
  'aws-access-key': 'AKIAIOSFODNN7EXAMPLE',
  google: `AIza${'a'.repeat(35)}`,
  stripe: `sk_live_${'a'.repeat(16)}`,
  replicate: `r8_${'a'.repeat(30)}`,
  huggingface: `hf_${'a'.repeat(30)}`,
  npm: `npm_${'a'.repeat(36)}`,
  sendgrid: `SG.${'a'.repeat(22)}.${'a'.repeat(43)}`,
  'telegram-bot': `12345678:AA${'a'.repeat(33)}`,
  jwt: 'eyJabcdefgh.eyJabcdefgh.abcdefgh',
  'rsc-brain': `rscb_${'a'.repeat(43)}`,
  'url-credentials': 'a://:b@',
  authorization: 'authorization: bearer abcdefgh',
  assignment: 'pwd=abcdefgh',
  private: '<private>x</private>',
}

// A Db that counts the rows each statement returns and keeps the statements.
function counting(db: Db) {
  const seen = { maxRows: 0, totalRows: 0, texts: [] as string[] }
  const wrap = (d: Db): Db => ({
    async query<T extends Row>(text: string, params?: Params) {
      const rows = await d.query<T>(text, params)
      seen.maxRows = Math.max(seen.maxRows, rows.length)
      seen.totalRows += rows.length
      seen.texts.push(text)
      return rows
    },
    one: (text, params) => d.one(text, params),
    tx: (f) => d.tx((t) => f(wrap(t))),
  })
  return { db: wrap(db), seen }
}

const step = () => {
  const s = STEPS.find((x) => x.id === '0018_redact_clients')
  assert.ok(s, 'the step is known to the migrator')
  return s
}

describe('migration 0018 on a large installation', { skip: skipPg }, () => {
  let w: World
  let brainId = ''
  before(async () => {
    w = await world()
    const eric = await w.person('Eric')
    await w.call(eric.key, 'POST', '/v1/brains', { slug: 'big' })
    brainId = String((await w.db.one("SELECT id FROM brains WHERE slug = 'big'"))?.id)
  })
  after(async () => w.close())

  it('the SQL test is true of a minimal sample of every rule, inside ordinary text', async () => {
    assert.deepEqual(Object.keys(MINIMAL).sort(), [...RULE_NAMES, 'private'].sort())
    for (const [name, sample] of Object.entries(MINIMAL)) {
      const text = `the app ${sample} said`
      assert.ok(redact(text).redactions > 0, `${name}: the sample is one the rules redact`)
      const r = await w.db.one<{ hit: boolean }>(`SELECT ${mayHoldSecret('$1::text')} AS hit`, [text])
      assert.equal(r?.hit, true, `${name}: the SQL test misses ${text}`)
    }
    // And false of the names programs usually give, so they are not read at all.
    for (const plain of ['claude-code', 'Claude Code/1.2.3', 'curl/8.7.1', 'rsc-factory run r_cd590faa']) {
      const r = await w.db.one<{ hit: boolean }>(`SELECT ${mayHoldSecret('$1::text')} AS hit`, [plain])
      assert.equal(r?.hit, false, plain)
    }
  })

  it('redacts 100 000 events reading only the rows that may hold a secret, a batch at a time, by key', async (t) => {
    await w.db.query(
      `INSERT INTO events (brain_id, at, kind, label, client)
       SELECT $1, now() - (g || ' seconds')::interval, 'entry.saved', 'x',
              CASE WHEN g % 2000 = 0 THEN 'bot ' || $2
                   WHEN g % 3 = 0 THEN 'Claude Code/1.2.3'
                   WHEN g % 3 = 1 THEN 'claude-code'
                   ELSE NULL END
         FROM generate_series(1, 100000) g`,
      [brainId, SECRET],
    )
    // Rows that only look like a secret (a long word) are read and left as they were.
    await w.db.query(
      `INSERT INTO events (brain_id, at, kind, label, client)
       SELECT $1, now(), 'entry.saved', 'x', 'averyveryverylongprogramname' FROM generate_series(1, 2500)`,
      [brainId],
    )
    // And dirty rows past the first batch, so only a run that goes on to the next batch cleans them.
    await w.db.query(
      `INSERT INTO events (brain_id, at, kind, label, client)
       SELECT $1, now(), 'entry.saved', 'x', 'late ' || $2 FROM generate_series(1, 5)`,
      [brainId, SECRET],
    )
    const c = counting(w.db)
    global.gc?.()
    const heap0 = process.memoryUsage().heapUsed
    const t0 = performance.now()
    let peak = heap0
    const timer = setInterval(() => {
      peak = Math.max(peak, process.memoryUsage().heapUsed)
    }, 5)
    await c.db.tx((tx) => step().run(tx))
    clearInterval(timer)
    peak = Math.max(peak, process.memoryUsage().heapUsed)
    const ms = performance.now() - t0
    t.diagnostic(
      `0018 on 102 505 events: ${ms.toFixed(0)} ms, ${c.seen.totalRows} rows read, ` +
        `largest read ${c.seen.maxRows} rows, heap growth ${((peak - heap0) / 1048576).toFixed(1)} MiB`,
    )
    const left = await w.db.one<{ n: string }>('SELECT count(*) AS n FROM events WHERE client LIKE $1', [
      '%0123456789abcdefghij%',
    ])
    assert.equal(Number(left?.n), 0)
    const kept = await w.db.one<{ n: string }>(
      "SELECT count(*) AS n FROM events WHERE client IN ('claude-code', 'Claude Code/1.2.3', 'averyveryverylongprogramname')",
    )
    let plain = 2500
    for (let g = 1; g <= 100_000; g++) if (g % 2000 !== 0 && g % 3 !== 2) plain++
    assert.equal(Number(kept?.n), plain)
    // Never the whole table: the 55 dirty rows and the 2 500 look-alikes, in batches, updated by key.
    assert.ok(c.seen.maxRows <= REDACT_BATCH, `one read returned ${c.seen.maxRows} rows`)
    assert.ok(c.seen.totalRows <= 2555 + 10, `${c.seen.totalRows} rows read`)
    assert.ok(!c.seen.texts.some((x) => /ctid/.test(x)), 'rows are found and written by key')
  })
})
