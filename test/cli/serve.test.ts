// `rsc-brain serve` stops on SIGTERM even while a program follows a brain's events: an open stream must
// not keep the server alive (spec B5 «Flujo de eventos»).
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createServer } from 'node:net'
import { after, before, describe, it } from 'node:test'
import { migrate } from '../../src/db/migrate.ts'
import { createAccount } from '../../src/domain/accounts.ts'
import { mintPersonToken } from '../../src/domain/keys.ts'
import { freshDatabase, skipPg, type TestDb } from '../helpers/pg.ts'

const CLI = new URL('../../src/cli/main.ts', import.meta.url).pathname

const freePort = () =>
  new Promise<number>((resolve) => {
    const s = createServer()
    s.listen(0, '127.0.0.1', () => {
      const port = (s.address() as { port: number }).port
      s.close(() => resolve(port))
    })
  })

describe('rsc-brain serve', { skip: skipPg }, () => {
  let t: TestDb
  before(async () => {
    t = await freshDatabase()
  })
  after(async () => t.drop())

  it('stops on SIGTERM while an event stream is open', async () => {
    await migrate(t.db)
    await t.db.query(
      "UPDATE installation SET name = 'T', public_url = 'http://localhost', setup_done_at = now()",
    )
    const clock = () => new Date()
    const id = await createAccount(t.db, clock, {
      kind: 'person',
      name: 'Eric',
      email: 'e@example.com',
      canCreateBrains: true,
    })
    const key = (
      await mintPersonToken(t.db, clock, {
        accountId: id,
        name: 't',
        perm: 'write',
        allBrains: true,
        days: 1,
      })
    ).secret
    const port = await freePort()
    const p = spawn(process.execPath, [CLI, 'serve'], {
      env: { ...process.env, RSC_BRAIN_DATABASE_URL: t.url, RSC_BRAIN_PORT: String(port) },
    })
    const exited = new Promise<number | null>((r) => p.on('exit', (code) => r(code)))
    let out = ''
    await new Promise<void>((resolve, reject) => {
      p.stdout.on('data', (d) => {
        out += d
        if (out.includes('listening')) resolve()
      })
      p.on('exit', () => reject(new Error(`serve exited early: ${out}`)))
    })
    const base = `http://127.0.0.1:${port}`
    const auth = { authorization: `Bearer ${key}` }
    const made = await fetch(`${base}/v1/brains`, {
      method: 'POST',
      headers: { ...auth, 'content-type': 'application/json' },
      body: JSON.stringify({ slug: 'live' }),
    })
    assert.equal(made.status, 201)
    const ac = new AbortController()
    const stream = await fetch(`${base}/v1/brains/live/events`, { headers: auth, signal: ac.signal })
    assert.equal(stream.status, 200)
    const t0 = Date.now()
    p.kill('SIGTERM')
    const code = await Promise.race([exited, new Promise<'hung'>((r) => setTimeout(() => r('hung'), 8000))])
    ac.abort()
    if (code === 'hung') p.kill('SIGKILL')
    assert.equal(code, 0, 'serve did not stop with a stream open')
    assert.ok(Date.now() - t0 < 8000)
  })
})
