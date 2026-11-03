// The launcher's `update` (plan §3.9, T042; spec B7 «Actualizar», CA6, CA7) and `key rotate` (spec «la llave … se
// puede rotar», C10), with the fake `docker` of test/deploy/fake-docker.sh: no daemon, so it runs in CI. What this
// pins is the order of the steps and what a failure leaves: the new image is ready (built or checked) while the old
// one serves; maintenance goes on before the pre-update copy; the migration runs with the new image only after the old
// service stopped; maintenance comes off only once the new one answers as the version asked. A failure in the
// migration or the start restores the pre-update copy with the old image and --keep-keys, starts the old one, records
// the failure for the web and exits 4. The real containers are test/install/update.test.ts.
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
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
  // The fake docker's own (never the launcher's).
  'cksum',
]
const VERSIONS = 'rsc-brain:test=0.1.0 rsc-brain:next=0.2.0 rsc-brain:broken=0.3.0 rsc-brain:old=0.0.9'
const PRE = 'rsc-brain-20261103T120000Z-pre-update.rscb'

let BASE = ''
let SYSBIN = ''
let FAKEBIN = ''
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
const launch = (c: Case, args: string[], o: { env?: Record<string, string>; answers?: string } = {}): Run => {
  const seen = size(c.log)
  const seenIn = size(c.stdin)
  const seenImages = size(join(c.state, 'images.log'))
  let tty = c.tty
  if (o.answers !== undefined) {
    tty = join(c.state, `answers-${++n}`)
    writeFileSync(tty, o.answers)
  }
  const r = spawnSync(join(SYSBIN, 'sh'), [LAUNCHER, ...args], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 30_000,
    env: {
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
      ...o.env,
    },
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
