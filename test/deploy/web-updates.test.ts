// The launcher's `web-updates enable|disable|status` (rsc-updates §3.7, §3.9; CA15, CA26, CA27, CA28), with the fake
// `docker` of test/deploy/fake-docker.sh: no daemon, so it runs in CI. What this pins: it is off in a new installation;
// enable warns that whoever controls the updater controls the server, takes the credential from a file and keeps it
// in one place readable by its owner only, proves the repository answers with it before anything runs, and starts a
// compose project of its own that the service's project never touches; in an installation made by rsc-factory it
// exits 2 and says where to update; disable leaves no container and no credential; uninstall does the same. Exit codes:
// 0 done, 2 usage, 3 something is missing (nothing changed), 4 failed and put back, 1 other.
import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import {
  appendFileSync,
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
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { after, before, describe, it } from 'node:test'

const ROOT = new URL('../..', import.meta.url).pathname
const LAUNCHER = join(ROOT, 'deploy', 'rsc-brain.sh')
const FAKE = join(ROOT, 'test', 'deploy', 'fake-docker.sh')
const TOKEN = 'ghp_SecretTokenValue0123456789'
const KEY =
  '-----BEGIN OPENSSH PRIVATE KEY-----\nQUJDREVGR0hJSktMTU5PUA==\n-----END OPENSSH PRIVATE KEY-----\n'
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
  'cksum',
  'perl',
  'stat',
]
const VERSIONS = 'rsc-brain:test=0.1.0 rsc-brain:next=0.2.0'
const IMG = 'rsc-brain-updater:rsc-brain'
const PROJECT = 'rsc-brain-updater'

let BASE = ''
let SYSBIN = ''
let FAKEBIN = ''
const shell = () => process.env.RSC_BRAIN_TEST_SHELL ?? join(SYSBIN, 'sh')
before(() => {
  BASE = mkdtempSync(join(tmpdir(), 'rscb-webupd-'))
  SYSBIN = join(BASE, 'sysbin')
  FAKEBIN = join(BASE, 'fakebin')
  mkdirSync(SYSBIN)
  mkdirSync(FAKEBIN)
  for (const t of TOOLS) {
    const r = spawnSync('/bin/sh', ['-c', `command -v ${t}`], { encoding: 'utf8' })
    const p = r.stdout.trim()
    if (r.status === 0 && p.startsWith('/')) symlinkSync(p, join(SYSBIN, t))
  }
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
type Case = {
  dir: string
  home: string
  log: string
  stdin: string
  state: string
  tty: string
  files: string
}
const fresh = (): Case => {
  const c = join(BASE, `case-${++n}`)
  mkdirSync(join(c, 'state'), { recursive: true })
  mkdirSync(join(c, 'home'))
  mkdirSync(join(c, 'files'))
  return {
    dir: join(c, 'install'),
    home: join(c, 'home'),
    log: join(c, 'docker.log'),
    stdin: join(c, 'docker.stdin'),
    state: join(c, 'state'),
    tty: join(c, 'no-terminal', 'tty'),
    files: join(c, 'files'),
  }
}
type Run = { code: number | null; stdout: string; stderr: string; calls: string[]; piped: string }
const size = (file: string) => (existsSync(file) ? readFileSync(file, 'utf8').length : 0)
const tail = (file: string, from: number) => (existsSync(file) ? readFileSync(file, 'utf8').slice(from) : '')
const launch = (c: Case, args: string[], o: { env?: Record<string, string>; answers?: string } = {}): Run => {
  const seen = size(c.log)
  const seenIn = size(c.stdin)
  let tty = c.tty
  if (o.answers !== undefined) {
    tty = join(c.state, `answers-${++n}`)
    writeFileSync(tty, o.answers)
  }
  const r = spawnSync(shell(), [LAUNCHER, ...args], {
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
const installed = async (extra: string[] = []) => {
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
    '--image',
    'rsc-brain:test',
    ...extra,
  ])
  assert.equal(r.code, 0, r.stderr)
  return c
}
const mode = (p: string) => (statSync(p).mode & 0o777).toString(8)
let fileNo = 0
// A file of its own each time: two cases never share one.
const tokenFile = (c: Case, text = `${TOKEN}\n`) => {
  const f = join(c.files, `token-${++fileNo}`)
  writeFileSync(f, text, { mode: 0o600 })
  return f
}
const keyFile = (c: Case) => {
  const f = join(c.files, 'key')
  writeFileSync(f, KEY, { mode: 0o600 })
  return f
}
const enable = (c: Case, ...more: string[]) => ['web-updates', 'enable', '--yes', '--dir', c.dir, ...more]
const everyFile = (dir: string): string[] => {
  const out: string[] = []
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name)
    if (e.isDirectory()) out.push(...everyFile(p))
    else if (e.isFile()) out.push(p)
  }
  return out
}
const upd = (calls: string[]) => calls.filter((l) => l.includes(`-p ${PROJECT} `))

describe('web-updates: off in a new installation (CA15)', () => {
  it('a new installation has no updater: no folder of it, no container, no compose file of it, and the report folder the service reads exists', async () => {
    const c = await installed()
    assert.equal(existsSync(join(c.dir, 'updater')), false)
    assert.equal(existsSync(join(c.dir, 'compose.updater.yaml')), false)
    assert.equal(mode(join(c.dir, 'update', 'report')), '755')
    assert.equal(mode(join(c.dir, 'update', 'request')), '700')
    assert.equal(mode(join(c.dir, 'update', 'state')), '700')
    const r = launch(c, ['web-updates', 'status', '--dir', c.dir])
    assert.equal(r.code, 0, r.stderr)
    assert.match(r.stdout, /Updates from the web are off\./)
  })
})

describe('web-updates enable', () => {
  it('in an installation made by rsc-factory: exit 2, says where to update, touches nothing and calls nothing', async () => {
    const c = await installed()
    const env = readFileSync(join(c.dir, '.env'), 'utf8').replace(
      "RSC_BRAIN_COMPANION='0'",
      "RSC_BRAIN_COMPANION='1'",
    )
    assert.match(env, /RSC_BRAIN_COMPANION='1'/)
    writeFileSync(join(c.dir, '.env'), env)
    const before = readdirSync(c.dir).sort()
    for (const more of [[], ['--yes']]) {
      const r = launch(c, ['web-updates', 'enable', '--dir', c.dir, ...more, ...(more.length ? [] : [])])
      assert.equal(r.code, 2, r.stderr)
      assert.match(r.stderr, /rsc-brain was installed by rsc-factory: update it from there\./)
      assert.deepEqual(r.calls, [], 'not even a question to docker')
    }
    assert.deepEqual(readdirSync(c.dir).sort(), before)
    assert.equal(existsSync(join(c.dir, 'updater')), false)
  })

  it('status and disable in such an installation still work (disable has nothing to do)', async () => {
    const c = await installed()
    writeFileSync(
      join(c.dir, '.env'),
      readFileSync(join(c.dir, '.env'), 'utf8').replace("COMPANION='0'", "COMPANION='1'"),
    )
    assert.equal(launch(c, ['web-updates', 'status', '--dir', c.dir]).code, 0)
    assert.equal(launch(c, ['web-updates', 'disable', '--dir', c.dir]).code, 0)
  })

  it('warns that whoever controls it controls the server; without --yes and without a terminal it is exit 2 and nothing is made', async () => {
    const c = await installed()
    const r = launch(c, ['web-updates', 'enable', '--dir', c.dir])
    assert.equal(r.code, 2, r.stderr)
    assert.match(r.stderr, /controls this server/)
    assert.match(r.stderr, /--yes/)
    assert.equal(existsSync(join(c.dir, 'updater')), false)
    assert.equal(upd(r.calls).length, 0)
    assert.equal(
      r.calls.some((l) => /^build /.test(l)),
      false,
    )
  })

  it('asked and answered no: exit 1, nothing made', async () => {
    const c = await installed()
    const r = launch(c, ['web-updates', 'enable', '--dir', c.dir], { answers: 'n\n' })
    assert.equal(r.code, 1, r.stderr)
    assert.match(r.stderr, /controls this server/)
    assert.equal(existsSync(join(c.dir, 'updater')), false)
  })

  it('answered yes: it goes on', async () => {
    const c = await installed()
    const r = launch(c, ['web-updates', 'enable', '--dir', c.dir], { answers: 'y\n' })
    assert.equal(r.code, 0, r.stderr)
    assert.equal(existsSync(join(c.dir, 'updater', 'loop.sh')), true)
  })

  it('--yes: builds the image, proves the access from a container, starts a project of its own, in that order', async () => {
    const c = await installed()
    const r = launch(c, enable(c))
    assert.equal(r.code, 0, r.stderr)
    assert.match(r.stderr, /controls this server/)
    const calls = r.calls
    const idx = (re: RegExp, from = 0) => {
      const i = calls.slice(from).findIndex((l) => re.test(l))
      assert.ok(i >= 0, `missing: ${re}\n${calls.join('\n')}`)
      return i + from
    }
    const build = idx(new RegExp(`^build -t ${IMG} -$`))
    const access = idx(/^run --rm .*sh .*\/updater\/loop\.sh --access$/, build)
    const up = idx(new RegExp(`^compose .*-p ${PROJECT} .* up -d`), access)
    assert.ok(build < access && access < up)
    // Everything compose was told about is the updater's project and its file; the service's is never named.
    const compose = calls.filter((l) => l.startsWith('compose ') && !l.startsWith('compose version'))
    assert.ok(compose.length > 0)
    for (const l of compose) {
      assert.match(l, new RegExp(`-p ${PROJECT} `), l)
      assert.ok(l.includes(`-f ${c.dir}/updater/compose.updater.yaml`), l)
    }
    assert.equal(
      calls.some((l) => / (stop|down) /.test(l) && !l.includes(PROJECT)),
      false,
      'the service is left as it was',
    )
    assert.equal(
      calls.some((l) => /^compose .*(rm|up).* (app|door)\b/.test(l)),
      false,
    )
    // The access test runs as the owner, with the installation in its own path, and no socket.
    const run = calls[access] as string
    assert.ok(run.includes(`-v ${c.dir}:${c.dir}`), run)
    assert.equal(run.includes('docker.sock'), false, run)
    assert.match(run, /-u \d+:\d+/)
    assert.equal(existsSync(join(c.state, 'updater-up')), true)
  })

  it('leaves its files where the container reads them, with the modes that keep them from the web', async () => {
    const c = await installed()
    const r = launch(c, enable(c))
    assert.equal(r.code, 0, r.stderr)
    const u = join(c.dir, 'updater')
    assert.equal(mode(u), '700')
    for (const f of [
      'loop.sh',
      'credentials.sh',
      'rsc-brain.sh',
      'Dockerfile',
      'compose.updater.yaml',
      'updater.env',
      'passwd',
    ]) {
      assert.equal(existsSync(join(u, f)), true, f)
    }
    assert.equal(mode(join(u, 'credentials')), '700')
    assert.equal(mode(join(u, 'home')), '700')
    assert.equal(mode(join(c.dir, 'update', 'state')), '700')
    const e = readFileSync(join(u, 'updater.env'), 'utf8')
    const own = readEnv(c.dir)
    // The owner of the settings: what the updater writes stays theirs.
    const owner = statSync(join(c.dir, '.env'))
    assert.match(e, new RegExp(`RSC_BRAIN_UPDATER_DIR='${c.dir}'`))
    assert.match(e, new RegExp(`RSC_BRAIN_UPDATER_UID='${owner.uid}'`))
    assert.match(e, new RegExp(`RSC_BRAIN_UPDATER_GID='${owner.gid}'`))
    assert.match(e, /RSC_BRAIN_UPDATER_SOCKET_GID='999'/)
    assert.match(e, /RSC_BRAIN_UPDATER_HOSTNAME='rsc-brain-updater'/)
    assert.match(e, new RegExp(`RSC_BRAIN_UPDATER_IMAGE='${IMG}'`))
    assert.match(
      readFileSync(join(u, 'passwd'), 'utf8'),
      new RegExp(`^root:x:0:0:.*\\nupdater:x:${owner.uid}:${owner.gid}:`),
    )
    // The installation key is in .env, which the updater reads as the launcher does; it is not copied anywhere else.
    for (const f of everyFile(u))
      assert.equal(readFileSync(f, 'utf8').includes(own.RSC_BRAIN_SECRET as string), false, f)
  })

  it('the credential of a file: copied to one place for its owner, and nowhere else, not on a command line, not in a log', async () => {
    const c = await installed()
    const f = tokenFile(c)
    const r = launch(c, enable(c, '--repo-token-file', f), { env: { FAKE_STDIN: c.stdin } })
    assert.equal(r.code, 0, r.stderr)
    const kept = join(c.dir, 'updater', 'credentials', 'token')
    assert.equal(readFileSync(kept, 'utf8'), `${TOKEN}\n`)
    assert.equal(mode(kept), '600')
    assert.equal(readFileSync(f, 'utf8'), `${TOKEN}\n`, 'the file given is left as it was')
    assert.equal(r.calls.join('\n').includes(TOKEN), false)
    assert.equal((r.stdout + r.stderr).includes(TOKEN), false)
    assert.equal(r.piped.includes(TOKEN), false)
    for (const p of everyFile(c.dir)) {
      if (p === kept) continue
      assert.equal(readFileSync(p, 'utf8').includes(TOKEN), false, p)
    }
  })

  it('a key file: copied the same way', async () => {
    const c = await installed(['--repo', 'git@github.com:acme/brain.git'])
    const r = launch(c, enable(c, '--repo-key', keyFile(c)))
    assert.equal(r.code, 0, r.stderr)
    const kept = join(c.dir, 'updater', 'credentials', 'key')
    assert.equal(readFileSync(kept, 'utf8'), KEY)
    assert.equal(mode(kept), '600')
    assert.equal(r.calls.join('\n').includes('QUJDREVGR0hJSktMTU5PUA'), false)
  })

  it('a token it does not accept: exit 2, nothing made, and the reason says it is the token', async () => {
    const c = await installed()
    const bad: Array<[string, string]> = [
      ['a second line', `${TOKEN}\nmore\n`],
      ['three lines', `${TOKEN}\nmore\nmore\n`],
      ['a space', 'ghp abc def ghi jkl\n'],
      ['nothing', '\n'],
      ['too short', 'abc\n'],
      ['a quote', `${TOKEN}'\n`],
      ['a dollar sign', `${TOKEN}$HOME\n`],
    ]
    for (const [why, text] of bad) {
      const r = launch(c, enable(c, '--repo-token-file', tokenFile(c, text)))
      assert.equal(r.code, 2, `${why}: ${r.stderr}`)
      assert.match(r.stderr, /--repo-token-file takes one line/, why)
      assert.equal(existsSync(join(c.dir, 'updater')), false, why)
      assert.equal(
        r.calls.some((l) => /^build /.test(l)),
        false,
        why,
      )
      assert.equal((r.stdout + r.stderr).includes(TOKEN), false, why)
    }
    const gone = launch(c, enable(c, '--repo-token-file', join(c.files, 'nope')))
    assert.equal(gone.code, 2, gone.stderr)
    assert.match(gone.stderr, /--repo-token-file takes a file/)
    const both = launch(c, enable(c, '--repo-token-file', tokenFile(c), '--repo-key', keyFile(c)))
    assert.equal(both.code, 2, both.stderr)
    assert.match(both.stderr, /not both/)
    const none = launch(c, enable(c, '--repo-key'))
    assert.equal(none.code, 2, none.stderr)
    // One that is fine goes through, at the largest size a token may have.
    const ok = launch(c, enable(c, '--repo-token-file', tokenFile(c, `${'a'.repeat(255)}\n`)))
    assert.equal(ok.code, 0, ok.stderr)
    const over = launch(c, enable(c, '--repo-token-file', tokenFile(c, `${'a'.repeat(256)}\n`)))
    assert.equal(over.code, 2, over.stderr)
  })

  it('a key it does not accept: exit 2, nothing made; the PEM kinds it does', async () => {
    const c = await installed(['--repo', 'git@github.com:acme/brain.git'])
    const pem = (kind: string, body = 'QUJD\n') => `-----BEGIN ${kind}-----\n${body}-----END ${kind}-----\n`
    const bad: Array<[string, string]> = [
      ['plain text', 'hello\n'],
      ['a certificate', pem('CERTIFICATE')],
      ['a public key', pem('PUBLIC KEY')],
      ['text after the header', `-----BEGIN OPENSSH PRIVATE KEY----- x\n${'QUJD\n'}`],
      ['text before the header', `x\n${pem('OPENSSH PRIVATE KEY')}`],
      ['too large', pem('OPENSSH PRIVATE KEY', `${'A'.repeat(100)}\n`.repeat(200))],
    ]
    for (const [why, text] of bad) {
      const f = join(c.files, `key-${++fileNo}`)
      writeFileSync(f, text, { mode: 0o600 })
      const r = launch(c, enable(c, '--repo-key', f))
      assert.equal(r.code, 2, `${why}: ${r.stderr}`)
      assert.match(r.stderr, /--repo-key takes an SSH private key/, why)
      assert.equal(existsSync(join(c.dir, 'updater')), false, why)
    }
    const gone = launch(c, enable(c, '--repo-key', join(c.files, 'nope')))
    assert.equal(gone.code, 2, gone.stderr)
    for (const kind of ['OPENSSH PRIVATE KEY', 'RSA PRIVATE KEY', 'EC PRIVATE KEY', 'PRIVATE KEY']) {
      const f = join(c.files, `key-${++fileNo}`)
      writeFileSync(f, pem(kind), { mode: 0o600 })
      const r = launch(c, enable(c, '--repo-key', f))
      assert.equal(r.code, 0, `${kind}: ${r.stderr}`)
    }
    // Just under the size limit goes through.
    const f = join(c.files, `key-${++fileNo}`)
    const head = '-----BEGIN OPENSSH PRIVATE KEY-----\n'
    writeFileSync(f, head + 'A'.repeat(16384 - head.length - 1) + '\n', { mode: 0o600 })
    assert.equal(statSync(f).size, 16384)
    assert.equal(launch(c, enable(c, '--repo-key', f)).code, 0)
  })

  it('an installation folder with a colon or a dollar sign in its path is refused, one test each', async () => {
    for (const ch of [':', '$']) {
      const c = fresh()
      const odd = join(dirname(c.dir), `in${ch}stall`)
      const port = String(await freePort())
      const made = launch(c, [
        'install',
        '--local',
        '--yes',
        '--dir',
        odd,
        '--port',
        port,
        '--image',
        'rsc-brain:test',
      ])
      assert.equal(made.code, 0, made.stderr)
      const r = launch(c, ['web-updates', 'enable', '--yes', '--dir', odd])
      assert.equal(r.code, 2, `${ch}: ${r.stderr}`)
      assert.match(r.stderr, /without ':' or '\$' in its path/, ch)
      assert.equal(existsSync(join(odd, 'updater')), false, ch)
      assert.equal(
        r.calls.some((l) => /^build /.test(l)),
        false,
        ch,
      )
    }
  })

  it('a failure on a working updater leaves it working: its files, its credential and its container', async () => {
    const c = await installed()
    const first = tokenFile(c)
    assert.equal(launch(c, enable(c, '--repo-token-file', first)).code, 0)
    const loop = join(c.dir, 'updater', 'loop.sh')
    appendFileSync(loop, '# the one that was running\n')
    const kept = readFileSync(loop, 'utf8')
    const other = tokenFile(c, 'ghp_AnotherTokenValue99887766\n')
    const cases: Array<[string, Record<string, string>, number]> = [
      ['the repository does not answer', { FAKE_ACCESS_EXIT: '1' }, 3],
      ['the image does not build', { FAKE_BUILD_EXIT: '1' }, 4],
      ['the container does not start', { FAKE_UPDATER_UP_EXIT: '1' }, 4],
      ['the container is stopped by a start that fails', { FAKE_UPDATER_UP_FAIL_ONCE: '1' }, 4],
    ]
    for (const [why, env, code] of cases) {
      const r = launch(c, enable(c, '--repo-token-file', other), { env })
      assert.equal(r.code, code, `${why}: ${r.stderr}`)
      assert.equal(readFileSync(join(c.dir, 'updater', 'credentials', 'token'), 'utf8'), `${TOKEN}\n`, why)
      assert.equal(readFileSync(loop, 'utf8'), kept, `${why}: its files are the ones that were running`)
      assert.equal(existsSync(join(c.state, 'updater-up')), true, why)
      assert.equal(
        upd(r.calls).some((l) => / down /.test(l)),
        false,
        `${why}: not stopped`,
      )
      assert.equal(
        r.calls.some((l) => l.startsWith('image rm')),
        false,
        `${why}: its image stays`,
      )
      assert.equal(existsSync(join(c.dir, 'updater', 'previous')), false, `${why}: nothing left over`)
      assert.equal((r.stdout + r.stderr).includes('AnotherToken'), false, why)
    }
    // And a run that goes well replaces the credential and leaves nothing over.
    const ok = launch(c, enable(c, '--repo-token-file', other))
    assert.equal(ok.code, 0, ok.stderr)
    assert.match(readFileSync(join(c.dir, 'updater', 'credentials', 'token'), 'utf8'), /AnotherToken/)
    assert.equal(existsSync(join(c.dir, 'updater', 'credentials.old')), false)
    assert.deepEqual(filesWith(c.dir, TOKEN), [], 'the one it replaced is nowhere')
    assert.equal(existsSync(join(c.dir, 'updater', 'previous')), false)
  })

  const OTHER = 'ghp_AnotherTokenValue99887766'
  const filesWith = (dir: string, text: string) =>
    everyFile(dir).filter((f) => readFileSync(f, 'utf8').includes(text))
  // An enable that was killed outright (SIGKILL, a power cut) while it started the container.
  const killedEnable = async (c: Case, token: string) => {
    const child = spawn(shell(), [LAUNCHER, ...enable(c, '--repo-token-file', tokenFile(c, `${token}\n`))], {
      stdio: 'ignore',
      detached: true,
      env: {
        PATH: `${FAKEBIN}:${SYSBIN}`,
        HOME: c.home,
        FAKE_LOG: c.log,
        FAKE_STDIN: c.stdin,
        FAKE_STATE: c.state,
        FAKE_UPDATER_UP_SLEEP: '30',
      },
    })
    for (let i = 0; i < 200 && !existsSync(join(c.state, 'updater-up-started')); i++)
      await new Promise((r) => setTimeout(r, 50))
    assert.equal(existsSync(join(c.state, 'updater-up-started')), true, 'it was starting the container')
    const closed = new Promise((resolve) => child.on('exit', resolve))
    process.kill(-(child.pid as number), 'SIGKILL')
    await closed
    rmSync(join(c.state, 'updater-up-started'))
  }

  it('an enable killed outright leaves no credential that disable would not remove', async () => {
    const c = await installed()
    assert.equal(launch(c, enable(c, '--repo-token-file', tokenFile(c))).code, 0)
    await killedEnable(c, OTHER)
    rmSync(join(c.dir, '.rsc-brain', 'lock'), { recursive: true, force: true })
    const r = launch(c, ['web-updates', 'disable', '--dir', c.dir])
    assert.equal(r.code, 0, r.stderr)
    for (const secret of [TOKEN, 'AnotherToken']) assert.deepEqual(filesWith(c.dir, secret), [], secret)
    assert.equal(existsSync(join(c.dir, 'updater')), false)
  })

  it('an enable killed outright leaves no credential that uninstall would not remove', async () => {
    const c = await installed()
    assert.equal(launch(c, enable(c, '--repo-token-file', tokenFile(c))).code, 0)
    await killedEnable(c, OTHER)
    rmSync(join(c.dir, '.rsc-brain', 'lock'), { recursive: true, force: true })
    assert.equal(launch(c, ['uninstall', '--dir', c.dir]).code, 0)
    for (const secret of [TOKEN, 'AnotherToken']) assert.deepEqual(filesWith(c.dir, secret), [], secret)
  })

  it('the next enable after a killed one goes back to the last working state first, then does its own work', async () => {
    const c = await installed()
    assert.equal(launch(c, enable(c, '--repo-token-file', tokenFile(c))).code, 0)
    await killedEnable(c, OTHER)
    rmSync(join(c.dir, '.rsc-brain', 'lock'), { recursive: true, force: true })
    const r = launch(c, enable(c))
    assert.equal(r.code, 0, r.stderr)
    assert.equal(
      readFileSync(join(c.dir, 'updater', 'credentials', 'token'), 'utf8'),
      `${TOKEN}\n`,
      'the credential of the working one',
    )
    assert.deepEqual(filesWith(c.dir, 'AnotherToken'), [])
    for (const left of ['previous', 'credentials.old'])
      assert.equal(existsSync(join(c.dir, 'updater', left)), false, left)
  })

  it('disable removes every copy of the credential, also when another launcher is at work', async () => {
    const c = await installed()
    launch(c, enable(c, '--repo-token-file', tokenFile(c)))
    for (const left of ['credentials.old', 'previous/credentials']) {
      mkdirSync(join(c.dir, 'updater', left), { recursive: true })
      writeFileSync(join(c.dir, 'updater', left, 'token'), `${OTHER}\n`)
    }
    mkdirSync(join(c.dir, '.rsc-brain', 'lock'), { recursive: true })
    writeFileSync(
      join(c.dir, '.rsc-brain', 'lock', 'owner'),
      `${process.pid} ${spawnSync('uname', ['-n'], { encoding: 'utf8' }).stdout.trim()}\n`,
    )
    const busy = launch(c, ['web-updates', 'disable', '--dir', c.dir])
    assert.equal(busy.code, 3, busy.stderr)
    for (const secret of [TOKEN, 'AnotherToken'])
      assert.deepEqual(filesWith(c.dir, secret), [], `${secret}: gone before the lock`)
  })

  it('a copy that fails partway leaves no partial copy and the updater as it was', async (t) => {
    if (process.getuid?.() === 0) return t.skip('root reads anything')
    const c = await installed()
    assert.equal(launch(c, enable(c, '--repo-token-file', tokenFile(c))).code, 0)
    chmodSync(join(c.dir, 'updater', 'passwd'), 0)
    try {
      const r = launch(c, enable(c, '--repo-token-file', tokenFile(c, `${OTHER}\n`)))
      assert.equal(r.code, 4, r.stderr)
    } finally {
      chmodSync(join(c.dir, 'updater', 'passwd'), 0o644)
    }
    assert.equal(existsSync(join(c.dir, 'updater', 'previous.tmp')), false, 'the partial copy is removed')
    assert.equal(existsSync(join(c.dir, 'updater', 'previous')), false)
    assert.equal(existsSync(join(c.dir, 'updater', 'credentials.old')), false)
    assert.equal(readFileSync(join(c.dir, 'updater', 'credentials', 'token'), 'utf8'), `${TOKEN}\n`)
    assert.deepEqual(filesWith(c.dir, 'AnotherToken'), [])
    assert.equal(existsSync(join(c.state, 'updater-up')), true)
  })

  it('a token one character short and a key one byte over are refused, the shortest token goes', async () => {
    const c = await installed()
    assert.equal(
      launch(c, enable(c, '--repo-token-file', tokenFile(c, `${'a'.repeat(7)}\n`))).code,
      2,
      '7 characters',
    )
    assert.equal(
      launch(c, enable(c, '--repo-token-file', tokenFile(c, `${'a'.repeat(8)}\n`))).code,
      0,
      '8 characters',
    )
    const k = await installed(['--repo', 'git@github.com:acme/brain.git'])
    const head = '-----BEGIN OPENSSH PRIVATE KEY-----\n'
    const key = (size: number) => {
      const f = join(k.files, `key-${++fileNo}`)
      writeFileSync(f, head + 'A'.repeat(size - head.length - 1) + '\n', { mode: 0o600 })
      assert.equal(statSync(f).size, size)
      return f
    }
    assert.equal(launch(k, enable(k, '--repo-key', key(16385))).code, 2, '16385 bytes')
  })

  it('a copy cut short is never trusted: it is built apart, and the next enable throws it away', async () => {
    const c = await installed()
    assert.equal(launch(c, enable(c, '--repo-token-file', tokenFile(c))).code, 0)
    // What an enable cut during the copy leaves: a temporary folder with a truncated file in it.
    mkdirSync(join(c.dir, 'updater', 'previous.tmp'), { recursive: true })
    for (const f of ['updater.env', 'loop.sh', 'passwd'])
      writeFileSync(join(c.dir, 'updater', 'previous.tmp', f), 'RSC_BRA')
    const live = readFileSync(join(c.dir, 'updater', 'updater.env'), 'utf8')
    const r = launch(c, enable(c, '--repo-token-file', tokenFile(c, `${OTHER}\n`)), {
      env: { FAKE_ACCESS_EXIT: '1' },
    })
    assert.equal(r.code, 3, r.stderr)
    assert.equal(existsSync(join(c.dir, 'updater', 'previous.tmp')), false, 'thrown away')
    assert.equal(existsSync(join(c.dir, 'updater', 'previous')), false)
    assert.equal(readFileSync(join(c.dir, 'updater', 'updater.env'), 'utf8'), live, 'the live file is whole')
    assert.notEqual(readFileSync(join(c.dir, 'updater', 'passwd'), 'utf8'), 'RSC_BRA')
  })

  it('disable and uninstall remove the temporary folder too', async () => {
    for (const cmd of [['web-updates', 'disable'], ['uninstall']]) {
      const c = await installed()
      launch(c, enable(c))
      mkdirSync(join(c.dir, 'updater', 'previous.tmp'), { recursive: true })
      writeFileSync(join(c.dir, 'updater', 'previous.tmp', 'updater.env'), 'RSC_BRA')
      assert.equal(launch(c, [...cmd, '--dir', c.dir]).code, 0)
      assert.equal(existsSync(join(c.dir, 'updater')), false, cmd.join(' '))
    }
    // And the one that is turned off while another launcher holds the lock.
    const c = await installed()
    launch(c, enable(c))
    mkdirSync(join(c.dir, 'updater', 'previous.tmp'), { recursive: true })
    mkdirSync(join(c.dir, '.rsc-brain', 'lock'), { recursive: true })
    writeFileSync(
      join(c.dir, '.rsc-brain', 'lock', 'owner'),
      `${process.pid} ${spawnSync('uname', ['-n'], { encoding: 'utf8' }).stdout.trim()}\n`,
    )
    assert.equal(launch(c, ['web-updates', 'disable', '--dir', c.dir]).code, 3)
    assert.equal(existsSync(join(c.dir, 'updater', 'previous.tmp')), false)
  })

  it('a failed enable puts back updater.env, the one that was running', async () => {
    const c = await installed()
    assert.equal(launch(c, enable(c)).code, 0)
    const env = join(c.dir, 'updater', 'updater.env')
    appendFileSync(env, '# the one that was running\n')
    const kept = readFileSync(env, 'utf8')
    const r = launch(c, enable(c), { env: { FAKE_ACCESS_EXIT: '1' } })
    assert.equal(r.code, 3, r.stderr)
    assert.equal(readFileSync(env, 'utf8'), kept)
  })

  it('a stop (Ctrl-C) while turning it on again leaves the working updater as it was', async () => {
    const c = await installed()
    assert.equal(launch(c, enable(c, '--repo-token-file', tokenFile(c))).code, 0)
    const child = spawn(
      shell(),
      [LAUNCHER, ...enable(c, '--repo-token-file', tokenFile(c, 'ghp_AnotherTokenValue99887766\n'))],
      {
        stdio: 'ignore',
        detached: true,
        env: {
          PATH: `${FAKEBIN}:${SYSBIN}`,
          HOME: c.home,
          FAKE_LOG: c.log,
          FAKE_STDIN: c.stdin,
          FAKE_STATE: c.state,
          FAKE_UPDATER_UP_SLEEP: '30',
        },
      },
    )
    for (let i = 0; i < 200 && !existsSync(join(c.state, 'updater-up-started')); i++)
      await new Promise((r) => setTimeout(r, 50))
    assert.equal(existsSync(join(c.state, 'updater-up-started')), true, 'it was starting the container')
    const closed = new Promise((resolve) => child.on('exit', resolve))
    // The terminal's Ctrl-C reaches the whole group: the launcher and the docker it waits for.
    process.kill(-(child.pid as number), 'SIGINT')
    await closed
    assert.equal(readFileSync(join(c.dir, 'updater', 'credentials', 'token'), 'utf8'), `${TOKEN}\n`)
    assert.equal(existsSync(join(c.state, 'updater-up')), true)
  })

  it('a token goes with an https address and a key with an ssh one', async () => {
    const ssh = await installed(['--repo', 'git@github.com:acme/brain.git'])
    const token = launch(ssh, enable(ssh, '--repo-token-file', tokenFile(ssh)))
    assert.equal(token.code, 2, token.stderr)
    const https = await installed(['--repo', 'https://github.com/acme/brain'])
    const key = launch(https, enable(https, '--repo-key', keyFile(https)))
    assert.equal(key.code, 2, key.stderr)
    for (const c of [ssh, https]) assert.equal(existsSync(join(c.dir, 'updater')), false)
  })

  it('the repository does not answer with that access: exit 3, nothing running, the credential gone', async () => {
    const c = await installed()
    const r = launch(c, enable(c, '--repo-token-file', tokenFile(c)), { env: { FAKE_ACCESS_EXIT: '1' } })
    assert.equal(r.code, 3, r.stderr)
    assert.match(r.stderr, /does not answer with that access/)
    assert.equal(existsSync(join(c.dir, 'updater')), false, 'no credential left')
    assert.equal(
      upd(r.calls).some((l) => / up /.test(l)),
      false,
    )
    assert.equal(existsSync(join(c.state, 'updater-up')), false)
    assert.equal((r.stdout + r.stderr).includes(TOKEN), false)
  })

  it('the updater does not start: exit 4, what it made is removed, and the service is as it was', async () => {
    const c = await installed()
    const r = launch(c, enable(c, '--repo-token-file', tokenFile(c)), { env: { FAKE_UPDATER_UP_EXIT: '1' } })
    assert.equal(r.code, 4, r.stderr)
    assert.equal(existsSync(join(c.dir, 'updater')), false)
    assert.ok(
      r.calls.some((l) => l.startsWith('image rm') && l.includes(IMG)),
      r.calls.join('\n'),
    )
    assert.ok(upd(r.calls).some((l) => / down /.test(l)))
    assert.equal(existsSync(join(c.state, 'up')), true, 'the service still runs')
  })

  it('an image that does not build: exit 4 and nothing left', async () => {
    const c = await installed()
    const r = launch(c, enable(c), { env: { FAKE_BUILD_EXIT: '1' } })
    assert.equal(r.code, 4, r.stderr)
    assert.equal(existsSync(join(c.dir, 'updater')), false)
  })

  it('without docker or without git: exit 3 and nothing made', async () => {
    const c = await installed()
    const r = launch(c, enable(c), { env: { FAKE_INFO_EXIT: '1' } })
    assert.equal(r.code, 3, r.stderr)
    assert.equal(existsSync(join(c.dir, 'updater')), false)
  })

  it('no installation there: exit 3', () => {
    const c = fresh()
    const r = launch(c, enable(c))
    assert.equal(r.code, 3, r.stderr)
  })

  it('another launcher at work: exit 3, nothing made', async () => {
    const c = await installed()
    mkdirSync(join(c.dir, '.rsc-brain', 'lock'), { recursive: true })
    writeFileSync(
      join(c.dir, '.rsc-brain', 'lock', 'owner'),
      `${process.pid} ${spawnSync('uname', ['-n'], { encoding: 'utf8' }).stdout.trim()}\n`,
    )
    const r = launch(c, enable(c))
    assert.equal(r.code, 3, r.stderr)
    assert.equal(existsSync(join(c.dir, 'updater')), false)
  })

  it('run again, it keeps the credential it has when no other is given, and leaves one updater', async () => {
    const c = await installed()
    launch(c, enable(c, '--repo-token-file', tokenFile(c)))
    const r = launch(c, enable(c))
    assert.equal(r.code, 0, r.stderr)
    assert.equal(readFileSync(join(c.dir, 'updater', 'credentials', 'token'), 'utf8'), `${TOKEN}\n`)
    assert.equal(existsSync(join(c.state, 'updater-up')), true)
  })

  it('options that belong to other commands are refused', async () => {
    const c = await installed()
    for (const args of [
      ['status', '--repo-key', 'x'],
      ['web-updates', 'status', '--repo-token-file', 'x'],
      ['web-updates', 'disable', '--repo-key', 'x'],
      ['web-updates'],
      ['web-updates', 'launch'],
    ]) {
      const r = launch(c, [...args, '--dir', c.dir])
      assert.equal(r.code, 2, `${args.join(' ')}: ${r.stderr}`)
    }
  })
})

describe('web-updates status and disable (CA26)', () => {
  it('status says on while the updater runs, and off after disable', async () => {
    const c = await installed()
    launch(c, enable(c))
    const on = launch(c, ['web-updates', 'status', '--dir', c.dir])
    assert.equal(on.code, 0, on.stderr)
    assert.match(on.stdout, /Updates from the web are on\./)
    const off = launch(c, ['web-updates', 'disable', '--dir', c.dir])
    assert.equal(off.code, 0, off.stderr)
    assert.match(off.stdout, /Updates from the web are off\./)
    assert.match(off.stdout, /sh rsc-brain\.sh update/)
    assert.match(launch(c, ['web-updates', 'status', '--dir', c.dir]).stdout, /are off\./)
  })

  it('disable: no container, no credential, no report of the updater; the service and its copies are untouched', async () => {
    const c = await installed()
    launch(c, enable(c, '--repo-token-file', tokenFile(c)))
    writeFileSync(join(c.dir, 'update', 'report', 'updater.json'), '{}')
    writeFileSync(join(c.dir, 'update', 'report', 'check.json'), '{}')
    writeFileSync(join(c.dir, 'update', 'request', 'request'), '')
    writeFileSync(join(c.dir, 'update', 'request', 'retry'), '')
    mkdirSync(join(c.dir, 'update', 'state', 'attempts'), { recursive: true })
    writeFileSync(join(c.dir, 'update', 'state', 'attempts', 'v9.9.9'), 'FAILED_AT=1\n')
    const before = readdirSync(join(c.dir, 'backups')).sort()
    const r = launch(c, ['web-updates', 'disable', '--dir', c.dir], { env: { FAKE_UPDATER_LEFT: '1' } })
    assert.equal(r.code, 0, r.stderr)
    assert.ok(
      r.calls.includes('rm -f l3ft'),
      `a container compose no longer knows is removed by id\n${r.calls.join('\n')}`,
    )
    assert.deepEqual(readdirSync(join(c.dir, 'update', 'state')), [], 'what it remembered goes too')
    assert.equal(mode(join(c.dir, 'update', 'state')), '700')
    assert.equal(existsSync(join(c.dir, 'update', 'request', 'retry')), false)
    assert.ok(upd(r.calls).some((l) => / down /.test(l)))
    assert.ok(r.calls.some((l) => l.startsWith('image rm') && l.includes(IMG)))
    assert.equal(existsSync(join(c.dir, 'updater')), false, 'credentials included')
    assert.equal(existsSync(join(c.dir, 'update', 'report', 'updater.json')), false)
    assert.equal(existsSync(join(c.dir, 'update', 'report', 'check.json')), false)
    assert.equal(existsSync(join(c.dir, 'update', 'request', 'request')), false)
    assert.equal(existsSync(join(c.state, 'updater-up')), false)
    assert.equal(existsSync(join(c.state, 'up')), true)
    assert.deepEqual(readdirSync(join(c.dir, 'backups')).sort(), before)
    assert.equal(
      r.calls.some((l) => / (stop|down) /.test(l) && !l.includes(PROJECT)),
      false,
    )
  })

  it('disable twice, and disable when it was never on: exit 0', async () => {
    const c = await installed()
    assert.equal(launch(c, ['web-updates', 'disable', '--dir', c.dir]).code, 0)
    launch(c, enable(c))
    assert.equal(launch(c, ['web-updates', 'disable', '--dir', c.dir]).code, 0)
    assert.equal(launch(c, ['web-updates', 'disable', '--dir', c.dir]).code, 0)
  })

  it('disable removes the credential even when Docker is not running', async () => {
    const c = await installed()
    launch(c, enable(c, '--repo-token-file', tokenFile(c)))
    const r = launch(c, ['web-updates', 'disable', '--dir', c.dir], { env: { FAKE_INFO_EXIT: '1' } })
    assert.equal(existsSync(join(c.dir, 'updater', 'credentials')), false)
    assert.notEqual(r.code, 0, 'it says it could not stop the container')
    assert.match(r.stderr, /credential/i)
  })

  it('disable killed while the container stops: the credential is already gone', async () => {
    const c = await installed()
    launch(c, enable(c, '--repo-token-file', tokenFile(c)))
    const child = spawn(shell(), [LAUNCHER, 'web-updates', 'disable', '--dir', c.dir], {
      stdio: 'ignore',
      env: {
        PATH: `${FAKEBIN}:${SYSBIN}`,
        HOME: c.home,
        FAKE_LOG: c.log,
        FAKE_STDIN: c.stdin,
        FAKE_STATE: c.state,
        FAKE_UPDATER_DOWN_SLEEP: '30',
      },
    })
    for (let i = 0; i < 200 && !existsSync(join(c.state, 'updater-down-started')); i++)
      await new Promise((r) => setTimeout(r, 50))
    assert.equal(existsSync(join(c.state, 'updater-down-started')), true, 'it was stopping the container')
    child.kill('SIGKILL')
    assert.equal(existsSync(join(c.dir, 'updater', 'credentials')), false)
  })

  it('disable with another launcher at work: exit 3, and the credential is already gone', async () => {
    const c = await installed()
    launch(c, enable(c, '--repo-token-file', tokenFile(c)))
    mkdirSync(join(c.dir, '.rsc-brain', 'lock'), { recursive: true })
    writeFileSync(
      join(c.dir, '.rsc-brain', 'lock', 'owner'),
      `${process.pid} ${spawnSync('uname', ['-n'], { encoding: 'utf8' }).stdout.trim()}\n`,
    )
    const r = launch(c, ['web-updates', 'disable', '--dir', c.dir])
    assert.equal(r.code, 3, r.stderr)
    assert.equal(existsSync(join(c.dir, 'updater', 'credentials')), false)
  })

  const busyLock = (c: Case) => {
    mkdirSync(join(c.dir, '.rsc-brain', 'lock'), { recursive: true })
    writeFileSync(
      join(c.dir, '.rsc-brain', 'lock', 'owner'),
      `${process.pid} ${spawnSync('uname', ['-n'], { encoding: 'utf8' }).stdout.trim()}\n`,
    )
  }

  it('a disable that cannot get the lock leaves a «disabling» mark, does not say nothing changed, and status says it is not finished', async () => {
    const c = await installed()
    launch(c, enable(c, '--repo-token-file', tokenFile(c)))
    busyLock(c)
    const r = launch(c, ['web-updates', 'disable', '--dir', c.dir])
    assert.equal(r.code, 3, r.stderr)
    assert.equal(
      existsSync(join(c.dir, 'updater', 'disabling')),
      true,
      'the loop is told before the lock is asked for',
    )
    assert.doesNotMatch(r.stderr + r.stdout, /Nothing was changed/)
    assert.match(r.stderr, /credential is removed/i)
    assert.match(r.stderr, /web-updates disable/)
    const st = launch(c, ['web-updates', 'status', '--dir', c.dir])
    assert.match(st.stdout, /disable has not finished/i)
    assert.doesNotMatch(st.stdout, /are on\./)
  })

  it('a finished disable clears the mark with the rest of the updater, and a later status says off', async () => {
    const c = await installed()
    launch(c, enable(c, '--repo-token-file', tokenFile(c)))
    assert.equal(launch(c, ['web-updates', 'disable', '--dir', c.dir]).code, 0)
    assert.equal(existsSync(join(c.dir, 'updater', 'disabling')), false)
    assert.match(launch(c, ['web-updates', 'status', '--dir', c.dir]).stdout, /are off\./)
  })

  it('an enable that does not get the lock leaves the mark; one that has the lock clears it', async () => {
    const c = await installed()
    launch(c, enable(c, '--repo-token-file', tokenFile(c)))
    busyLock(c)
    launch(c, ['web-updates', 'disable', '--dir', c.dir])
    const blocked = launch(c, enable(c))
    assert.equal(blocked.code, 3, blocked.stderr)
    assert.equal(existsSync(join(c.dir, 'updater', 'disabling')), true)
    rmSync(join(c.dir, '.rsc-brain', 'lock'), { recursive: true, force: true })
    const again = launch(c, enable(c))
    assert.equal(again.code, 0, again.stderr)
    assert.equal(existsSync(join(c.dir, 'updater', 'disabling')), false)
  })

  it('an enable that fails does not undo an unfinished disable: the mark stays and status still says so', async () => {
    const c = await installed()
    launch(c, enable(c, '--repo-token-file', tokenFile(c)))
    busyLock(c)
    launch(c, ['web-updates', 'disable', '--dir', c.dir])
    rmSync(join(c.dir, '.rsc-brain', 'lock'), { recursive: true, force: true })
    // The credential is gone, and the repository does not answer without it.
    const r = launch(c, enable(c), { env: { FAKE_ACCESS_EXIT: '1' } })
    assert.equal(r.code, 3, r.stderr)
    assert.equal(existsSync(join(c.dir, 'updater', 'disabling')), true)
    assert.match(launch(c, ['web-updates', 'status', '--dir', c.dir]).stdout, /disable has not finished/i)
  })

  it('uninstall --delete-data removes the folders of the marks and the report too', async () => {
    const c = await installed()
    const r = launch(c, ['uninstall', '--delete-data', '--confirm', 'rsc-brain', '--dir', c.dir])
    assert.equal(r.code, 0, r.stderr)
    assert.equal(existsSync(join(c.dir, 'update')), false)
  })

  it('uninstall takes the updater with it, credential included', async () => {
    const c = await installed()
    launch(c, enable(c, '--repo-token-file', tokenFile(c)))
    const r = launch(c, ['uninstall', '--dir', c.dir])
    assert.equal(r.code, 0, r.stderr)
    assert.ok(upd(r.calls).some((l) => / down /.test(l)))
    assert.equal(existsSync(join(c.dir, 'updater')), false)
    assert.equal(existsSync(join(c.state, 'updater-up')), false)
  })
})

describe('an update keeps the updater current (§3.7)', () => {
  const gitWith = (c: Case, marker: string) => {
    const gitBin = join(c.state, 'gitbin')
    mkdirSync(gitBin, { recursive: true })
    const deploy = join(ROOT, 'deploy')
    writeFileSync(
      join(gitBin, 'git'),
      `#!/bin/sh\nprintf 'git %s\\n' "$*" >>"$FAKE_LOG"\nfor last; do :; done\nmkdir -p "$last/deploy/updater"\ncp "${deploy}/compose.yaml" "${deploy}/Caddyfile" "${deploy}/compose.updater.yaml" "${deploy}/rsc-brain.sh" "$last/deploy/"\ncp "${deploy}/updater/"* "$last/deploy/updater/"\necho '# ${marker}' >>"$last/deploy/updater/loop.sh"\n`,
    )
    chmodSync(join(gitBin, 'git'), 0o755)
    return gitBin
  }
  const bump = (c: Case, gitBin: string, env: Record<string, string> = {}) =>
    launch(
      c,
      ['update', '--yes', '--dir', c.dir, '--version', 'v0.2.0', '--repo', 'ssh://git@example.com/brain.git'],
      {
        env: {
          PATH: `${gitBin}:${FAKEBIN}:${SYSBIN}`,
          FAKE_IMAGES: 'rsc-brain:test',
          FAKE_IMAGE_VERSIONS: `${VERSIONS} rsc-brain:v0.2.0=0.2.0`,
          ...env,
        },
      },
    )

  it('after an update that went well, its files are those of the new version (the container restarts into them)', async () => {
    const c = await installed()
    launch(c, enable(c))
    const r = bump(c, gitWith(c, 'v0.2.0'))
    assert.equal(r.code, 0, r.stderr)
    assert.match(readFileSync(join(c.dir, 'updater', 'loop.sh'), 'utf8'), /# v0\.2\.0\n$/)
    assert.deepEqual(
      readdirSync(join(c.dir, 'updater')).filter((f) => f.endsWith('.new')),
      [],
    )
    assert.equal(mode(join(c.dir, 'updater')), '700')
  })

  it('after one that failed and went back, they are as they were', async () => {
    const c = await installed()
    launch(c, enable(c))
    const before = readFileSync(join(c.dir, 'updater', 'loop.sh'), 'utf8')
    const r = bump(c, gitWith(c, 'v0.2.0'), { FAKE_MIGRATE_FAIL: 'rsc-brain:v0.2.0' })
    assert.equal(r.code, 4, r.stderr)
    assert.equal(readFileSync(join(c.dir, 'updater', 'loop.sh'), 'utf8'), before)
  })

  it('an update by --image does not refresh the updater from a source left by an earlier build', async () => {
    const c = await installed()
    launch(c, enable(c))
    const old = join(c.dir, '.rsc-brain', 'src', 'deploy')
    mkdirSync(join(old, 'updater'), { recursive: true })
    for (const f of ['loop.sh', 'credentials.sh', 'Dockerfile'])
      writeFileSync(join(old, 'updater', f), '# stale\n')
    writeFileSync(join(old, 'compose.updater.yaml'), '# stale\n')
    writeFileSync(join(old, 'rsc-brain.sh'), '# stale\n')
    const before = readFileSync(join(c.dir, 'updater', 'loop.sh'), 'utf8')
    const r = launch(c, ['update', '--yes', '--dir', c.dir, '--image', 'rsc-brain:next'])
    assert.equal(r.code, 0, r.stderr)
    assert.equal(readFileSync(join(c.dir, 'updater', 'loop.sh'), 'utf8'), before)
    for (const f of ['compose.updater.yaml', 'rsc-brain.sh']) {
      assert.equal(readFileSync(join(c.dir, 'updater', f), 'utf8').includes('# stale'), false, f)
    }
  })

  it('an installation without the updater is not given one by an update', async () => {
    const c = await installed()
    const r = bump(c, gitWith(c, 'v0.2.0'))
    assert.equal(r.code, 0, r.stderr)
    assert.equal(existsSync(join(c.dir, 'updater')), false)
    assert.equal(
      r.stderr.includes('could not be given the files'),
      false,
      'and it does not complain about it',
    )
  })
})
