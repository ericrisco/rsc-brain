// The launcher, deploy/rsc-brain.sh (plan §3.8, T037; spec B7 «Modos de instalación», «Desinstalar»), with a fake
// `docker` on the PATH (test/deploy/fake-docker.sh): no daemon, no containers, so it runs in CI (plan §5.1). The real
// containers are test/install/launcher.test.ts. The launcher runs with a PATH made of the few tools it may use, never
// with this machine's: a missing `docker`, `docker compose` or `git` is really missing. The terminal it asks on is
// RSC_BRAIN_TTY (a file of answers here; a path that cannot be opened is «no terminal»).
//
// CA4 (requirements: nothing changes when one is missing), CA5 (no questions with --yes; the same result as the
// questions answered alike; --json prints only the summary), CA9c (the summary carries the installation key), CA21
// (a PostgreSQL too old: exit 3, nothing created), the port in use, reinstalling keeps the key and the data,
// uninstall removes only what it made, and the key never on a command line.
import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { connect, createServer, type Server } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, describe, it } from 'node:test'

const ROOT = new URL('../..', import.meta.url).pathname
const LAUNCHER = join(ROOT, 'deploy', 'rsc-brain.sh')
const FAKE = join(ROOT, 'test', 'deploy', 'fake-docker.sh')
// Every tool the launcher may use. Anything else it calls is missing here, and the test that needs it fails.
const TOOLS = [
  'sh',
  'cat',
  'chmod',
  'chown',
  'cp',
  'cut',
  'date',
  'df',
  'dirname',
  'basename',
  'grep',
  'head',
  'id',
  'ls',
  'mkdir',
  'mktemp',
  'mv',
  'od',
  'rm',
  'rmdir',
  'sed',
  'sort',
  'uname',
  'kill',
  'sleep',
  'tail',
  'tr',
  'wc',
  'env',
  'nc',
  'lsof',
  'ss',
  'setsid',
]

let BASE = ''
let SYSBIN = ''
let FAKEBIN = ''
const servers: Server[] = []

const which = (tool: string) => {
  const r = spawnSync('/bin/sh', ['-c', `command -v ${tool}`], { encoding: 'utf8' })
  const p = r.stdout.trim()
  return r.status === 0 && p.startsWith('/') ? p : null
}

before(() => {
  BASE = mkdtempSync(join(tmpdir(), 'rscb-launcher-'))
  SYSBIN = join(BASE, 'sysbin')
  FAKEBIN = join(BASE, 'fakebin')
  mkdirSync(SYSBIN)
  mkdirSync(FAKEBIN)
  for (const t of TOOLS) {
    const p = which(t)
    if (p) symlinkSync(p, join(SYSBIN, t))
  }
  copyFileSync(FAKE, join(FAKEBIN, 'docker'))
  chmodSync(join(FAKEBIN, 'docker'), 0o755)
})
after(() => {
  for (const s of servers) s.close()
  rmSync(BASE, { recursive: true, force: true })
})

let n = 0
type Case = { dir: string; home: string; log: string; stdin: string; state: string; tty: string }
const fresh = (): Case => {
  const c = join(BASE, `case-${++n}`)
  mkdirSync(join(c, 'state'), { recursive: true })
  mkdirSync(join(c, 'home'))
  return {
    dir: join(c, 'install'),
    home: join(c, 'home'),
    log: join(c, 'docker.log'),
    stdin: join(c, 'docker.stdin'),
    state: join(c, 'state'),
    tty: join(c, 'no-terminal', 'tty'),
  }
}

type Run = {
  code: number | null
  signal: NodeJS.Signals | null
  stdout: string
  stderr: string
  calls: string[]
  piped: string
}
const launch = (
  c: Case,
  args: string[],
  o: { env?: Record<string, string>; path?: string; answers?: string; shell?: string } = {},
): Run => {
  const seen = existsSync(c.log) ? readFileSync(c.log, 'utf8').length : 0
  const seenIn = existsSync(c.stdin) ? readFileSync(c.stdin, 'utf8').length : 0
  let tty = c.tty
  if (o.answers !== undefined) {
    tty = join(c.state, `answers-${++n}`)
    writeFileSync(tty, o.answers)
  }
  // RSC_BRAIN_TEST_SHELL runs the whole file under another shell (dash), as test/deploy/update.test.ts does.
  const r = spawnSync(
    o.shell ?? process.env.RSC_BRAIN_TEST_SHELL ?? join(SYSBIN, 'sh'),
    [LAUNCHER, ...args],
    {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 30_000,
      env: {
        PATH: o.path ?? `${FAKEBIN}:${SYSBIN}`,
        HOME: c.home,
        LANG: 'C',
        FAKE_LOG: c.log,
        FAKE_STDIN: c.stdin,
        FAKE_STATE: c.state,
        RSC_BRAIN_TTY: tty,
        ...o.env,
      },
    },
  )
  assert.notEqual(r.signal, 'SIGTERM', `the launcher hung: ${r.stderr}`)
  return {
    code: r.status,
    signal: r.signal,
    stdout: r.stdout,
    stderr: r.stderr,
    // This run's calls and input only (a case may run the launcher several times).
    calls: existsSync(c.log)
      ? readFileSync(c.log, 'utf8').slice(seen).trim().split('\n').filter(Boolean)
      : [],
    piped: existsSync(c.stdin) ? readFileSync(c.stdin, 'utf8').slice(seenIn) : '',
  }
}

const freePort = () =>
  new Promise<number>((resolve) => {
    const s = createServer().listen(0, '127.0.0.1', () => {
      const p = (s.address() as { port: number }).port
      s.close(() => resolve(p))
    })
  })
// A server that holds a port. The launcher probes it with `nc -z`, which closes the connection abruptly: the reset
// reaches the server's socket, and with no handler for it the error is raised by the process, after the test, and
// fails the whole file.
const holding = (s: Server): Server => {
  s.on('connection', (socket) => socket.on('error', () => {}))
  return s
}
const busyPort = () =>
  new Promise<number>((resolve) => {
    const s = holding(createServer()).listen(0, '127.0.0.1', () => {
      servers.push(s)
      resolve((s.address() as { port: number }).port)
    })
  })

// The launcher's own format: KEY='value', one per line.
const readEnv = (dir: string): Record<string, string> => {
  const out: Record<string, string> = {}
  for (const line of readFileSync(join(dir, '.env'), 'utf8').split('\n')) {
    const m = /^([A-Z_][A-Z0-9_]*)='(.*)'$/.exec(line)
    if (m) out[m[1] as string] = m[2] as string
  }
  return out
}
const mode = (p: string) => statSync(p).mode & 0o777
const IMAGE = ['--image', 'rsc-brain:test']
const local = async (c: Case, ...more: string[]) => [
  'install',
  '--local',
  '--yes',
  '--dir',
  c.dir,
  '--port',
  String(await freePort()),
  ...IMAGE,
  ...more,
]

describe('the launcher: requirements (CA4)', () => {
  it('without docker: exit 3, says what is missing and where to get it, and creates nothing', async () => {
    const c = fresh()
    const r = launch(c, await local(c), { path: SYSBIN })
    assert.equal(r.code, 3, r.stderr)
    assert.match(r.stderr, /Docker is not installed/)
    assert.match(r.stderr, /https:\/\/docs\.docker\.com\/get-docker\//)
    assert.match(r.stderr, /Nothing was changed/)
    assert.equal(existsSync(c.dir), false)
  })

  it('docker without its daemon running: exit 3, creates nothing', async () => {
    const c = fresh()
    const r = launch(c, await local(c), { env: { FAKE_INFO_EXIT: '1' } })
    assert.equal(r.code, 3)
    assert.match(r.stderr, /Docker is not running/)
    assert.equal(existsSync(c.dir), false)
  })

  it('without docker compose: exit 3 with where to get it, creates nothing', async () => {
    const c = fresh()
    const r = launch(c, await local(c), { env: { FAKE_NO_COMPOSE: '1' } })
    assert.equal(r.code, 3)
    assert.match(r.stderr, /Docker Compose v2 is missing/)
    assert.match(r.stderr, /https:\/\/docs\.docker\.com\/compose\/install\//)
    assert.equal(existsSync(c.dir), false)
    assert.equal(
      r.calls.some((l) => / up /.test(l)),
      false,
    )
  })

  it('without git, building from the source: exit 3 with where to get it, creates nothing', async () => {
    const c = fresh()
    const port = String(await freePort())
    const r = launch(c, [
      'install',
      '--local',
      '--yes',
      '--dir',
      c.dir,
      '--port',
      port,
      '--version',
      'v0.1.0',
    ])
    assert.equal(r.code, 3, r.stderr)
    assert.match(r.stderr, /git is not installed/)
    assert.match(r.stderr, /https:\/\/git-scm\.com\/downloads/)
    assert.equal(existsSync(c.dir), false)
  })

  it('with a ready image (--image), git is not needed', async () => {
    const c = fresh()
    const r = launch(c, await local(c))
    assert.equal(r.code, 0, r.stderr)
  })

  it('an image that does not exist: exit 3, creates nothing', async () => {
    const c = fresh()
    const r = launch(c, await local(c), { env: { FAKE_IMAGES: 'other:1' } })
    assert.equal(r.code, 3)
    assert.match(r.stderr, /rsc-brain:test/)
    assert.equal(existsSync(c.dir), false)
  })

  it('too little disk: exit 3 saying how much is free and needed, creates nothing', async () => {
    const c = fresh()
    const fakeDf = join(c.state, 'bin')
    mkdirSync(fakeDf)
    writeFileSync(
      join(fakeDf, 'df'),
      '#!/bin/sh\necho "Filesystem 1024-blocks Used Available Capacity Mounted"\necho "/dev/x 100 99 1000 99% /"\n',
    )
    chmodSync(join(fakeDf, 'df'), 0o755)
    const r = launch(c, await local(c), { path: `${fakeDf}:${FAKEBIN}:${SYSBIN}` })
    assert.equal(r.code, 3, r.stderr)
    assert.match(r.stderr, /disk/i)
    assert.equal(existsSync(c.dir), false)
  })

  it('CA21: an existing PostgreSQL that is too old: exit 3 saying so, nothing created', async () => {
    const c = fresh()
    const url = join(c.state, 'db-url')
    writeFileSync(url, 'postgres://brain:s3cret-db-pw@db.internal:5432/brain\n')
    const r = launch(c, await local(c, '--db', 'existing', '--db-url-file', url), {
      env: { FAKE_DB_CHECK_EXIT: '3' },
    })
    assert.equal(r.code, 3, r.stderr)
    assert.match(r.stderr, /PostgreSQL 17 or newer/)
    assert.match(r.stderr, /Nothing was changed/)
    assert.equal(existsSync(c.dir), false)
    assert.equal(
      r.calls.some((l) => /^compose /.test(l) && / up /.test(l)),
      false,
    )
  })
})

describe('the launcher: options (CA5)', () => {
  const bad: Array<[string, string[], RegExp]> = [
    ['an unknown option', ['install', '--local', '--yes', '--frobnicate'], /--frobnicate/],
    ['an unknown command', ['launch'], /Unknown command/],
    ['no command', [], /Usage/],
    ['a port that is not a number', ['install', '--local', '--yes', '--port', '80a'], /--port/],
    ['a port out of range', ['install', '--local', '--yes', '--port', '70000'], /--port/],
    ['port 0', ['install', '--local', '--yes', '--port', '0'], /--port/],
    [
      'local and a domain',
      ['install', '--local', '--domain', 'brain.example.com', '--yes'],
      /--local or --domain/,
    ],
    ['a domain that is not one', ['install', '--domain', 'http://x', '--yes'], /--domain/],
    ['a database kind that does not exist', ['install', '--local', '--db', 'mysql', '--yes'], /--db/],
    ['existing without a URL', ['install', '--local', '--db', 'existing', '--yes'], /--db-url-file/],
    ['shared without the other database', ['install', '--local', '--db', 'shared', '--yes'], /--factory-db/],
    ['a version that is not one', ['install', '--local', '--version', 'latest', '--yes'], /--version/],
    [
      'a version and an image',
      ['install', '--local', '--version', 'v1.0.0', '--image', 'x', '--yes'],
      /--image/,
    ],
    ['a name with spaces', ['install', '--local', '--name', 'my brain', '--yes'], /--name/],
    ['an option without its value', ['install', '--local', '--yes', '--port'], /--port/],
    ['restore without a file', ['restore', '--confirm', 'x'], /--file/],
  ]
  for (const [what, args, says] of bad) {
    it(`${what}: exit 2, says which option, changes nothing`, () => {
      const c = fresh()
      const r = launch(
        c,
        [...args.slice(0, 1), '--dir', c.dir, ...args.slice(1)].filter((a) => a !== ''),
      )
      assert.equal(r.code, 2, `${what}: ${r.stderr}`)
      assert.match(r.stderr, says)
      assert.equal(existsSync(c.dir), false)
      assert.equal(
        r.calls.some((l) => / up /.test(l)),
        false,
      )
    })
  }

  it('a value that may be a secret is never repeated back', () => {
    const c = fresh()
    const r = launch(c, ['install', '--local', '--yes', 'postgres://u:hunter2-secret@h/db'])
    assert.equal(r.code, 2)
    assert.doesNotMatch(r.stderr + r.stdout, /hunter2-secret/)
  })

  it('--yes with an answer missing: exit 2 naming the option that gives it, never asking', async () => {
    const c = fresh()
    const r = launch(c, ['install', '--yes', '--dir', c.dir, '--port', String(await freePort()), ...IMAGE])
    assert.equal(r.code, 2)
    assert.match(r.stderr, /--local or --domain/)
    assert.equal(existsSync(c.dir), false)
  })

  it('no terminal and no --yes: exit 2 saying to pass --yes; a closed input never blocks', async () => {
    const c = fresh()
    const port = String(await freePort())
    const r = launch(c, ['install', '--local', '--dir', c.dir, '--port', port, ...IMAGE])
    assert.equal(r.code, 2)
    assert.match(r.stderr, /--yes/)
    assert.equal(existsSync(c.dir), false)
  })

  it('CA5: the questions answered alike give the same .env and the same files as the options with --yes', async () => {
    const port = String(await freePort())
    const a = fresh()
    const asked = launch(a, ['install', '--dir', a.dir, '--port', port, ...IMAGE], {
      answers: '\n1\ny\n',
    })
    assert.equal(asked.code, 0, asked.stderr)
    assert.match(asked.stderr, /Domain/)
    const b = fresh()
    const told = launch(b, [
      'install',
      '--local',
      '--db',
      'bundled',
      '--yes',
      '--dir',
      b.dir,
      '--port',
      port,
      ...IMAGE,
    ])
    assert.equal(told.code, 0, told.stderr)
    assert.doesNotMatch(told.stderr, /Domain|\[Y\/n\]/)
    const ea = readEnv(a.dir)
    const eb = readEnv(b.dir)
    assert.deepEqual(Object.keys(ea).sort(), Object.keys(eb).sort())
    const random = new Set(['RSC_BRAIN_SECRET', 'POSTGRES_PASSWORD'])
    for (const k of Object.keys(ea)) if (!random.has(k)) assert.equal(ea[k], eb[k], k)
    assert.deepEqual(readdirSync(a.dir).sort(), readdirSync(b.dir).sort())
  })
})

describe('the launcher: a local installation', () => {
  it('CA9c, CA5: --json prints only the summary, with the installation key that is in .env', async () => {
    const c = fresh()
    const args = await local(c, '--json')
    const port = args[args.indexOf('--port') + 1]
    const r = launch(c, args)
    assert.equal(r.code, 0, r.stderr)
    const lines = r.stdout.trim().split('\n')
    assert.equal(lines.length, 1, r.stdout)
    const s = JSON.parse(lines[0] as string)
    const env = readEnv(c.dir)
    assert.deepEqual(Object.keys(s).sort(), [
      'db',
      'dir',
      'installationKey',
      'keyId',
      'mode',
      'url',
      'version',
    ])
    assert.equal(s.installationKey, env.RSC_BRAIN_SECRET)
    assert.ok((env.RSC_BRAIN_SECRET ?? '').length >= 64)
    assert.equal(s.keyId, 'k3yid0123456')
    assert.equal(s.url, `http://localhost:${port}`)
    assert.equal(s.mode, 'local')
    assert.equal(s.db, 'bundled')
    assert.equal(s.version, '0.1.0')
    assert.equal(s.dir, c.dir)
    // Every step said what it was doing, on the error stream.
    assert.match(r.stderr, /Checking/)
  })

  it('writes .env only for its owner, with «this machine only» from one value', async () => {
    const c = fresh()
    const args = await local(c)
    const port = args[args.indexOf('--port') + 1]
    const r = launch(c, args)
    assert.equal(r.code, 0, r.stderr)
    assert.equal(mode(join(c.dir, '.env')), 0o600)
    const env = readEnv(c.dir)
    assert.equal(env.RSC_BRAIN_PUBLISH, `127.0.0.1:${port}`)
    assert.equal(env.RSC_BRAIN_LOCAL_ONLY, '1')
    assert.equal(env.RSC_BRAIN_TRUSTED_PROXIES, '')
    assert.equal(env.RSC_BRAIN_IMAGE, 'rsc-brain:test')
    assert.equal(env.RSC_BRAIN_DB, 'bundled')
    assert.equal(
      env.RSC_BRAIN_DATABASE_URL,
      'postgres://rsc_brain:provisioned-pw@postgres:5432/rsc_brain?sslmode=disable',
    )
    assert.match(env.POSTGRES_PASSWORD ?? '', /^[0-9a-f]{64}$/)
    // The compose file publishes exactly the value the service is told (one value for both: risk 7).
    const compose = readFileSync(join(c.dir, 'compose.yaml'), 'utf8')
    assert.match(compose, /- "\$\{RSC_BRAIN_PUBLISH[:?][^}]*\}:8090"/)
    assert.match(compose, /RSC_BRAIN_PUBLISH: \$\{RSC_BRAIN_PUBLISH/)
    assert.ok(existsSync(join(c.dir, 'Caddyfile')))
    assert.ok(statSync(join(c.dir, 'backups')).isDirectory())
    // The bundled profile, never the server one.
    const up = r.calls.find((l) => /^compose /.test(l) && / up /.test(l)) ?? ''
    assert.match(up, /--profile bundled/)
    assert.doesNotMatch(up, /--profile server/)
    assert.match(up, /-p rsc-brain /)
  })

  it('the database role is made with the administration login on the standard input, never on a command line', async () => {
    const c = fresh()
    const r = launch(c, await local(c))
    assert.equal(r.code, 0, r.stderr)
    const env = readEnv(c.dir)
    const provision = r.calls.find((l) => / rsc-brain db provision /.test(l)) ?? ''
    assert.match(provision, /--database rsc_brain --role rsc_brain/)
    assert.match(r.piped, new RegExp(`postgres://postgres:${env.POSTGRES_PASSWORD}@postgres:5432/postgres`))
  })

  it('no secret ever reaches a command line', async () => {
    const c = fresh()
    const r = launch(c, await local(c, '--json'))
    assert.equal(r.code, 0)
    const env = readEnv(c.dir)
    const all = r.calls.join('\n')
    for (const secret of [env.RSC_BRAIN_SECRET, env.POSTGRES_PASSWORD, 'provisioned-pw'])
      assert.equal(all.includes(secret as string), false, 'a secret on a command line')
    // The key id is asked with the key on the standard input.
    assert.match(r.piped, new RegExp(`<<< key id\\n${env.RSC_BRAIN_SECRET}`))
  })

  it('says the address and the first-time setup; the key is printed once, only to a terminal', async () => {
    const c = fresh()
    const r = launch(c, await local(c))
    assert.equal(r.code, 0)
    const env = readEnv(c.dir)
    assert.match(r.stdout, /http:\/\/localhost:\d+/)
    assert.match(r.stdout, /first-time setup/)
    // Standard output is not a terminal here (it could be a log): the key is not printed, how to see it is.
    assert.equal((r.stdout + r.stderr).includes(env.RSC_BRAIN_SECRET as string), false)
    assert.match(r.stdout, /key show/)
  })

  it('works under a strict POSIX shell (dash), when there is one', {
    skip: which('dash') ? false : 'dash is not installed here',
  }, async () => {
    const c = fresh()
    const r = launch(c, await local(c, '--json'), { shell: which('dash') as string })
    assert.equal(r.code, 0, r.stderr)
    assert.equal(JSON.parse(r.stdout).mode, 'local')
  })

  it('passes shellcheck as POSIX sh, when it is installed', {
    skip: which('shellcheck') ? false : 'shellcheck is not installed here',
  }, () => {
    const r = spawnSync(which('shellcheck') as string, ['-s', 'sh', LAUNCHER], { encoding: 'utf8' })
    assert.equal(r.status, 0, r.stdout)
  })
})

describe('the launcher: the port', () => {
  it('a probe that resets the connection to a held port does not fail the run', async () => {
    const port = await busyPort()
    await new Promise<void>((done) => {
      const probe = connect(port, '127.0.0.1', () => {
        probe.resetAndDestroy()
        setTimeout(done, 200)
      })
    })
  })

  it('in use, with --yes: exit 3 naming --port and a free one, nothing changed', async () => {
    const c = fresh()
    const port = await busyPort()
    const r = launch(c, ['install', '--local', '--yes', '--dir', c.dir, '--port', String(port), ...IMAGE])
    assert.equal(r.code, 3, r.stderr)
    assert.match(r.stderr, new RegExp(`Port ${port} is in use`))
    assert.match(r.stderr, /--port/)
    assert.equal(existsSync(c.dir), false)
  })

  it('in use, with questions: offers the next free one and uses it', async () => {
    const c = fresh()
    const port = await busyPort()
    const r = launch(
      c,
      ['install', '--local', '--db', 'bundled', '--dir', c.dir, '--port', String(port), ...IMAGE],
      {
        answers: 'y\ny\n',
      },
    )
    assert.equal(r.code, 0, r.stderr)
    const chosen = Number((readEnv(c.dir).RSC_BRAIN_PUBLISH ?? '').split(':')[1])
    assert.ok(chosen > port, `chose ${chosen}`)
    assert.match(r.stderr, new RegExp(`Use ${chosen} instead`))
  })
})

describe('the launcher: reinstalling (spec «Volver a ejecutar el instalador»)', () => {
  it('keeps the key, the database passwords, the copies; changes only what it is told', async () => {
    const c = fresh()
    const first = launch(c, await local(c, '--json'))
    assert.equal(first.code, 0, first.stderr)
    const before = readEnv(c.dir)
    writeFileSync(join(c.dir, 'backups', 'rsc-brain-20261101T030000Z-scheduled.rscb'), 'copy')
    const port2 = String(await freePort())
    const second = launch(c, ['install', '--local', '--yes', '--json', '--dir', c.dir, '--port', port2])
    assert.equal(second.code, 0, second.stderr)
    const afterEnv = readEnv(c.dir)
    for (const k of ['RSC_BRAIN_SECRET', 'POSTGRES_PASSWORD', 'RSC_BRAIN_DATABASE_URL', 'RSC_BRAIN_IMAGE'])
      assert.equal(afterEnv[k], before[k], k)
    assert.equal(afterEnv.RSC_BRAIN_PUBLISH, `127.0.0.1:${port2}`)
    assert.equal(JSON.parse(second.stdout).installationKey, before.RSC_BRAIN_SECRET)
    assert.equal(
      readFileSync(join(c.dir, 'backups', 'rsc-brain-20261101T030000Z-scheduled.rscb'), 'utf8'),
      'copy',
    )
    // The role was made once; the second run never asks for a new one, and never takes anything down with -v.
    assert.equal(second.calls.filter((l) => / db provision /.test(l)).length, 0)
    assert.equal(
      second.calls.some((l) => / down /.test(l) && / -v/.test(l)),
      false,
    )
  })

  it('on its own running port, the port is not «in use»', async () => {
    const c = fresh()
    const args = await local(c)
    assert.equal(launch(c, args).code, 0)
    const port = Number(args[args.indexOf('--port') + 1])
    const holder = holding(createServer()).listen(port, '127.0.0.1')
    servers.push(holder)
    await new Promise((r) => holder.once('listening', r))
    const again = launch(c, ['install', '--local', '--yes', '--dir', c.dir, '--port', String(port)])
    assert.equal(again.code, 0, again.stderr)
  })

  it('stopped, its port taken by something else meanwhile: exit 3, nothing changed', async () => {
    const c = fresh()
    const args = await local(c)
    assert.equal(launch(c, args).code, 0)
    assert.equal(launch(c, ['uninstall', '--dir', c.dir]).code, 0)
    const port = Number(args[args.indexOf('--port') + 1])
    const holder = holding(createServer()).listen(port, '127.0.0.1')
    servers.push(holder)
    await new Promise((r) => holder.once('listening', r))
    const before = readFileSync(join(c.dir, '.env'), 'utf8')
    const again = launch(c, ['install', '--yes', '--dir', c.dir])
    assert.equal(again.code, 3, again.stderr)
    assert.match(again.stderr, new RegExp(`Port ${port} is in use`))
    assert.equal(readFileSync(join(c.dir, '.env'), 'utf8'), before)
  })

  it('running, moved to a port that is taken: exit 3, nothing changed', async () => {
    const c = fresh()
    assert.equal(launch(c, await local(c)).code, 0)
    const taken = await busyPort()
    const before = readFileSync(join(c.dir, '.env'), 'utf8')
    const again = launch(c, ['install', '--yes', '--dir', c.dir, '--port', String(taken)])
    assert.equal(again.code, 3, again.stderr)
    assert.equal(readFileSync(join(c.dir, '.env'), 'utf8'), before)
  })

  it('a failed start on a reinstall puts the previous settings back and starts them: exit 4, nothing deleted', async () => {
    const c = fresh()
    assert.equal(launch(c, await local(c)).code, 0)
    const before = readFileSync(join(c.dir, '.env'), 'utf8')
    const r = launch(c, ['install', '--local', '--yes', '--dir', c.dir, '--port', String(await freePort())], {
      env: { FAKE_UP_FAIL_ONCE: '1' },
    })
    assert.equal(r.code, 4, r.stderr)
    assert.equal(readFileSync(join(c.dir, '.env'), 'utf8'), before)
    assert.equal(
      r.calls.some((l) => / down /.test(l) && / -v/.test(l)),
      false,
    )
    assert.ok(r.calls.filter((l) => / up /.test(l)).length >= 2, 'started the previous one again')
    assert.match(r.stderr, /previous/)
  })

  it('a failed first install takes down what it made, and only that: exit 4', async () => {
    const c = fresh()
    mkdirSync(c.dir)
    // The one file a folder may hold before the first install: the person's own additions.
    writeFileSync(join(c.dir, 'compose.override.yaml'), 'services: {}\n')
    const r = launch(c, await local(c), { env: { FAKE_UP_EXIT: '1' } })
    assert.equal(r.code, 4, r.stderr)
    assert.ok(r.calls.some((l) => / down /.test(l) && / -v /.test(l) && /-p rsc-brain /.test(l)))
    assert.deepEqual(readdirSync(c.dir).sort(), ['compose.override.yaml', 'last-failure.log'])
    assert.equal(readFileSync(join(c.dir, 'compose.override.yaml'), 'utf8'), 'services: {}\n')
  })

  it('another version on a reinstall is refused (that is an update, with a copy first): exit 2, nothing changed', async () => {
    const c = fresh()
    assert.equal(launch(c, await local(c)).code, 0)
    const before = readFileSync(join(c.dir, '.env'), 'utf8')
    const r = launch(c, ['install', '--local', '--yes', '--dir', c.dir, '--image', 'rsc-brain:newer'])
    assert.equal(r.code, 2)
    assert.match(r.stderr, /update/)
    assert.equal(readFileSync(join(c.dir, '.env'), 'utf8'), before)
    assert.equal(
      r.calls.some((l) => / up /.test(l)),
      false,
    )
  })

  it('a new installation under a name Docker already holds (another folder): exit 3, nothing taken down', async () => {
    for (const env of [{ FAKE_VOLUMES: 'rsc-brain_pgdata' }, { FAKE_PROJECTS: '1' }]) {
      const c = fresh()
      const r = launch(c, await local(c), { env })
      assert.equal(r.code, 3, r.stderr)
      assert.match(r.stderr, /already holds an installation called rsc-brain/)
      assert.equal(
        r.calls.some((l) => / down /.test(l) || / up /.test(l)),
        false,
      )
      assert.equal(existsSync(c.dir), false)
    }
  })

  it('a different database on a reinstall is refused: exit 2, nothing changed', async () => {
    const c = fresh()
    assert.equal(launch(c, await local(c)).code, 0)
    const before = readFileSync(join(c.dir, '.env'), 'utf8')
    const url = join(c.state, 'db-url')
    writeFileSync(url, 'postgres://b:p@h/db\n')
    const r = launch(c, [
      'install',
      '--local',
      '--yes',
      '--dir',
      c.dir,
      '--db',
      'existing',
      '--db-url-file',
      url,
    ])
    assert.equal(r.code, 2)
    assert.equal(readFileSync(join(c.dir, '.env'), 'utf8'), before)
  })
})

describe('the launcher: databases', () => {
  it('an existing database for rsc-brain alone: checked with the URL on the standard input, kept in .env', async () => {
    const c = fresh()
    const url = join(c.state, 'db-url')
    writeFileSync(url, 'postgres://brain:s3cret-db-pw@db.internal:5432/brain\n')
    const r = launch(c, await local(c, '--db', 'existing', '--db-url-file', url))
    assert.equal(r.code, 0, r.stderr)
    const env = readEnv(c.dir)
    assert.equal(env.RSC_BRAIN_DATABASE_URL, 'postgres://brain:s3cret-db-pw@db.internal:5432/brain')
    assert.equal(env.POSTGRES_PASSWORD, undefined)
    assert.ok(r.calls.some((l) => / rsc-brain db check --url-stdin /.test(l)))
    assert.match(r.piped, /<<< db check\npostgres:\/\/brain:s3cret-db-pw@/)
    assert.equal(r.calls.join('\n').includes('s3cret-db-pw'), false)
    const up = r.calls.find((l) => /^compose /.test(l) && / up /.test(l)) ?? ''
    assert.doesNotMatch(up, /--profile bundled/)
  })

  it('a URL holding a quote or a line break is refused (it could not be kept as written): exit 2', async () => {
    const c = fresh()
    const url = join(c.state, 'db-url')
    writeFileSync(url, "postgres://b:it's@h/db\n")
    const r = launch(c, await local(c, '--db', 'existing', '--db-url-file', url))
    assert.equal(r.code, 2)
    assert.doesNotMatch(r.stderr, /it's/)
    assert.equal(existsSync(c.dir), false)
  })

  it('shared with another program: its database is closed to rsc-brain; the login is used once and never kept', async () => {
    const c = fresh()
    const admin = join(c.state, 'admin-url')
    writeFileSync(admin, 'postgres://admin:adm1n-pw@db.internal:5432/postgres\n')
    const r = launch(
      c,
      await local(c, '--db', 'shared', '--db-admin-url-file', admin, '--factory-db', 'rsc_factory'),
      {
        env: { FAKE_PROVISION_WARNING: 'the owner of rsc_factory is a superuser' },
      },
    )
    assert.equal(r.code, 0, r.stderr)
    const provision = r.calls.find((l) => / db provision /.test(l)) ?? ''
    assert.match(provision, /--isolate-from rsc_factory/)
    assert.match(r.piped, /<<< db provision\npostgres:\/\/admin:adm1n-pw@/)
    assert.match(r.stderr, /superuser/)
    const env = readEnv(c.dir)
    assert.equal(
      env.RSC_BRAIN_DATABASE_URL,
      'postgres://rsc_brain:provisioned-pw@db.internal:5432/rsc_brain?sslmode=disable',
    )
    assert.equal(readFileSync(join(c.dir, '.env'), 'utf8').includes('adm1n-pw'), false)
    assert.equal(r.calls.join('\n').includes('adm1n-pw'), false)
  })

  it('a failed first install with a database it made removes that database (with the same login)', async () => {
    const c = fresh()
    const admin = join(c.state, 'admin-url')
    writeFileSync(admin, 'postgres://admin:adm1n-pw@db.internal:5432/postgres\n')
    const r = launch(c, await local(c, '--db', 'existing', '--db-admin-url-file', admin), {
      env: { FAKE_UP_EXIT: '1' },
    })
    assert.equal(r.code, 4, r.stderr)
    assert.ok(
      r.calls.some((l) =>
        / rsc-brain db drop --database rsc_brain --role rsc_brain --confirm rsc_brain/.test(l),
      ),
    )
    assert.match(r.piped, /<<< db drop\npostgres:\/\/admin:adm1n-pw@/)
  })
})

describe('the launcher: a server', () => {
  it('Caddy in front with the domain; the service believes only Caddy’s fixed address', async () => {
    const c = fresh()
    const http = String(await freePort())
    const https = String(await freePort())
    const r = launch(
      c,
      [
        'install',
        '--domain',
        'brain.example.com',
        '--yes',
        '--json',
        '--dir',
        c.dir,
        '--port',
        String(await freePort()),
        '--http-port',
        http,
        '--https-port',
        https,
        ...IMAGE,
      ],
      { env: { FAKE_SUBNETS: '192.168.200.0/24 172.17.0.0/16' } },
    )
    assert.equal(r.code, 0, r.stderr)
    const s = JSON.parse(r.stdout)
    assert.equal(s.mode, 'server')
    assert.equal(s.url, `https://brain.example.com:${https}`)
    const env = readEnv(c.dir)
    assert.equal(env.RSC_BRAIN_DOMAIN, 'brain.example.com')
    assert.equal(env.RSC_BRAIN_LOCAL_ONLY, '0')
    assert.equal(env.RSC_BRAIN_SETUP_URL, `https://brain.example.com:${https}`)
    // A subnet nobody uses, and the proxy's address inside it, outside the range handed out to the others.
    assert.equal(env.RSC_BRAIN_SUBNET, '192.168.201.0/24')
    assert.equal(env.RSC_BRAIN_PROXY_IP, '192.168.201.2')
    assert.equal(env.RSC_BRAIN_TRUSTED_PROXIES, '192.168.201.2')
    const up = r.calls.find((l) => /^compose /.test(l) && / up /.test(l)) ?? ''
    assert.match(up, /--profile server/)
    assert.match(up, /--profile bundled/)
    const caddy = readFileSync(join(c.dir, 'Caddyfile'), 'utf8')
    assert.match(caddy, /\{\$RSC_BRAIN_DOMAIN\}/)
    assert.match(caddy, /reverse_proxy app:8090/)
  })

  it('ports 80/443 in use: exit 3 naming the port, nothing changed', async () => {
    const c = fresh()
    const http = await busyPort()
    const r = launch(c, [
      'install',
      '--domain',
      'brain.example.com',
      '--yes',
      '--dir',
      c.dir,
      '--port',
      String(await freePort()),
      '--http-port',
      String(http),
      '--https-port',
      String(await freePort()),
      ...IMAGE,
    ])
    assert.equal(r.code, 3, r.stderr)
    assert.match(r.stderr, new RegExp(`Port ${http} is in use`))
    assert.equal(existsSync(c.dir), false)
  })
})

describe('the launcher: building from the source', () => {
  it('clones the version asked into its own <dir>/.rsc-brain/src and builds rsc-brain:<version> from it', async () => {
    const c = fresh()
    const gitBin = join(c.state, 'gitbin')
    mkdirSync(gitBin)
    // A git that "clones" a tree holding the deploy files.
    writeFileSync(
      join(gitBin, 'git'),
      `#!/bin/sh\nprintf 'git %s\\n' "$*" >>"$FAKE_LOG"\nfor last; do :; done\nmkdir -p "$last/deploy"\ncp "${join(ROOT, 'deploy')}/compose.yaml" "${join(ROOT, 'deploy')}/Caddyfile" "$last/deploy/"\n`,
    )
    chmodSync(join(gitBin, 'git'), 0o755)
    const r = launch(
      c,
      [
        'install',
        '--local',
        '--yes',
        '--dir',
        c.dir,
        '--port',
        String(await freePort()),
        '--version',
        'v0.1.0',
        '--repo',
        'ssh://git@example.com/brain.git',
      ],
      { path: `${gitBin}:${FAKEBIN}:${SYSBIN}`, env: { FAKE_IMAGES: 'other:1' } },
    )
    assert.equal(r.code, 0, r.stderr)
    assert.ok(
      r.calls.some((l) =>
        /^git clone --depth 1 --branch v0\.1\.0 ssh:\/\/git@example\.com\/brain\.git /.test(l),
      ),
      r.calls.join('\n'),
    )
    assert.ok(
      r.calls.some((l) => new RegExp(`^build -t rsc-brain:v0\\.1\\.0 ${c.dir}/\\.rsc-brain/src$`).test(l)),
    )
    assert.equal(readEnv(c.dir).RSC_BRAIN_IMAGE, 'rsc-brain:v0.1.0')
    assert.ok(existsSync(join(c.dir, '.rsc-brain', 'src', 'deploy', 'compose.yaml')))
  })
})

describe('the launcher: day to day', () => {
  const installed = async () => {
    const c = fresh()
    const r = launch(c, await local(c))
    assert.equal(r.code, 0, r.stderr)
    return c
  }

  it('status --json says where it is and whether it answers', async () => {
    const c = await installed()
    const r = launch(c, ['status', '--json', '--dir', c.dir])
    assert.equal(r.code, 0, r.stderr)
    const s = JSON.parse(r.stdout)
    assert.equal(s.running, true)
    assert.equal(s.healthy, true)
    assert.equal(s.mode, 'local')
    assert.equal(s.dir, c.dir)
    assert.equal('installationKey' in s, false)
  })

  it('status of a folder with no installation: exit 3 saying so', () => {
    const c = fresh()
    const r = launch(c, ['status', '--dir', c.dir])
    assert.equal(r.code, 3)
    assert.match(r.stderr, /No rsc-brain installation/)
  })

  it('backup and backups run in the service', async () => {
    const c = await installed()
    const b = launch(c, ['backup', '--dir', c.dir])
    assert.equal(b.code, 0, b.stderr)
    assert.ok(b.calls.some((l) => / exec -T app rsc-brain backup/.test(l)))
    const l = launch(c, ['backups', '--dir', c.dir])
    assert.equal(l.code, 0)
    assert.match(l.stdout, /\.rscb/)
  })

  it('key show: without a terminal and without --yes, exit 2; with --yes, the key and nothing else', async () => {
    const c = await installed()
    const no = launch(c, ['key', 'show', '--dir', c.dir])
    assert.equal(no.code, 2)
    assert.equal(no.stdout, '')
    const env = readEnv(c.dir)
    const yes = launch(c, ['key', 'show', '--yes', '--dir', c.dir])
    assert.equal(yes.code, 0)
    assert.equal(yes.stdout, `${env.RSC_BRAIN_SECRET}\n`)
    const asked = launch(c, ['key', 'show', '--dir', c.dir], { answers: 'n\n' })
    assert.equal(asked.code, 1)
    assert.equal(asked.stdout, '')
  })

  it('restore: the copy goes into the copies, the key on the standard input; the service stops and starts again', async () => {
    const c = await installed()
    const copy = join(c.state, 'rsc-brain-20261101T030000Z-manual.rscb')
    writeFileSync(copy, 'copy')
    const key = join(c.state, 'old-key')
    writeFileSync(key, 'the-old-installation-key-0123456789abcdef\n')
    const r = launch(c, [
      'restore',
      '--dir',
      c.dir,
      '--file',
      copy,
      '--key-file',
      key,
      '--confirm',
      'My brain',
    ])
    assert.equal(r.code, 0, r.stderr)
    assert.equal(
      readFileSync(join(c.dir, 'backups', 'rsc-brain-20261101T030000Z-manual.rscb'), 'utf8'),
      'copy',
    )
    const i = r.calls.findIndex((l) => / rsc-brain restore --file /.test(l))
    assert.ok(i > 0)
    assert.match(
      r.calls[i] as string,
      /--file \/backups\/rsc-brain-20261101T030000Z-manual\.rscb --confirm My brain/,
    )
    assert.ok(
      r.calls.slice(0, i).some((l) => / stop app/.test(l)),
      'stopped before',
    )
    assert.ok(
      r.calls.slice(i).some((l) => / up -d/.test(l)),
      'started after',
    )
    assert.match(r.piped, /<<< restore\nthe-old-installation-key-0123456789abcdef/)
    assert.equal(r.calls.join('\n').includes('the-old-installation-key'), false)
    assert.match(r.stdout + r.stderr, /sign in again/)
  })

  it('restore that the service refuses: starts it again and passes the exit on', async () => {
    const c = await installed()
    const copy = join(c.state, 'x.rscb')
    writeFileSync(copy, 'copy')
    const r = launch(c, ['restore', '--dir', c.dir, '--file', copy, '--confirm', 'x'], {
      env: { FAKE_RESTORE_EXIT: '2' },
    })
    assert.equal(r.code, 2)
    const i = r.calls.findIndex((l) => / rsc-brain restore --file /.test(l))
    assert.ok(r.calls.slice(i).some((l) => / up -d/.test(l)))
  })

  it('restore of a file that is not there: exit 2, the service untouched', async () => {
    const c = await installed()
    const r = launch(c, ['restore', '--dir', c.dir, '--file', join(c.state, 'none.rscb'), '--confirm', 'x'])
    assert.equal(r.code, 2)
    assert.equal(
      r.calls.some((l) => / stop /.test(l)),
      false,
    )
  })
})

describe('the launcher: uninstall (CA16, spec «Desinstalar»)', () => {
  const installed = async (...more: string[]) => {
    const c = fresh()
    const r = launch(c, await local(c, ...more))
    assert.equal(r.code, 0, r.stderr)
    writeFileSync(join(c.dir, 'backups', 'rsc-brain-20261101T030000Z-scheduled.rscb'), 'copy')
    return c
  }

  it('without --delete-data: the containers go; the data, the copies and the key stay', async () => {
    const c = await installed()
    const before = readFileSync(join(c.dir, '.env'), 'utf8')
    const r = launch(c, ['uninstall', '--dir', c.dir])
    assert.equal(r.code, 0, r.stderr)
    const down = r.calls.find((l) => / down/.test(l)) ?? ''
    assert.match(down, /-p rsc-brain /)
    assert.doesNotMatch(down, / -v\b|--volumes/)
    assert.equal(readFileSync(join(c.dir, '.env'), 'utf8'), before)
    assert.ok(existsSync(join(c.dir, 'backups', 'rsc-brain-20261101T030000Z-scheduled.rscb')))
    assert.match(r.stdout, /kept/)
  })

  it('--delete-data without --confirm (and no terminal), or with another name: exit 2, nothing deleted', async () => {
    const c = await installed()
    for (const confirm of [[], ['--confirm', 'other']]) {
      const r = launch(c, ['uninstall', '--delete-data', '--dir', c.dir, ...confirm])
      assert.equal(r.code, 2, r.stderr)
      assert.equal(
        r.calls.some((l) => / down/.test(l)),
        false,
      )
      assert.ok(existsSync(join(c.dir, 'backups', 'rsc-brain-20261101T030000Z-scheduled.rscb')))
    }
    // --yes is no confirmation of a deletion.
    const y = launch(c, ['uninstall', '--delete-data', '--yes', '--dir', c.dir])
    assert.equal(y.code, 2)
  })

  it('--delete-data asked on a terminal: a wrong name deletes nothing', async () => {
    const c = await installed()
    const r = launch(c, ['uninstall', '--delete-data', '--dir', c.dir], { answers: 'nope\n' })
    assert.equal(r.code, 2)
    assert.ok(existsSync(join(c.dir, '.env')))
  })

  it('--delete-data --confirm <name>: its volumes and copies go; the key is kept in a file only its owner reads', async () => {
    const c = await installed()
    const env = readEnv(c.dir)
    writeFileSync(join(c.dir, 'compose.override.yaml'), 'services: {}\n')
    const r = launch(c, ['uninstall', '--delete-data', '--confirm', 'rsc-brain', '--dir', c.dir])
    assert.equal(r.code, 0, r.stderr)
    const down = r.calls.find((l) => / down/.test(l)) ?? ''
    assert.match(down, /-p rsc-brain .* down -v --remove-orphans/)
    assert.equal(existsSync(join(c.dir, 'backups')), false)
    assert.equal(existsSync(join(c.dir, '.env')), false)
    const keyFile = join(c.dir, 'installation-key.txt')
    assert.equal(readFileSync(keyFile, 'utf8').trim(), env.RSC_BRAIN_SECRET)
    assert.equal(mode(keyFile), 0o600)
    // What the person wrote there stays.
    assert.ok(existsSync(join(c.dir, 'compose.override.yaml')))
    assert.match(r.stdout, /installation-key\.txt/)
  })

  it('--delete-data of an existing database: removed with the administration login when given, said what to remove when not', async () => {
    const c = fresh()
    const admin = join(c.state, 'admin-url')
    writeFileSync(admin, 'postgres://admin:adm1n-pw@db.internal:5432/postgres\n')
    assert.equal(launch(c, await local(c, '--db', 'existing', '--db-admin-url-file', admin)).code, 0)
    const without = fresh()
    const url = join(without.state, 'db-url')
    writeFileSync(url, 'postgres://b:p@db.internal:5432/brain\n')
    assert.equal(launch(without, await local(without, '--db', 'existing', '--db-url-file', url)).code, 0)

    const r = launch(c, [
      'uninstall',
      '--delete-data',
      '--confirm',
      'rsc-brain',
      '--dir',
      c.dir,
      '--db-admin-url-file',
      admin,
    ])
    assert.equal(r.code, 0, r.stderr)
    assert.ok(
      r.calls.some((l) =>
        / rsc-brain db drop --database rsc_brain --role rsc_brain --confirm rsc_brain/.test(l),
      ),
    )
    assert.match(r.piped, /<<< db drop\npostgres:\/\/admin:adm1n-pw@/)

    const w = launch(without, ['uninstall', '--delete-data', '--confirm', 'rsc-brain', '--dir', without.dir])
    assert.equal(w.code, 0, w.stderr)
    assert.equal(
      w.calls.some((l) => / db drop /.test(l)),
      false,
    )
    assert.match(w.stdout, /remove the database/i)
  })

  it('uninstall where nothing is installed: exit 3, nothing touched', () => {
    const c = fresh()
    mkdirSync(c.dir)
    const r = launch(c, ['uninstall', '--dir', c.dir])
    assert.equal(r.code, 3)
    assert.equal(r.calls.length, 0)
  })
})

// The review of PR #35: what the launcher may touch, what it inherits, what it leaves when it fails or is stopped.
describe('the launcher: only its own (review of PR #35)', () => {
  it('a folder holding files that are not an installation is refused and left as it was (a git clone, say)', async () => {
    const c = fresh()
    mkdirSync(join(c.dir, 'src'), { recursive: true })
    writeFileSync(join(c.dir, 'src', 'work.ts'), 'uncommitted work')
    const r = launch(c, await local(c))
    assert.equal(r.code, 2, r.stderr)
    assert.match(
      r.stderr,
      /already holds files that are not an rsc-brain installation\. Choose another folder with --dir/,
    )
    assert.equal(readFileSync(join(c.dir, 'src', 'work.ts'), 'utf8'), 'uncommitted work')
    assert.deepEqual(readdirSync(c.dir), ['src'])
    assert.equal(
      r.calls.some((l) => / up /.test(l) || /^build /.test(l)),
      false,
    )
  })

  it('a .env the launcher did not write is not an installation: refused, untouched', async () => {
    const c = fresh()
    mkdirSync(c.dir)
    writeFileSync(join(c.dir, '.env'), "RSC_BRAIN_SECRET='someone elses'\n")
    const r = launch(c, await local(c))
    assert.equal(r.code, 2, r.stderr)
    assert.equal(readFileSync(join(c.dir, '.env'), 'utf8'), "RSC_BRAIN_SECRET='someone elses'\n")
    for (const cmd of [['uninstall'], ['key', 'show', '--yes']]) {
      const u = launch(c, [...cmd, '--dir', c.dir])
      assert.equal(u.code, 3, u.stderr)
      assert.equal(u.stdout, '')
    }
  })

  it('values of the installation exported in the shell never reach docker compose; it says so once', async () => {
    const c = fresh()
    const r = launch(c, await local(c), {
      env: {
        RSC_BRAIN_SECRET: 'from-the-shell-0123456789abcdef0123456789',
        RSC_BRAIN_PUBLISH: '0.0.0.0:80',
        POSTGRES_PASSWORD: 'shell-pw',
        RSC_BRAIN_ACME_CA: 'https://evil.example/dir',
        COMPOSE_PROFILES: 'server',
        // Named only in compose.yaml: the list comes from the file, not from the launcher's memory.
        RSC_BRAIN_TRUSTED_PROXIES: '0.0.0.0/0',
        RSC_BRAIN_LOCAL_ONLY: '0',
      },
    })
    assert.equal(r.code, 0, r.stderr)
    assert.deepEqual(
      r.calls.filter((l) => l.startsWith('LEAK ')),
      [],
    )
    assert.equal((r.stderr.match(/set in this shell/g) ?? []).length, 1, r.stderr)
    assert.match(r.stderr, /RSC_BRAIN_SECRET/)
    assert.doesNotMatch(r.stderr, /from-the-shell/)
    for (const day of [['status'], ['backups'], ['uninstall']]) {
      const d = launch(c, [...day, '--dir', c.dir], {
        env: { RSC_BRAIN_SECRET: 'x'.repeat(40), RSC_BRAIN_IMAGE: 'evil' },
      })
      assert.deepEqual(
        d.calls.filter((l) => l.startsWith('LEAK ')),
        [],
        day.join(' '),
      )
    }
  })

  it('a failed start keeps the service’s last lines, without the key, in <dir>/last-failure.log (0600), and says where', async () => {
    const c = fresh()
    const r = launch(c, await local(c), { env: { FAKE_UP_EXIT: '1' } })
    assert.equal(r.code, 4)
    const log = join(c.dir, 'last-failure.log')
    const text = readFileSync(log, 'utf8')
    assert.match(text, /boot failed: database refused/)
    assert.doesNotMatch(text, /\(key [0-9a-f]{20,}/)
    assert.match(text, /\[redacted\]/)
    assert.equal(mode(log), 0o600)
    assert.ok(r.stderr.includes(`"${log}"`), r.stderr)
    assert.ok(
      r.calls.findIndex((l) => / logs /.test(l)) < r.calls.findIndex((l) => / down /.test(l)),
      'the logs are read before the containers go',
    )
  })

  it('a user who may not use Docker is told how to fix it: exit 3, nothing changed', async () => {
    const c = fresh()
    const r = launch(c, await local(c), { env: { FAKE_INFO_DENIED: '1' } })
    assert.equal(r.code, 3)
    assert.match(
      r.stderr,
      /Your user cannot use Docker\. Add it to the docker group \(sudo usermod -aG docker \$USER/,
    )
    assert.equal(existsSync(c.dir), false)
  })

  const admin = (c: Case) => {
    const f = join(c.state, 'admin-url')
    writeFileSync(f, 'postgres://admin:adm1n-pw@db.internal:5432/postgres\n')
    return f
  }
  const launchAsync = (c: Case, args: string[], env: Record<string, string>, signal: NodeJS.Signals) =>
    new Promise<{ code: number | null; stderr: string }>((resolve) => {
      const p = spawn(join(SYSBIN, 'sh'), [LAUNCHER, ...args], {
        stdio: ['ignore', 'pipe', 'pipe'],
        env: {
          PATH: `${FAKEBIN}:${SYSBIN}`,
          HOME: c.home,
          LANG: 'C',
          FAKE_LOG: c.log,
          FAKE_STDIN: c.stdin,
          FAKE_STATE: c.state,
          RSC_BRAIN_TTY: c.tty,
          ...env,
        },
      })
      let stderr = ''
      let sent = false
      p.stderr.on('data', (d) => {
        stderr += d
        if (!sent && /Making the database/.test(stderr)) {
          sent = true
          // Once the fake provision has started (it sleeps), stop the launcher.
          const wait = setInterval(() => {
            if (existsSync(join(c.state, 'provision-started'))) {
              clearInterval(wait)
              p.kill(signal)
            }
          }, 50)
        }
      })
      p.on('close', (code) => resolve({ code, stderr }))
    })

  it('stopped (HUP) while making the database: takes back the database it was making, the containers and its files', async () => {
    const c = fresh()
    const args = await local(c, '--db', 'existing', '--db-admin-url-file', admin(c))
    const r = await launchAsync(c, args, { FAKE_PROVISION_SLEEP: '1' }, 'SIGHUP')
    assert.equal(r.code, 4, r.stderr)
    assert.match(r.stderr, /Interrupted/)
    const calls = readFileSync(c.log, 'utf8')
    assert.match(calls, / rsc-brain db drop --database rsc_brain --role rsc_brain --confirm rsc_brain/)
    assert.match(readFileSync(c.stdin, 'utf8'), /<<< db drop\npostgres:\/\/admin:adm1n-pw@/)
    assert.equal(existsSync(c.dir), false)
  })

  it('killed outright mid-install, a rerun takes back what the first one left and installs as a first install', async () => {
    const c = fresh()
    const args = await local(c, '--db', 'existing', '--db-admin-url-file', admin(c))
    const killed = await launchAsync(c, args, { FAKE_PROVISION_SLEEP: '1' }, 'SIGKILL')
    assert.equal(killed.code, null)
    assert.equal(existsSync(join(c.dir, '.env')), false, 'no .env before the first install completes')
    await new Promise((r) => setTimeout(r, 1500))
    const again = launch(c, args)
    assert.equal(again.code, 0, again.stderr)
    assert.match(again.stderr, /interrupted/)
    const drop = again.calls.findIndex((l) => / db drop /.test(l))
    const provision = again.calls.findIndex((l) => / db provision /.test(l))
    assert.ok(drop >= 0 && drop < provision, 'the database the first one was making is removed first')
    // A first install: the onboarding, and the new key in the summary.
    assert.match(again.stdout, /first-time setup/)
    assert.match(readFileSync(join(c.dir, '.env'), 'utf8'), /RSC_BRAIN_LAUNCHER='1'/)
    assert.equal(existsSync(join(c.dir, '.rsc-brain', 'install.pending')), false)
  })

  it('an interrupted install that made a database cannot resume without the login that removes it: exit 2', async () => {
    const c = fresh()
    const args = await local(c, '--db', 'existing', '--db-admin-url-file', admin(c))
    await launchAsync(c, args, { FAKE_PROVISION_SLEEP: '1' }, 'SIGKILL')
    await new Promise((r) => setTimeout(r, 1500))
    const url = join(c.state, 'db-url')
    writeFileSync(url, 'postgres://b:p@h/db\n')
    const r = launch(c, [
      'install',
      '--local',
      '--yes',
      '--dir',
      c.dir,
      '--db',
      'existing',
      '--db-url-file',
      url,
    ])
    assert.equal(r.code, 2, r.stderr)
    assert.match(r.stderr, /--db-admin-url-file/)
    assert.ok(existsSync(join(c.dir, '.rsc-brain', 'install.pending')))
  })
})

describe('the launcher: restore and ports (review of PR #35)', () => {
  const installed = async () => {
    const c = fresh()
    const r = launch(c, await local(c))
    assert.equal(r.code, 0, r.stderr)
    return c
  }

  it('restore takes a copy by the name backups prints, from <dir>/backups', async () => {
    const c = await installed()
    writeFileSync(join(c.dir, 'backups', 'rsc-brain-20261101T030000Z-manual.rscb'), 'copy')
    const r = launch(c, [
      'restore',
      '--dir',
      c.dir,
      '--file',
      'rsc-brain-20261101T030000Z-manual.rscb',
      '--confirm',
      'x',
    ])
    assert.equal(r.code, 0, r.stderr)
    assert.ok(
      r.calls.some((l) => / restore --file \/backups\/rsc-brain-20261101T030000Z-manual\.rscb /.test(l)),
    )
  })

  it('a restore that fails removes the copy it brought into <dir>/backups', async () => {
    const c = await installed()
    const copy = join(c.state, 'brought.rscb')
    writeFileSync(copy, 'copy')
    const r = launch(c, ['restore', '--dir', c.dir, '--file', copy, '--confirm', 'x'], {
      env: { FAKE_RESTORE_EXIT: '1' },
    })
    assert.equal(r.code, 1)
    assert.equal(existsSync(join(c.dir, 'backups', 'brought.rscb')), false)
    assert.ok(existsSync(copy))
  })

  const bin = (c: Case, tools: string[]) => {
    const d = join(c.state, `bin-${++n}`)
    mkdirSync(d)
    for (const t of readdirSync(SYSBIN))
      if (!['nc', 'lsof', 'ss'].includes(t)) symlinkSync(join(SYSBIN, t), join(d, t))
    for (const t of tools) {
      const p = which(t)
      if (p) symlinkSync(p, join(d, t))
    }
    return d
  }

  it('without nc, lsof or ss, a port in use is still found (bash), or the launcher says it cannot check', {
    skip: which('bash') ? false : 'bash is not installed here',
  }, async () => {
    const c = fresh()
    const port = await busyPort()
    const withBash = launch(
      c,
      ['install', '--local', '--yes', '--dir', c.dir, '--port', String(port), ...IMAGE],
      {
        path: `${FAKEBIN}:${bin(c, ['bash'])}`,
      },
    )
    assert.equal(withBash.code, 3, withBash.stderr)
    assert.match(withBash.stderr, new RegExp(`Port ${port} is in use`))
    const none = launch(
      c,
      ['install', '--local', '--yes', '--dir', c.dir, '--port', String(await freePort()), ...IMAGE],
      {
        path: `${FAKEBIN}:${bin(c, [])}`,
      },
    )
    assert.equal(none.code, 0, none.stderr)
    assert.match(none.stderr, /cannot check whether port \d+ is free/)
  })
})

// The second pass on PR #35: one launcher at a time per folder, the files a folder may hold, the journal at every
// step, and a restore checked before the service stops.
describe('the launcher: one at a time, and the rest (second pass on PR #35)', () => {
  const host = spawnSync('uname', ['-n'], { encoding: 'utf8' }).stdout.trim()
  const admin = (c: Case) => {
    const f = join(c.state, 'admin-url')
    writeFileSync(f, 'postgres://admin:adm1n-pw@db.internal:5432/postgres\n')
    return f
  }
  const background = (c: Case, args: string[], env: Record<string, string>) => {
    const p = spawn(join(SYSBIN, 'sh'), [LAUNCHER, ...args], {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: {
        PATH: `${FAKEBIN}:${SYSBIN}`,
        HOME: c.home,
        LANG: 'C',
        FAKE_LOG: c.log,
        FAKE_STDIN: c.stdin,
        FAKE_STATE: c.state,
        RSC_BRAIN_TTY: c.tty,
        ...env,
      },
    })
    let stdout = ''
    let stderr = ''
    p.stdout.on('data', (d) => {
      stdout += d
    })
    p.stderr.on('data', (d) => {
      stderr += d
    })
    const done = new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve) =>
      p.on('close', (code) => resolve({ code, stdout, stderr })),
    )
    return { p, done, stderr: () => stderr }
  }
  const until = async (f: () => boolean) => {
    for (let i = 0; i < 200 && !f(); i++) await new Promise((r) => setTimeout(r, 50))
    assert.ok(f(), 'timed out')
  }

  it('a second launcher on the same folder while one works: exit 3 naming its process; the first ends with its own key', async () => {
    const c = fresh()
    const args = await local(c, '--json', '--db', 'existing', '--db-admin-url-file', admin(c))
    const a = background(c, args, { FAKE_PROVISION_SLEEP: '2' })
    await until(() => existsSync(join(c.state, 'provision-started')))
    const b = launch(c, args)
    assert.equal(b.code, 3, b.stderr)
    assert.match(
      b.stderr,
      new RegExp(
        `Another rsc-brain launcher is working on "${c.dir}" \\(process ${a.p.pid}\\)\\. Wait for it to finish\\.`,
      ),
    )
    const first = await a.done
    assert.equal(first.code, 0, first.stderr)
    assert.equal(JSON.parse(first.stdout).installationKey, readEnv(c.dir).RSC_BRAIN_SECRET)
    assert.equal(existsSync(join(c.dir, '.rsc-brain', 'lock')), false, 'the lock is let go')
  })

  it('install, uninstall, restore, backup, update and key rotate wait their turn; status does not', async () => {
    const c = fresh()
    assert.equal(launch(c, await local(c)).code, 0)
    mkdirSync(join(c.dir, '.rsc-brain', 'lock'), { recursive: true })
    writeFileSync(join(c.dir, '.rsc-brain', 'lock', 'owner'), `${process.pid} ${host}\n`)
    const copy = join(c.state, 'x.rscb')
    writeFileSync(copy, 'copy')
    for (const cmd of [
      ['install', '--local', '--yes'],
      ['uninstall'],
      ['restore', '--file', copy, '--confirm', 'x'],
      ['backup'],
      ['update', '--yes', '--image', 'rsc-brain:test'],
      ['key', 'rotate', '--yes'],
    ]) {
      const r = launch(c, [...cmd, '--dir', c.dir])
      assert.equal(r.code, 3, `${cmd[0]}: ${r.stderr}`)
      assert.match(r.stderr, new RegExp(`\\(process ${process.pid}\\)`))
      assert.equal(
        r.calls.some((l) => / (up|down|stop|run|exec) /.test(l)),
        false,
        cmd[0],
      )
    }
    assert.equal(launch(c, ['status', '--dir', c.dir]).code, 0)
  })

  it('a lock left by a launcher that died is taken over (and said so)', async () => {
    const c = fresh()
    assert.equal(launch(c, await local(c)).code, 0)
    // A process number nobody has: spawn one that ends, and take its number.
    const gone = spawnSync('sh', ['-c', 'echo $$'], { encoding: 'utf8' }).stdout.trim()
    mkdirSync(join(c.dir, '.rsc-brain', 'lock'), { recursive: true })
    writeFileSync(join(c.dir, '.rsc-brain', 'lock', 'owner'), `${gone} ${host}\n`)
    const r = launch(c, ['backup', '--dir', c.dir])
    assert.equal(r.code, 0, r.stderr)
    assert.match(r.stderr, new RegExp(`stopped \\(process ${gone}\\)`))
    assert.equal(existsSync(join(c.dir, '.rsc-brain', 'lock')), false)
  })

  for (const name of [
    'installation-key.txt',
    'installation-key-id0123456789.txt',
    'rsc-brain.sh',
    '.DS_Store',
    'lost+found',
    '._compose.override.yaml',
    'Thumbs.db',
    'last-failure.log',
    'compose.override.yaml',
  ]) {
    it(`a folder holding only ${name} may take a first install`, async () => {
      const c = fresh()
      mkdirSync(c.dir)
      if (name === 'lost+found') mkdirSync(join(c.dir, name))
      else writeFileSync(join(c.dir, name), name.startsWith('installation-key') ? `${'k'.repeat(64)}\n` : 'x')
      const r = launch(c, await local(c))
      assert.equal(r.code, 0, r.stderr)
      // Left in place; the log of an earlier failed install goes once one succeeds.
      assert.equal(existsSync(join(c.dir, name)), name !== 'last-failure.log')
    })
  }

  it('uninstall --delete-data then install: the saved key is used again (--yes), so old copies stay restorable; it says which', async () => {
    const c = fresh()
    assert.equal(launch(c, await local(c)).code, 0)
    const key = readEnv(c.dir).RSC_BRAIN_SECRET
    assert.equal(launch(c, ['uninstall', '--delete-data', '--confirm', 'rsc-brain', '--dir', c.dir]).code, 0)
    const again = launch(c, await local(c, '--json'))
    assert.equal(again.code, 0, again.stderr)
    assert.equal(readEnv(c.dir).RSC_BRAIN_SECRET, key)
    assert.equal(JSON.parse(again.stdout).installationKey, key)
    assert.ok(
      again.stderr.includes(`Using the installation key saved in "${join(c.dir, 'installation-key.txt')}"`),
      again.stderr,
    )
  })

  it('asked, a new key instead of the saved one: says the saved file is left as it was', async () => {
    const c = fresh()
    mkdirSync(c.dir)
    writeFileSync(join(c.dir, 'installation-key.txt'), `${'k'.repeat(64)}\n`)
    const r = launch(
      c,
      ['install', '--local', '--db', 'bundled', '--dir', c.dir, '--port', String(await freePort()), ...IMAGE],
      {
        answers: 'n\ny\n',
      },
    )
    assert.equal(r.code, 0, r.stderr)
    assert.notEqual(readEnv(c.dir).RSC_BRAIN_SECRET, 'k'.repeat(64))
    assert.match(r.stderr, /Reuse the installation key saved in/)
    assert.match(r.stderr, /A new installation key was made/)
    assert.equal(readFileSync(join(c.dir, 'installation-key.txt'), 'utf8'), `${'k'.repeat(64)}\n`)
  })

  it('a saved key file that holds no usable key is not used: exit 2, nothing changed', async () => {
    const c = fresh()
    mkdirSync(c.dir)
    writeFileSync(join(c.dir, 'installation-key.txt'), "short'\n")
    const r = launch(c, await local(c))
    assert.equal(r.code, 2, r.stderr)
    assert.deepEqual(readdirSync(c.dir), ['installation-key.txt'])
  })

  for (const at of ['state', 'backups', 'compose.yaml', 'Caddyfile']) {
    it(`killed right after it makes ${at}: the journal already names it, and the next run takes it back`, async () => {
      const c = fresh()
      const args = await local(c)
      const killed = launch(c, args, { env: { RSC_BRAIN_TEST_STOP_AT: at } })
      assert.equal(killed.signal, 'SIGKILL', killed.stderr)
      const pending = readFileSync(join(c.dir, '.rsc-brain', 'install.pending'), 'utf8')
      const made = /^RSC_BRAIN_PENDING_MADE='(.*)'$/m.exec(pending)?.[1] ?? ''
      assert.ok(made.split(' ').includes(at === 'state' ? '.rsc-brain' : at), made)
      const again = launch(c, args)
      assert.equal(again.code, 0, again.stderr)
      assert.match(again.stderr, /interrupted/)
    })
  }

  it('restore checks the name and the key before it stops anything: a wrong name never stops the service', async () => {
    const c = fresh()
    assert.equal(launch(c, await local(c)).code, 0)
    const copy = join(c.state, 'brought.rscb')
    writeFileSync(copy, 'copy')
    const r = launch(c, ['restore', '--dir', c.dir, '--file', copy, '--confirm', 'wrong'], {
      env: { FAKE_RESTORE_CHECK_EXIT: '2' },
    })
    assert.equal(r.code, 2, r.stderr)
    assert.equal(
      r.calls.some((l) => / stop /.test(l) || / run --rm .* restore --file/.test(l)),
      false,
    )
    assert.ok(
      r.calls.some((l) =>
        / exec -T app rsc-brain restore --check --file \/backups\/brought\.rscb --confirm wrong/.test(l),
      ),
    )
    assert.equal(existsSync(join(c.dir, 'backups', 'brought.rscb')), false)
    const ok = launch(c, ['restore', '--dir', c.dir, '--file', copy, '--confirm', 'right'])
    assert.equal(ok.code, 0, ok.stderr)
    const check = ok.calls.findIndex((l) => / restore --check /.test(l))
    const stop = ok.calls.findIndex((l) => / stop app/.test(l))
    assert.ok(check >= 0 && check < stop, 'checked before stopping')
  })
})

describe('the launcher: the folder changed while it asked (second pass on PR #35)', () => {
  it('another launcher completed an install while this one waited on a question: exit 3, the installation untouched', {
    skip: which('mkfifo') ? false : 'mkfifo is not installed here',
  }, async () => {
    const c = fresh()
    const port = String(await freePort())
    const tty = join(c.state, 'tty')
    spawnSync(which('mkfifo') as string, [tty])
    // B asks its questions on a terminal nobody has answered yet.
    const b = spawn(join(SYSBIN, 'sh'), [LAUNCHER, 'install', '--dir', c.dir, '--port', port, ...IMAGE], {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: {
        PATH: `${FAKEBIN}:${SYSBIN}`,
        HOME: c.home,
        LANG: 'C',
        FAKE_LOG: c.log,
        FAKE_STDIN: c.stdin,
        FAKE_STATE: c.state,
        RSC_BRAIN_TTY: tty,
      },
    })
    let stderr = ''
    b.stderr.on('data', (d) => {
      stderr += d
    })
    const done = new Promise<number | null>((resolve) => b.on('close', resolve))
    // Meanwhile A installs into the same folder, start to end.
    const a = launch(c, ['install', '--local', '--yes', '--dir', c.dir, '--port', port, ...IMAGE])
    assert.equal(a.code, 0, a.stderr)
    const before = readFileSync(join(c.dir, '.env'), 'utf8')
    const { open } = await import('node:fs/promises')
    const writer = await open(tty, 'w')
    await new Promise((r) => setTimeout(r, 200))
    await writer.write('\n1\ny\n')
    const code = await done
    await writer.close()
    assert.equal(code, 3, stderr)
    assert.match(stderr, /changed while this launcher was getting ready/)
    assert.equal(readFileSync(join(c.dir, '.env'), 'utf8'), before)
  })
})

// Companion mode (plan F1 §3.1, T048): rsc-factory's installer runs `install --companion --attach-network NAME
// --factory-url URL` and reads the --json summary. The app joins the network shared with rsc-factory as `rsc-brain`,
// has no Caddy of its own (rsc-factory's serves it), and waits with a one-time key for rsc-factory's setup.
describe('the launcher: companion mode (F1)', () => {
  const NET = 'rsc-shared=192.168.230.0/24|192.168.230.1'
  const adminFile = (c: Case) => {
    const f = join(c.state, 'admin-url')
    writeFileSync(f, 'postgres://admin:adm1n-pw@postgres:5432/postgres\n')
    return f
  }
  const companion = async (c: Case, ...more: string[]) => [
    ...(await local(c)),
    '--companion',
    '--attach-network',
    'rsc-shared',
    '--factory-url',
    'http://localhost:3000',
    '--db',
    'shared',
    '--db-admin-url-file',
    adminFile(c),
    '--factory-db',
    'rscf',
    ...more,
  ]
  const server = async (c: Case, ...more: string[]) =>
    (await companion(c, ...more)).filter((a) => a !== '--local').concat(['--domain', 'brain.example.com'])

  for (const shell of ['sh', 'dash'] as const) {
    it(`local, under ${shell}: --json adds the one-time key and the internal address; .env keeps them for the service`, {
      skip: shell === 'dash' && !which('dash') ? 'dash is not installed here' : false,
    }, async () => {
      const c = fresh()
      const r = launch(c, await companion(c, '--json'), {
        env: { FAKE_NETWORKS: NET },
        ...(shell === 'dash' ? { shell: which('dash') as string } : {}),
      })
      assert.equal(r.code, 0, r.stderr)
      const lines = r.stdout.trim().split('\n')
      assert.equal(lines.length, 1, r.stdout)
      const s = JSON.parse(lines[0] as string)
      assert.deepEqual(Object.keys(s).sort(), [
        'companionToken',
        'db',
        'dir',
        'installationKey',
        'internalUrl',
        'keyId',
        'mode',
        'url',
        'version',
      ])
      const env = readEnv(c.dir)
      assert.match(s.companionToken, /^[0-9a-f]{64}$/)
      assert.notEqual(s.companionToken, s.installationKey)
      assert.equal(env.RSC_BRAIN_COMPANION_TOKEN, s.companionToken)
      assert.equal(s.internalUrl, 'http://rsc-brain:8090')
      assert.deepEqual([s.mode, s.db], ['local', 'shared'])
      assert.equal(mode(join(c.dir, '.env')), 0o600)
      assert.deepEqual(
        [
          env.RSC_BRAIN_SHARED_NETWORK,
          env.RSC_BRAIN_COMPANION_NETWORK,
          env.RSC_BRAIN_COMPANION_GATEWAY,
          env.RSC_BRAIN_FACTORY_URL,
          env.RSC_BRAIN_LOCAL_ONLY,
          env.RSC_BRAIN_TRUSTED_PROXIES,
        ],
        ['rsc-shared', '192.168.230.0/24', '192.168.230.1', 'http://localhost:3000', '1', ''],
      )
      // The app joins the shared network, external, as rsc-brain; the compose file names the service's settings.
      const extra = readFileSync(join(c.dir, 'compose.companion.yaml'), 'utf8')
      assert.match(extra, /name: \$\{RSC_BRAIN_SHARED_NETWORK/)
      assert.match(extra, /external: true/)
      assert.match(extra, /aliases:\s*\n\s*- rsc-brain/)
      // Its own network keeps the default route: «this machine only» trusts that gateway, never the shared one.
      assert.match(extra, /default:\s*\n\s*gw_priority: 1/)
      const compose = readFileSync(join(c.dir, 'compose.yaml'), 'utf8')
      for (const v of ['COMPANION_TOKEN', 'COMPANION_NETWORK', 'COMPANION_GATEWAY', 'FACTORY_URL'])
        assert.match(compose, new RegExp(`RSC_BRAIN_${v}: \\$\\{RSC_BRAIN_${v}:-\\}`))
      const up = r.calls.find((l) => /^compose /.test(l) && / up /.test(l)) ?? ''
      assert.match(up, new RegExp(`-f ${join(c.dir, 'compose.companion.yaml')}`))
      assert.doesNotMatch(up, /--profile (server|bundled)/)
      // The database is checked from the shared network (where rsc-factory's PostgreSQL is).
      const check = r.calls.find((l) => / rsc-brain db check /.test(l)) ?? ''
      assert.match(check, /--network rsc-shared/)
      // The one-time key never on a command line.
      assert.equal(r.calls.join('\n').includes(s.companionToken), false)
    })
  }

  it('server: no Caddy of its own; the service believes only rsc-factory’s proxy; the https address', async () => {
    const c = fresh()
    const r = launch(c, await server(c, '--trusted-proxy', '192.168.230.2', '--json'), {
      env: { FAKE_NETWORKS: NET },
    })
    assert.equal(r.code, 0, r.stderr)
    const s = JSON.parse(r.stdout)
    assert.deepEqual(
      [s.mode, s.url, s.internalUrl],
      ['server', 'https://brain.example.com', 'http://rsc-brain:8090'],
    )
    const env = readEnv(c.dir)
    assert.deepEqual(
      [env.RSC_BRAIN_TRUSTED_PROXIES, env.RSC_BRAIN_LOCAL_ONLY, env.RSC_BRAIN_SETUP_URL],
      ['192.168.230.2', '0', 'https://brain.example.com'],
    )
    const up = r.calls.find((l) => /^compose /.test(l) && / up /.test(l)) ?? ''
    assert.doesNotMatch(up, /--profile server/)
  })

  for (const [what, env, says] of [
    ['Docker Compose older than 2.33', { FAKE_COMPOSE_VERSION: 'v2.32.4' }, /Compose 2\.33/],
    ['Docker Engine older than 28', { FAKE_ENGINE_VERSION: '27.5.1' }, /Engine 28/],
  ] as const) {
    it(`${what}: exit 3 naming what it needs, nothing created`, async () => {
      const c = fresh()
      const r = launch(c, await companion(c), { env: { FAKE_NETWORKS: NET, ...env } })
      assert.equal(r.code, 3, r.stderr)
      assert.match(r.stderr, says)
      assert.equal(existsSync(c.dir), false)
    })
  }
  it('a server needs no newer Docker: no gw_priority there («this machine only» is off), any Compose v2', async () => {
    const c = fresh()
    const r = launch(c, await server(c, '--trusted-proxy', '192.168.230.2'), {
      env: { FAKE_NETWORKS: NET, FAKE_COMPOSE_VERSION: 'v2.20.3', FAKE_ENGINE_VERSION: '24.0.9' },
    })
    assert.equal(r.code, 0, r.stderr)
    assert.doesNotMatch(readFileSync(join(c.dir, 'compose.companion.yaml'), 'utf8'), /gw_priority/)
  })

  for (const [what, nets] of [
    ['an IPv6 subnet', 'rsc-shared=192.168.230.0/24|192.168.230.1,fd00:1::/64|fd00:1::1'],
    ['IPv6 turned on', 'rsc-shared=192.168.230.0/24|192.168.230.1,ipv6'],
  ] as const) {
    it(`a shared network with ${what}: exit 2 saying IPv4 only, nothing created`, async () => {
      const c = fresh()
      const r = launch(c, await companion(c), { env: { FAKE_NETWORKS: nets } })
      assert.equal(r.code, 2, r.stderr)
      assert.match(r.stderr, /IPv6/)
      assert.equal(existsSync(c.dir), false)
    })
  }

  it('Docker Compose 5 is newer than 2.33', async () => {
    const c = fresh()
    const r = launch(c, await companion(c), { env: { FAKE_NETWORKS: NET, FAKE_COMPOSE_VERSION: 'v5.0.1' } })
    assert.equal(r.code, 0, r.stderr)
  })

  it('the shared network does not exist: exit 3 naming it, nothing created', async () => {
    const c = fresh()
    const r = launch(c, await companion(c), { env: { FAKE_NETWORKS: '' } })
    assert.equal(r.code, 3, r.stderr)
    assert.match(r.stderr, /There is no Docker network rsc-shared/)
    assert.match(r.stderr, /Nothing was changed/)
    assert.equal(existsSync(c.dir), false)
  })

  for (const [what, ip] of [
    ['outside the shared network', '10.0.0.2'],
    ['its gateway', '192.168.230.1'],
  ] as const) {
    it(`a trusted proxy ${what}: exit 2, nothing created`, async () => {
      const c = fresh()
      const r = launch(c, await server(c, '--trusted-proxy', ip), { env: { FAKE_NETWORKS: NET } })
      assert.equal(r.code, 2, r.stderr)
      assert.match(r.stderr, /--trusted-proxy/)
      assert.equal(existsSync(c.dir), false)
    })
  }

  const bad: Array<[string, string[], RegExp]> = [
    [
      '--companion without the network',
      ['--companion', '--factory-url', 'http://localhost:3000'],
      /--attach-network/,
    ],
    [
      '--companion without the address of rsc-factory',
      ['--companion', '--attach-network', 'rsc-shared'],
      /--factory-url/,
    ],
    ['the network without --companion', ['--attach-network', 'rsc-shared'], /--companion/],
    [
      'the address of rsc-factory without --companion',
      ['--factory-url', 'http://localhost:3000'],
      /--companion/,
    ],
    [
      'a network name a shell would read',
      ['--companion', '--attach-network', 'a;b', '--factory-url', 'http://localhost:3000'],
      /--attach-network/,
    ],
    [
      'rsc-factory in clear on a server address',
      ['--companion', '--attach-network', 'n', '--factory-url', 'http://factory.example.com'],
      /--factory-url/,
    ],
    [
      'rsc-factory on [::1] (the service refuses it too)',
      ['--companion', '--attach-network', 'n', '--factory-url', 'http://[::1]:3000'],
      /--factory-url/,
    ],
    [
      'a port past 65535 in the address of rsc-factory',
      ['--companion', '--attach-network', 'n', '--factory-url', 'https://factory.example.com:65536'],
      /--factory-url/,
    ],
    [
      'an address of rsc-factory longer than 300 characters',
      [
        '--companion',
        '--attach-network',
        'n',
        '--factory-url',
        `https://factory.example.com/${'a'.repeat(290)}`,
      ],
      /--factory-url/,
    ],
    [
      'an address of rsc-factory with credentials',
      ['--companion', '--attach-network', 'n', '--factory-url', 'https://me@factory.example.com'],
      /--factory-url/,
    ],
    [
      'an address of rsc-factory with a quote',
      ['--companion', '--attach-network', 'n', '--factory-url', "https://factory.example.com/it's"],
      /--factory-url/,
    ],
    [
      'rsc-brain’s own PostgreSQL',
      ['--companion', '--attach-network', 'n', '--factory-url', 'http://localhost:3000', '--db', 'bundled'],
      /--db/,
    ],
    [
      'ports for a Caddy it does not run',
      [
        '--companion',
        '--attach-network',
        'n',
        '--factory-url',
        'http://localhost:3000',
        '--http-port',
        '8080',
      ],
      /--http-port/,
    ],
    [
      'a trusted proxy that is not an address',
      [
        '--companion',
        '--attach-network',
        'n',
        '--factory-url',
        'http://localhost:3000',
        '--trusted-proxy',
        'caddy',
      ],
      /--trusted-proxy/,
    ],
    [
      'a trusted proxy on this machine only',
      [
        '--companion',
        '--attach-network',
        'n',
        '--factory-url',
        'http://localhost:3000',
        '--trusted-proxy',
        '192.168.230.2',
      ],
      /--trusted-proxy/,
    ],
  ]
  for (const [what, args, says] of bad) {
    it(`${what}: exit 2, says which option, changes nothing`, async () => {
      const c = fresh()
      const r = launch(c, [...(await local(c)), ...args], { env: { FAKE_NETWORKS: NET } })
      assert.equal(r.code, 2, r.stderr)
      assert.match(r.stderr, says)
      assert.equal(existsSync(c.dir), false)
      assert.equal(r.calls.length, 0, r.calls.join('\n'))
    })
  }

  it('a server without the address of rsc-factory’s proxy: exit 2 naming --trusted-proxy', async () => {
    const c = fresh()
    const r = launch(c, await server(c), { env: { FAKE_NETWORKS: NET } })
    assert.equal(r.code, 2, r.stderr)
    assert.match(r.stderr, /--trusted-proxy/)
  })

  it('reinstalling keeps the one-time key and the shared network; --json gives the key again', async () => {
    const c = fresh()
    const first = launch(c, await companion(c, '--json'), { env: { FAKE_NETWORKS: NET } })
    assert.equal(first.code, 0, first.stderr)
    const before = readEnv(c.dir)
    const again = launch(c, ['install', '--yes', '--json', '--dir', c.dir], { env: { FAKE_NETWORKS: NET } })
    assert.equal(again.code, 0, again.stderr)
    const s = JSON.parse(again.stdout)
    assert.equal(s.companionToken, JSON.parse(first.stdout).companionToken)
    const after = readEnv(c.dir)
    for (const k of [
      'RSC_BRAIN_COMPANION_TOKEN',
      'RSC_BRAIN_SHARED_NETWORK',
      'RSC_BRAIN_COMPANION_NETWORK',
      'RSC_BRAIN_FACTORY_URL',
      'RSC_BRAIN_SECRET',
    ])
      assert.equal(after[k], before[k], k)
    const up = again.calls.find((l) => /^compose /.test(l) && / up /.test(l)) ?? ''
    assert.match(up, /compose\.companion\.yaml/)
  })

  it('an installation that is not in companion mode does not become one on a reinstall: exit 2, nothing changed', async () => {
    const c = fresh()
    assert.equal(launch(c, await local(c)).code, 0)
    const before = readFileSync(join(c.dir, '.env'), 'utf8')
    const r = launch(
      c,
      [
        'install',
        '--yes',
        '--dir',
        c.dir,
        '--companion',
        '--attach-network',
        'rsc-shared',
        '--factory-url',
        'http://localhost:3000',
      ],
      { env: { FAKE_NETWORKS: NET } },
    )
    assert.equal(r.code, 2, r.stderr)
    assert.match(r.stderr, /companion/)
    assert.equal(readFileSync(join(c.dir, '.env'), 'utf8'), before)
    assert.equal(existsSync(join(c.dir, 'compose.companion.yaml')), false)
  })

  it('values of companion mode exported in the shell never reach docker compose', async () => {
    const c = fresh()
    const r = launch(c, await companion(c), {
      env: {
        FAKE_NETWORKS: NET,
        RSC_BRAIN_SHARED_NETWORK: 'elsewhere',
        RSC_BRAIN_COMPANION_TOKEN: 'from-the-shell-0123456789abcdef0123',
        RSC_BRAIN_FACTORY_URL: 'https://evil.example.com',
      },
    })
    assert.equal(r.code, 0, r.stderr)
    assert.deepEqual(
      r.calls.filter((l) => l.startsWith('LEAK ')),
      [],
    )
  })

  it('uninstall --delete-data removes its compose file for the shared network too', async () => {
    const c = fresh()
    assert.equal(launch(c, await companion(c), { env: { FAKE_NETWORKS: NET } }).code, 0)
    const r = launch(c, ['uninstall', '--dir', c.dir, '--delete-data', '--confirm', 'rsc-brain', '--yes'], {
      env: { FAKE_NETWORKS: NET },
    })
    assert.equal(r.code, 0, r.stderr)
    assert.equal(existsSync(join(c.dir, 'compose.companion.yaml')), false)
  })
})
