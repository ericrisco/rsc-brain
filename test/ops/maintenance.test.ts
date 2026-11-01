// Maintenance (spec B7 «Actualizar», C12; plan §3.1): one row says until when rsc-brain refuses writes and
// why. It ends on its own after 30 minutes at most, so a command that died halfway never leaves the
// installation without writes.
import assert from 'node:assert/strict'
import { cp, mkdtemp, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, describe, it } from 'node:test'
import { MIGRATIONS_DIR, migrate } from '../../src/db/migrate.ts'
import { MAINTENANCE_MAX_SECONDS, maintenance } from '../../src/http/maintenance.ts'
import { freshDatabase, skipPg, type TestDb } from '../helpers/pg.ts'

describe('maintenance on PostgreSQL', { skip: skipPg }, () => {
  let t: TestDb
  const at = new Date('2026-11-01T10:00:00.000Z')
  const later = (s: number) => new Date(at.getTime() + s * 1000)
  before(async () => {
    t = await freshDatabase()
    await migrate(t.db)
  })
  after(async () => t.drop())

  it('is off on a new installation', async () => {
    assert.equal(await maintenance.current(t.db, at), null)
  })

  it('on: lasts 30 minutes by default, and says why', async () => {
    const r = await maintenance.on(t.db, at, { reason: 'update' })
    assert.equal(r.until.toISOString(), later(1800).toISOString())
    assert.equal(MAINTENANCE_MAX_SECONDS, 1800)
    assert.deepEqual(await maintenance.current(t.db, later(1799)), { until: later(1800), reason: 'update' })
  })

  it('ends by itself at 30 minutes: an expired maintenance is no maintenance', async () => {
    assert.equal(await maintenance.current(t.db, later(1800)), null)
    assert.equal(await maintenance.current(t.db, later(3600)), null)
  })

  it('never lasts more than 30 minutes, nor less than a minute', async () => {
    await assert.rejects(() => maintenance.on(t.db, at, { seconds: 1801, reason: 'manual' }), /1800/)
    await assert.rejects(() => maintenance.on(t.db, at, { seconds: 59, reason: 'manual' }), /60/)
    await assert.rejects(() => maintenance.on(t.db, at, { seconds: 1.5, reason: 'manual' }))
    const r = await maintenance.on(t.db, at, { seconds: 60, reason: 'manual' })
    assert.equal(r.until.toISOString(), later(60).toISOString())
  })

  it('takes only the known reasons', async () => {
    await assert.rejects(() => maintenance.on(t.db, at, { reason: 'because' as unknown as 'manual' }))
    for (const reason of ['update', 'restore', 'manual'] as const) {
      await maintenance.on(t.db, at, { reason })
      assert.equal((await maintenance.current(t.db, at))?.reason, reason)
    }
  })

  it('off: writes are taken again at once', async () => {
    await maintenance.on(t.db, at, { reason: 'restore' })
    await maintenance.off(t.db)
    assert.equal(await maintenance.current(t.db, at), null)
    const row = await t.db.one('SELECT maintenance_until, maintenance_reason FROM installation')
    assert.deepEqual(row, { maintenance_until: null, maintenance_reason: null })
  })
})

describe('migration 0022', { skip: skipPg }, () => {
  let t: TestDb
  let dir: string
  before(async () => {
    t = await freshDatabase()
    dir = await mkdtemp(join(tmpdir(), 'mig22-'))
    // A database of the previous release: every migration up to 0021.
    for (const f of await readdir(MIGRATIONS_DIR)) {
      if (/^\d{4}_.+\.sql$/.test(f) && f < '0022') await cp(join(MIGRATIONS_DIR, f), join(dir, f))
    }
    await migrate(t.db, dir)
  })
  after(async () => {
    await rm(dir, { recursive: true })
    await t.drop()
  })

  it('applies over a database at 0021 and adds the two columns, empty', async () => {
    const before = await t.db.query(
      "SELECT 1 FROM information_schema.columns WHERE column_name = 'maintenance_until'",
    )
    assert.equal(before.length, 0)
    const applied = await migrate(t.db)
    assert.ok(applied.includes('0022_maintenance'), applied.join(', '))
    const row = await t.db.one('SELECT maintenance_until, maintenance_reason FROM installation WHERE id = 1')
    assert.deepEqual(row, { maintenance_until: null, maintenance_reason: null })
    assert.deepEqual(await migrate(t.db), [])
  })
})
