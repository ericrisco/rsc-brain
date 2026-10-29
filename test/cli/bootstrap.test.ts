// The first administrator is created by a command: once, even if two runs race, and the key is shown
// once and works.
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { after, before, describe, it } from 'node:test'
import { freshDatabase, skipPg, type TestDb } from '../helpers/pg.ts'

const CLI = new URL('../../src/cli/main.ts', import.meta.url).pathname

function run(url: string, args: string[]): Promise<{ code: number; out: string; err: string }> {
  return new Promise((resolve) => {
    const p = spawn(process.execPath, [CLI, ...args], {
      env: { ...process.env, RSC_BRAIN_DATABASE_URL: url },
    })
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

describe('rsc-brain admin bootstrap', { skip: skipPg }, () => {
  let t: TestDb
  before(async () => {
    t = await freshDatabase()
  })
  after(async () => t.drop())

  it('two runs at once create exactly one administrator', async () => {
    const [a, b] = await Promise.all([
      run(t.url, ['admin', 'bootstrap', '--email', 'one@example.com', '--name', 'One']),
      run(t.url, ['admin', 'bootstrap', '--email', 'two@example.com', '--name', 'Two']),
    ])
    assert.deepEqual([a.code, b.code].sort(), [0, 1])
    const admins = await t.db.query('SELECT email FROM accounts WHERE is_admin')
    assert.equal(admins.length, 1)
    const loser = a.code === 1 ? a : b
    assert.match(loser.err, /already has an administrator/)
    const winner = a.code === 0 ? a : b
    assert.match(winner.out, /rscb_[A-Za-z0-9_-]{43}/)
  })

  it('a service account gets its main key once', async () => {
    const r = await run(t.url, ['service', 'create', '--name', 'RSC Factory', '--can-create-brains'])
    assert.equal(r.code, 0)
    assert.match(r.out, /Main key \(shown once\):\nrscb_/)
    const s = await t.db.one("SELECT kind, can_create_brains FROM accounts WHERE name = 'RSC Factory'")
    assert.deepEqual(s, { kind: 'service', can_create_brains: true })
  })

  it('missing arguments say what to pass', async () => {
    const r = await run(t.url, ['admin', 'bootstrap'])
    assert.equal(r.code, 2)
    assert.match(r.err, /--email and --name/)
  })
})
