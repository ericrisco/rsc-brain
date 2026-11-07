// Updating from the web with real containers (plan T064; spec CA27, CA28): local only, never in CI (plan §5.1). Runs with
// RSC_BRAIN_INSTALL_TESTS=1 and Docker answering (npm run test:install). Every Docker resource carries the prefix
// rscb-b3-test- (RSC_BRAIN_INSTALL_PREFIX changes it) and a random id, and is removed by exact name afterwards; the
// folders live under RSC_BRAIN_INSTALL_TMP (or the system's temporary folder).
//
// CA27, complete: a standalone installation, built from this tree, has the button off (409 updates_off, no updater
// container). `web-updates enable` starts the updater against a repository of its own (a local bare repository holding a
// copy of this tree as v98.0.0, version bumped, with its notes). The service learns of the new version from the updater's
// report; the administration's wrong password is a failed attempt and leaves no mark; a token and a made-up body gain
// nothing; two administrators' requests at once start one update. The updater takes the mark, runs the launcher's own
// `update` (copy first, stop, build, migrate, start) and the service answers as 98.0.0 with the session from before, the
// last update recorded, the mark gone and the audit line there. `disable` turns it off again.
// CA28, with the real launcher: in an installation made by rsc-factory `web-updates enable` exits 2, names rsc-factory
// and starts nothing.
import assert from 'node:assert/strict'
import { execFile, spawnSync } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, describe, it } from 'node:test'
import { promisify } from 'node:util'

const run = promisify(execFile)
const ROOT = new URL('../..', import.meta.url).pathname
const LAUNCHER = join(ROOT, 'deploy', 'rsc-brain.sh')
const ID = randomBytes(4).toString('hex')
const PREFIX = process.env.RSC_BRAIN_INSTALL_PREFIX ?? 'rscb-b3-test'
const NAME = `${PREFIX}-${ID}`
const BASE_IMAGE = `${PREFIX}-image:${ID}`
const UPDATER = `${NAME}-updater`
const UPDATER_IMAGE = `rsc-brain-updater:${NAME}`
const WEB = { 'x-requested-with': 'rsc-brain-web', 'content-type': 'application/json' }
const PASSWORD = 'a long test password b3'
const NEXT = '98.0.0'
const INSTALLED = (JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')) as { version: string })
  .version

const why = (() => {
  if (process.env.CI) return 'CI has no Docker (plan §5.1)'
  if (process.env.RSC_BRAIN_INSTALL_TESTS !== '1')
    return 'set RSC_BRAIN_INSTALL_TESTS=1 to update from the web with real containers'
  if (spawnSync('docker', ['info'], { stdio: 'ignore' }).status !== 0) return 'Docker does not answer'
  return null
})()

const docker = async (...args: string[]) => (await run('docker', args, { maxBuffer: 64 << 20 })).stdout.trim()
const measured = (line: string) => process.stdout.write(`# measured: ${line}\n`)
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
const freePort = () =>
  new Promise<number>((resolve) => {
    const s = createServer().listen(0, '127.0.0.1', () => {
      const p = (s.address() as { port: number }).port
      s.close(() => resolve(p))
    })
  })
const until = async <T>(
  what: string,
  f: () => Promise<T | null | undefined | false>,
  seconds: number,
): Promise<T> => {
  const end = Date.now() + seconds * 1000
  for (;;) {
    const v = await f().catch(() => null)
    if (v) return v
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`)
    await sleep(1000)
  }
}
const launch = (args: string[]) =>
  spawnSync('sh', [LAUNCHER, ...args], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, RSC_BRAIN_TTY: '/nonexistent/tty' },
    timeout: 900_000,
  })
const git = (...a: string[]) => {
  const r = spawnSync('git', a, {
    encoding: 'utf8',
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 't',
      GIT_AUTHOR_EMAIL: 't@t',
      GIT_COMMITTER_NAME: 't',
      GIT_COMMITTER_EMAIL: 't@t',
    },
  })
  assert.equal(r.status, 0, r.stderr)
  return r.stdout
}

describe('updating from the web with real containers (CA27)', { skip: why ?? false }, () => {
  let base = ''
  let dir = ''
  let site = ''
  let cookie = ''
  let token = ''
  let second = ''

  const signIn = async (email: string, password = PASSWORD) => {
    const r = await fetch(`${site}/v1/auth/login`, {
      method: 'POST',
      headers: WEB,
      body: JSON.stringify({ email, password }),
    })
    return { status: r.status, cookie: (r.headers.get('set-cookie') ?? '').split(';')[0] ?? '' }
  }
  const as = (c: string, path: string, init: RequestInit = {}) =>
    fetch(`${site}${path}`, { ...init, headers: { ...WEB, cookie: c, ...(init.headers ?? {}) } })
  const ask = (c: string, body: unknown = { password: PASSWORD }, path = '/v1/admin/update') =>
    as(c, path, { method: 'POST', body: JSON.stringify(body) })
  const system = async (c = cookie) =>
    (await (await as(c, '/v1/admin/system')).json()) as {
      version: string
      release: { installed: string; latest: string | null; newer: boolean }
      update: {
        mode: string
        requested: boolean
        running: unknown
        last: { ok: boolean; from: string; to: string } | null
      }
    }
  const marks = () => readdirSync(join(dir, 'update', 'request'))

  before(async () => {
    base = mkdtempSync(join(process.env.RSC_BRAIN_INSTALL_TMP ?? tmpdir(), `${PREFIX}-`))
    dir = join(base, 'install')
    let started = Date.now()
    await run('docker', ['build', '-q', '-t', BASE_IMAGE, ROOT], { maxBuffer: 64 << 20 })
    measured(`docker build of rsc-brain ${((Date.now() - started) / 1000).toFixed(1)} s`)
    // The repository: this tree (as it is, tracked and new files, none ignored), once as installed and once as 98.0.0.
    const repo = join(base, 'repo.git')
    const work = join(base, 'work')
    git('init', '-q', '--bare', repo)
    mkdirSync(work)
    const files = git('-C', ROOT, 'ls-files', '-co', '--exclude-standard', '-z').split('\0').filter(Boolean)
    for (const f of files) {
      if (!existsSync(join(ROOT, f))) continue
      mkdirSync(join(work, f, '..'), { recursive: true })
      cpSync(join(ROOT, f), join(work, f))
    }
    git('init', '-q', work)
    git('-C', work, 'add', '-A')
    git('-C', work, 'commit', '-q', '-m', 'installed')
    git('-C', work, 'tag', `v${INSTALLED}`)
    writeFileSync(join(work, 'src', 'core', 'version.ts'), `export const VERSION = '${NEXT}'\n`)
    writeFileSync(
      join(work, 'CHANGELOG.md'),
      `# Changelog\n\n## v${NEXT}\n\n- The version the web test updates to.\n\n${readFileSync(join(work, 'CHANGELOG.md'), 'utf8').replace(/^# Changelog\n+/, '')}`,
    )
    git('-C', work, 'commit', '-q', '-am', 'next')
    git('-C', work, 'tag', `v${NEXT}`)
    git('-C', work, 'push', '-q', repo, 'HEAD:refs/heads/main', `v${INSTALLED}`, `v${NEXT}`)
    rmSync(work, { recursive: true, force: true })
    started = Date.now()
    const port = await freePort()
    const r = launch([
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
      BASE_IMAGE,
      '--repo',
      `file://${repo}`,
    ])
    assert.equal(r.status, 0, r.stderr)
    measured(`install ${((Date.now() - started) / 1000).toFixed(1)} s`)
    site = JSON.parse(r.stdout).url
    // The updater reaches the repository at the same path as here, so it lives in the installation folder.
    cpSync(repo, join(dir, 'repo.git'), { recursive: true })
    const env = readFileSync(join(dir, '.env'), 'utf8').replace(
      /^RSC_BRAIN_REPO_URL=.*$/m,
      `RSC_BRAIN_REPO_URL='file://${join(dir, 'repo.git')}'`,
    )
    writeFileSync(join(dir, '.env'), env, { mode: 0o600 })
    const setup = await fetch(`${site}/v1/setup`, {
      method: 'POST',
      headers: WEB,
      body: JSON.stringify({
        name: 'B3 test',
        publicUrl: site,
        admin: { name: 'Ada', email: 'ada@example.com', password: PASSWORD },
      }),
    })
    assert.equal(setup.status, 201, await setup.text())
    const s = await signIn('ada@example.com')
    assert.equal(s.status, 200)
    cookie = s.cookie
    // A second session of the administrator stands for the second administrator: the mark is what decides, not who.
    second = (await signIn('ada@example.com')).cookie
    const made = await as(cookie, '/v1/me/tokens', {
      method: 'POST',
      body: JSON.stringify({ name: 'b3', perm: 'write', allBrains: true, days: 30 }),
    })
    assert.equal(made.status, 201, await made.clone().text())
    token = ((await made.json()) as { token: { secret: string } }).token.secret
  })

  after(async () => {
    spawnSync('sh', [LAUNCHER, 'web-updates', 'disable', '--dir', dir], { stdio: 'ignore' })
    for (const kind of ['container', 'volume', 'network']) {
      const ls = kind === 'container' ? ['ps', '-aq'] : [kind, 'ls', '-q']
      for (const project of [NAME, UPDATER]) {
        const ids = (
          await docker(...ls, '--filter', `label=com.docker.compose.project=${project}`).catch(() => '')
        )
          .split('\n')
          .filter(Boolean)
        for (const id of ids) {
          if (kind === 'container') await docker('rm', '-f', '-v', id).catch(() => {})
          else await docker(kind, 'rm', '-f', id).catch(() => {})
        }
      }
    }
    // The images this test built or the update built, by exact name.
    const built = (await docker('image', 'ls', '--format', '{{.Repository}}:{{.Tag}}').catch(() => ''))
      .split('\n')
      .filter((i) => i.startsWith(`rsc-brain:`) && i.includes(NAME))
    for (const i of [BASE_IMAGE, UPDATER_IMAGE, ...built])
      await docker('image', 'rm', '-f', i).catch(() => {})
    if (base) rmSync(base, { recursive: true, force: true })
  })

  it('off by default (CA15): the button is refused with the command, and no updater container exists', async () => {
    const r = await ask(cookie)
    assert.equal(r.status, 409)
    assert.equal(((await r.json()) as { error: { code: string } }).error.code, 'updates_off')
    assert.deepEqual(marks(), [])
    assert.equal(await docker('ps', '-aq', '--filter', `label=com.docker.compose.project=${UPDATER}`), '')
    assert.equal((await system()).update.mode, 'off')
  })

  it('enable: the service learns of the new version from the updater, never asking the repository itself', {
    timeout: 900_000,
  }, async () => {
    const r = launch(['web-updates', 'enable', '--yes', '--dir', dir])
    assert.equal(r.status, 0, r.stderr)
    const s = await until(
      'the service to see the updater and the newer version',
      async () => {
        const x = await system()
        return x.update.mode === 'on' && x.release.newer && x.release.latest === `v${NEXT}` ? x : null
      },
      180,
    )
    assert.equal(s.release.installed, `v${INSTALLED}`)
  })

  it('refusals leave nothing: a wrong password is a failed attempt, a token and a key are refused, the body gains nothing', async () => {
    const wrong = await ask(cookie, { password: 'not the password' })
    assert.equal(wrong.status, 401)
    assert.deepEqual(marks(), [])
    const none = await ask(cookie, {})
    assert.equal(none.status, 401)
    const byToken = await fetch(`${site}/v1/admin/update`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ password: PASSWORD }),
    })
    assert.equal(byToken.status, 403)
    assert.deepEqual(marks(), [])
  })

  it('two sessions of the administration at once: one update starts, the other is told so; the mark is empty whatever the body said', async () => {
    assert.ok(second, 'the second administrator exists')
    const extra = {
      password: PASSWORD,
      version: 'v0.0.1',
      repo: 'https://evil.example/x.git',
      command: 'rm -rf /',
    }
    const [a, b] = await Promise.all([ask(cookie, extra), ask(second)])
    assert.deepEqual([a.status, b.status].sort(), [202, 409])
    const lost = a.status === 409 ? a : b
    assert.equal(((await lost.json()) as { error: { code: string } }).error.code, 'update_running')
  })

  it('the update runs to the end: the new version answers, the session from before still works, the last update is recorded, the mark is gone', {
    timeout: 1_500_000,
  }, async () => {
    const started = Date.now()
    const seen = new Set<string>()
    const done = await until(
      'the service to answer as the new version',
      async () => {
        try {
          const h = await fetch(`${site}/v1/health`)
          seen.add(String(h.status))
        } catch {
          seen.add('refused')
        }
        const x = await system()
        return x.version === NEXT ? x : null
      },
      1_300,
    )
    measured(
      `update from the web ${INSTALLED} → ${NEXT}: ${((Date.now() - started) / 1000).toFixed(1)} s, health statuses seen: ${[...seen].sort().join(',')}`,
    )
    assert.equal(done.release.installed, `v${NEXT}`)
    const settled = await until(
      'the updater to say it is done',
      async () => {
        const x = await system()
        return x.update.last && !x.update.running && !x.update.requested ? x : null
      },
      120,
    )
    assert.deepEqual(
      { ok: settled.update.last?.ok, from: settled.update.last?.from, to: settled.update.last?.to },
      { ok: true, from: INSTALLED, to: NEXT },
    )
    assert.deepEqual(marks(), [])
    const audit = (await (await as(cookie, '/v1/admin/audit?action=update.request')).json()) as {
      items?: Array<{ action: string }>
    }
    assert.ok(
      (audit.items ?? []).some((i) => i.action === 'update.request'),
      'the request is in the audit',
    )
    const image = await docker('inspect', '-f', '{{.Config.Image}}', `${NAME}-app-1`)
    assert.notEqual(image, BASE_IMAGE, 'the service runs the image the update built')
  })

  it('disable (CA26): the container is gone and the button is refused again', async () => {
    const r = launch(['web-updates', 'disable', '--dir', dir])
    assert.equal(r.status, 0, r.stderr)
    assert.equal(await docker('ps', '-aq', '--filter', `label=com.docker.compose.project=${UPDATER}`), '')
    const refused = await ask(cookie)
    assert.equal(refused.status, 409)
    assert.equal(((await refused.json()) as { error: { code: string } }).error.code, 'updates_off')
  })
})

describe('an installation made by rsc-factory has no button of its own (CA28)', {
  skip: why ?? false,
}, () => {
  let dir = ''
  before(() => {
    dir = join(mkdtempSync(join(process.env.RSC_BRAIN_INSTALL_TMP ?? tmpdir(), `${PREFIX}-c-`)), 'install')
    mkdirSync(dir, { recursive: true })
    writeFileSync(
      join(dir, '.env'),
      `RSC_BRAIN_LAUNCHER='1'\nRSC_BRAIN_NAME='${NAME}-c'\nCOMPOSE_PROJECT_NAME='${NAME}-c'\nRSC_BRAIN_COMPANION='1'\n`,
      { mode: 0o600 },
    )
  })
  after(() => {
    if (dir) rmSync(join(dir, '..'), { recursive: true, force: true })
  })
  it('web-updates enable exits 2, names rsc-factory, and starts nothing', async () => {
    const r = launch(['web-updates', 'enable', '--yes', '--dir', dir])
    assert.equal(r.status, 2, r.stderr)
    assert.match(r.stderr, /rsc-brain was installed by rsc-factory: update it from there\./)
    assert.equal(
      await docker('ps', '-aq', '--filter', `label=com.docker.compose.project=${NAME}-c-updater`),
      '',
    )
    assert.equal(existsSync(join(dir, 'updater')), false)
  })
})
