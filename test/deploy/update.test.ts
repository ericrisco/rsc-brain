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
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  realpathSync,
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

  it('without setsid, the way back runs as a job of its own: a second Ctrl-C does not stop the restore halfway', async (t) => {
    // The shell itself, not its name (on Debian and Ubuntu, sh is dash), known only once before() has run.
    if (/dash$/.test(realpathSync(shell()))) {
      t.skip('dash has no job control without a terminal (Linux, where /bin/sh is dash, has setsid)')
      return
    }
    const c = await installed()
    const bin = join(c.state, 'nosetsid')
    mkdirSync(bin)
    for (const t of TOOLS) {
      if (t !== 'setsid' && existsSync(join(SYSBIN, t))) symlinkSync(join(SYSBIN, t), join(bin, t))
    }
    const before = readFileSync(join(c.dir, '.env'), 'utf8')
    const r = await launchStopped(
      c,
      update(c, '--image', 'rsc-brain:broken'),
      { PATH: `${FAKEBIN}:${bin}`, FAKE_MIGRATE_FAIL: 'rsc-brain:broken', FAKE_RESTORE_SLEEP: '2' },
      [{ marker: 'restore-started', signal: 'SIGINT' }],
    )
    assert.equal(r.signal, null, `killed by ${r.signal}: ${r.stderr}`)
    assert.equal(r.code, 4, r.stderr)
    assert.match(r.stderr, /went back to 0\.1\.0/)
    assert.doesNotMatch(r.stderr, /Done|\[1\]/, 'no job notice')
    assert.equal(readFileSync(join(c.dir, '.env'), 'utf8'), before)
  })
})
