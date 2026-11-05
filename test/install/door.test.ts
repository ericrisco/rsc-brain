// The stand-in door with real containers (rsc-updates §3.9, T057; CA22, CA27): local only, never in CI. Runs with
// RSC_BRAIN_INSTALL_TESTS=1 and Docker answering (npm run test:install), and with the shell in RSC_BRAIN_TEST_SHELL.
// Every Docker resource carries the prefix rscb-b1-door- and a random id, and is removed after.
//
// An update to an image whose migration takes a few seconds and then fails, on this machine and on a server (Caddy in
// front, HTTPS with a certificate of its own): while the service is stopped and through the whole restore of the way
// back, the address answers 503 with Retry-After: a page with the step for a browser, the refusal programs know for the
// rest. Afterwards the version before answers, and nothing of the door is left.
import assert from 'node:assert/strict'
import { execFile, spawn, spawnSync } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, describe, it } from 'node:test'
import { promisify } from 'node:util'

const run = promisify(execFile)
const ROOT = new URL('../..', import.meta.url).pathname
const LAUNCHER = join(ROOT, 'deploy', 'rsc-brain.sh')
const ID = randomBytes(4).toString('hex')
const PREFIX = `rscb-b1-door-${ID}`
const IMAGE = `${PREFIX}-image:test`
const BROKEN = `${PREFIX}-broken:test`
const PASSWORD = 'a long test password for the door'
const WEB = { 'x-requested-with': 'rsc-brain-web', 'content-type': 'application/json' }

const why = (() => {
  if (process.env.CI) return 'CI has no Docker (plan §5.1)'
  if (process.env.RSC_BRAIN_INSTALL_TESTS !== '1')
    return 'set RSC_BRAIN_INSTALL_TESTS=1 to update with real containers'
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
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
type Run = { code: number | null; stdout: string; stderr: string }
const launch = (args: string[], onStderr?: (all: string) => void): Promise<Run> =>
  new Promise((resolve) => {
    const p = spawn(process.env.RSC_BRAIN_TEST_SHELL ?? 'sh', [LAUNCHER, ...args], {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, RSC_BRAIN_TTY: '/nonexistent/tty' },
    })
    let stdout = ''
    let stderr = ''
    p.stdout.on('data', (d) => {
      stdout += d
    })
    p.stderr.on('data', (d) => {
      stderr += d
      onStderr?.(stderr)
    })
    p.on('close', (code) => resolve({ code, stdout, stderr }))
  })
// One answer through curl: it can resolve the domain and take the certificate of a server. A refused connection is 0.
type Seen = { status: number; retryAfter: string; body: string; phase: string }
const ask = async (url: string, accept: string, extra: string[], phase: string): Promise<Seen> => {
  try {
    const { stdout } = await run('curl', [
      '-sk',
      '--max-time',
      '5',
      '-H',
      `Accept: ${accept}`,
      ...extra,
      '-w',
      '\n%{http_code} %header{retry-after}',
      url,
    ])
    const cut = stdout.lastIndexOf('\n')
    const [status, retryAfter] = stdout.slice(cut + 1).split(' ')
    return { status: Number(status), retryAfter: retryAfter ?? '', body: stdout.slice(0, cut), phase }
  } catch {
    return { status: 0, retryAfter: '', body: '', phase }
  }
}

// What the update says it is doing, from its own lines.
const phaseOf = (stderr: string) => {
  const marks: Array<[string, string]> = [
    ['Stopping rsc-brain', 'stopping'],
    ['Migrating the data', 'migrating'],
    ['Going back to rsc-brain', 'going-back'],
    ['Restoring the copy', 'restoring'],
    ['Starting rsc-brain', 'starting'],
  ]
  let at = -1
  let phase = 'before'
  for (const [text, name] of marks) {
    const i = stderr.lastIndexOf(text)
    if (i > at) {
      at = i
      phase = name
    }
  }
  return phase
}

describe('the stand-in door with real containers', { skip: why ?? false }, () => {
  let BASE = ''
  const made: string[] = []
  const sweep = async (name: string) => {
    const ids = (await docker('ps', '-aq', '--filter', `label=com.docker.compose.project=${name}`))
      .split('\n')
      .filter(Boolean)
    if (ids.length) await docker('rm', '-fv', ...ids)
    for (const n of (
      await docker('network', 'ls', '-q', '--filter', `label=com.docker.compose.project=${name}`)
    )
      .split('\n')
      .filter(Boolean))
      await docker('network', 'rm', n).catch(() => {})
    for (const v of (
      await docker('volume', 'ls', '-q', '--filter', `label=com.docker.compose.project=${name}`)
    )
      .split('\n')
      .filter(Boolean))
      await docker('volume', 'rm', v).catch(() => {})
  }

  before(async () => {
    BASE = mkdtempSync(join(process.env.RSC_BRAIN_INSTALL_TMP ?? tmpdir(), 'rscb-b1-door-'))
    await run('docker', ['build', '-q', '-t', IMAGE, ROOT], { maxBuffer: 64 << 20 })
    const ctx = join(BASE, 'image')
    mkdirSync(ctx)
    writeFileSync(join(ctx, '0999_test_slow_broken.sql'), 'SELECT pg_sleep(5);\nSELECT 1 / 0;\n')
    writeFileSync(
      join(ctx, 'Dockerfile'),
      [
        `FROM ${IMAGE}`,
        'USER root',
        'COPY 0999_test_slow_broken.sql /app/migrations/0999_test_slow_broken.sql',
        `RUN chmod a+r /app/migrations/*.sql && sed -i "s/VERSION = '[^']*'/VERSION = '99.0.0'/" /app/dist/core/version.js`,
        'USER node',
      ].join('\n'),
    )
    await run('docker', ['build', '-q', '-t', BROKEN, ctx])
    assert.equal(await docker('run', '--rm', BROKEN, 'rsc-brain', 'version'), '99.0.0')
  })
  after(async () => {
    for (const name of made) await sweep(name)
    await docker('image', 'rm', '-f', IMAGE, BROKEN).catch(() => {})
    if (BASE) rmSync(BASE, { recursive: true, force: true })
  })

  const scenario = async (o: {
    name: string
    install: (dir: string) => Promise<string[]>
    url: (dir: string) => string
    curl: (dir: string) => string[]
    prepare?: (dir: string) => Promise<void>
    setupAt: (dir: string) => string
  }) => {
    const name = `${PREFIX}-${o.name}`
    made.push(name)
    const dir = join(BASE, o.name)
    mkdirSync(dir)
    await o.prepare?.(dir)
    const got = await launch([
      'install',
      '--yes',
      '--json',
      '--dir',
      dir,
      '--name',
      name,
      '--image',
      IMAGE,
      ...(await o.install(dir)),
    ])
    assert.equal(got.code, 0, got.stderr)
    const url = o.url(dir)
    const extra = o.curl(dir)
    // A server: wait for the certificate of its own.
    for (let i = 0; i < 60 && (await ask(`${url}/v1/health`, '*/*', extra, '')).status !== 200; i++)
      await sleep(1000)
    const setup = await ask(`${url}/v1/health`, '*/*', extra, '')
    assert.equal(setup.status, 200, 'it answers before the update')
    const site = o.setupAt(dir)
    const done = await run('curl', [
      '-sk',
      ...extra,
      '-o',
      '/dev/null',
      '-w',
      '%{http_code}',
      '-X',
      'POST',
      '-H',
      `x-requested-with: ${WEB['x-requested-with']}`,
      '-H',
      `content-type: ${WEB['content-type']}`,
      '-d',
      JSON.stringify({
        name: 'door test',
        publicUrl: site,
        admin: { name: 'Ada', email: 'ada@example.com', password: PASSWORD },
      }),
      `${url}/v1/setup`,
    ])
    assert.equal(done.stdout, '201')

    let stderr = ''
    let running = true
    const seen: Seen[] = []
    const posted: Seen[] = []
    const poll = (async () => {
      while (running) {
        const phase = phaseOf(stderr)
        const [page, api, form] = await Promise.all([
          ask(`${url}/`, 'text/html', extra, phase),
          ask(`${url}/v1/health`, 'application/json', extra, phase),
          ask(`${url}/login`, 'text/html', [...extra, '-X', 'POST', '-d', 'a=b'], phase),
        ])
        posted.push(form)
        // Only what was asked and answered within one step says something about that step.
        const same = phaseOf(stderr) === phase ? phase : 'between'
        seen.push({ ...page, phase: same }, { ...api, phase: same })
        await sleep(150)
      }
    })()
    const r = await launch(['update', '--yes', '--dir', dir, '--image', BROKEN], (all) => {
      stderr = all
    })
    running = false
    await poll
    assert.equal(r.code, 4, r.stderr)

    const door = seen.filter((s) => s.status === 503)
    const pages = door.filter((s) => s.body.includes('<!doctype html>'))
    const refusals = door.filter(
      (s) => s.body.includes('"under_maintenance"') && s.body.includes('"retryAfter":30'),
    )
    assert.ok(pages.some((s) => s.phase === 'migrating' && s.body.includes('Migrating the data.')))
    // Nothing anonymous learns a version from the door, in any step. And a form that posts gets the page, with the
    // same status: nothing reaches the service.
    for (const s of [...door, ...posted.filter((p) => p.status === 503)])
      assert.doesNotMatch(s.body, /\d+\.\d+\.\d+/, s.body.slice(0, 200))
    for (const phase of ['migrating', 'restoring'])
      assert.ok(
        posted.some(
          (p) =>
            p.phase === phase &&
            p.status === 503 &&
            p.retryAfter === '30' &&
            p.body.includes('<!doctype html>'),
        ),
        `a form that posts while ${phase}`,
      )
    assert.ok(pages.some((s) => s.phase === 'restoring' && s.body.includes('Restoring the copy')))
    assert.ok(refusals.some((s) => s.phase === 'migrating'))
    assert.ok(refusals.some((s) => s.phase === 'restoring'))
    for (const s of door) assert.equal(s.retryAfter, '30', s.body)
    const parsed = JSON.parse(refusals[0]?.body ?? '{}')
    assert.deepEqual(Object.keys(parsed.error), ['code', 'message', 'howToProceed'])
    // All through the restore: never a refused connection, never a 502.
    const during = seen.filter((s) => s.phase === 'restoring')
    assert.ok(during.length > 0)
    for (const s of during) assert.equal(s.status, 503, `${s.phase}: ${s.status} ${s.body.slice(0, 120)}`)
    process.stdout.write(
      `# measured: ${o.name}: ${seen.length} answers, ${door.length} from the door, ${seen.filter((s) => s.status === 0).length} refused, ${seen.filter((s) => s.status === 502).length} 502\n`,
    )

    // The version before is back, and nothing of the door is left.
    const back = await ask(`${url}/v1/health`, 'application/json', extra, '')
    assert.equal(back.status, 200, back.body)
    assert.equal(JSON.parse(back.body).ok, true)
    assert.equal(
      await docker(
        'ps',
        '-aq',
        '--filter',
        `label=com.docker.compose.project=${name}`,
        '--filter',
        'label=com.docker.compose.service=door',
      ),
      '',
    )
    const status = await launch(['status', '--json', '--dir', dir])
    assert.equal(JSON.parse(status.stdout).version, readVersion())
    assert.equal(status.code, 0, status.stderr)
  }
  const readVersion = () =>
    (JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')) as { version: string }).version

  it('on this machine', async () => {
    const port = await freePort()
    await scenario({
      name: 'local',
      install: async () => ['--local', '--port', String(port)],
      url: () => `http://127.0.0.1:${port}`,
      curl: () => [],
      setupAt: () => `http://localhost:${port}`,
    })
  })

  it('on a server: through Caddy, with its name for the service', async () => {
    const [http, https, publish] = [await freePort(), await freePort(), await freePort()]
    await scenario({
      name: 'server',
      install: async () => [
        '--domain',
        'brain.test',
        '--http-port',
        String(http),
        '--https-port',
        String(https),
        '--port',
        String(publish),
      ],
      url: () => `https://brain.test:${https}`,
      curl: () => ['--resolve', `brain.test:${https}:127.0.0.1`],
      // A certificate of its own, and no ACME from a test. The launcher keeps this file and loads it.
      prepare: async (dir) => {
        writeFileSync(
          join(dir, 'compose.override.yaml'),
          `services:\n  caddy:\n    environment:\n      RSC_BRAIN_ACME_CA: http://127.0.0.1:1/dir\n    volumes:\n      - ${join(BASE, 'Caddyfile.test')}:/etc/caddy/Caddyfile:ro\n`,
        )
        writeFileSync(
          join(BASE, 'Caddyfile.test'),
          '{$RSC_BRAIN_DOMAIN} {\n\ttls internal\n\treverse_proxy app:8090\n}\n',
        )
      },
      setupAt: () => `https://brain.test:${https}`,
    })
  })
})
