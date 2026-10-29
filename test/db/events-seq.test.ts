// Events carry a delivery sequence, given by the live feed in the order the events became visible
// (spec B5 «Flujo de eventos»). An installation that already has events gets them numbered in id
// order when it upgrades; the feed numbers only what is still unnumbered, and the replay of a brain
// stops where the live feed takes over.
import assert from 'node:assert/strict'
import { copyFile, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, describe, it } from 'node:test'
import { systemClock } from '../../src/core/clock.ts'
import { MIGRATIONS_DIR, migrate, migrationFiles } from '../../src/db/migrate.ts'
import { createAccount } from '../../src/domain/accounts.ts'
import { eventsOfBrain, sequenceEvents } from '../../src/domain/events.ts'
import { freshDatabase, skipPg, type TestDb } from '../helpers/pg.ts'

describe('the delivery sequence of events', { skip: skipPg }, () => {
  let t: TestDb
  let dir: string
  let brainId: string
  let account: string
  const add = (label: string) =>
    t.db.query(
      `INSERT INTO events (brain_id, at, kind, account_id, label) VALUES ($1, now(), 'entry.saved', $2, $3)`,
      [brainId, account, label],
    )

  before(async () => {
    t = await freshDatabase()
    dir = await mkdtemp(join(tmpdir(), 'mig-seq-'))
    const files = await migrationFiles(MIGRATIONS_DIR)
    // The installation as it was before the sequence.
    for (const f of files.filter((x) => x < '0012')) await copyFile(join(MIGRATIONS_DIR, f), join(dir, f))
    await migrate(t.db, dir)
    account = await createAccount(t.db, systemClock, { kind: 'person', name: 'Eric', email: 'e@example.com' })
    brainId = 'brn_seq'
    await t.db.query(
      `INSERT INTO brains (id, slug, name, created_by, created_at, updated_at) VALUES ($1, 'seq', 'Seq', $2, now(), now())`,
      [brainId, account],
    )
    for (const label of ['one', 'two', 'three']) await add(label)
    await migrate(t.db)
  })
  after(async () => {
    await rm(dir, { recursive: true })
    await t.drop()
  })

  it('upgrading numbers the events already there, in id order', async () => {
    const rows = await t.db.query<{ label: string; seq: string }>('SELECT label, seq FROM events ORDER BY id')
    assert.deepEqual(
      rows.map((r) => [r.label, Number(r.seq)]),
      [
        ['one', 1],
        ['two', 2],
        ['three', 3],
      ],
    )
  })

  it('the feed numbers what is new, after what was there, and only once', async () => {
    await add('four')
    await add('five')
    const got = await sequenceEvents(t.db, 500)
    assert.deepEqual(got, [4, 5])
    assert.deepEqual(await sequenceEvents(t.db, 500), [])
    await assert.rejects(() => t.db.query(`UPDATE events SET seq = 1 WHERE label = 'five'`))
  })

  it('a batch takes at most its size, oldest first', async () => {
    for (const label of ['six', 'seven', 'eight']) await add(label)
    // A row touched since (a purge, a fix by hand) moves in the table; the oldest still goes first.
    await t.db.query(`UPDATE events SET label = label WHERE label = 'six'`)
    assert.deepEqual(await sequenceEvents(t.db, 2), [6, 7])
    assert.deepEqual(await sequenceEvents(t.db, 2), [8])
    const six = await t.db.one<{ seq: string }>(`SELECT seq FROM events WHERE label = 'six'`)
    assert.equal(Number(six?.seq), 6)
  })

  it('the replay of a brain goes from after one sequence up to another, both bounds kept', async () => {
    const rows = await eventsOfBrain(t.db, brainId, 2, 5, new Date(0), 100)
    assert.deepEqual(
      rows.map((r) => [r.seq, r.label]),
      [
        [3, 'three'],
        [4, 'four'],
        [5, 'five'],
      ],
    )
  })
})
