// `rsc-brain backup` and `rsc-brain backups list` (plan §3.3): what the launcher runs in the container to make a
// copy (by hand, before an update) and to see the copies. The key is read from the environment, never from the
// command line, and never printed: only its id.
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtemp, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, describe, it } from 'node:test'
import { makeLog } from '../../src/core/log.ts'
import { migrate } from '../../src/db/migrate.ts'
import { backup, backupJob, readStatus } from '../../src/ops/backup/backup.ts'
import { keyId } from '../../src/ops/backup/format.ts'
import { freshDatabase, skipPg, type TestDb } from '../helpers/pg.ts'

const CLI = new URL('../../src/cli/main.ts', import.meta.url).pathname
const KEY = 'cli-backup-test-key-with-more-than-thirty-two-chars'

function run(
  args: string[],
  env: Record<string, string>,
): Promise<{ code: number; out: string; err: string }> {
  return new Promise((resolve) => {
    const p = spawn(process.execPath, [CLI, ...args], { env: { ...process.env, ...env } })
    let out = ''
    let err = ''
    p.stdout.on('data', (d) => {
      out += d
    })
    p.stderr.on('data', (d) => {
      err += d
    })
    p.on('close', (code) => resolve({ code: code ?? -1, out, err }))
  })
}

describe('rsc-brain backups list (no database needed)', () => {
  let dir: string
  before(async () => {
    dir = await mkdtemp(join(tmpdir(), 'rsc-brain-cli-list-'))
  })
  after(async () => rm(dir, { recursive: true, force: true }))

  it('without RSC_BRAIN_BACKUPS: exit 2, saying which variable to set', async () => {
    for (const args of [['backups', 'list'], ['backup']]) {
      const r = await run(args, { RSC_BRAIN_BACKUPS: '', RSC_BRAIN_DATABASE_URL: 'postgres://nowhere/x' })
      assert.equal(r.code, 2, r.err)
      assert.match(r.err, /RSC_BRAIN_BACKUPS/)
    }
  })

  it('an empty folder: no copies, said plainly; --json gives the items and the status', async () => {
    const env = { RSC_BRAIN_BACKUPS: dir, RSC_BRAIN_DATABASE_URL: 'postgres://nowhere/x' }
    const r = await run(['backups', 'list'], env)
    assert.equal(r.code, 0, r.err)
    assert.match(r.out, /No copies yet/)
    const j = await run(['backups', 'list', '--json'], env)
    assert.deepEqual(JSON.parse(j.out), { items: [], lastOk: null, lastFailure: null, keyId: null })
  })

  it('a reason a person cannot give, or an unknown option: exit 2', async () => {
    const env = {
      RSC_BRAIN_BACKUPS: dir,
      RSC_BRAIN_DATABASE_URL: 'postgres://nowhere/x',
      RSC_BRAIN_SECRET: KEY,
    }
    assert.equal((await run(['backup', '--reason', 'scheduled'], env)).code, 2)
    assert.equal((await run(['backup', '--key', KEY], env)).code, 2)
    assert.equal((await run(['backups', 'show'], env)).code, 2)
  })
})

describe('rsc-brain backup', { skip: skipPg }, () => {
  let t: TestDb
  let dir: string
  let env: Record<string, string>
  before(async () => {
    t = await freshDatabase()
    await migrate(t.db)
    dir = await mkdtemp(join(tmpdir(), 'rsc-brain-cli-backup-'))
    env = { RSC_BRAIN_DATABASE_URL: t.url, RSC_BRAIN_BACKUPS: dir, RSC_BRAIN_SECRET: KEY }
  })
  after(async () => {
    await t.drop()
    await rm(dir, { recursive: true, force: true })
  })

  it('makes a copy, says where and with which key id, never the key', async () => {
    const r = await run(['backup'], env)
    assert.equal(r.code, 0, r.err)
    assert.match(r.out, /Copy written: rsc-brain-\d{8}T\d{6}Z-manual\.rscb/)
    assert.match(r.out, new RegExp(`key id ${keyId(KEY)}`))
    assert.ok(!r.out.includes(KEY) && !r.err.includes(KEY))
    // Names are by the second: a second copy within it is refused, and the first is left as it was.
    const again = await run(['backup'], env)
    if (again.code !== 0) assert.match(again.err, /exists already\. Try again in a second/)
    await new Promise((r) => setTimeout(r, 1100))
    const j = await run(['backup', '--json'], env)
    assert.equal(j.code, 0, j.err)
    const info = JSON.parse(j.out)
    assert.equal(info.keyId, keyId(KEY))
    assert.equal(info.reason, 'manual')
    assert.ok(!j.out.includes(KEY))
  })

  it('backups list shows them, newest first, with their key id', async () => {
    const r = await run(['backups', 'list', '--json'], env)
    assert.equal(r.code, 0, r.err)
    const j = JSON.parse(r.out)
    assert.equal(j.items.length, (await readdir(dir)).filter((f) => f.endsWith('.rscb')).length)
    assert.equal(j.keyId, keyId(KEY))
    assert.ok(j.lastOk && j.lastFailure === null)
    const human = await run(['backups', 'list'], env)
    assert.match(human.out, /manual/)
    assert.ok(!human.out.includes(KEY))
  })

  it('without the installation key: exit 1, nothing written, the failure kept for the web', async () => {
    const before = (await readdir(dir)).sort()
    const { RSC_BRAIN_SECRET: _, ...noKey } = env
    const saved = process.env.RSC_BRAIN_SECRET
    delete process.env.RSC_BRAIN_SECRET
    const r = await run(['backup'], noKey).finally(() => {
      if (saved !== undefined) process.env.RSC_BRAIN_SECRET = saved
    })
    assert.equal(r.code, 1)
    assert.match(r.err, /RSC_BRAIN_SECRET/)
    assert.deepEqual((await readdir(dir)).sort(), before)
    assert.equal((await readStatus(dir)).lastFailure?.category, 'no_installation_secret')
    const list = await run(['backups', 'list'], env)
    assert.match(list.out, /The last copy failed .*no_installation_secret/)
  })

  it('pre-update without maintenance: exit 1 with the way out', async () => {
    const r = await run(['backup', '--reason', 'pre-update'], env)
    assert.equal(r.code, 1)
    assert.match(r.err, /maintenance on --reason update/)
  })

  it('the job of serve: a scheduled copy, then the old ones pruned, said in the log; a failure is logged, never thrown', async () => {
    const lines: string[] = []
    const log = makeLog((l) => lines.push(l))
    let now = new Date('2026-11-01T03:00:00Z')
    const job = backupJob(t.db, { dir, secret: KEY, keep: 1, clock: () => now, log })
    await job()
    now = new Date('2026-11-02T03:00:00Z')
    await job()
    const scheduled = (await backup.list(dir)).filter((b) => b.reason === 'scheduled')
    assert.deepEqual(
      scheduled.map((b) => b.createdAt),
      ['2026-11-02T03:00:00.000Z'],
    )
    const done = lines.map((l) => JSON.parse(l)).filter((l) => l.event === 'backup_done')
    assert.equal(done.length, 2)
    assert.equal(done[1].count, 1, 'one copy pruned')
    now = new Date('2026-11-03T03:00:00Z')
    const broken = backupJob(t.db, { dir, secret: undefined, keep: 1, clock: () => now, log })
    await broken()
    const failed = lines.map((l) => JSON.parse(l)).filter((l) => l.event === 'backup_failed')
    assert.deepEqual(
      failed.map((l) => l.code),
      ['no_installation_secret'],
    )
    assert.ok(lines.every((l) => !l.includes(KEY)))
  })
})
