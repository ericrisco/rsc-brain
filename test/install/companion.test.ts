// Companion mode with real containers (plan F1 T049, the B7 container lane): local only, never in CI (plan §5.1). Runs
// with RSC_BRAIN_INSTALL_TESTS=1 and Docker answering (npm run test:install). It stands in for rsc-factory's installer:
// a shared network and a PostgreSQL on it (as rsc-factory's), then `rsc-brain.sh install --companion`, then the
// handshake from a container on that network, as rsc-factory's setup makes it. Every Docker resource carries the
// prefix rscb-f1c- and a random id, and is removed after.
//
// What only real containers show: the app is reachable as rsc-brain on the shared network; the handshake is not
// reachable from this machine through the published port; two calls at once set up once; and «this machine only»
// still holds with two networks (the default route stays on the installation's own network), so the administration
// signs in from this machine afterwards.
import assert from 'node:assert/strict'
import { execFile, spawn, spawnSync } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, describe, it } from 'node:test'
import { promisify } from 'node:util'

const run = promisify(execFile)
const ROOT = new URL('../..', import.meta.url).pathname
const LAUNCHER = join(ROOT, 'deploy', 'rsc-brain.sh')
const ID = randomBytes(4).toString('hex')
const IMAGE = `rscb-f1c-image:${ID}`
const NAME = `rscb-f1c-${ID}`
const NET = `rscb-f1c-shared-${ID}`
const PG = `rscb-f1c-pg-${ID}`
const PG_IMAGE =
  'postgres:17.11-alpine@sha256:266d3c257594e195b309ae9d1805e54c788f1d7b375f56bf6c367aac6c917e7b'
const WEB = { 'x-requested-with': 'rsc-brain-web', 'content-type': 'application/json' }
const ADMIN = { name: 'Eric', email: 'eric@example.com', password: 'a long enough password' }

const why = (() => {
  if (process.env.CI) return 'CI has no Docker (plan §5.1)'
  if (process.env.RSC_BRAIN_INSTALL_TESTS !== '1')
    return 'set RSC_BRAIN_INSTALL_TESTS=1 to install with real containers'
  if (spawnSync('docker', ['info'], { stdio: 'ignore' }).status !== 0) return 'Docker does not answer'
  return null
})()

const docker = async (...args: string[]) => (await run('docker', args, { maxBuffer: 64 << 20 })).stdout.trim()
const freePort = () =>
  new Promise<number>((resolve) => {
    const s = createServer().listen(0, '127.0.0.1', () => {
      const p = (s.address() as { port: number }).port
      s.close(() => resolve(p))
    })
  })
const until = async <T>(what: string, f: () => Promise<T | null>, seconds = 120): Promise<T> => {
  const end = Date.now() + seconds * 1000
  for (;;) {
    const v = await f().catch(() => null)
    if (v !== null) return v
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`)
    await new Promise((r) => setTimeout(r, 1000))
  }
}

// A call made from a container on the shared network, as rsc-factory's web makes it. The key and the body go on the
// standard input, never on a command line.
const fromShared = (
  input: { token: string; body: unknown },
  path = '/v1/setup/companion',
): Promise<{ status: number; body: string }> =>
  new Promise((resolve, reject) => {
    const script =
      "let s='';process.stdin.on('data',d=>s+=d).on('end',async()=>{const i=JSON.parse(s);" +
      `const r=await fetch('http://rsc-brain:8090${path}',{method:'POST',` +
      "headers:{'content-type':'application/json',authorization:'Bearer '+i.token},body:JSON.stringify(i.body)});" +
      'process.stdout.write(JSON.stringify({status:r.status,body:await r.text()}))})'
    const p = spawn(
      'docker',
      ['run', '--rm', '-i', '--network', NET, '--entrypoint', 'node', IMAGE, '-e', script],
      {
        stdio: ['pipe', 'pipe', 'pipe'],
      },
    )
    let out = ''
    let err = ''
    p.stdout.on('data', (d) => {
      out += d
    })
    p.stderr.on('data', (d) => {
      err += d
    })
    p.on('close', (code) => {
      if (code !== 0) return reject(new Error(`the call failed (${code}): ${err}`))
      resolve(JSON.parse(out))
    })
    p.stdin.end(JSON.stringify(input))
  })

describe('companion mode with real containers', { skip: why ?? false }, () => {
  let base = ''
  let dir = ''
  let port = 0
  let summary: { companionToken: string; internalUrl: string; url: string; installationKey: string } = {
    companionToken: '',
    internalUrl: '',
    url: '',
    installationKey: '',
  }
  let firstKey = ''
  const local = (path: string, init: RequestInit = {}) => fetch(`http://127.0.0.1:${port}${path}`, init)

  before(async () => {
    base = mkdtempSync(join(process.env.RSC_BRAIN_INSTALL_TMP ?? tmpdir(), 'rscb-f1c-'))
    dir = join(base, 'install')
    await run('docker', ['build', '-q', '-t', IMAGE, ROOT], { maxBuffer: 64 << 20 })
    // What rsc-factory's installer has made before it calls the launcher: the shared network and its PostgreSQL.
    await docker('network', 'create', NET)
    const pgPassword = randomBytes(16).toString('hex')
    const env = join(base, 'pg.env')
    writeFileSync(env, `POSTGRES_PASSWORD=${pgPassword}\n`, { mode: 0o600 })
    await docker(
      'run',
      '-d',
      '--name',
      PG,
      '--network',
      NET,
      '--network-alias',
      'postgres',
      '--env-file',
      env,
      PG_IMAGE,
    )
    await until('PostgreSQL', async () =>
      (await docker('exec', PG, 'pg_isready', '-U', 'postgres')).includes('accepting') ? true : null,
    )
    await until('the database of rsc-factory', async () =>
      (await docker('exec', PG, 'psql', '-U', 'postgres', '-c', 'CREATE DATABASE rscf')).length ? true : null,
    )
    const admin = join(base, 'admin-url')
    writeFileSync(admin, `postgres://postgres:${pgPassword}@postgres:5432/postgres\n`, { mode: 0o600 })
    port = await freePort()
    const r = spawnSync(
      'sh',
      [
        LAUNCHER,
        'install',
        '--local',
        '--yes',
        '--json',
        '--dir',
        dir,
        '--name',
        NAME,
        '--port',
        String(port),
        '--image',
        IMAGE,
        '--companion',
        '--attach-network',
        NET,
        '--factory-url',
        'http://localhost:3000',
        '--db',
        'shared',
        '--db-admin-url-file',
        admin,
        '--factory-db',
        'rscf',
      ],
      { encoding: 'utf8', env: { ...process.env, RSC_BRAIN_TTY: '/nonexistent/tty' }, timeout: 300_000 },
    )
    rmSync(admin)
    assert.equal(r.status, 0, r.stderr)
    summary = JSON.parse(r.stdout)
  })

  after(async () => {
    const filter = `label=com.docker.compose.project=${NAME}`
    for (const c of (await docker('ps', '-aq', '--filter', filter).catch(() => ''))
      .split('\n')
      .filter(Boolean))
      await docker('rm', '-f', '-v', c).catch(() => {})
    for (const v of (await docker('volume', 'ls', '-q', '--filter', filter).catch(() => ''))
      .split('\n')
      .filter(Boolean))
      await docker('volume', 'rm', '-f', v).catch(() => {})
    for (const n of (await docker('network', 'ls', '-q', '--filter', filter).catch(() => ''))
      .split('\n')
      .filter(Boolean))
      await docker('network', 'rm', n).catch(() => {})
    await docker('rm', '-f', '-v', PG).catch(() => {})
    await docker('network', 'rm', NET).catch(() => {})
    await docker('image', 'rm', '-f', IMAGE).catch(() => {})
    if (base) rmSync(base, { recursive: true, force: true })
  })

  it('the summary carries the one-time key and the internal address; .env keeps the key for its owner only', () => {
    assert.match(summary.companionToken, /^[0-9a-f]{64}$/)
    assert.equal(summary.internalUrl, 'http://rsc-brain:8090')
    assert.equal(summary.url, `http://localhost:${port}`)
    assert.match(
      readFileSync(join(dir, '.env'), 'utf8'),
      new RegExp(`RSC_BRAIN_COMPANION_TOKEN='${summary.companionToken}'`),
    )
  })

  it('waiting: the web of this machine says to finish in rsc-factory; the handshake is not there from this machine', async () => {
    const state = await local('/v1/setup')
    assert.equal(state.status, 409)
    const body = (await state.json()) as { error: { code: string; factoryUrl: string } }
    assert.deepEqual([body.error.code, body.error.factoryUrl], ['companion_pending', 'http://localhost:3000'])
    const fromHere = await local('/v1/setup/companion', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${summary.companionToken}` },
      body: JSON.stringify({ admin: ADMIN }),
    })
    assert.equal(fromHere.status, 404)
  })

  it('from the shared network: a wrong key is refused; two calls at once set up once', async () => {
    const wrong = await fromShared({ token: 'f'.repeat(64), body: { admin: ADMIN } })
    assert.equal(wrong.status, 401, wrong.body)
    const both = await Promise.all([
      fromShared({
        token: summary.companionToken,
        body: { admin: ADMIN, factoryUrl: 'http://localhost:3000' },
      }),
      fromShared({
        token: summary.companionToken,
        body: { admin: { ...ADMIN, email: 'other@example.com' } },
      }),
    ])
    assert.deepEqual(both.map((b) => b.status).sort(), [201, 404], both.map((b) => b.body).join('\n'))
    const made = JSON.parse((both.find((b) => b.status === 201) as { body: string }).body)
    firstKey = made.serviceKey
    assert.deepEqual(Object.keys(made).sort(), ['adminId', 'serviceId', 'serviceKey'])
    const again = await fromShared({ token: summary.companionToken, body: { admin: ADMIN } })
    assert.equal(again.status, 404, again.body)
  })

  it('then the administration signs in from this machine (its own network kept the default route), no setup left', async () => {
    assert.equal((await local('/v1/setup')).status, 404)
    const branding = (await (await local('/v1/branding')).json()) as { setupRequired: boolean }
    assert.equal(branding.setupRequired, false)
    const login = await until(
      'a sign-in',
      async () => {
        for (const email of [ADMIN.email, 'other@example.com']) {
          const r = await local('/v1/auth/login', {
            method: 'POST',
            headers: WEB,
            body: JSON.stringify({ email, password: ADMIN.password }),
          })
          if (r.status === 200) return r.status
        }
        return null
      },
      10,
    )
    assert.equal(login, 200)
    const route = await docker(
      'compose',
      '-p',
      NAME,
      '--project-directory',
      dir,
      'exec',
      '-T',
      'app',
      'cat',
      '/proc/net/route',
    )
    const net = await docker(
      'network',
      'inspect',
      '--format',
      '{{range .IPAM.Config}}{{.Gateway}}{{end}}',
      `${NAME}_default`,
    )
    const gw = /^\S+\s+00000000\s+([0-9A-F]{8})/m.exec(route)?.[1] ?? ''
    const n = Number.parseInt(gw, 16)
    assert.equal([n & 255, (n >>> 8) & 255, (n >>> 16) & 255, n >>> 24].join('.'), net)
  })

  it('reconnecting from the shared network: a new main key with an administrator’s password; the one before stops', async () => {
    const me = (key: string) => local('/v1/me', { headers: { authorization: `Bearer ${key}` } })
    assert.equal((await me(firstKey)).status, 200)
    let got: { status: number; body: string } | null = null
    for (const email of [ADMIN.email, 'other@example.com']) {
      got = await fromShared(
        { token: summary.companionToken, body: { email, password: ADMIN.password } },
        '/v1/setup/companion/reconnect',
      )
      if (got.status === 201) break
    }
    assert.equal(got?.status, 201, got?.body)
    const next = JSON.parse(got?.body ?? '{}') as { serviceKey: string }
    assert.equal((await me(next.serviceKey)).status, 200)
    assert.equal((await me(firstKey)).status, 401)
    // From this machine, through the published port, it is not there.
    const fromHere = await local('/v1/setup/companion/reconnect', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${summary.companionToken}` },
      body: JSON.stringify({ email: ADMIN.email, password: ADMIN.password }),
    })
    assert.equal(fromHere.status, 404)
  })
})
