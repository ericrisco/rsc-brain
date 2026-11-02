// Review of PR31 (spec B7 «Exportar», plan §3.5): an export is prepared into a private file inside a short
// snapshot, and only then sent. A client that stops reading holds no database connection and no snapshot (so
// copies before an update are not held up), and is let go after a stall; at most two exports are prepared at
// once; a disk short of room refuses before anything is written; the file goes in every case.
import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from 'node:fs'
import { get, type IncomingMessage } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, describe, it } from 'node:test'
import { EXPORT_LIMITS, EXPORT_STATE, sweepExports } from '../../src/ops/export/export.ts'
import { download } from '../helpers/download.ts'
import { skipPg } from '../helpers/pg.ts'
import { type World, world } from '../helpers/world.ts'

const root = mkdtempSync(join(tmpdir(), 'rsc-brain-export-send-'))
// Made by the server itself, as it would be.
const dir = join(root, 'exports')
after(() => rmSync(root, { recursive: true, force: true }))

describe('a crash leaves no export behind (the next start sweeps)', () => {
  it('removes prepared files older than an hour, keeps the fresh one', async () => {
    const d = mkdtempSync(join(tmpdir(), 'rsc-brain-export-sweep-'))
    try {
      writeFileSync(join(d, 'old.zip.part'), 'x')
      writeFileSync(join(d, 'fresh.zip.part'), 'y')
      const old = new Date(Date.now() - 2 * 3_600_000)
      utimesSync(join(d, 'old.zip.part'), old, old)
      await sweepExports(d, new Date())
      assert.deepEqual(readdirSync(d), ['fresh.zip.part'])
    } finally {
      rmSync(d, { recursive: true, force: true })
    }
  })
})

describe('preparing and sending an export', { skip: skipPg }, () => {
  let w: World
  let web: string
  const path = '/v1/brains/big/export?format=readable'
  const open = (): Promise<IncomingMessage> =>
    new Promise((resolve, reject) => {
      const req = get(`${w.base}${path}`, { headers: { cookie: `rscb_session=${web}` } }, (res) => {
        // A client that stops reading: nothing is taken from the socket.
        res.pause()
        resolve(res)
      })
      req.on('error', reject)
    })
  // Every prepared file is gone, within a moment.
  const gone = async () => {
    const end = Date.now() + 3000
    while (readdirSync(dir).length && Date.now() < end) await new Promise((r) => setTimeout(r, 50))
    assert.deepEqual(readdirSync(dir), [])
  }
  const inTransaction = async () =>
    Number(
      (
        await w.db.one(
          `SELECT count(*)::int AS n FROM pg_stat_activity
            WHERE datname = current_database() AND state LIKE 'idle in transaction%'`,
        )
      )?.n,
    )

  before(async () => {
    // What a crash left there goes when the server starts.
    mkdirSync(dir, { mode: 0o700 })
    writeFileSync(join(dir, 'crashed.zip.part'), 'x')
    const old = new Date(Date.now() - 2 * 3_600_000)
    utimesSync(join(dir, 'crashed.zip.part'), old, old)
    chmodSync(dir, 0o755)
    w = await world({ exportDir: dir })
    const eric = await w.person('Eric')
    await w.call(eric.key, 'POST', '/v1/brains', { slug: 'big', purpose: 'A big export.' })
    web = await w.web(eric.id)
    // About 18 MB of text that compresses to half: more than any socket holds. One entry by the API, the rest
    // copied from it in the database.
    const r = await w.call(eric.key, 'POST', '/v1/brains/big/entries', {
      type: 'note',
      title: 'Noise',
      content: randomBytes(16_000).toString('base64'),
    })
    assert.equal(r.status, 201, r.text)
    await w.db.query(
      `INSERT INTO entries (id, brain_id, session_id, type, title, content, author_id, norm_hash, created_at, updated_at)
       SELECT 'ent_' || lpad(to_hex(g), 12, '0'), brain_id, session_id, type, 'Noise ' || g,
              (SELECT string_agg(md5(random()::text || g || i), '') FROM generate_series(1, 700) i),
              author_id, md5(g::text), created_at, updated_at
         FROM entries e, generate_series(1, 800) g WHERE e.id = $1`,
      [String((r.body.receipt as Record<string, unknown>).entryId)],
    )
  })
  after(async () => w.close())

  it('clients that stop reading hold no database connection and no snapshot', async () => {
    const stalled = [await open(), await open(), await open()]
    for (const s of stalled) assert.equal(s.statusCode, 200)
    await new Promise((r) => setTimeout(r, 300))
    assert.equal(await inTransaction(), 0)
    // The pool still answers everyone else.
    assert.equal((await w.callWeb(web, 'GET', '/v1/brains/big')).status, 200)
    for (const s of stalled) s.destroy()
    await gone()
  })

  it('a client that stalls is let go, and its file goes', async () => {
    const was = EXPORT_LIMITS.stallMs
    EXPORT_LIMITS.stallMs = 300
    try {
      const s = await open()
      // The prepared file only this user reads, while it waits.
      for (const f of readdirSync(dir)) assert.equal(statSync(join(dir, f)).mode & 0o077, 0, f)
      // Seen from the server: the prepared file goes once the stalled download is let go.
      const end = Date.now() + 3000
      while (readdirSync(dir).length && Date.now() < end) await new Promise((r) => setTimeout(r, 50))
      assert.deepEqual(readdirSync(dir), [], 'the stalled download was not let go')
      s.destroy()
    } finally {
      EXPORT_LIMITS.stallMs = was
    }
  })

  it('a whole download is the whole file, sized, and its file goes', async () => {
    const d = await download(w, { session: web }, path)
    assert.equal(d.status, 200)
    assert.equal(Number(d.headers.get('content-length')), d.bytes.length)
    assert.ok(d.bytes.length > 8_000_000, `${d.bytes.length} bytes`)
    // The file goes once the server has sent its end (a moment after the client read it).
    await gone()
    assert.equal(EXPORT_STATE.building, 0)
  })

  it('a third export while two are prepared is told to wait', async () => {
    EXPORT_STATE.building = 2
    try {
      const d = await download(w, { session: web }, path)
      assert.equal(d.status, 409)
      assert.equal(((d.json?.error ?? {}) as Record<string, unknown>).code, 'export_busy')
      assert.match(
        String(((d.json?.error ?? {}) as Record<string, unknown>).message),
        /Another export is being prepared/,
      )
    } finally {
      EXPORT_STATE.building = 0
    }
    assert.deepEqual(readdirSync(dir), [])
  })

  it('a disk short of room refuses before sending, and leaves nothing', async () => {
    const was = EXPORT_LIMITS.minFreeBytes
    EXPORT_LIMITS.minFreeBytes = Number.MAX_SAFE_INTEGER
    const since = Number((await w.db.one('SELECT coalesce(max(id), 0) AS n FROM audit'))?.n)
    try {
      const d = await download(w, { session: web }, path)
      assert.equal(d.status, 507)
      // Refused before it started: no export is recorded.
      const n = await w.db.one(
        "SELECT count(*)::int AS n FROM audit WHERE action = 'brain.export' AND id > $1",
        [since],
      )
      assert.equal(n?.n, 0)
      assert.equal(((d.json?.error ?? {}) as Record<string, unknown>).code, 'export_no_space')
    } finally {
      EXPORT_LIMITS.minFreeBytes = was
    }
    assert.deepEqual(readdirSync(dir), [])
    assert.equal(EXPORT_STATE.building, 0)
  })

  it('an export bigger than an export may be refuses, and its file goes', async () => {
    const was = EXPORT_LIMITS.maxBytes
    EXPORT_LIMITS.maxBytes = 1024 * 1024
    try {
      const d = await download(w, { session: web }, path)
      assert.equal(d.status, 507)
    } finally {
      EXPORT_LIMITS.maxBytes = was
    }
    assert.deepEqual(readdirSync(dir), [])
    assert.equal(EXPORT_STATE.building, 0)
  })

  it('prepares in a folder only this user reads, files only this user reads', async () => {
    assert.equal(statSync(dir).mode & 0o077, 0)
  })
})
