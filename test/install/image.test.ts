// The rsc-brain image (plan T033, spec B7 C19), with real containers: local only, never in CI (plan §5.1). Runs with
// RSC_BRAIN_INSTALL_TESTS=1 and Docker answering (npm run test:install). Builds the image from this tree, then: it
// prints its version; it holds the built server, the web and the migrations, and none of the tests, the local
// database, .env or the git history; it runs as an unprivileged user and says when it is healthy. And «this machine
// only» behind the container's network: published on 127.0.0.1 with RSC_BRAIN_LOCAL_ONLY=1, the browser on this
// machine counts as this machine; without the flag it does not; with the flag but published to the network, the
// service refuses to start. Everything it creates carries a unique name and is removed after.
import assert from 'node:assert/strict'
import { execFile, spawnSync } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { createServer } from 'node:net'
import { after, before, describe, it } from 'node:test'
import { promisify } from 'node:util'
import { VERSION } from '../../src/core/version.ts'

const run = promisify(execFile)
const ROOT = new URL('../..', import.meta.url).pathname
const ID = randomBytes(4).toString('hex')
const IMAGE = `rscb-pr33-test-image:${ID}`
const NET = `rscb-pr33-test-net-${ID}`
const PG = `rscb-pr33-test-pg-${ID}`
const PG_IMAGE = process.env.RSC_BRAIN_TEST_PG_IMAGE ?? 'postgres:17-alpine'

const why = (() => {
  if (process.env.CI) return 'CI has no Docker (plan §5.1)'
  if (process.env.RSC_BRAIN_INSTALL_TESTS !== '1')
    return 'set RSC_BRAIN_INSTALL_TESTS=1 to build and run the image'
  if (spawnSync('docker', ['info'], { stdio: 'ignore' }).status !== 0) return 'Docker does not answer'
  return null
})()

const docker = async (...args: string[]) => (await run('docker', args, { maxBuffer: 64 << 20 })).stdout.trim()
const containers: string[] = []
const freePort = () =>
  new Promise<number>((resolve) => {
    const s = createServer().listen(0, '127.0.0.1', () => {
      const p = (s.address() as { port: number }).port
      s.close(() => resolve(p))
    })
  })
const until = async <T>(what: string, f: () => Promise<T | null>, seconds = 90): Promise<T> => {
  const end = Date.now() + seconds * 1000
  for (;;) {
    const v = await f().catch(() => null)
    if (v !== null) return v
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`)
    await new Promise((r) => setTimeout(r, 500))
  }
}

describe('the rsc-brain image', { skip: why ?? false }, () => {
  before(async () => {
    const started = Date.now()
    await run('docker', ['build', '-q', '-t', IMAGE, ROOT], { maxBuffer: 64 << 20 })
    process.stdout.write(`# measured: docker build ${((Date.now() - started) / 1000).toFixed(1)} s\n`)
  })
  after(async () => {
    for (const c of containers) await docker('rm', '-f', '-v', c).catch(() => {})
    await docker('network', 'rm', NET).catch(() => {})
    await docker('image', 'rm', '-f', IMAGE).catch(() => {})
  })

  it('prints its version', async () => {
    assert.equal(await docker('run', '--rm', IMAGE, 'rsc-brain', 'version'), VERSION)
  })

  it('holds what runs and nothing else; runs unprivileged; has a health check', async () => {
    const sh = (script: string) => docker('run', '--rm', '--entrypoint', 'sh', IMAGE, '-c', script)
    assert.notEqual(await sh('id -u'), '0', 'runs as root')
    assert.deepEqual((await sh('ls -A /app')).split('\n').sort(), [
      'LICENSE',
      'dist',
      'migrations',
      'node_modules',
      'package.json',
    ])
    assert.equal(
      await sh('test -f /app/dist/web/index.html && test -f /app/dist/cli/main.js && echo ok'),
      'ok',
    )
    assert.ok((await sh('ls /app/migrations')).split('\n').some((f) => /^0001_.*\.sql$/.test(f)))
    assert.equal(await sh('test -d /app/node_modules/pg && echo ok'), 'ok')
    // No development dependency, test, local database, secret or history anywhere in the image.
    assert.equal(
      await sh('ls /app/node_modules | grep -E "^(typescript|vite|@biomejs|@playwright)$" || true'),
      '',
    )
    assert.equal(
      await sh('find / -xdev \\( -name .pg-test -o -name ".env*" -o -name .git \\) 2>/dev/null || true'),
      '',
    )
    // (A library may ship its own tests; ours are never there.)
    assert.equal(await sh('find /app -path /app/node_modules -prune -o -name "*.test.*" -print'), '')
    assert.equal(await sh('stat -c %U /backups'), 'node')
    const health = JSON.parse(
      await docker('image', 'inspect', '--format', '{{json .Config.Healthcheck}}', IMAGE),
    )
    assert.match(health.Test.join(' '), /\/v1\/health/)
  })

  describe('with a database', () => {
    let pgUrl = ''
    before(async () => {
      await docker('network', 'create', NET)
      containers.push(PG)
      await docker(
        'run',
        '-d',
        '--name',
        PG,
        '--network',
        NET,
        '-e',
        'POSTGRES_PASSWORD=pr33-test-only',
        PG_IMAGE,
      )
      await until('PostgreSQL', async () =>
        (await docker('exec', PG, 'pg_isready', '-U', 'postgres')) ? true : null,
      )
      pgUrl = `postgres://postgres:pr33-test-only@${PG}:5432/postgres`
    })

    const start = async (env: Record<string, string>) => {
      const port = await freePort()
      const name = `rscb-pr33-test-app-${ID}-${port}`
      containers.push(name)
      const envArgs = Object.entries({ RSC_BRAIN_DATABASE_URL: pgUrl, ...env }).flatMap(([k, v]) => [
        '-e',
        `${k}=${v}`,
      ])
      await docker(
        'run',
        '-d',
        '--name',
        name,
        '--network',
        NET,
        '-p',
        `127.0.0.1:${port}:8090`,
        '--health-interval',
        '1s',
        '--health-start-period',
        '30s',
        ...envArgs,
        IMAGE,
      )
      return { name, base: `http://127.0.0.1:${port}` }
    }
    const setupConnection = async (base: string) =>
      until('the setup state', async () => {
        const r = await fetch(`${base}/v1/setup`)
        return r.status === 200 ? ((await r.json()) as { connection: { local: boolean } }).connection : null
      })

    it('C19: with RSC_BRAIN_LOCAL_ONLY=1, published on 127.0.0.1, this machine is this machine; and it is healthy', async () => {
      const app = await start({ RSC_BRAIN_LOCAL_ONLY: '1', RSC_BRAIN_PUBLISH: '127.0.0.1:8090' })
      assert.deepEqual(await setupConnection(app.base), { encrypted: false, local: true })
      const status = await until('healthy', async () => {
        const s = await docker('inspect', '--format', '{{.State.Health.Status}}', app.name)
        return s === 'healthy' ? s : null
      })
      assert.equal(status, 'healthy')
      // Relayed by something, it is never this machine.
      const relayed = await fetch(`${app.base}/v1/setup`, { headers: { 'x-forwarded-for': '127.0.0.1' } })
      assert.equal(((await relayed.json()) as { connection: { local: boolean } }).connection.local, false)
    })

    it('C19: without the flag, the same browser is not this machine (a password over http is refused)', async () => {
      const app = await start({})
      assert.deepEqual(await setupConnection(app.base), { encrypted: false, local: false })
    })

    it('C19: with the flag but published to the network, the service does not start', async () => {
      const app = await start({ RSC_BRAIN_LOCAL_ONLY: '1', RSC_BRAIN_PUBLISH: '0.0.0.0:8090' })
      const state = await until('the exit', async () => {
        const s = await docker('inspect', '--format', '{{.State.Status}} {{.State.ExitCode}}', app.name)
        return s.startsWith('exited') ? s : null
      })
      assert.notEqual(state, 'exited 0')
      const logs = (await run('docker', ['logs', app.name])).stderr
      assert.match(logs, /RSC_BRAIN_LOCAL_ONLY=1 needs RSC_BRAIN_PUBLISH/)
    })
  })
})
