// The first administrator is created by a command: once, even if two runs race, and the key is shown
// once and works.
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { after, before, describe, it } from 'node:test'
import { freshDatabase, skipPg, type TestDb } from '../helpers/pg.ts'

const CLI = new URL('../../src/cli/main.ts', import.meta.url).pathname

function run(
  url: string,
  args: string[],
  env: Record<string, string> = {},
): Promise<{ code: number; out: string; err: string }> {
  return new Promise((resolve) => {
    const p = spawn(process.execPath, [CLI, ...args], {
      env: { ...process.env, RSC_BRAIN_DATABASE_URL: url, ...env },
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

  it('review: the bootstrapped administrator gets a single-use link to set a web password', async () => {
    const t2 = await freshDatabase()
    try {
      const r = await run(t2.url, ['admin', 'bootstrap', '--email', 'boot@example.com', '--name', 'Boot'])
      assert.equal(r.code, 0, r.err)
      const token = /token=(rscb_[A-Za-z0-9_-]{43})/.exec(r.out)?.[1]
      assert.ok(token, r.out)
      const used = await t2.db.one('SELECT count(*)::int AS n FROM password_resets')
      assert.equal(used?.n, 1)
      const again = await run(t2.url, ['admin', 'reset-link', '--email', 'boot@example.com'])
      assert.equal(again.code, 0, again.err)
      assert.match(again.out, /reset#token=rscb_/)
      assert.equal((await run(t2.url, ['admin', 'reset-link', '--email', 'nobody@example.com'])).code, 1)
    } finally {
      await t2.drop()
    }
  })
})

describe('rsc-brain setup --from-env (companion mode)', { skip: skipPg }, () => {
  it('review: names what is missing; prepares once and prints the service key as JSON; then refuses', async () => {
    const t = await freshDatabase()
    try {
      const missing = await run(t.url, ['setup', '--from-env'], { RSC_BRAIN_SETUP_URL: '' })
      assert.equal(missing.code, 2)
      assert.match(missing.err, /RSC_BRAIN_SETUP_URL.*RSC_BRAIN_ADMIN_PASSWORD/)
      const env = {
        RSC_BRAIN_SETUP_URL: 'http://localhost:8090',
        RSC_BRAIN_ADMIN_NAME: 'Eric',
        RSC_BRAIN_ADMIN_EMAIL: 'eric@example.com',
        RSC_BRAIN_ADMIN_PASSWORD: 'a long enough password',
      }
      // A failure in the service account leaves nothing set up, so it can be run again.
      const bad = await run(t.url, ['setup', '--from-env'], {
        ...env,
        RSC_BRAIN_SERVICE_NAME: 'x'.repeat(81),
      })
      assert.equal(bad.code, 1)
      assert.equal((await t.db.one('SELECT setup_done_at FROM installation'))?.setup_done_at, null)
      const ok = await run(t.url, ['setup', '--from-env'], env)
      assert.equal(ok.code, 0, ok.err)
      const out = JSON.parse(ok.out) as { serviceKey: string }
      assert.match(out.serviceKey, /^rscb_/)
      const again = await run(t.url, ['setup', '--from-env'], env)
      assert.equal(again.code, 1)
      assert.doesNotMatch(again.out, /rscb_/)
    } finally {
      await t.drop()
    }
  })
})
