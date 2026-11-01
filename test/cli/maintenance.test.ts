// `rsc-brain maintenance on|off|status` and `rsc-brain version` (plan §3.1, §3.9): what the launcher runs
// inside the container to put rsc-brain in maintenance around an update, and to check the version it serves.
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { after, before, describe, it } from 'node:test'
import { VERSION } from '../../src/core/version.ts'
import { freshDatabase, skipPg, type TestDb } from '../helpers/pg.ts'

const CLI = new URL('../../src/cli/main.ts', import.meta.url).pathname

function run(
  args: string[],
  env: Record<string, string> = {},
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

describe('rsc-brain version', () => {
  it('prints the version and needs no database', async () => {
    const r = await run(['version'], { RSC_BRAIN_DATABASE_URL: '' })
    assert.equal(r.code, 0, r.err)
    assert.equal(r.out, `${VERSION}\n`)
  })
})

describe('rsc-brain maintenance', { skip: skipPg }, () => {
  let t: TestDb
  let env: Record<string, string>
  before(async () => {
    t = await freshDatabase()
    env = { RSC_BRAIN_DATABASE_URL: t.url }
  })
  after(async () => t.drop())

  it('status says off on a new installation', async () => {
    const r = await run(['maintenance', 'status', '--json'], env)
    assert.equal(r.code, 0, r.err)
    assert.deepEqual(JSON.parse(r.out), { until: null, reason: null })
    const human = await run(['maintenance', 'status'], env)
    assert.match(human.out, /Maintenance is off/)
  })

  it('on, with seconds and a reason; status --json gives {until, reason}', async () => {
    const t0 = Date.now()
    const r = await run(['maintenance', 'on', '--seconds', '120', '--reason', 'update'], env)
    assert.equal(r.code, 0, r.err)
    assert.match(r.out, /Maintenance is on until .+ \(update\)/)
    const s = JSON.parse((await run(['maintenance', 'status', '--json'], env)).out)
    assert.equal(s.reason, 'update')
    const left = new Date(s.until).getTime() - t0
    assert.ok(left > 100_000 && left <= 125_000, `${left}`)
  })

  it('off ends it at once', async () => {
    const r = await run(['maintenance', 'off'], env)
    assert.equal(r.code, 0, r.err)
    assert.deepEqual(JSON.parse((await run(['maintenance', 'status', '--json'], env)).out), {
      until: null,
      reason: null,
    })
  })

  it('a maintenance that expired by itself is off, and status says it expired', async () => {
    await t.db.query(
      "UPDATE installation SET maintenance_until = now() - interval '1 minute', maintenance_reason = 'update'",
    )
    const r = await run(['maintenance', 'status', '--json'], env)
    const s = JSON.parse(r.out)
    assert.equal(s.until, null)
    assert.equal(s.reason, null)
    assert.ok(s.expiredAt, r.out)
    assert.match(
      (await run(['maintenance', 'status'], env)).out,
      /Maintenance is off\. The last one \(update\) expired/,
    )
  })

  it('wrong use: exit 2 with what to pass, nothing changed', async () => {
    for (const args of [
      ['maintenance', 'on', '--seconds', '4000'],
      ['maintenance', 'on', '--reason', 'whim'],
      ['maintenance', 'on', '--seconds', 'soon'],
      ['maintenance', 'sideways'],
    ]) {
      const r = await run(args, env)
      assert.equal(r.code, 2, `${args.join(' ')}: ${r.out}${r.err}`)
      assert.ok(r.err.length > 0)
    }
    const s = JSON.parse((await run(['maintenance', 'status', '--json'], env)).out)
    assert.equal(s.until, null)
  })
})
