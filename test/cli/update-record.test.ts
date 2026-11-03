// `rsc-brain update record` (plan §3.9, T042): what the launcher runs at the end of an update, in the service that
// answers then (the new one, or the old one after the rollback), so Admin › Backups & system can say how the last
// update went (CA7: «the failure is seen on the web»). It writes `lastUpdate` into status.json next to the copies,
// keeping everything else there. The log of a failed update arrives on the standard input; the installation key and
// database passwords never stay in it, and it is kept short.
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, describe, it } from 'node:test'

const CLI = new URL('../../src/cli/main.ts', import.meta.url).pathname
const KEY = 'update-record-test-key-with-more-than-thirty-two-chars'
const DB_PASSWORD = 'pw-canary-update-8d1e'

function run(
  args: string[],
  env: Record<string, string>,
  input = '',
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
    p.stdin.end(input)
  })
}

describe('rsc-brain update record (no database needed)', () => {
  let dir: string
  let env: Record<string, string>
  const status = async () => JSON.parse(await readFile(join(dir, 'status.json'), 'utf8'))
  before(async () => {
    dir = await mkdtemp(join(tmpdir(), 'rsc-brain-cli-update-'))
    env = {
      RSC_BRAIN_BACKUPS: dir,
      RSC_BRAIN_SECRET: KEY,
      RSC_BRAIN_DATABASE_URL: `postgres://rsc_brain:${DB_PASSWORD}@postgres:5432/rsc_brain`,
    }
  })
  after(async () => rm(dir, { recursive: true, force: true }))

  it('a good update: lastUpdate { ok, from, to, at } and everything else in status.json kept', async () => {
    const lastOk = { at: '2026-11-03T03:00:00.000Z', file: 'rsc-brain-20261103T030000Z-scheduled.rscb' }
    await writeFile(
      join(dir, 'status.json'),
      JSON.stringify({ lastOk, lastFailure: null, keyId: 'abc123abc123' }),
    )
    const started = Date.now()
    const r = await run(['update', 'record', '--ok', '--from', '0.1.0', '--to', '0.2.0'], env)
    assert.equal(r.code, 0, r.err)
    const s = await status()
    assert.deepEqual(s.lastOk, lastOk)
    assert.equal(s.keyId, 'abc123abc123')
    assert.equal(s.lastUpdate.ok, true)
    assert.equal(s.lastUpdate.from, '0.1.0')
    assert.equal(s.lastUpdate.to, '0.2.0')
    assert.ok(Date.parse(s.lastUpdate.at) >= started - 1000, s.lastUpdate.at)
    assert.equal(s.lastUpdate.log, undefined)
    assert.equal((await stat(join(dir, 'status.json'))).mode & 0o777, 0o600)
  })

  it('a failed update: its log from the standard input, without the key or a database password, and short', async () => {
    const lines = [
      `boot failed: key ${KEY}`,
      `connecting to postgres://rsc_brain:${DB_PASSWORD}@postgres:5432/rsc_brain`,
      ...Array.from({ length: 400 }, (_, i) => `migration 0024 line ${i}: relation "nowhere" does not exist`),
      // Near the end too, where the log is kept: the key, the database password alone, and another URL's password.
      `retrying with key ${KEY}`,
      `password=${DB_PASSWORD} rejected`,
      'mail via smtp://mailer:other-url-pw-35a7@smtp.example.test:587',
      'the last line',
    ]
    const r = await run(
      ['update', 'record', '--failed', '--from', '0.1.0', '--to', '0.2.0-broken'],
      env,
      `${lines.join('\n')}\n`,
    )
    assert.equal(r.code, 0, r.err)
    const u = (await status()).lastUpdate
    assert.equal(u.ok, false)
    assert.equal(u.to, '0.2.0-broken')
    assert.equal(typeof u.log, 'string')
    assert.ok(!u.log.includes(KEY), 'the key stayed in the log')
    assert.ok(!u.log.includes(DB_PASSWORD), 'a database password stayed in the log')
    assert.ok(!u.log.includes('other-url-pw-35a7'), 'the password of a URL stayed in the log')
    assert.match(u.log, /retrying with key \[redacted\]/)
    assert.ok(u.log.length <= 4000, `log of ${u.log.length} characters`)
    // The end of the log is what says why.
    assert.match(u.log, /the last line\s*$/)
    assert.ok(!(r.out + r.err).includes(KEY))
  })

  it('wrong use: exit 2, status.json untouched', async () => {
    const before = await readFile(join(dir, 'status.json'), 'utf8')
    for (const args of [
      ['update', 'record', '--from', '0.1.0', '--to', '0.2.0'],
      ['update', 'record', '--ok', '--failed', '--from', '0.1.0', '--to', '0.2.0'],
      ['update', 'record', '--ok', '--to', '0.2.0'],
      ['update', 'record', '--ok', '--from', '0.1.0'],
      ['update', 'record', '--ok', '--from', '0.1.0', '--to', 'x y'],
      ['update', 'record', '--ok', '--from', '0.1.0', '--to', '0.2.0', 'stray'],
      ['update', 'nothing'],
    ]) {
      const r = await run(args, env)
      assert.equal(r.code, 2, `${args.join(' ')}: ${r.err}`)
    }
    const none = await run(['update', 'record', '--ok', '--from', '0.1.0', '--to', '0.2.0'], {
      ...env,
      RSC_BRAIN_BACKUPS: '',
    })
    assert.equal(none.code, 2)
    assert.equal(await readFile(join(dir, 'status.json'), 'utf8'), before)
  })
})
