// The daily copy and its retention (spec B7 CA8, C2; plan §3.3): by default at 03:00 of the installation's time
// zone, keeping the newest 14 scheduled copies. A fake clock walks 15 days: 15 copies are made, 14 stay, the
// oldest is gone. Runs without PostgreSQL (CI): the copies are real .rscb files written by the format.
import assert from 'node:assert/strict'
import { mkdtemp, readdir, rename, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, describe, it } from 'node:test'
import { backup, backupName } from '../../src/ops/backup/backup.ts'
import { type BackupReason, writeBackup } from '../../src/ops/backup/format.ts'
import { createScheduler, nextRun, parseBackupAt } from '../../src/ops/backup/schedule.ts'

const KEY = 'schedule-test-key-with-more-than-thirty-two-chars'

async function fakeCopy(dir: string, at: Date, reason: BackupReason): Promise<string> {
  const name = backupName(at, reason)
  const parts: Buffer[] = []
  async function* rows() {
    yield Buffer.from('x')
  }
  await writeBackup(
    async (b) => void parts.push(Buffer.from(b)),
    {
      release: '0.1.0',
      migrations: [],
      createdAt: at.toISOString(),
      installation: { id: 1, name: 'T' },
      reason,
      tables: [],
      lastWriteAt: null,
    },
    rows(),
    KEY,
  )
  await writeFile(join(dir, name), Buffer.concat(parts))
  return name
}

describe('when the daily copy runs', () => {
  it('03:00 in the installation time zone, the next one strictly after now', () => {
    // Madrid is UTC+1 in winter, UTC+2 in summer.
    assert.equal(
      nextRun('03:00', 'Europe/Madrid', new Date('2026-11-02T01:00:00Z')).toISOString(),
      '2026-11-02T02:00:00.000Z',
    )
    assert.equal(
      nextRun('03:00', 'Europe/Madrid', new Date('2026-11-02T02:00:00Z')).toISOString(),
      '2026-11-03T02:00:00.000Z',
    )
    assert.equal(
      nextRun('03:00', 'Europe/Madrid', new Date('2026-07-01T12:00:00Z')).toISOString(),
      '2026-07-02T01:00:00.000Z',
    )
    assert.equal(
      nextRun('23:30', 'UTC', new Date('2026-11-02T23:29:59Z')).toISOString(),
      '2026-11-02T23:30:00.000Z',
    )
    assert.equal(
      nextRun('00:15', 'America/New_York', new Date('2026-11-02T12:00:00Z')).toISOString(),
      '2026-11-03T05:15:00.000Z',
    )
  })

  it('across a change of the clocks it stays at 03:00 local time', () => {
    // Europe/Madrid moves to summer time on 2026-03-29 (02:00 → 03:00).
    const fires: string[] = []
    let now = new Date('2026-03-27T12:00:00Z')
    for (let i = 0; i < 4; i += 1) {
      now = nextRun('03:00', 'Europe/Madrid', now)
      fires.push(now.toISOString())
    }
    assert.deepEqual(fires, [
      '2026-03-28T02:00:00.000Z',
      '2026-03-29T01:00:00.000Z',
      '2026-03-30T01:00:00.000Z',
      '2026-03-31T01:00:00.000Z',
    ])
  })

  it('a time in the hour the clocks go back is found from the right side of the change', () => {
    // 2026-10-25 in Madrid: 03:00 summer time becomes 02:00 winter time at 01:00 UTC. 01:30 is still summer time.
    assert.equal(
      nextRun('01:30', 'Europe/Madrid', new Date('2026-10-24T12:00:00Z')).toISOString(),
      '2026-10-24T23:30:00.000Z',
    )
  })

  it('RSC_BRAIN_BACKUP_AT is HH:MM; anything else is refused with the way out', () => {
    assert.equal(parseBackupAt('03:00'), '03:00')
    assert.equal(parseBackupAt('23:59'), '23:59')
    for (const bad of ['3:00', '24:00', '12:60', '03:00:00', 'noon', '']) {
      assert.throws(() => parseBackupAt(bad), /HH:MM/)
    }
  })
})

describe('CA8: 15 days of the daily copy', () => {
  let dir: string
  before(async () => {
    dir = await mkdtemp(join(tmpdir(), 'rsc-brain-schedule-'))
  })
  after(async () => rm(dir, { recursive: true, force: true }))

  it('fires 15 times, keeps 14, the oldest is removed; copies made by hand stay', async () => {
    let now = new Date('2026-11-01T00:00:00Z')
    const clock = () => now
    const made: string[] = []
    const manual = await fakeCopy(dir, new Date('2026-10-30T12:00:00Z'), 'manual')
    const preUpdate = await fakeCopy(dir, new Date('2026-10-31T12:00:00Z'), 'pre-update')
    const s = createScheduler({
      at: '03:00',
      tz: 'Europe/Madrid',
      clock,
      run: async () => {
        made.push(await fakeCopy(dir, clock(), 'scheduled'))
        await backup.prune(dir, 14)
      },
    })
    assert.equal(s.next().toISOString(), '2026-11-01T02:00:00.000Z')
    let fired = 0
    // Every 10 minutes for 15 days.
    for (let step = 0; step < 15 * 24 * 6; step += 1) {
      now = new Date(now.getTime() + 10 * 60_000)
      if (await s.check()) fired += 1
    }
    assert.equal(fired, 15)
    assert.equal(made.length, 15)
    const left = (await readdir(dir)).sort()
    const scheduled = left.filter((f) => f.endsWith('-scheduled.rscb'))
    assert.equal(scheduled.length, 14)
    assert.ok(!left.includes(made[0] as string), 'the oldest is removed')
    assert.deepEqual(scheduled, made.slice(1).sort())
    assert.ok(left.includes(manual) && left.includes(preUpdate))
    // Each at 03:00 Madrid (02:00 UTC in November).
    assert.ok(
      made.every((f) => /T020000Z-scheduled\.rscb$/.test(f)),
      made.join(' '),
    )
  })

  it('a check that comes late fires once, not once per missed day', async () => {
    let now = new Date('2026-11-01T00:00:00Z')
    let runs = 0
    const s = createScheduler({
      at: '03:00',
      tz: 'UTC',
      clock: () => now,
      run: async () => {
        runs += 1
      },
    })
    now = new Date('2026-11-05T00:00:00Z')
    assert.equal(await s.check(), true)
    assert.equal(await s.check(), false)
    assert.equal(runs, 1)
    assert.equal(s.next().toISOString(), '2026-11-05T03:00:00.000Z')
  })

  it('review of PR #29: started with no scheduled copy in the last 24 hours, it makes one at once, then keeps its time', async () => {
    let now = new Date('2026-11-05T12:00:00Z')
    let runs = 0
    const run = async () => {
      runs += 1
    }
    const s = createScheduler({
      at: '03:00',
      tz: 'UTC',
      clock: () => now,
      run,
      lastScheduledAt: new Date('2026-11-04T02:00:00Z'),
    })
    assert.equal(await s.check(), true, 'a copy at start')
    assert.equal(await s.check(), false, 'only once')
    assert.equal(s.next().toISOString(), '2026-11-06T03:00:00.000Z')
    now = new Date('2026-11-06T03:00:00Z')
    assert.equal(await s.check(), true)
    assert.equal(runs, 2)
  })

  it('review of PR #29: no catch-up when the last scheduled copy is recent, or the daily time is within the hour', async () => {
    const now = new Date('2026-11-05T12:00:00Z')
    const run = async () => {}
    const recent = createScheduler({
      at: '03:00',
      tz: 'UTC',
      clock: () => now,
      run,
      lastScheduledAt: new Date('2026-11-05T03:00:00Z'),
    })
    assert.equal(await recent.check(), false)
    assert.equal(recent.next().toISOString(), '2026-11-06T03:00:00.000Z')
    const soon = createScheduler({
      at: '12:30',
      tz: 'UTC',
      clock: () => now,
      run,
      lastScheduledAt: new Date('2026-11-01T12:30:00Z'),
    })
    assert.equal(await soon.check(), false)
    assert.equal(soon.next().toISOString(), '2026-11-05T12:30:00.000Z')
    // Never a scheduled copy at all: one at start.
    const never = createScheduler({ at: '03:00', tz: 'UTC', clock: () => now, run, lastScheduledAt: null })
    assert.equal(await never.check(), true)
  })

  it('second pass: a catch-up that meets a copy already running tries again every 2 minutes, then keeps the daily time', async () => {
    let now = new Date('2026-11-05T12:00:00Z')
    const answers: Array<'busy' | undefined> = ['busy', 'busy', undefined]
    const at: string[] = []
    const s = createScheduler({
      at: '03:00',
      tz: 'UTC',
      clock: () => now,
      run: async () => {
        at.push(now.toISOString())
        return answers.shift()
      },
      lastScheduledAt: null,
    })
    for (let i = 0; i < 10; i += 1) {
      await s.check()
      now = new Date(now.getTime() + 60_000)
    }
    assert.deepEqual(at, ['2026-11-05T12:00:00.000Z', '2026-11-05T12:02:00.000Z', '2026-11-05T12:04:00.000Z'])
    assert.equal(s.next().toISOString(), '2026-11-06T03:00:00.000Z')
  })

  it('second pass: it gives up retrying after 30 minutes, and the daily time still comes', async () => {
    let now = new Date('2026-11-05T12:00:00Z')
    let runs = 0
    const s = createScheduler({
      at: '03:00',
      tz: 'UTC',
      clock: () => now,
      run: async () => {
        runs += 1
        return 'busy'
      },
      lastScheduledAt: null,
    })
    for (let i = 0; i < 60; i += 1) {
      await s.check()
      now = new Date(now.getTime() + 60_000)
    }
    // At 0, 2, 4 … 30 minutes: 16 tries, then nothing until the daily time.
    assert.equal(runs, 16)
    assert.equal(s.next().toISOString(), '2026-11-06T03:00:00.000Z')
  })

  it('a run that fails does not stop the next day', async () => {
    let now = new Date('2026-11-01T00:00:00Z')
    let runs = 0
    const s = createScheduler({
      at: '03:00',
      tz: 'UTC',
      clock: () => now,
      run: async () => {
        runs += 1
        throw new Error('disk gone')
      },
    })
    now = new Date('2026-11-01T03:00:00Z')
    await assert.rejects(() => s.check())
    now = new Date('2026-11-02T03:00:00Z')
    await assert.rejects(() => s.check())
    assert.equal(runs, 2)
  })
})

describe('prune and list', () => {
  let dir: string
  before(async () => {
    dir = await mkdtemp(join(tmpdir(), 'rsc-brain-prune-'))
  })
  after(async () => rm(dir, { recursive: true, force: true }))

  it('only scheduled copies are pruned; keep below 1 still keeps the newest; unreadable files are never removed', async () => {
    const day = (d: number) => new Date(Date.UTC(2026, 10, d, 2))
    const s1 = await fakeCopy(dir, day(1), 'scheduled')
    const s2 = await fakeCopy(dir, day(2), 'scheduled')
    const m = await fakeCopy(dir, day(1), 'manual')
    const bad = backupName(day(0), 'scheduled')
    await writeFile(join(dir, bad), 'not a copy')
    // A copy still being written: its header is already there, but it is no copy until renamed.
    const writing = await fakeCopy(dir, day(3), 'scheduled')
    await rename(join(dir, writing), join(dir, `${writing}.part`))
    assert.deepEqual(await backup.prune(dir, 0), [s1])
    const left = (await readdir(dir)).sort()
    assert.ok(left.includes(s2) && left.includes(m) && left.includes(bad))
    assert.ok(!left.includes(s1))
  })

  it('list: newest first, headers only, never a .part nor a file of another name', async () => {
    await writeFile(join(dir, 'notes.txt'), 'hello')
    const list = await backup.list(dir)
    assert.deepEqual(
      list.map((b) => b.reason),
      ['scheduled', 'manual'],
    )
    assert.ok(list.every((b) => b.file.endsWith('.rscb') && b.id === b.file.slice(0, -5)))
    assert.ok(list[0] && list[0].bytes > 0 && /^[0-9a-f]{12}$/.test(list[0].keyId))
  })

  it('list of a folder that does not exist yet is empty', async () => {
    assert.deepEqual(await backup.list(join(dir, 'nope')), [])
  })
})
