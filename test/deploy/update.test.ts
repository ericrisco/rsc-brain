// The launcher's `update` (plan §3.9, T042; spec B7 «Actualizar», CA6, CA7) and `key rotate` (spec «la llave … se
// puede rotar», C10), with the fake `docker` of test/deploy/fake-docker.sh: no daemon, so it runs in CI. What this
// pins is the order of the steps and what a failure leaves: the new image is ready (built or checked) while the old
// one serves; maintenance goes on before the pre-update copy; the migration runs with the new image only after the old
// service stopped; maintenance comes off only once the new one answers as the version asked. A failure in the
// migration or the start restores the pre-update copy with the old image and --keep-keys, starts the old one, records
// the failure for the web and exits 4. The real containers are test/install/update.test.ts.
import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import {
  chmodSync,
  closeSync,
  copyFileSync,
  existsSync,
  ftruncateSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readdirSync,
  readFileSync,
  rmSync,
  statfsSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, describe, it } from 'node:test'

const ROOT = new URL('../..', import.meta.url).pathname
const LAUNCHER = join(ROOT, 'deploy', 'rsc-brain.sh')
const FAKE = join(ROOT, 'test', 'deploy', 'fake-docker.sh')
// The tools the launcher may use (the same list as launcher.test.ts): anything else is missing here.
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
  // A new session for what must not be stopped halfway by a Ctrl-C (without it, a job of its own).
  'setsid',
  // The fake docker's own (never the launcher's).
  'cksum',
  // Both: the launcher's way to a session of its own without setsid, and the fake docker's compose-like waits.
  'perl',
]
const VERSIONS = 'rsc-brain:test=0.1.0 rsc-brain:next=0.2.0 rsc-brain:broken=0.3.0 rsc-brain:old=0.0.9'
const PRE = 'rsc-brain-20261103T120000Z-pre-update.rscb'

let BASE = ''
let SYSBIN = ''
let FAKEBIN = ''
// The shell that runs the launcher: this system's sh, or another one to try the same tests with
// (RSC_BRAIN_TEST_SHELL=/usr/bin/dash node --test test/deploy/update.test.ts).
const shell = () => process.env.RSC_BRAIN_TEST_SHELL ?? join(SYSBIN, 'sh')
before(() => {
  BASE = mkdtempSync(join(tmpdir(), 'rscb-update-'))
  SYSBIN = join(BASE, 'sysbin')
  FAKEBIN = join(BASE, 'fakebin')
  mkdirSync(SYSBIN)
  mkdirSync(FAKEBIN)
  for (const t of TOOLS) {
    const r = spawnSync('/bin/sh', ['-c', `command -v ${t}`], { encoding: 'utf8' })
    const p = r.stdout.trim()
    if (r.status === 0 && p.startsWith('/')) symlinkSync(p, join(SYSBIN, t))
  }
  // Linux has setsid (util-linux, busybox); macOS does not: a stand-in that does what it does.
  if (!existsSync(join(SYSBIN, 'setsid'))) {
    writeFileSync(
      join(SYSBIN, 'setsid'),
      `#!/bin/sh\nexec perl -MPOSIX -e 'POSIX::setsid() or die "setsid: $!"; exec @ARGV or die' "$@"\n`,
    )
    chmodSync(join(SYSBIN, 'setsid'), 0o755)
  }
  copyFileSync(FAKE, join(FAKEBIN, 'docker'))
  chmodSync(join(FAKEBIN, 'docker'), 0o755)
})
after(() => rmSync(BASE, { recursive: true, force: true }))

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
  stdout: string
  stderr: string
  calls: string[]
  piped: string
  images: string[]
}
const tail = (file: string, from: number) => (existsSync(file) ? readFileSync(file, 'utf8').slice(from) : '')
const size = (file: string) => (existsSync(file) ? readFileSync(file, 'utf8').length : 0)
const environment = (c: Case, tty: string, env: Record<string, string> = {}) => ({
  PATH: `${FAKEBIN}:${SYSBIN}`,
  HOME: c.home,
  LANG: 'C',
  FAKE_LOG: c.log,
  FAKE_STDIN: c.stdin,
  FAKE_STATE: c.state,
  FAKE_IMAGE_VERSIONS: VERSIONS,
  RSC_BRAIN_TTY: tty,
  // The launcher waits up to 2 minutes for the service to answer; here, 2 seconds.
  RSC_BRAIN_TEST_WAIT: '2',
  ...env,
})
const launch = (c: Case, args: string[], o: { env?: Record<string, string>; answers?: string } = {}): Run => {
  const seen = size(c.log)
  const seenIn = size(c.stdin)
  const seenImages = size(join(c.state, 'images.log'))
  let tty = c.tty
  if (o.answers !== undefined) {
    tty = join(c.state, `answers-${++n}`)
    writeFileSync(tty, o.answers)
  }
  const r = spawnSync(shell(), [LAUNCHER, ...args], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 30_000,
    env: environment(c, tty, o.env),
  })
  assert.notEqual(r.signal, 'SIGTERM', `the launcher hung: ${r.stderr}`)
  return {
    code: r.status,
    stdout: r.stdout,
    stderr: r.stderr,
    calls: tail(c.log, seen).trim().split('\n').filter(Boolean),
    piped: tail(c.stdin, seenIn),
    images: tail(join(c.state, 'images.log'), seenImages).trim().split('\n').filter(Boolean),
  }
}
const freePort = () =>
  new Promise<number>((resolve) => {
    const s = createServer().listen(0, '127.0.0.1', () => {
      const p = (s.address() as { port: number }).port
      s.close(() => resolve(p))
    })
  })
const readEnv = (dir: string): Record<string, string> => {
  const out: Record<string, string> = {}
  for (const line of readFileSync(join(dir, '.env'), 'utf8').split('\n')) {
    const m = /^([A-Z_][A-Z0-9_]*)='(.*)'$/.exec(line)
    if (m) out[m[1] as string] = m[2] as string
  }
  return out
}
const installed = async (env: Record<string, string> = {}) => {
  const c = fresh()
  const port = String(await freePort())
  const r = launch(
    c,
    ['install', '--local', '--yes', '--dir', c.dir, '--port', port, '--image', 'rsc-brain:test'],
    { env },
  )
  assert.equal(r.code, 0, r.stderr)
  return c
}
// The index of the first call matching `re`, after `from`; -1 when none.
const at = (calls: string[], re: RegExp, from = 0) => {
  const i = calls.slice(from).findIndex((l) => re.test(l))
  return i < 0 ? -1 : i + from
}
const inOrder = (calls: string[], steps: RegExp[]) => {
  let i = 0
  for (const s of steps) {
    const j = at(calls, s, i)
    assert.ok(j >= 0, `missing, or out of order: ${s}\n${calls.join('\n')}`)
    i = j + 1
  }
}
const update = (c: Case, ...more: string[]) => ['update', '--yes', '--dir', c.dir, ...more]

describe('the launcher: update (CA6 with a fake docker)', () => {
  it('a good update, in order: new image ready, maintenance, pre-update copy, stop, migrate with the new image, start, answers as the new version, maintenance off, recorded', async () => {
    const c = await installed()
    const before = readEnv(c.dir)
    const r = launch(c, update(c, '--image', 'rsc-brain:next'))
    assert.equal(r.code, 0, r.stderr)
    inOrder(r.calls, [
      /^image inspect rsc-brain:next$/,
      /^run --rm rsc-brain:next rsc-brain version$/,
      / exec -T app rsc-brain maintenance on --reason update$/,
      / exec -T app rsc-brain backup --reason pre-update --json$/,
      / stop app$/,
      / run --rm -T --no-deps app rsc-brain migrate$/,
      / up -d/,
      / exec -T app wget .*\/v1\/health/,
      / exec -T app rsc-brain version$/,
      / exec -T app rsc-brain maintenance off$/,
      / exec -T app rsc-brain update record --ok --from 0\.1\.0 --to 0\.2\.0$/,
    ])
    // The migration and the start ran with the new image; the old one was never stopped before the copy.
    assert.deepEqual(r.images.slice(-2), ['run rsc-brain:next', 'up rsc-brain:next'])
    assert.equal(at(r.calls, / rsc-brain restore /), -1, 'nothing to roll back')
    const after = readEnv(c.dir)
    assert.equal(after.RSC_BRAIN_IMAGE, 'rsc-brain:next')
    assert.deepEqual(
      { ...after, RSC_BRAIN_IMAGE: '' },
      { ...before, RSC_BRAIN_IMAGE: '' },
      'only the image changes',
    )
    assert.equal(statSync(join(c.dir, '.env')).mode & 0o777, 0o600)
    assert.match(r.stdout, /updated from 0\.1\.0 to 0\.2\.0/)
    assert.ok(r.stdout.includes(PRE), 'names the copy made before')
    assert.equal(existsSync(join(c.dir, '.rsc-brain', 'lock')), false)
    // No key on a command line, ever.
    assert.equal(r.calls.join('\n').includes(before.RSC_BRAIN_SECRET as string), false)
  })

  it('--json prints only the summary: from, to, the image and the copy made before', async () => {
    const c = await installed()
    const r = launch(c, update(c, '--image', 'rsc-brain:next', '--json'))
    assert.equal(r.code, 0, r.stderr)
    const s = JSON.parse(r.stdout)
    assert.deepEqual(s, { from: '0.1.0', to: '0.2.0', image: 'rsc-brain:next', copy: PRE, dir: c.dir })
  })

  it('--version builds rsc-brain:<version> from its tag while the old one serves, then updates to it', async () => {
    const c = await installed()
    const gitBin = join(c.state, 'gitbin')
    mkdirSync(gitBin)
    writeFileSync(
      join(gitBin, 'git'),
      `#!/bin/sh\nprintf 'git %s\\n' "$*" >>"$FAKE_LOG"\nfor last; do :; done\nmkdir -p "$last/deploy"\ncp "${join(ROOT, 'deploy')}/compose.yaml" "${join(ROOT, 'deploy')}/Caddyfile" "$last/deploy/"\necho '# v0.2.0' >>"$last/deploy/compose.yaml"\n`,
    )
    chmodSync(join(gitBin, 'git'), 0o755)
    const r = launch(c, update(c, '--version', 'v0.2.0', '--repo', 'ssh://git@example.com/brain.git'), {
      env: {
        PATH: `${gitBin}:${FAKEBIN}:${SYSBIN}`,
        FAKE_IMAGES: 'rsc-brain:test',
        FAKE_IMAGE_VERSIONS: `${VERSIONS} rsc-brain:v0.2.0=0.2.0`,
      },
    })
    assert.equal(r.code, 0, r.stderr)
    inOrder(r.calls, [
      /^git clone --depth 1 --branch v0\.2\.0 ssh:\/\/git@example\.com\/brain\.git /,
      /^build -t rsc-brain:v0\.2\.0 /,
      / rsc-brain maintenance on --reason update$/,
    ])
    assert.equal(readEnv(c.dir).RSC_BRAIN_IMAGE, 'rsc-brain:v0.2.0')
    // The compose file of the new version is the installation's now.
    assert.match(readFileSync(join(c.dir, 'compose.yaml'), 'utf8'), /# v0\.2\.0\n$/)
  })

  it('an image that is not newer: exit 2, nothing done; the same image: nothing to update (exit 0)', async () => {
    const c = await installed()
    const before = readFileSync(join(c.dir, '.env'), 'utf8')
    const older = launch(c, update(c, '--image', 'rsc-brain:old'))
    assert.equal(older.code, 2, older.stderr)
    assert.match(older.stderr, /0\.0\.9.*not newer than 0\.1\.0/)
    const same = launch(c, update(c, '--image', 'rsc-brain:test'))
    assert.equal(same.code, 0, same.stderr)
    assert.match(same.stdout + same.stderr, /Nothing to update/)
    for (const r of [older, same]) assert.equal(at(r.calls, / maintenance | stop | migrate/), -1)
    assert.equal(readFileSync(join(c.dir, '.env'), 'utf8'), before)
  })

  it('an image that is not on this machine: exit 3, nothing done', async () => {
    const c = await installed()
    const r = launch(c, update(c, '--image', 'rsc-brain:nowhere'), { env: { FAKE_IMAGES: 'rsc-brain:test' } })
    assert.equal(r.code, 3, r.stderr)
    assert.equal(at(r.calls, / maintenance /), -1)
  })

  it('too little disk for twice the last copy and 1 GB: exit 3 saying how much, nothing done', async () => {
    const c = await installed()
    // A copy half the size of the free space (sparse: it takes no room), so twice it and 1 GB never fit. Sized from
    // this disk: some file systems refuse a sparse file far larger than the disk.
    const fs = statfsSync(c.dir)
    const fd = openSync(join(c.dir, 'backups', 'rsc-brain-20261102T030000Z-scheduled.rscb'), 'w')
    ftruncateSync(fd, Math.ceil((fs.bavail * fs.bsize) / 2))
    closeSync(fd)
    const r = launch(c, update(c, '--image', 'rsc-brain:next'))
    assert.equal(r.code, 3, r.stderr)
    assert.match(r.stderr, /twice the last copy/)
    assert.equal(at(r.calls, / maintenance /), -1)
  })

  it('no terminal and no --yes: exit 2, nothing done; asked and answered no: exit 1, nothing done', async () => {
    const c = await installed()
    const none = launch(c, ['update', '--dir', c.dir, '--image', 'rsc-brain:next'])
    assert.equal(none.code, 2, none.stderr)
    assert.match(none.stderr, /--yes/)
    const no = launch(c, ['update', '--dir', c.dir, '--image', 'rsc-brain:next'], { answers: 'n\n' })
    assert.equal(no.code, 1, no.stderr)
    for (const r of [none, no]) assert.equal(at(r.calls, / maintenance /), -1)
    assert.equal(readEnv(c.dir).RSC_BRAIN_IMAGE, 'rsc-brain:test')
  })

  it('the pre-update copy fails: maintenance off again, nothing else done, exit 1', async () => {
    const c = await installed()
    const r = launch(c, update(c, '--image', 'rsc-brain:next'), { env: { FAKE_BACKUP_EXIT: '1' } })
    assert.equal(r.code, 1, r.stderr)
    inOrder(r.calls, [/ maintenance on /, / backup --reason pre-update/, / maintenance off$/])
    assert.equal(at(r.calls, / stop app| migrate/), -1)
    assert.match(r.stderr, /Nothing was changed/)
    assert.equal(readEnv(c.dir).RSC_BRAIN_IMAGE, 'rsc-brain:test')
  })

  it('maintenance cannot go on: nothing done, exit 1', async () => {
    const c = await installed()
    const r = launch(c, update(c, '--image', 'rsc-brain:next'), { env: { FAKE_MAINTENANCE_EXIT: '1' } })
    assert.equal(r.code, 1, r.stderr)
    assert.equal(at(r.calls, / backup | stop app| migrate/), -1)
  })

  it('not running: exit 1 saying to start it, nothing done', async () => {
    const c = await installed()
    rmSync(join(c.state, 'up'))
    const r = launch(c, update(c, '--image', 'rsc-brain:next'))
    assert.equal(r.code, 1, r.stderr)
    assert.match(r.stderr, /not running/)
    assert.equal(at(r.calls, / maintenance /), -1)
  })
})

describe('the launcher: an update that fails goes back (CA7 with a fake docker)', () => {
  const rolledBack = (c: Case, r: Run, before: string, to: string) => {
    assert.equal(r.code, 4, r.stderr)
    // Back: the old settings, the pre-update copy restored with the old image and its keys kept, the old one started.
    const i = at(r.calls, / rsc-brain restore /)
    assert.ok(i > 0, r.calls.join('\n'))
    assert.match(
      r.calls[i] as string,
      new RegExp(` run --rm -T --no-deps app rsc-brain restore --file /backups/${PRE} --keep-keys$`),
    )
    inOrder(r.calls.slice(i), [
      / up -d/,
      / exec -T app wget .*\/v1\/health/,
      / exec -T app rsc-brain maintenance off$/,
      new RegExp(
        ` exec -T app rsc-brain update record --failed --from 0\\.1\\.0 --to ${to.replaceAll('.', '\\.')}$`,
      ),
    ])
    const restoreRun = r.images.findLastIndex((l) => l.startsWith('run '))
    assert.equal(r.images[restoreRun], 'run rsc-brain:test', 'the restore ran with the old image')
    assert.equal(r.images.at(-1), 'up rsc-brain:test', 'the old one started')
    assert.equal(readFileSync(join(c.dir, '.env'), 'utf8'), before, 'the settings are as they were')
    // The failure, for the web: the service's last lines, without the key.
    const key = readEnv(c.dir).RSC_BRAIN_SECRET as string
    assert.match(r.piped, /<<< update record\n/)
    assert.equal(r.piped.includes(key), false)
    assert.match(r.stderr, /went back to 0\.1\.0/)
    assert.match(r.stderr, /sessions and keys still work/i)
    assert.equal(existsSync(join(c.dir, '.rsc-brain', 'lock')), false)
  }

  it('a migration that fails: restore the copy, start the old one, record it, exit 4', async () => {
    const c = await installed()
    const before = readFileSync(join(c.dir, '.env'), 'utf8')
    const r = launch(c, update(c, '--image', 'rsc-brain:broken'), {
      env: { FAKE_MIGRATE_FAIL: 'rsc-brain:broken' },
    })
    rolledBack(c, r, before, '0.3.0')
    // It never started the new one.
    assert.equal(r.images.includes('up rsc-brain:broken'), false)
    assert.match(r.stderr, /The migration of 0\.3\.0 failed/)
  })

  it('the new one does not answer: the same way back, exit 4', async () => {
    const c = await installed()
    const before = readFileSync(join(c.dir, '.env'), 'utf8')
    const r = launch(c, update(c, '--image', 'rsc-brain:next'), {
      env: { FAKE_HEALTH_FAIL: 'rsc-brain:next' },
    })
    rolledBack(c, r, before, '0.2.0')
    assert.ok(r.images.includes('up rsc-brain:next'))
  })

  it('the new one answers as another version: the same way back, exit 4', async () => {
    const c = await installed()
    const before = readFileSync(join(c.dir, '.env'), 'utf8')
    // The image says 0.2.0 before it starts, and 0.1.5 once started (a wrong tag): it is not what was asked.
    const r = launch(c, update(c, '--image', 'rsc-brain:next'), {
      env: { FAKE_UP_VERSION: 'rsc-brain:next=0.1.5' },
    })
    rolledBack(c, r, before, '0.2.0')
  })

  it('a rollback that cannot restore: says what to do by hand, exit 1 (not 4)', async () => {
    const c = await installed()
    const r = launch(c, update(c, '--image', 'rsc-brain:broken'), {
      env: { FAKE_MIGRATE_FAIL: 'rsc-brain:broken', FAKE_RESTORE_EXIT: '1' },
    })
    assert.equal(r.code, 1, r.stderr)
    assert.match(r.stderr, new RegExp(`restore --file ${PRE}`))
  })
})

describe('the launcher: key rotate (spec C10)', () => {
  const env = { FAKE_KEY_ID_BY_KEY: '1' }
  it('stops, reseals with the new key on the standard input, keeps the old one in a file of its own, starts again', async () => {
    const c = await installed(env)
    const old = readEnv(c.dir).RSC_BRAIN_SECRET as string
    const r = launch(c, ['key', 'rotate', '--yes', '--json', '--dir', c.dir], { env })
    assert.equal(r.code, 0, r.stderr)
    const s = JSON.parse(r.stdout)
    const now = readEnv(c.dir).RSC_BRAIN_SECRET as string
    assert.notEqual(now, old)
    assert.ok(now.length >= 64)
    assert.equal(s.installationKey, now)
    assert.match(s.keyId, /^id\d+$/)
    assert.match(s.previousKeyId, /^id\d+$/)
    assert.notEqual(s.keyId, s.previousKeyId)
    assert.equal(s.previousKeyFile, join(c.dir, `installation-key-${s.previousKeyId}.txt`))
    assert.equal(readFileSync(s.previousKeyFile, 'utf8'), `${old}\n`)
    assert.equal(statSync(s.previousKeyFile).mode & 0o777, 0o600)
    assert.equal(statSync(join(c.dir, '.env')).mode & 0o777, 0o600)
    inOrder(r.calls, [
      / stop app$/,
      / run --rm -T --no-deps app rsc-brain key reseal$/,
      / up -d/,
      /wget .*\/v1\/health/,
    ])
    // The new key reached the reseal on its standard input, with the old one in its environment (.env); no key on a
    // command line.
    assert.match(r.piped, new RegExp(`<<< key reseal\\n${now}\\n`))
    assert.equal(r.calls.join('\n').includes(now) || r.calls.join('\n').includes(old), false)
    assert.match(r.stderr, /Copies made before need the previous key/)
  })

  it('without --json, the new key is printed only to a terminal; it says where it is and that old copies need the old key', async () => {
    const c = await installed(env)
    const r = launch(c, ['key', 'rotate', '--yes', '--dir', c.dir], { env })
    assert.equal(r.code, 0, r.stderr)
    const now = readEnv(c.dir).RSC_BRAIN_SECRET as string
    assert.equal((r.stdout + r.stderr).includes(now), false)
    assert.match(r.stdout, /key show/)
    assert.match(r.stdout + r.stderr, /installation-key-id\d+\.txt/)
  })

  it('a reseal that fails: the key is not changed, the service starts again, exit 1', async () => {
    const c = await installed(env)
    const before = readFileSync(join(c.dir, '.env'), 'utf8')
    const r = launch(c, ['key', 'rotate', '--yes', '--dir', c.dir], {
      env: { ...env, FAKE_RESEAL_EXIT: '1' },
    })
    assert.equal(r.code, 1, r.stderr)
    assert.equal(readFileSync(join(c.dir, '.env'), 'utf8'), before)
    const i = at(r.calls, / key reseal$/)
    assert.ok(at(r.calls, / up -d/, i) > i, 'started again')
    assert.match(r.stderr, /The key was not changed/)
  })

  it('no terminal and no --yes: exit 2; asked and answered no: exit 1; nothing stops either way', async () => {
    const c = await installed(env)
    const none = launch(c, ['key', 'rotate', '--dir', c.dir], { env })
    assert.equal(none.code, 2)
    const no = launch(c, ['key', 'rotate', '--dir', c.dir], { env, answers: 'n\n' })
    assert.equal(no.code, 1)
    for (const r of [none, no]) assert.equal(at(r.calls, / stop | reseal/), -1)
  })

  it('the saved old key does not keep a later install out of the folder (after uninstall --delete-data)', async () => {
    const c = await installed(env)
    const rotated = launch(c, ['key', 'rotate', '--yes', '--dir', c.dir], { env })
    assert.equal(rotated.code, 0, rotated.stderr)
    assert.equal(
      launch(c, ['uninstall', '--delete-data', '--confirm', 'rsc-brain', '--dir', c.dir], { env }).code,
      0,
    )
    const port = String(await freePort())
    const again = launch(
      c,
      ['install', '--local', '--yes', '--dir', c.dir, '--port', port, '--image', 'rsc-brain:test'],
      { env },
    )
    assert.equal(again.code, 0, again.stderr)
  })
})

// Review of PR #36: what an interrupted update or key rotation leaves, and what the next launcher command does with it.
// Ctrl-C at a terminal reaches the whole foreground process group (the launcher, docker, what docker runs): the
// launcher is started in a group of its own, and each signal goes to that group once the fake says a step started.
type Stop = { marker: string; signal: NodeJS.Signals }
const launchStopped = (c: Case, args: string[], env: Record<string, string>, stops: Stop[]) =>
  new Promise<{
    code: number | null
    signal: NodeJS.Signals | null
    stdout: string
    stderr: string
    calls: string[]
  }>((resolve) => {
    const seen = size(c.log)
    const p = spawn(shell(), [LAUNCHER, ...args], {
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: true,
      env: environment(c, c.tty, env),
    })
    let stdout = ''
    let stderr = ''
    p.stdout.on('data', (d) => {
      stdout += d
    })
    p.stderr.on('data', (d) => {
      stderr += d
    })
    const pending = [...stops]
    const poll = setInterval(() => {
      const next = pending[0]
      if (next && existsSync(join(c.state, next.marker))) {
        pending.shift()
        rmSync(join(c.state, next.marker))
        try {
          process.kill(-(p.pid as number), next.signal)
        } catch {}
      }
    }, 50)
    const guard = setTimeout(() => {
      try {
        process.kill(-(p.pid as number), 'SIGKILL')
      } catch {}
    }, 30_000)
    p.on('close', (code, signal) => {
      clearInterval(poll)
      clearTimeout(guard)
      resolve({ code, signal, stdout, stderr, calls: tail(c.log, seen).trim().split('\n').filter(Boolean) })
    })
  })
const exists = (c: Case, f: string) => existsSync(join(c.dir, '.rsc-brain', f))

describe('the launcher: Ctrl-C during an update (review of PR #36)', () => {
  it('during the migration: the way back is printed on the terminal, not lost in the migration log', async () => {
    const c = await installed()
    const before = readFileSync(join(c.dir, '.env'), 'utf8')
    const r = await launchStopped(c, update(c, '--image', 'rsc-brain:next'), { FAKE_MIGRATE_SLEEP: '2' }, [
      { marker: 'migrate-started', signal: 'SIGINT' },
    ])
    assert.equal(r.code, 4, r.stderr)
    assert.match(r.stderr, /Interrupted: going back/)
    assert.match(r.stderr, /went back to 0\.1\.0/)
    assert.match(r.stderr, /Restoring the copy made before the update/)
    assert.equal(readFileSync(join(c.dir, '.env'), 'utf8'), before)
  })

  it('during the health check of the new version: the same, on the terminal', async () => {
    const c = await installed()
    const r = await launchStopped(
      c,
      update(c, '--image', 'rsc-brain:next'),
      { FAKE_HEALTH_SLEEP: 'rsc-brain:next=2' },
      [{ marker: 'health-started', signal: 'SIGINT' }],
    )
    assert.equal(r.code, 4, r.stderr)
    assert.match(r.stderr, /Interrupted: going back/)
    assert.match(r.stderr, /went back to 0\.1\.0/)
  })

  it('during the health check of a first install: what it takes back is printed on the terminal', async () => {
    const c = fresh()
    const port = String(await freePort())
    const r = await launchStopped(
      c,
      ['install', '--local', '--yes', '--dir', c.dir, '--port', port, '--image', 'rsc-brain:test'],
      { FAKE_HEALTH_SLEEP: 'rsc-brain:test=2' },
      [{ marker: 'health-started', signal: 'SIGINT' }],
    )
    assert.equal(r.code, 4, r.stderr)
    assert.match(r.stderr, /Interrupted: taking back what this run made/)
    assert.match(r.stderr, /Removing the containers/)
  })

  it('a second Ctrl-C while it goes back does not stop the restore halfway', async () => {
    const c = await installed()
    const before = readFileSync(join(c.dir, '.env'), 'utf8')
    const r = await launchStopped(
      c,
      update(c, '--image', 'rsc-brain:broken'),
      { FAKE_MIGRATE_FAIL: 'rsc-brain:broken', FAKE_RESTORE_SLEEP: '2' },
      [{ marker: 'restore-started', signal: 'SIGINT' }],
    )
    assert.equal(r.signal, null, `killed by ${r.signal}: ${r.stderr}`)
    assert.equal(r.code, 4, r.stderr)
    assert.match(r.stderr, /went back to 0\.1\.0/)
    assert.equal(readFileSync(join(c.dir, '.env'), 'utf8'), before)
  })
})

describe('the launcher: an update killed after the switch is taken back by the next command (review of PR #36)', () => {
  // Killed outright (a power cut) while the new version migrates, or while it is asked whether it answers.
  const killedAfterSwitch = async (during: 'migrate' | 'health') => {
    const c = await installed()
    const before = readFileSync(join(c.dir, '.env'), 'utf8')
    const env: Record<string, string> =
      during === 'migrate' ? { FAKE_MIGRATE_SLEEP: '5' } : { FAKE_HEALTH_SLEEP: 'rsc-brain:next=5' }
    const r = await launchStopped(c, update(c, '--image', 'rsc-brain:next'), env, [
      { marker: `${during}-started`, signal: 'SIGKILL' },
    ])
    assert.equal(r.signal, 'SIGKILL', r.stderr)
    assert.equal(readEnv(c.dir).RSC_BRAIN_IMAGE, 'rsc-brain:next', 'killed after the switch')
    return { c, before }
  }
  const tookBack = (c: Case, r: Run, before: string) => {
    assert.equal(r.code, 4, r.stderr)
    assert.match(r.stderr, /update to 0\.2\.0 was interrupted/)
    assert.match(r.stderr, /went back to 0\.1\.0/)
    const i = at(r.calls, / rsc-brain restore /)
    assert.ok(i >= 0, r.calls.join('\n'))
    assert.match(r.calls[i] as string, new RegExp(`restore --file /backups/${PRE} --keep-keys$`))
    assert.equal(r.images.at(-1), 'up rsc-brain:test', 'the old one started')
    assert.equal(readFileSync(join(c.dir, '.env'), 'utf8'), before, 'the settings are as they were')
    assert.equal(exists(c, 'update.pending'), false)
    assert.equal(exists(c, 'env.previous'), false)
  }

  it('install: goes back (never copies the new settings over the way back)', async () => {
    const { c, before } = await killedAfterSwitch('migrate')
    const r = launch(c, ['install', '--yes', '--dir', c.dir])
    tookBack(c, r, before)
  })

  it('update: goes back instead of saying to start it with install', async () => {
    const { c, before } = await killedAfterSwitch('migrate')
    const r = launch(c, update(c, '--image', 'rsc-brain:next'))
    tookBack(c, r, before)
  })

  it('status: goes back, then a second status finds the old version running', async () => {
    const { c, before } = await killedAfterSwitch('health')
    const r = launch(c, ['status', '--dir', c.dir])
    tookBack(c, r, before)
    const again = launch(c, ['status', '--json', '--dir', c.dir])
    assert.equal(again.code, 0, again.stderr)
    assert.equal(JSON.parse(again.stdout).version, '0.1.0')
  })

  it('status leaves alone an update another launcher is running right now', async () => {
    const { c } = await killedAfterSwitch('migrate')
    // A live launcher on this machine holds the lock (this test's own process stands in for it).
    const host = spawnSync('uname', ['-n'], { encoding: 'utf8' }).stdout.trim()
    mkdirSync(join(c.dir, '.rsc-brain', 'lock'), { recursive: true })
    writeFileSync(join(c.dir, '.rsc-brain', 'lock', 'owner'), `${process.pid} ${host}\n`)
    const r = launch(c, ['status', '--dir', c.dir])
    assert.doesNotMatch(r.stderr, /Another rsc-brain launcher/)
    assert.equal(at(r.calls, / rsc-brain restore /), -1, 'nothing taken back')
    assert.ok(exists(c, 'update.pending'))
    assert.match(r.stdout, /rsc-brain in /)
  })

  it('a good update leaves no journal behind', async () => {
    const c = await installed()
    const r = launch(c, update(c, '--image', 'rsc-brain:next'))
    assert.equal(r.code, 0, r.stderr)
    assert.equal(exists(c, 'update.pending'), false)
  })
})

describe('the launcher: what a rollback says when it does not finish (review of PR #36)', () => {
  it('the copy is back but the old version does not start: says the data is back and how to start it', async () => {
    const c = await installed()
    const r = launch(c, update(c, '--image', 'rsc-brain:broken'), {
      env: { FAKE_MIGRATE_FAIL: 'rsc-brain:broken', FAKE_UP_EXIT: '1' },
    })
    assert.equal(r.code, 1, r.stderr)
    assert.doesNotMatch(r.stderr, /Restore it by hand/)
    assert.match(r.stderr, /data is back as it was just before the update/)
    assert.match(r.stderr, new RegExp(`install --dir "${c.dir}"`))
  })

  it('the copy could not be restored: update.log is kept', async () => {
    const c = await installed()
    const r = launch(c, update(c, '--image', 'rsc-brain:broken'), {
      env: { FAKE_MIGRATE_FAIL: 'rsc-brain:broken', FAKE_RESTORE_EXIT: '1' },
    })
    assert.equal(r.code, 1, r.stderr)
    assert.ok(exists(c, 'update.log'), 'the log of what failed stays')
    assert.match(
      readFileSync(join(c.dir, '.rsc-brain', 'update.log'), 'utf8'),
      /Migration 0024_broken\.sql failed/,
    )
  })
})

describe('the launcher: release candidates are ordered as semver says (review of PR #36)', () => {
  const pairs: Array<[string, string, boolean]> = [
    ['0.2.0-rc.1', '0.2.0-rc.2', true],
    ['0.2.0-rc.2', '0.2.0-rc.10', true],
    ['0.2.0-rc.2', '0.2.0-rc.1', false],
    ['0.2.0-alpha', '0.2.0-beta', true],
    ['0.2.0-alpha.1', '0.2.0-alpha', false],
    ['0.2.0-alpha', '0.2.0-alpha.1', true],
    ['0.2.0-rc.1', '0.2.0', true],
    ['0.2.0', '0.2.0-rc.3', false],
    ['0.2.0-1', '0.2.0-a', true],
    ['0.2.0-a', '0.2.0-1', false],
  ]
  for (const [from, to, ok] of pairs) {
    it(`${from} to ${to}: ${ok ? 'updates' : 'refused (exit 2)'}`, async () => {
      const versions = `rsc-brain:test=${from} rsc-brain:next=${to}`
      const c = await installed({ FAKE_IMAGE_VERSIONS: versions })
      const r = launch(c, update(c, '--image', 'rsc-brain:next'), { env: { FAKE_IMAGE_VERSIONS: versions } })
      assert.equal(r.code, ok ? 0 : 2, r.stderr)
      if (!ok) assert.match(r.stderr, /not newer than/)
    })
  }
})

describe('the launcher: a key rotation that was interrupted (review of PR #36)', () => {
  const env = { FAKE_KEY_ID_BY_KEY: '1' }
  const sealed = (c: Case) => readFileSync(join(c.state, 'sealed'), 'utf8').trim()
  const rotatedKey = (c: Case) =>
    /^RSC_BRAIN_SECRET='(.*)'$/m.exec(
      readFileSync(join(c.dir, '.rsc-brain', 'env.rotated'), 'utf8'),
    )?.[1] as string
  // Killed outright while it stops the service (before the reseal), or once the reseal has written.
  const killedRotating = (c: Case, marker: 'stop-started' | 'reseal-committed') =>
    launchStopped(
      c,
      ['key', 'rotate', '--yes', '--dir', c.dir],
      { ...env, ...(marker === 'stop-started' ? { FAKE_STOP_SLEEP: '5' } : { FAKE_RESEAL_SLEEP: '5' }) },
      [{ marker, signal: 'SIGKILL' }],
    )

  it('killed after the reseal: the next key rotate finishes it with the key the data is sealed with', async () => {
    const c = await installed(env)
    const killed = await killedRotating(c, 'reseal-committed')
    assert.equal(killed.signal, 'SIGKILL', killed.stderr)
    const pending = rotatedKey(c)
    assert.equal(sealed(c), pending, 'the data is sealed with the new key')
    const r = launch(c, ['key', 'rotate', '--yes', '--json', '--dir', c.dir], { env })
    assert.equal(r.code, 0, r.stderr)
    assert.match(r.stderr, /interrupted/)
    assert.equal(readEnv(c.dir).RSC_BRAIN_SECRET, pending, '.env holds the key the data is sealed with')
    assert.equal(sealed(c), pending)
    assert.equal(JSON.parse(r.stdout).installationKey, pending)
    assert.equal(exists(c, 'env.rotated'), false)
  })

  it('killed before the reseal: the next key rotate finishes it too', async () => {
    const c = await installed(env)
    const killed = await killedRotating(c, 'stop-started')
    assert.equal(killed.signal, 'SIGKILL', killed.stderr)
    const pending = rotatedKey(c)
    const r = launch(c, ['key', 'rotate', '--yes', '--dir', c.dir], { env })
    assert.equal(r.code, 0, r.stderr)
    assert.equal(readEnv(c.dir).RSC_BRAIN_SECRET, pending)
    assert.equal(sealed(c), pending)
  })

  it('a reseal that reports a failure after it wrote: the key that seals the data is never deleted', async () => {
    const c = await installed(env)
    const r = launch(c, ['key', 'rotate', '--yes', '--dir', c.dir], {
      env: { ...env, FAKE_RESEAL_FAIL_AFTER_COMMIT: '1' },
    })
    assert.equal(r.code, 1, r.stderr)
    const kept = [readEnv(c.dir).RSC_BRAIN_SECRET]
    if (exists(c, 'env.rotated')) kept.push(rotatedKey(c))
    assert.ok(kept.includes(sealed(c)), 'the key the data is sealed with is still on disk')
    assert.equal(sealed(c), readEnv(c.dir).RSC_BRAIN_SECRET, 'and it is the one in .env')
  })

  it('with a rotation left halfway, install, update, backup and restore refuse and say how to finish it; status warns', async () => {
    const c = await installed(env)
    writeFileSync(join(c.dir, 'backups', 'rsc-brain-20261101T030000Z-manual.rscb'), 'a copy')
    const killed = await killedRotating(c, 'reseal-committed')
    assert.equal(killed.signal, 'SIGKILL', killed.stderr)
    const before = readFileSync(join(c.dir, '.env'), 'utf8')
    for (const args of [
      ['install', '--yes', '--dir', c.dir],
      update(c, '--image', 'rsc-brain:next'),
      ['backup', '--dir', c.dir],
      [
        'restore',
        '--file',
        'rsc-brain-20261101T030000Z-manual.rscb',
        '--confirm',
        'rsc-brain',
        '--dir',
        c.dir,
      ],
    ]) {
      const r = launch(c, args, { env })
      assert.equal(r.code, 1, `${args[0]}: ${r.stderr}`)
      assert.match(r.stderr, /key rotation .*was interrupted/, args[0])
      assert.match(r.stderr, /key rotate --dir/, args[0])
      assert.equal(at(r.calls, / maintenance | stop app| migrate| restore | backup /), -1, args[0])
    }
    assert.equal(readFileSync(join(c.dir, '.env'), 'utf8'), before)
    assert.ok(exists(c, 'env.rotated'))
    const s = launch(c, ['status', '--dir', c.dir], { env })
    assert.match(s.stderr, /key rotation .*was interrupted/)
  })
})

describe('the launcher: no secret on a command line (review of PR #36)', () => {
  // Every program the launcher runs is wrapped: its arguments are written down, then the real one runs. A secret in
  // an argument is readable by anyone on the machine (ps); the key and the passwords go through files, the standard
  // input or the environment only.
  let SPYBIN = ''
  before(() => {
    SPYBIN = join(BASE, 'spybin')
    mkdirSync(SPYBIN)
    const sh = spawnSync('/bin/sh', ['-c', 'command -v sh'], { encoding: 'utf8' }).stdout.trim()
    for (const t of TOOLS) {
      if (t === 'sh' || !existsSync(join(SYSBIN, t))) continue
      writeFileSync(
        join(SPYBIN, t),
        `#!${sh}\nprintf '%s %s\\n' ${t} "$*" >>"$SPY_LOG"\nexec ${join(SYSBIN, t)} "$@"\n`,
      )
      chmodSync(join(SPYBIN, t), 0o755)
    }
  })
  const spied = (c: Case, env: Record<string, string> = {}) => ({
    ...env,
    PATH: `${FAKEBIN}:${SPYBIN}:${join(SYSBIN, 'only-sh')}`,
    SPY_LOG: join(c.state, 'spy.log'),
  })
  // Long hex runs are what the launcher's keys and passwords look like.
  const noSecrets = (c: Case, secrets: string[]) => {
    const log = readFileSync(join(c.state, 'spy.log'), 'utf8')
    for (const s of secrets) assert.equal(log.includes(s), false, 'a secret was on a command line')
    assert.doesNotMatch(log, /[0-9a-f]{40,}/, 'something like a key was on a command line')
  }
  before(() => {
    mkdirSync(join(SYSBIN, 'only-sh'))
    symlinkSync(join(SYSBIN, 'sh'), join(SYSBIN, 'only-sh', 'sh'))
  })

  it('a first install that fails keeps the service log without the key, and never names it to sed', async () => {
    const c = fresh()
    mkdirSync(c.dir)
    const key = 'f'.repeat(24) + '0123456789abcdef'.repeat(4)
    writeFileSync(join(c.dir, 'installation-key.txt'), `${key}\n`)
    const port = String(await freePort())
    const r = launch(
      c,
      ['install', '--local', '--yes', '--dir', c.dir, '--port', port, '--image', 'rsc-brain:test'],
      { env: spied(c, { FAKE_HEALTH_EXIT: '1' }) },
    )
    assert.equal(r.code, 4, r.stderr)
    const log = readFileSync(join(c.dir, 'last-failure.log'), 'utf8')
    assert.match(log, /\[redacted\]/)
    assert.equal(log.includes(key), false)
    noSecrets(c, [key])
  })

  it('an update that fails keeps the log without the key or the password, and never names them to sed', async () => {
    const c = await installed()
    const e = readEnv(c.dir)
    const r = launch(c, update(c, '--image', 'rsc-brain:broken'), {
      env: spied(c, { FAKE_MIGRATE_FAIL: 'rsc-brain:broken' }),
    })
    assert.equal(r.code, 4, r.stderr)
    const log = readFileSync(join(c.dir, 'last-failure.log'), 'utf8')
    assert.match(log, /\[redacted\]/)
    assert.equal(log.includes(e.RSC_BRAIN_SECRET as string), false)
    noSecrets(c, [e.RSC_BRAIN_SECRET as string, e.POSTGRES_PASSWORD as string])
  })

  it('key rotate writes the new key into .env without naming it to sed', async () => {
    const c = await installed({ FAKE_KEY_ID_BY_KEY: '1' })
    const old = readEnv(c.dir)
    const r = launch(c, ['key', 'rotate', '--yes', '--dir', c.dir], {
      env: spied(c, { FAKE_KEY_ID_BY_KEY: '1' }),
    })
    assert.equal(r.code, 0, r.stderr)
    const now = readEnv(c.dir)
    assert.notEqual(now.RSC_BRAIN_SECRET, old.RSC_BRAIN_SECRET)
    assert.deepEqual(
      { ...now, RSC_BRAIN_SECRET: '' },
      { ...old, RSC_BRAIN_SECRET: '' },
      'only the key changed',
    )
    noSecrets(c, [old.RSC_BRAIN_SECRET as string, now.RSC_BRAIN_SECRET as string])
  })
})

describe('the launcher: second review of PR #36', () => {
  // N1: the error stream and the standard output it started with are kept (4 and 5); one of them closed is no reason
  // to stop before a word is said (dash stops a script whose `exec` cannot redirect).
  for (const fd of [1, 2]) {
    it(`runs with its ${fd === 1 ? 'standard output' : 'error stream'} closed`, () => {
      const c = fresh()
      const r = spawnSync(
        '/bin/sh',
        ['-c', `exec ${fd}>&-; exec "$0" "$@"`, shell(), LAUNCHER, 'status', '--dir', c.dir],
        {
          encoding: 'utf8',
          stdio: ['ignore', 'pipe', 'pipe'],
          timeout: 30_000,
          env: environment(c, c.tty),
        },
      )
      assert.equal(r.status, 3, r.stderr)
      if (fd === 1) assert.match(r.stderr, /No rsc-brain installation in/)
    })
  }

  // N2: a Ctrl-C right after the journal is written, before anything was switched.
  it('a Ctrl-C between the journal and the switch leaves no journal: the next command takes nothing back', async () => {
    const c = await installed()
    const before = readFileSync(join(c.dir, '.env'), 'utf8')
    const r = launch(c, update(c, '--image', 'rsc-brain:next'), {
      env: { RSC_BRAIN_TEST_STOP_AT: 'update-journal', RSC_BRAIN_TEST_STOP_SIGNAL: 'INT' },
    })
    assert.equal(r.code, 1, r.stderr)
    assert.match(r.stderr, /Interrupted\.[\s\S]*Nothing was changed/)
    assert.equal(exists(c, 'update.pending'), false, 'no journal left behind')
    assert.equal(readFileSync(join(c.dir, '.env'), 'utf8'), before)
    const s = launch(c, ['status', '--dir', c.dir])
    assert.equal(s.code, 0, s.stderr)
    assert.equal(at(s.calls, / rsc-brain restore /), -1, 'nothing taken back')
  })

  // N3: with a rotation left halfway, the key in .env may not be the one the data is sealed with.
  it('key show refuses while a key rotation is left halfway, and says to finish it with key rotate', async () => {
    const env = { FAKE_KEY_ID_BY_KEY: '1' }
    const c = await installed(env)
    const killed = await launchStopped(
      c,
      ['key', 'rotate', '--yes', '--dir', c.dir],
      { ...env, FAKE_RESEAL_SLEEP: '5' },
      [{ marker: 'reseal-committed', signal: 'SIGKILL' }],
    )
    assert.equal(killed.signal, 'SIGKILL', killed.stderr)
    const r = launch(c, ['key', 'show', '--yes', '--dir', c.dir], { env })
    assert.equal(r.code, 1, r.stderr)
    assert.equal(r.stdout, '', 'no key printed')
    assert.match(r.stderr, /key rotation .*was interrupted/)
    assert.match(r.stderr, /key rotate --dir/)
  })

  // Q2: a rollback whose restore failed leaves a mark every later command shows, until a restore goes well.
  it('a rollback that could not restore leaves rollback.failed: shown by every command, status fails, a good restore clears it', async () => {
    const c = await installed()
    // The copy made before the update (the fake docker writes no file).
    writeFileSync(join(c.dir, 'backups', PRE), 'a copy')
    const failed = launch(c, update(c, '--image', 'rsc-brain:broken'), {
      env: { FAKE_MIGRATE_FAIL: 'rsc-brain:broken', FAKE_RESTORE_EXIT: '1' },
    })
    assert.equal(failed.code, 1, failed.stderr)
    assert.ok(exists(c, 'rollback.failed'), 'the mark is left')
    const mark = readFileSync(join(c.dir, '.rsc-brain', 'rollback.failed'), 'utf8')
    assert.ok(mark.includes(PRE), mark)
    assert.match(mark, new RegExp(`restore --file ${PRE} --confirm `))
    const shown = new RegExp(
      `could not go back[\\s\\S]*${PRE.replace(/\./g, '\\.')}[\\s\\S]*restore --file ${PRE.replace(/\./g, '\\.')}`,
    )
    const s = launch(c, ['status', '--dir', c.dir])
    assert.notEqual(s.code, 0, 'status fails while the mark is there')
    assert.match(s.stderr, shown)
    const sj = launch(c, ['status', '--json', '--dir', c.dir])
    assert.notEqual(sj.code, 0)
    assert.match(sj.stderr, shown)
    for (const args of [
      ['install', '--yes', '--dir', c.dir],
      update(c, '--image', 'rsc-brain:next'),
      ['backup', '--dir', c.dir],
      ['key', 'rotate', '--yes', '--dir', c.dir],
    ]) {
      const r = launch(c, args)
      assert.match(r.stderr, shown, args.join(' '))
      assert.ok(exists(c, 'rollback.failed'), `${args[0]} leaves the mark`)
    }
    const failedRestore = launch(c, ['restore', '--file', PRE, '--confirm', 'rsc-brain', '--dir', c.dir], {
      env: { FAKE_RESTORE_EXIT: '1' },
    })
    assert.notEqual(failedRestore.code, 0)
    assert.match(failedRestore.stderr, shown)
    assert.ok(exists(c, 'rollback.failed'), 'a restore that fails keeps the mark')
    const restored = launch(c, ['restore', '--file', PRE, '--confirm', 'rsc-brain', '--dir', c.dir])
    assert.equal(restored.code, 0, restored.stderr)
    assert.equal(exists(c, 'rollback.failed'), false, 'a good restore clears it')
    const again = launch(c, ['status', '--dir', c.dir])
    assert.equal(again.code, 0, again.stderr)
    assert.doesNotMatch(again.stderr, /could not go back/)
  })

  // Q1: docker compose takes back a SIGINT the launcher ignores, forwards it to the container and stops waiting for
  // it (seen with real docker): what must not stop halfway runs in a session of its own.
  it('a second Ctrl-C during the reseal of a key rotation does not stop it halfway', async () => {
    const env = { FAKE_KEY_ID_BY_KEY: '1' }
    const c = await installed(env)
    const old = readEnv(c.dir).RSC_BRAIN_SECRET
    const r = await launchStopped(
      c,
      ['key', 'rotate', '--yes', '--dir', c.dir],
      { ...env, FAKE_RESEAL_SLEEP: '2' },
      [{ marker: 'reseal-committed', signal: 'SIGINT' }],
    )
    assert.equal(r.signal, null, `killed by ${r.signal}: ${r.stderr}`)
    assert.equal(r.code, 0, r.stderr)
    assert.notEqual(readEnv(c.dir).RSC_BRAIN_SECRET, old)
    assert.equal(readFileSync(join(c.state, 'sealed'), 'utf8').trim(), readEnv(c.dir).RSC_BRAIN_SECRET)
    assert.equal(exists(c, 'env.rotated'), false)
  })

  // Every tool but those named: what a machine without them has.
  const without = (c: Case, ...gone: string[]) => {
    const bin = join(c.state, `without-${gone.join('-')}`)
    mkdirSync(bin)
    for (const t of TOOLS) {
      if (!gone.includes(t) && existsSync(join(SYSBIN, t))) symlinkSync(join(SYSBIN, t), join(bin, t))
    }
    return `${FAKEBIN}:${bin}`
  }

  it('without setsid, perl gives the way back a session of its own: a second Ctrl-C does not stop the restore halfway', async () => {
    const c = await installed()
    const before = readFileSync(join(c.dir, '.env'), 'utf8')
    const r = await launchStopped(
      c,
      update(c, '--image', 'rsc-brain:broken'),
      { PATH: without(c, 'setsid'), FAKE_MIGRATE_FAIL: 'rsc-brain:broken', FAKE_RESTORE_SLEEP: '2' },
      [{ marker: 'restore-started', signal: 'SIGINT' }],
    )
    assert.equal(r.signal, null, `killed by ${r.signal}: ${r.stderr}`)
    assert.equal(r.code, 4, r.stderr)
    assert.match(r.stderr, /went back to 0\.1\.0/)
    assert.equal(readFileSync(join(c.dir, '.env'), 'utf8'), before)
  })

  it('without setsid or perl, the way back still runs (unshielded: the known limit)', async () => {
    const c = await installed()
    const before = readFileSync(join(c.dir, '.env'), 'utf8')
    const r = launch(c, update(c, '--image', 'rsc-brain:broken'), {
      env: { PATH: without(c, 'setsid', 'perl'), FAKE_MIGRATE_FAIL: 'rsc-brain:broken' },
    })
    assert.equal(r.code, 4, r.stderr)
    assert.match(r.stderr, /went back to 0\.1\.0/)
    assert.equal(readFileSync(join(c.dir, '.env'), 'utf8'), before)
  })

  // Third review: a rollback that failed to restore, killed while it starts the old version; the next command goes
  // back again and this time the restore works.
  it('a later rollback whose restore works clears rollback.failed: status is healthy again', async () => {
    const c = await installed()
    writeFileSync(join(c.dir, 'backups', PRE), 'a copy')
    const killed = await launchStopped(
      c,
      update(c, '--image', 'rsc-brain:broken'),
      {
        FAKE_MIGRATE_FAIL: 'rsc-brain:broken',
        FAKE_RESTORE_EXIT: '1',
        FAKE_HEALTH_SLEEP: 'rsc-brain:test=5',
      },
      [{ marker: 'health-started', signal: 'SIGKILL' }],
    )
    assert.equal(killed.signal, 'SIGKILL', killed.stderr)
    assert.ok(exists(c, 'rollback.failed'), 'the failed restore left its mark')
    assert.ok(exists(c, 'update.pending'), 'killed before the journal went')
    const again = launch(c, ['status', '--dir', c.dir])
    assert.equal(again.code, 4, again.stderr)
    assert.match(again.stderr, /went back to 0\.1\.0/)
    assert.equal(exists(c, 'rollback.failed'), false, 'the restore worked this time')
    const s = launch(c, ['status', '--dir', c.dir])
    assert.equal(s.code, 0, s.stderr)
    assert.doesNotMatch(s.stderr, /could not go back/)
  })
})

// ---- update --check (rsc-updates §3.5, §3.9; CA27, CA29b): what is published, said from the machine's own access.
const VECTORS = JSON.parse(
  readFileSync(join(ROOT, 'test', 'fixtures', 'published-vectors.json'), 'utf8'),
) as {
  newest: Array<{ name: string; tags: string[]; newest: string | null }>
  compare: Array<{ name: string; installed: string; newest: string; result: string }>
  notes: Array<{ name: string; tag: string; changelog: string; notes: string }>
}
const fakeGit = (
  c: Case,
  o: { tags?: string[]; refs?: string; changelog?: string; fail?: string; cloneFail?: boolean } = {},
) => {
  const bin = join(c.state, 'gitbin')
  mkdirSync(bin, { recursive: true })
  const refs = o.refs ?? (o.tags ?? []).map((t) => `${'a'.repeat(40)}\trefs/tags/${t}`).join('\n')
  writeFileSync(join(c.state, 'refs.txt'), refs ? `${refs}\n` : '')
  writeFileSync(join(c.state, 'changelog.md'), o.changelog ?? '')
  writeFileSync(
    join(bin, 'git'),
    `#!/bin/sh
printf 'git %s\\n' "$*" >>"$FAKE_LOG"
case " $* " in
*" ls-remote "*)
  ${o.fail ? `printf '%s\\n' ${JSON.stringify(o.fail)} >&2; exit 128` : `cat "${join(c.state, 'refs.txt')}"; exit 0`}
  ;;
*" clone "*) ${o.cloneFail ? 'exit 128' : 'for last; do :; done; mkdir -p "$last"; exit 0'} ;;
*" show "*) cat "${join(c.state, 'changelog.md')}"; exit 0 ;;
esac
exit 0
`,
  )
  chmodSync(join(bin, 'git'), 0o755)
  return { PATH: `${bin}:${FAKEBIN}:${SYSBIN}` }
}
const check = (c: Case, env: Record<string, string>, ...more: string[]) =>
  launch(c, ['update', '--check', '--dir', c.dir, ...more], { env })
// Every file of a folder as it is: name, mode, time and content; a change anywhere shows.
const snapshot = (root: string): string[] => {
  const out: string[] = []
  const walk = (d: string) => {
    for (const f of readdirSync(d).sort()) {
      const p = join(d, f)
      const s = lstatSync(p)
      if (s.isDirectory()) {
        out.push(`${p} dir ${s.mode} ${s.mtimeMs}`)
        walk(p)
      } else out.push(`${p} ${s.mode} ${s.mtimeMs} ${readFileSync(p, 'latin1')}`)
    }
  }
  walk(root)
  return out
}

describe('the launcher: update --check', () => {
  it('--json says the versions and what changes, with real git against a real repository', async () => {
    const c = await installed()
    const repo = join(c.state, 'repo')
    mkdirSync(repo)
    const git = (...a: string[]) => {
      const r = spawnSync('git', ['-C', repo, '-c', 'user.name=t', '-c', 'user.email=t@example.test', ...a], {
        encoding: 'utf8',
      })
      assert.equal(r.status, 0, r.stderr)
    }
    git('init', '-q')
    writeFileSync(
      join(repo, 'CHANGELOG.md'),
      '# Changelog\n\n## v0.10.0\n\n- Ten "quoted".\n\n## v0.2.0\n\n- Two.\n',
    )
    git('add', '.')
    git('commit', '-qm', 'one')
    for (const t of ['v0.2.0', 'v0.10.0', 'v99.0.0-rc1']) git('tag', t)
    git('branch', 'v98.0.0')
    const bin = join(c.state, 'realgit')
    mkdirSync(bin)
    const where = spawnSync('/bin/sh', ['-c', 'command -v git'], { encoding: 'utf8' }).stdout.trim()
    symlinkSync(where, join(bin, 'git'))
    const r = launch(c, ['update', '--check', '--json', '--dir', c.dir, '--repo', repo], {
      env: { PATH: `${bin}:${FAKEBIN}:${SYSBIN}` },
    })
    assert.equal(r.code, 0, r.stderr)
    assert.deepEqual(JSON.parse(r.stdout), {
      installed: 'v0.1.0',
      latest: 'v0.10.0',
      newer: true,
      notes: '- Ten "quoted".',
    })
  })

  it('in words: both versions, what changes and how to update', async () => {
    const c = await installed()
    const env = fakeGit(c, { tags: ['v0.2.0'], changelog: '## v0.2.0\n\n- Two.\n' })
    const r = check(c, env)
    assert.equal(r.code, 0, r.stderr)
    assert.match(r.stdout, /Version v0\.1\.0 is running\. Version v0\.2\.0 is available\./)
    assert.match(r.stdout, /- Two\./)
    assert.match(r.stdout, /rsc-brain\.sh update/)
  })

  it('nothing moves: no file, no lock, no temporary left; docker only asked; an interrupted update stays as it is', async () => {
    const c = await installed()
    const state = join(c.dir, '.rsc-brain')
    // A journal and a lock of a launcher that died: a command that changes something would take the update back.
    mkdirSync(join(state, 'lock'), { recursive: true })
    writeFileSync(join(state, 'lock', 'owner'), '999999 nowhere')
    writeFileSync(
      join(state, 'update.pending'),
      `RSC_BRAIN_UPDATE_FROM='0.1.0'\nRSC_BRAIN_UPDATE_TO='0.2.0'\nRSC_BRAIN_UPDATE_COPY='${PRE}'\n`,
    )
    const tmp = join(c.state, 'tmp')
    mkdirSync(tmp)
    const before = snapshot(c.dir)
    const upBefore = readFileSync(join(c.state, 'up-image'), 'utf8')
    const env = { ...fakeGit(c, { tags: ['v0.2.0'], changelog: '## v0.2.0\n\n- Two.\n' }), TMPDIR: tmp }
    for (const r of [check(c, env), check(c, env, '--json')]) {
      assert.equal(r.code, 0, r.stderr)
      const docker = r.calls.filter((l) => !l.startsWith('git ') && !l.startsWith('LEAK '))
      assert.ok(docker.length > 0)
      for (const call of docker)
        assert.match(call, /^(info|compose version|.* ps -q app|.* exec -T app rsc-brain version)$/, call)
    }
    assert.deepEqual(snapshot(c.dir), before)
    assert.equal(readFileSync(join(c.state, 'up-image'), 'utf8'), upBefore)
    assert.deepEqual(readdirSync(tmp), [], 'its temporary folder is gone')
  })

  it('a stop while it works leaves no temporary behind', async () => {
    const c = await installed()
    const tmp = join(c.state, 'tmp')
    mkdirSync(tmp)
    const env = fakeGit(c, { tags: ['v0.2.0'], changelog: '## v0.2.0\n\n- Two.\n' })
    const gitFile = join(c.state, 'gitbin', 'git')
    writeFileSync(gitFile, `#!/bin/sh\n: >"${join(c.state, 'asked')}"\nexec sleep 20\n`)
    const child = spawn(shell(), [LAUNCHER, 'update', '--check', '--dir', c.dir], {
      stdio: ['ignore', 'ignore', 'ignore'],
      env: { ...environment(c, c.tty), ...env, TMPDIR: tmp },
    })
    const code = await new Promise<number | null>((resolve) => {
      const look = setInterval(() => {
        if (existsSync(join(c.state, 'asked'))) {
          clearInterval(look)
          child.kill('SIGTERM')
        }
      }, 20)
      child.on('exit', (status, signal) => {
        clearInterval(look)
        resolve(signal ? 128 : status)
      })
    })
    assert.notEqual(code, 0)
    assert.deepEqual(readdirSync(tmp), [])
  })

  it('the newest: exit 0, and says so; ahead of what is published: exit 0, and not newer', async () => {
    const c = await installed()
    const same = check(c, fakeGit(c, { tags: ['v0.1.0'] }))
    assert.equal(same.code, 0, same.stderr)
    assert.match(same.stdout, /Version v0\.1\.0 is running\. This is the newest\./)
    const ahead = check(c, fakeGit(c, { tags: ['v0.0.9'] }), '--json')
    assert.equal(ahead.code, 0, ahead.stderr)
    assert.equal(JSON.parse(ahead.stdout).newer, false)
    const words = check(c, fakeGit(c, { tags: ['v0.0.9'] }))
    assert.match(words.stdout, /ahead of the newest published version \(v0\.0\.9\)/)
    assert.doesNotMatch(words.stdout, /This is the newest/)
  })

  for (const v of VECTORS.newest)
    it(`vector, newest: ${v.name}`, async () => {
      const c = await installed()
      const r = check(c, fakeGit(c, { tags: v.tags }), '--json')
      const got = JSON.parse(r.stdout)
      assert.equal(got.latest, v.newest)
      if (v.newest === null) {
        assert.equal(r.code, 3)
        assert.equal(got.error, 'none')
        assert.match(r.stderr, /Cannot update: no published version yet/)
      } else assert.equal(r.code, 0, r.stderr)
    })

  for (const v of VECTORS.compare)
    it(`vector, compare: ${v.name}`, async () => {
      const c = await installed()
      const running = v.installed.slice(1)
      const s = launch(c, ['update', '--check', '--json', '--dir', c.dir], {
        env: { ...fakeGit(c, { tags: [v.newest] }), FAKE_IMAGE_VERSIONS: `rsc-brain:test=${running}` },
      })
      assert.equal(s.code, 0, s.stderr)
      assert.equal(JSON.parse(s.stdout).installed, v.installed)
      assert.equal(JSON.parse(s.stdout).newer, v.result === 'newer')
      const words = launch(c, ['update', '--check', '--dir', c.dir], {
        env: { ...fakeGit(c, { tags: [v.newest] }), FAKE_IMAGE_VERSIONS: `rsc-brain:test=${running}` },
      })
      const said = { newer: /is available/, up_to_date: /This is the newest/, older: /ahead of the newest/ }
      assert.match(words.stdout, said[v.result as keyof typeof said])
    })

  for (const v of VECTORS.notes)
    it(`vector, notes: ${v.name}`, async () => {
      const c = await installed()
      const r = check(c, fakeGit(c, { tags: [v.tag], changelog: v.changelog }), '--json')
      assert.equal(r.code, 0, r.stderr)
      assert.equal(JSON.parse(r.stdout).notes, v.notes)
    })

  it('numbers past 64 bits keep their order', async () => {
    const c = await installed()
    const tags = ['v99999999999999999999.0.0', 'v100000000000000000000.0.0']
    const r = check(c, fakeGit(c, { tags }), '--json')
    assert.equal(r.code, 0, r.stderr)
    assert.equal(JSON.parse(r.stdout).latest, 'v100000000000000000000.0.0')
    assert.equal(JSON.parse(r.stdout).newer, true)
    const running = launch(c, ['update', '--check', '--json', '--dir', c.dir], {
      env: { ...fakeGit(c, { tags }), FAKE_IMAGE_VERSIONS: 'rsc-brain:test=100000000000000000001.0.0' },
    })
    assert.equal(JSON.parse(running.stdout).newer, false)
  })

  it('a ref is a tag only under refs/tags, whole: a nested name does not count', async () => {
    const c = await installed()
    const sha = 'a'.repeat(40)
    const refs = `${sha}\trefs/tags/x/refs/tags/v9.9.9\n${sha}\trefs/tags/v0.2.0`
    const r = check(c, fakeGit(c, { refs }), '--json')
    assert.equal(JSON.parse(r.stdout).latest, 'v0.2.0')
  })

  it('notes: at most 4000 whole characters, and whatever they hold is valid JSON', async () => {
    const c = await installed()
    for (const ch of ['é', '😀']) {
      const changelog = `## v1.0.0\n\n${ch.repeat(4050)}\n`
      const r = check(c, fakeGit(c, { tags: ['v1.0.0'], changelog }), '--json')
      assert.equal(r.code, 0, r.stderr)
      assert.equal(JSON.parse(r.stdout).notes, ch.repeat(4000))
    }
    const odd = 'a "quote", a \\back\\slash,\ta tab\u0001 and\n\nlines'
    const r = check(c, fakeGit(c, { tags: ['v1.0.0'], changelog: `## v1.0.0\n\n${odd}\n` }), '--json')
    assert.equal(JSON.parse(r.stdout).notes, odd.replace('\u0001', ''))
  })

  it('no access or no network: exit 3, the reason, never up to date, and no secret of the address', async () => {
    const c = await installed()
    const secret = 'hunter2token'
    const url = `https://user:${secret}@github.com/acme/private.git`
    for (const [fail, error] of [
      [
        `fatal: could not read Username for 'https://user:${secret}@github.com': terminal prompts disabled`,
        'no_access',
      ],
      [`remote: Repository not found.\nfatal: repository '${url}/' not found`, 'no_access'],
      ['git@github.com: Permission denied (publickey).', 'no_access'],
      ["fatal: unable to access 'x': Could not resolve host: github.com", 'network'],
    ] as const) {
      const env = fakeGit(c, { fail })
      const j = launch(c, ['update', '--check', '--json', '--dir', c.dir, '--repo', url], { env })
      assert.equal(j.code, 3, j.stderr)
      assert.deepEqual(JSON.parse(j.stdout), {
        installed: 'v0.1.0',
        latest: null,
        newer: false,
        notes: '',
        error,
      })
      const w = launch(c, ['update', '--check', '--dir', c.dir, '--repo', url], { env })
      assert.equal(w.code, 3)
      assert.match(w.stderr, /Could not check for a new version/)
      assert.doesNotMatch(`${w.stdout}${w.stderr}`, /This is the newest/)
      for (const text of [j.stdout, j.stderr, w.stdout, w.stderr])
        assert.equal(text.includes(secret), false, text)
    }
  })

  it('asks git never to wait for someone to type', async () => {
    const c = await installed()
    const env = fakeGit(c, { tags: ['v0.2.0'] })
    writeFileSync(
      join(c.state, 'gitbin', 'git'),
      `#!/bin/sh\necho "prompt=$GIT_TERMINAL_PROMPT ssh=$GIT_SSH_COMMAND" >"${join(c.state, 'seen')}"\nexit 128\n`,
    )
    check(c, env)
    const seen = readFileSync(join(c.state, 'seen'), 'utf8')
    assert.match(seen, /prompt=0/)
    assert.match(seen, /ssh=.*BatchMode=yes/)
  })

  it('rsc-brain not running or no git: exit 3 and nothing moved', async () => {
    const c = await installed()
    const env = fakeGit(c, { tags: ['v0.2.0'] })
    rmSync(join(c.state, 'up'))
    const before = snapshot(c.dir)
    const r = check(c, env)
    assert.equal(r.code, 3, r.stderr)
    assert.match(r.stderr, /not running/)
    assert.deepEqual(snapshot(c.dir), before)
    writeFileSync(join(c.state, 'up'), '')
    const nogit = launch(c, ['update', '--check', '--dir', c.dir])
    assert.equal(nogit.code, 3, nogit.stderr)
    assert.match(nogit.stderr, /git is not installed/)
  })

  it('does not go with --version, --image or another command', async () => {
    const c = await installed()
    for (const args of [
      ['update', '--check', '--version', 'v0.2.0', '--dir', c.dir],
      ['update', '--check', '--image', 'rsc-brain:next', '--dir', c.dir],
      ['status', '--check', '--dir', c.dir],
      ['install', '--check', '--dir', c.dir],
    ]) {
      const r = launch(c, args)
      assert.equal(r.code, 2, r.stderr)
    }
  })
})

describe('the launcher: update --check, the review of PR #41', () => {
  const SECRET = 'hunter2token'
  const shouting = `HTTPS://user:${SECRET}@github.com/acme/private.git`

  it('--json answers in the same shape when rsc-brain is stopped', async () => {
    const c = await installed()
    const env = fakeGit(c, { tags: ['v0.2.0'] })
    rmSync(join(c.state, 'up'))
    const r = check(c, env, '--json')
    assert.equal(r.code, 3, r.stderr)
    assert.deepEqual(JSON.parse(r.stdout), {
      installed: null,
      latest: null,
      newer: false,
      notes: '',
      error: 'not_running',
    })
    assert.match(r.stderr, /not running/)
  })

  it('while an update runs it says so, and does not send anyone to install', async () => {
    const c = await installed()
    const env = fakeGit(c, { tags: ['v0.2.0'] })
    rmSync(join(c.state, 'up'))
    mkdirSync(join(c.dir, '.rsc-brain', 'lock'), { recursive: true })
    const host = spawnSync('uname', ['-n'], { encoding: 'utf8' }).stdout.trim()
    writeFileSync(join(c.dir, '.rsc-brain', 'lock', 'owner'), `${process.pid} ${host}`)
    writeFileSync(join(c.dir, '.rsc-brain', 'update.pending'), `RSC_BRAIN_UPDATE_COPY='${PRE}'\n`)
    const r = check(c, env, '--json')
    assert.equal(r.code, 3, r.stderr)
    assert.equal(JSON.parse(r.stdout).error, 'updating')
    assert.match(r.stderr, /An update is running/)
    assert.doesNotMatch(r.stderr, /rsc-brain\.sh install/)
  })

  it('an update that was killed halfway says how it is taken back, not install', async () => {
    const c = await installed()
    const env = fakeGit(c, { tags: ['v0.2.0'] })
    rmSync(join(c.state, 'up'))
    mkdirSync(join(c.dir, '.rsc-brain'), { recursive: true })
    writeFileSync(join(c.dir, '.rsc-brain', 'update.pending'), `RSC_BRAIN_UPDATE_COPY='${PRE}'\n`)
    const r = check(c, env, '--json')
    assert.equal(r.code, 3, r.stderr)
    assert.equal(JSON.parse(r.stdout).error, 'updating')
    assert.match(r.stderr, /was interrupted/)
    assert.match(r.stderr, / status /)
    assert.doesNotMatch(r.stderr, /rsc-brain\.sh install/)
  })

  it('--json has that shape for what is missing too: no Docker, no git, no installation', async () => {
    const c = await installed()
    const noDocker = check(c, fakeGit(c, { tags: ['v0.2.0'] }), '--json')
    assert.equal(noDocker.code, 0, noDocker.stderr)
    const down = launch(c, ['update', '--check', '--json', '--dir', c.dir], {
      env: { ...fakeGit(c, { tags: ['v0.2.0'] }), FAKE_INFO_EXIT: '1' },
    })
    assert.equal(down.code, 3)
    assert.equal(JSON.parse(down.stdout).error, 'missing')
    const nogit = launch(c, ['update', '--check', '--json', '--dir', c.dir])
    assert.equal(nogit.code, 3)
    assert.equal(JSON.parse(nogit.stdout).error, 'missing')
    const none = launch(c, ['update', '--check', '--json', '--dir', join(c.state, 'nothing')])
    assert.equal(none.code, 3)
    assert.equal(JSON.parse(none.stdout).error, 'missing')
    assert.equal(JSON.parse(none.stdout).installed, null)
  })

  it('a scheme in capitals: the credentials still stay out of .env and of everything said', async () => {
    const c = fresh()
    const port = String(await freePort())
    const base = ['install', '--local', '--yes', '--dir', c.dir, '--port', port, '--image', 'rsc-brain:test']
    const r = launch(c, [...base, '--repo', shouting])
    assert.equal(r.code, 0, r.stderr)
    assert.equal(readFileSync(join(c.dir, '.env'), 'utf8').includes(SECRET), false)
    assert.equal(readEnv(c.dir).RSC_BRAIN_REPO_URL, 'HTTPS://github.com/acme/private.git')
    const ssh = fresh()
    const r2 = launch(ssh, [
      'install',
      '--local',
      '--yes',
      '--dir',
      ssh.dir,
      '--port',
      String(await freePort()),
      '--image',
      'rsc-brain:test',
      '--repo',
      `SSH://git:${SECRET}@example.com/x.git`,
    ])
    assert.equal(r2.code, 0, r2.stderr)
    assert.equal(readEnv(ssh.dir).RSC_BRAIN_REPO_URL, 'SSH://git@example.com/x.git')
    const failed = check(c, fakeGit(c, { fail: 'fatal: not found' }), '--repo', shouting)
    assert.match(failed.stderr, /HTTPS:\/\/github\.com\/acme\/private\.git/)
    assert.equal(failed.stderr.includes(SECRET), false)
  })

  it('what install and update say about the repository never carries its credentials', async () => {
    // install: no tags yet, and the source cannot be fetched.
    const a = fresh()
    const envA = fakeGit(a, { tags: [], cloneFail: true })
    const noTags = launch(
      a,
      ['install', '--local', '--yes', '--dir', a.dir, '--port', String(await freePort()), '--repo', shouting],
      { env: envA },
    )
    assert.match(noTags.stderr, /No published version of rsc-brain at HTTPS:\/\/github\.com/)
    const b = fresh()
    const fetchVersion = launch(
      b,
      [
        'install',
        '--local',
        '--yes',
        '--dir',
        b.dir,
        '--port',
        String(await freePort()),
        '--version',
        'v0.2.0',
        '--repo',
        shouting,
      ],
      { env: fakeGit(b, { tags: ['v0.2.0'], cloneFail: true }) },
    )
    assert.match(fetchVersion.stderr, /Could not fetch v0\.2\.0 from HTTPS:\/\/github\.com/)
    // update: no tags, and the source cannot be fetched.
    const c = await installed()
    const none = launch(c, update(c, '--repo', shouting), { env: fakeGit(c, { tags: [] }) })
    assert.equal(none.code, 3)
    assert.match(none.stderr, /No published version of rsc-brain at HTTPS:\/\/github\.com/)
    const fetch = launch(c, update(c, '--version', 'v0.2.0', '--repo', shouting), {
      env: { ...fakeGit(c, { tags: ['v0.2.0'], cloneFail: true }), FAKE_IMAGES: 'rsc-brain:test' },
    })
    assert.equal(fetch.code, 3, fetch.stderr)
    assert.match(fetch.stderr, /Could not fetch v0\.2\.0 from HTTPS:\/\/github\.com/)
    for (const r of [noTags, fetchVersion, none, fetch])
      assert.equal(`${r.stdout}${r.stderr}`.includes(SECRET), false, r.stderr)
  })

  it('the clone of the notes has the limits of the question; if it fails the version still stands', async () => {
    const c = await installed()
    const ok = check(c, fakeGit(c, { tags: ['v0.2.0'], changelog: '## v0.2.0\n\n- Two.\n' }))
    for (const verb of ['ls-remote', 'clone'])
      assert.ok(
        ok.calls.some(
          (l) =>
            l.startsWith('git ') &&
            l.includes(' http.lowSpeedLimit=1 ') &&
            l.includes(' http.lowSpeedTime=30 ') &&
            l.includes(` ${verb} `),
        ),
        `${verb}: ${ok.calls.join('\n')}`,
      )
    const r = check(c, fakeGit(c, { tags: ['v0.2.0'], cloneFail: true }), '--json')
    assert.equal(r.code, 0, r.stderr)
    assert.deepEqual(JSON.parse(r.stdout), { installed: 'v0.1.0', latest: 'v0.2.0', newer: true, notes: '' })
  })

  it('--version with leading zeros is not a published version', async () => {
    const c = await installed()
    const r = launch(c, update(c, '--version', 'v01.0.0'))
    assert.equal(r.code, 2, r.stderr)
  })

  it('over ssh both give up on a dead connection', async () => {
    const c = await installed()
    const env = fakeGit(c, { tags: ['v0.2.0'] })
    writeFileSync(
      join(c.state, 'gitbin', 'git'),
      `#!/bin/sh\ncase " $* " in *" ls-remote "*|*" clone "*) echo "$GIT_SSH_COMMAND" >>"${join(c.state, 'seen')}" ;; esac\ncase " $* " in *" ls-remote "*) echo "${'a'.repeat(40)} refs/tags/v0.2.0" ;; esac\nexit 0\n`,
    )
    assert.equal(check(c, env).code, 0)
    const seen = readFileSync(join(c.state, 'seen'), 'utf8').trim().split('\n')
    assert.equal(seen.length, 2)
    for (const line of seen) {
      assert.match(line, /BatchMode=yes/)
      assert.match(line, /ConnectTimeout=\d+/)
      assert.match(line, /ServerAliveInterval=\d+/)
    }
  })
})

describe('the launcher: where the versions are asked', () => {
  it('install writes RSC_BRAIN_REPO_URL, without credentials; reinstalling keeps it, off included; compose hands it over', async () => {
    const plain = await installed()
    assert.equal(readEnv(plain.dir).RSC_BRAIN_REPO_URL, 'https://github.com/ericrisco/rsc-brain.git')
    const compose = readFileSync(join(plain.dir, 'compose.yaml'), 'utf8')
    assert.ok(
      // biome-ignore lint/suspicious/noTemplateCurlyInString: the syntax of compose
      compose.includes('RSC_BRAIN_REPO_URL: ${RSC_BRAIN_REPO_URL-https://github.com/ericrisco/rsc-brain}'),
    )

    const c = fresh()
    const port = String(await freePort())
    const secret = 'hunter2token'
    const args = ['install', '--local', '--yes', '--dir', c.dir, '--port', port, '--image', 'rsc-brain:test']
    const r = launch(c, [...args, '--repo', `https://user:${secret}@github.com/acme/private.git`])
    assert.equal(r.code, 0, r.stderr)
    assert.equal(readEnv(c.dir).RSC_BRAIN_REPO_URL, 'https://github.com/acme/private.git')
    assert.equal(readFileSync(join(c.dir, '.env'), 'utf8').includes(secret), false)
    assert.equal(launch(c, args).code, 0)
    assert.equal(readEnv(c.dir).RSC_BRAIN_REPO_URL, 'https://github.com/acme/private.git')

    const env = readFileSync(join(c.dir, '.env'), 'utf8')
    writeFileSync(join(c.dir, '.env'), env.replace(/^RSC_BRAIN_REPO_URL=.*$/m, "RSC_BRAIN_REPO_URL=''"))
    assert.equal(launch(c, args).code, 0)
    assert.equal(readEnv(c.dir).RSC_BRAIN_REPO_URL, '')
  })

  it('--check and update ask the repository of the installation, unless --repo says otherwise; off only silences the web', async () => {
    const c = fresh()
    const port = String(await freePort())
    const base = ['install', '--local', '--yes', '--dir', c.dir, '--port', port, '--image', 'rsc-brain:test']
    assert.equal(launch(c, [...base, '--repo', 'ssh://git@example.com/mine.git']).code, 0)
    const env = fakeGit(c, { tags: ['v0.1.0'] })
    assert.ok(
      check(c, env).calls.some((l) => /^git .*ls-remote .*ssh:\/\/git@example\.com\/mine\.git/.test(l)),
    )
    const other = launch(
      c,
      ['update', '--check', '--dir', c.dir, '--repo', 'ssh://git@example.com/other.git'],
      { env },
    )
    assert.ok(other.calls.some((l) => /^git .*ls-remote .*other\.git/.test(l)))
    const up = launch(c, ['update', '--yes', '--dir', c.dir], { env })
    assert.equal(up.code, 0, up.stderr)
    assert.ok(up.calls.some((l) => /^git .*ls-remote .*mine\.git/.test(l)))
    const text = readFileSync(join(c.dir, '.env'), 'utf8')
    writeFileSync(join(c.dir, '.env'), text.replace(/^RSC_BRAIN_REPO_URL=.*$/m, "RSC_BRAIN_REPO_URL=''"))
    assert.ok(check(c, env).calls.some((l) => /^git .*ls-remote .*ericrisco\/rsc-brain/.test(l)))
  })

  it('an address with a quote or a line break is refused', async () => {
    const c = fresh()
    const r = launch(c, [
      'install',
      '--local',
      '--yes',
      '--dir',
      c.dir,
      '--image',
      'rsc-brain:test',
      '--repo',
      "https://x/a'b",
    ])
    assert.equal(r.code, 2, r.stderr)
  })
})

// ---- The stand-in door (rsc-updates §3.9, CA22/CA27): while the service is stopped, something answers on its port.
describe('the launcher: the stand-in door', () => {
  const DOOR_UP = / --profile door .*up -d --no-deps door$/
  const DOOR_RM = / --profile door .*rm -fsv door$/
  const steps = (c: Case) =>
    existsSync(join(c.state, 'door-steps.log')) ? readFileSync(join(c.state, 'door-steps.log'), 'utf8') : ''

  it('compose: a profile of its own, no restart, the port and the alias of the service; the service still has them', () => {
    const compose = readFileSync(join(ROOT, 'deploy', 'compose.yaml'), 'utf8')
    const door = /\n {2}door:\n((?: {4}.*\n| {6}.*\n)+)/.exec(compose)?.[1] ?? ''
    assert.match(door, /profiles: \[door\]/)
    assert.match(door, /image: caddy:2\.11\.7-alpine@sha256:/)
    assert.match(door, /restart: "no"/)
    assert.match(door, /"\$\{RSC_BRAIN_PUBLISH:\?run rsc-brain\.sh install\}:8090"/)
    assert.match(door, /aliases:\n\s+- app\n/)
    assert.match(door, /\.\/door\.Caddyfile:\/etc\/caddy\/Caddyfile:ro/)
    assert.match(door, /\.\/\.rsc-brain\/door:\/door:ro/)
  })

  it('the Caddyfile: 503 and Retry-After for everything, a page for a browser, the shape clients know for the rest', () => {
    const f = readFileSync(join(ROOT, 'deploy', 'door.Caddyfile'), 'utf8')
    assert.match(f, /header Retry-After 30/)
    assert.match(f, /auto_https off/)
    assert.match(f, /admin off/)
    assert.match(f, /:8090 \{/)
    const json = /respond `(\{.*\})` 503/.exec(f)?.[1] ?? ''
    assert.deepEqual(Object.keys(JSON.parse(json).error), ['code', 'message', 'howToProceed'])
    assert.equal(JSON.parse(json).error.code, 'under_maintenance')
    assert.equal(JSON.parse(json).retryAfter, 30)
    assert.match(f, /include "\/step\.txt"/)
    assert.doesNotMatch(f, /https?:\/\/(?!www\.w3)/, 'nothing from outside')
  })

  it('install brings door.Caddyfile; an update: door up once stopped, gone before the new one starts, a step for each', async () => {
    const c = await installed()
    assert.ok(existsSync(join(c.dir, 'door.Caddyfile')))
    const r = launch(c, update(c, '--image', 'rsc-brain:next'))
    assert.equal(r.code, 0, r.stderr)
    inOrder(r.calls, [
      /^image inspect caddy:2\.11\.7-alpine@sha256:/,
      / rsc-brain maintenance on --reason update$/,
      / stop app$/,
      DOOR_UP,
      / run --rm -T --no-deps app rsc-brain migrate$/,
      DOOR_RM,
      / up -d --remove-orphans$/,
    ])
    assert.equal(existsSync(join(c.state, 'door')), false, 'nothing left on the port')
    assert.match(steps(c), /migrate: Migrating the data\./)
    assert.equal(statSync(join(c.dir, '.rsc-brain', 'door')).mode & 0o777, 0o755)
  })

  it('a failed migration: the door stays through the restore, and goes before the old one starts', async () => {
    const c = await installed()
    const r = launch(c, update(c, '--image', 'rsc-brain:broken'), {
      env: { FAKE_MIGRATE_FAIL: 'rsc-brain:broken' },
    })
    assert.equal(r.code, 4, r.stderr)
    inOrder(r.calls, [
      DOOR_UP,
      / rsc-brain migrate$/,
      DOOR_UP,
      / rsc-brain restore .*--keep-keys/,
      DOOR_RM,
      / up -d --remove-orphans$/,
    ])
    assert.equal(at(r.calls, DOOR_RM) > at(r.calls, / rsc-brain restore /), true)
    assert.equal(existsSync(join(c.state, 'door')), false)
    assert.match(steps(c), /restore: Restoring the copy made before the update/)
  })

  it('no step of the door names a version: an update, a failed migration, a start that fails, a way back', async () => {
    const VERSION_LIKE = /\d+\.\d+\.\d+/
    const good = await installed()
    assert.equal(launch(good, update(good, '--image', 'rsc-brain:next')).code, 0)
    const failed = await installed()
    const f = launch(failed, update(failed, '--image', 'rsc-brain:broken'), {
      env: { FAKE_MIGRATE_FAIL: 'rsc-brain:broken' },
    })
    assert.equal(f.code, 4, f.stderr)
    const late = await installed()
    const h = launch(late, update(late, '--image', 'rsc-brain:broken'), {
      env: { FAKE_HEALTH_FAIL: 'rsc-brain:broken' },
    })
    assert.equal(h.code, 4, h.stderr)
    for (const c of [good, failed, late]) {
      assert.ok(steps(c).length > 0)
      assert.doesNotMatch(steps(c), VERSION_LIKE)
    }
    assert.match(steps(good), /Migrating the data\.\n/)
    assert.match(steps(failed), /Going back to the version before\.\n/)
    assert.doesNotMatch(readFileSync(join(ROOT, 'deploy', 'door.Caddyfile'), 'utf8'), VERSION_LIKE)
  })

  it('any method that accepts HTML gets the page: the Caddyfile does not look at the method', () => {
    const f = readFileSync(join(ROOT, 'deploy', 'door.Caddyfile'), 'utf8')
    assert.match(f, /@page header Accept \*text\/html\*\n/)
    assert.doesNotMatch(f, /\bmethod [A-Z]/)
    assert.doesNotMatch(f, /reverse_proxy/, 'nothing reaches the service from here')
  })

  it('a new version that does not answer: the door comes back for the way back', async () => {
    const c = await installed()
    const r = launch(c, update(c, '--image', 'rsc-brain:broken'), {
      env: { FAKE_HEALTH_FAIL: 'rsc-brain:broken' },
    })
    assert.equal(r.code, 4, r.stderr)
    inOrder(r.calls, [
      DOOR_UP,
      DOOR_RM,
      / up -d --remove-orphans$/,
      DOOR_UP,
      / rsc-brain restore /,
      DOOR_RM,
      / up -d --remove-orphans$/,
    ])
    assert.equal(existsSync(join(c.state, 'door')), false)
  })

  it('a launcher killed with the door up: the next one takes it down before starting anything', async () => {
    const c = await installed()
    const killed = launch(c, update(c, '--image', 'rsc-brain:broken'), {
      env: { RSC_BRAIN_TEST_STOP_AT: 'door-up' },
    })
    assert.notEqual(killed.code, 0)
    assert.ok(existsSync(join(c.state, 'door')), 'it was up')
    const r = launch(c, ['status', '--dir', c.dir])
    inOrder(r.calls, [/ rsc-brain restore /, DOOR_RM, / up -d --remove-orphans$/])
    assert.equal(existsSync(join(c.state, 'door')), false)
  })

  it('the image of the door is ready before anything moves: fetched when missing; refused, exit 3, when it cannot be', async () => {
    const c = await installed()
    const before = readFileSync(join(c.dir, '.env'), 'utf8')
    const env = { FAKE_IMAGES: 'rsc-brain:test rsc-brain:next', FAKE_PULL_EXIT: '1' }
    const no = launch(c, update(c, '--image', 'rsc-brain:next'), { env })
    assert.equal(no.code, 3, no.stderr)
    assert.match(no.stderr, /caddy:2\.11\.7-alpine/)
    assert.match(no.stderr, /Nothing was changed/)
    assert.equal(at(no.calls, / maintenance | stop /), -1)
    assert.equal(readFileSync(join(c.dir, '.env'), 'utf8'), before)
    const ok = launch(c, update(c, '--image', 'rsc-brain:next'), { env: { ...env, FAKE_PULL_EXIT: '0' } })
    assert.equal(ok.code, 0, ok.stderr)
    inOrder(ok.calls, [/^pull caddy:2\.11\.7-alpine/, / maintenance on /])
  })

  it('a door that does not start does not stop the update: it says so and goes on', async () => {
    const c = await installed()
    const r = launch(c, update(c, '--image', 'rsc-brain:next'), { env: { FAKE_DOOR_UP_EXIT: '1' } })
    assert.equal(r.code, 0, r.stderr)
    assert.match(r.stderr, /stand-in/)
  })

  // An installation from before (compose.yaml without a door).
  const old = (c: Case) => {
    const text = readFileSync(join(c.dir, 'compose.yaml'), 'utf8')
    writeFileSync(join(c.dir, 'compose.yaml'), text.replace(/\n {2}door:\n(?: {4}.*\n| {6}.*\n)+/, '\n'))
    rmSync(join(c.dir, 'door.Caddyfile'))
  }

  it('an installation from before, updated with --image: no door, and the update works as before', async () => {
    const c = await installed()
    old(c)
    const r = launch(c, update(c, '--image', 'rsc-brain:next'))
    assert.equal(r.code, 0, r.stderr)
    assert.equal(at(r.calls, / door /), -1, r.calls.join('\n'))
    assert.equal(at(r.calls, /^image inspect caddy/), -1)
  })

  it('from before, updated to a version with a door that fails: the door serves, and goes by its labels once the compose file has none', async () => {
    const c = await installed()
    old(c)
    const gitBin = join(c.state, 'gitbin')
    mkdirSync(gitBin)
    const deploy = join(ROOT, 'deploy')
    writeFileSync(
      join(gitBin, 'git'),
      `#!/bin/sh\nprintf 'git %s\\n' "$*" >>"$FAKE_LOG"\nfor last; do :; done\nmkdir -p "$last/deploy"\ncp "${deploy}/compose.yaml" "${deploy}/Caddyfile" "${deploy}/door.Caddyfile" "$last/deploy/"\n`,
    )
    chmodSync(join(gitBin, 'git'), 0o755)
    const r = launch(c, update(c, '--version', 'v0.3.0'), {
      env: {
        PATH: `${gitBin}:${FAKEBIN}:${SYSBIN}`,
        FAKE_IMAGE_VERSIONS: `${VERSIONS} rsc-brain:v0.3.0=0.3.0`,
        FAKE_MIGRATE_FAIL: 'rsc-brain:v0.3.0',
      },
    })
    assert.equal(r.code, 4, r.stderr)
    inOrder(r.calls, [
      /^image inspect caddy/,
      DOOR_UP,
      / rsc-brain restore /,
      /^rm -fv /,
      / up -d --remove-orphans$/,
    ])
    assert.equal(existsSync(join(c.state, 'door')), false)
    assert.doesNotMatch(readFileSync(join(c.dir, 'compose.yaml'), 'utf8'), /\n {2}door:/)
  })

  it('companion: the door takes the name on the shared network too, only while the compose file has one', async () => {
    const c = fresh()
    const port = String(await freePort())
    const url = join(c.state, 'db-url.txt')
    writeFileSync(url, 'postgres://rsc_brain:pw@db.internal:5432/rsc_brain\n')
    const env = { FAKE_NETWORKS: 'rsc-shared=172.30.0.0/16|172.30.0.1' }
    const a = launch(
      c,
      [
        'install',
        '--local',
        '--yes',
        '--dir',
        c.dir,
        '--port',
        port,
        '--image',
        'rsc-brain:test',
        '--companion',
        '--attach-network',
        'rsc-shared',
        '--factory-url',
        'http://localhost:9000',
        '--db',
        'existing',
        '--db-url-file',
        url,
      ],
      { env },
    )
    assert.equal(a.code, 0, a.stderr)
    const file = join(c.dir, 'compose.companion.yaml')
    assert.match(readFileSync(file, 'utf8'), /\n {2}door:\n {4}networks:\n[\s\S]*- rsc-brain\n/)
    old(c)
    const r = launch(c, update(c, '--image', 'rsc-brain:next'), { env })
    assert.equal(r.code, 0, r.stderr)
    assert.doesNotMatch(
      readFileSync(file, 'utf8'),
      /door/,
      'a service without an image would stop every compose call',
    )
    assert.match(readFileSync(file, 'utf8'), /- rsc-brain\n/)
  })
})
