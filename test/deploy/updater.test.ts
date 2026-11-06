// The updater of rsc-brain (rsc-updates §3.7, §3.9; T059 for CA27): the loop that runs inside its own container and
// starts `update` when the web leaves a request mark, and what it may reach. No Docker here: the loop runs on this
// machine with a stand-in launcher that records how it was called, one tick at a time (RSC_BRAIN_UPDATER_ONCE=1), with
// a clock the test sets (RSC_BRAIN_UPDATER_NOW). What this pins is the rules of CA20 and CA21: a mark is only looked at
// (never opened: a FIFO does not hang it, a link is not followed, what is written in it means nothing), the update that
// starts is always the same command for the newest published version, a failed version is tried once, then at most
// 3 times more with 15 minutes between them, and nothing a failure says carries a credential. The real containers are
// test/install/updater.test.ts.
import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import {
  chmodSync,
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
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, describe, it } from 'node:test'

const ROOT = new URL('../..', import.meta.url).pathname
const LOOP = join(ROOT, 'deploy', 'updater', 'loop.sh')
const CREDENTIALS = join(ROOT, 'deploy', 'updater', 'credentials.sh')
const COMPOSE_UPDATER = join(ROOT, 'deploy', 'compose.updater.yaml')
const COMPOSE = join(ROOT, 'deploy', 'compose.yaml')
const DOCKERFILE = join(ROOT, 'deploy', 'updater', 'Dockerfile')
const TOKEN = 'ghp_SecretTokenValue0123456789'
const NOW = 1_800_000_000
const SHELLS = (process.env.RSC_BRAIN_TEST_SHELL ?? '/bin/sh').split(',')

let BASE = ''
let FAKE = ''
before(() => {
  BASE = mkdtempSync(join(tmpdir(), 'rscb-updater-'))
  // The stand-in launcher. `update --check --json` answers $FAKE_CHECK (exit $FAKE_CHECK_EXIT); `update --yes` takes
  // $FAKE_UPDATE_SLEEP seconds, says $FAKE_UPDATE_SAYS on its error stream and exits $FAKE_UPDATE_EXIT; `status` is the
  // recovery of a journal. Every call is a line of $FAKE_LOG; an update also writes what it found around it.
  FAKE = join(BASE, 'launcher.sh')
  writeFileSync(
    FAKE,
    `#!/bin/sh
printf '%s\\n' "$*" >>"\${FAKE_LOG:?}"
case "$1" in
status) exit 0 ;;
update)
  case " $* " in
  *" --check "*)
    printf '%s\\n' "\${FAKE_CHECK:-}"
    exit "\${FAKE_CHECK_EXIT:-0}"
    ;;
  esac
  {
    echo "env GIT_ASKPASS=\${GIT_ASKPASS:-}"
    echo "env GIT_SSH_COMMAND=\${GIT_SSH_COMMAND:-}"
    echo "env GIT_TERMINAL_PROMPT=\${GIT_TERMINAL_PROMPT:-}"
    echo "request_mark=$([ -e "\${RSC_BRAIN_UPDATER_DIR}/update/request/request" ] || [ -L "\${RSC_BRAIN_UPDATER_DIR}/update/request/request" ] && echo present || echo gone)"
    echo "running=$(grep -c running "\${RSC_BRAIN_UPDATER_DIR}/update/report/updater.json" 2>/dev/null)"
    env | sed 's/^/ENV /'
  } >>"\${FAKE_LOG}.snapshot"
  trap 'echo forwarded >>"\${FAKE_LOG}.signals"; exit 4' TERM
  if [ -n "\${FAKE_UPDATE_SLEEP:-}" ]; then
    : >"\${FAKE_LOG}.started"
    sleep "$FAKE_UPDATE_SLEEP" &
    wait $!
  fi
  [ -n "\${FAKE_UPDATE_SAYS:-}" ] && printf '%s\\n' "$FAKE_UPDATE_SAYS" >&2
  exit "\${FAKE_UPDATE_EXIT:-0}"
  ;;
esac
exit 0
`,
  )
  chmodSync(FAKE, 0o755)
})
after(() => rmSync(BASE, { recursive: true, force: true }))

let n = 0
type Case = { dir: string; log: string }
const fresh = (): Case => {
  const c = join(BASE, `case-${++n}`)
  const dir = join(c, 'install')
  for (const d of ['update/request', 'update/report', 'update/state', 'updater/credentials', '.rsc-brain'])
    mkdirSync(join(dir, d), { recursive: true })
  writeFileSync(join(dir, '.env'), "RSC_BRAIN_LAUNCHER='1'\nRSC_BRAIN_NAME='rsc-brain'\n")
  writeFileSync(join(c, 'launcher.log'), '')
  return { dir, log: join(c, 'launcher.log') }
}
const NEWER = (to = 'v0.9.0', notes = '- It is faster.') =>
  JSON.stringify({ installed: 'v0.2.0', latest: to, newer: true, notes })
const UP_TO_DATE = JSON.stringify({ installed: 'v0.2.0', latest: 'v0.2.0', newer: false, notes: '' })

type Tick = { code: number | null; stdout: string; stderr: string; calls: string[] }
function tick(
  c: Case,
  env: Record<string, string> = {},
  o: { shell?: string; at?: number; timeout?: number } = {},
): Tick {
  const r = spawnSync(o.shell ?? SHELLS[0] ?? '/bin/sh', [LOOP], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: o.timeout ?? 20_000,
    env: {
      PATH: process.env.PATH ?? '/usr/bin:/bin',
      HOME: join(c.dir, 'updater', 'home'),
      RSC_BRAIN_UPDATER_DIR: c.dir,
      RSC_BRAIN_UPDATER_LAUNCHER: FAKE,
      RSC_BRAIN_UPDATER_ONCE: '1',
      RSC_BRAIN_UPDATER_NOW: String(o.at ?? NOW),
      FAKE_LOG: c.log,
      FAKE_CHECK: NEWER(),
      ...env,
    },
  })
  assert.notEqual(r.signal, 'SIGTERM', `the loop hung: ${r.stderr}`)
  return {
    code: r.status,
    stdout: r.stdout,
    stderr: r.stderr,
    calls: readFileSync(c.log, 'utf8').trim().split('\n').filter(Boolean),
  }
}
const mark = (c: Case, name = 'request') => join(c.dir, 'update', 'request', name)
const report = (c: Case, name: string) =>
  JSON.parse(readFileSync(join(c.dir, 'update', 'report', name), 'utf8'))
const updates = (calls: string[]) => calls.filter((l) => l.startsWith('update') && !l.includes('--check'))
const checks = (calls: string[]) => calls.filter((l) => l.includes('--check'))
const everything = (c: Case) => {
  const out: string[] = []
  const walk = (d: string) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, e.name)
      if (e.isDirectory()) walk(p)
      else if (e.isFile() && !p.includes('/credentials/')) out.push(readFileSync(p, 'utf8'))
    }
  }
  walk(c.dir)
  if (existsSync(c.log)) out.push(readFileSync(c.log, 'utf8'))
  return out.join('\n')
}

for (const shell of SHELLS) {
  const sh = { shell }
  describe(`the updater loop, under ${shell} (CA12b, CA20, CA21)`, () => {
    it('starts by taking back what an interrupted update left: the launcher is asked for its status first', () => {
      const c = fresh()
      writeFileSync(join(c.dir, '.rsc-brain', 'update.pending'), "RSC_BRAIN_UPDATE_PHASE='switched'\n")
      const t = tick(c, {}, sh)
      assert.equal(t.code, 0, t.stderr)
      assert.match(t.calls[0] ?? '', new RegExp(`^status --dir ${c.dir}$`))
    })

    it('says it is alive: updater.json with the time of the beat, written whole', () => {
      const c = fresh()
      const t = tick(c, {}, sh)
      assert.equal(t.code, 0, t.stderr)
      const u = report(c, 'updater.json')
      assert.equal(u.enabled, true)
      assert.equal(u.beatAt, new Date(NOW * 1000).toISOString().replace('.000Z', 'Z'))
      assert.deepEqual(
        readdirSync(join(c.dir, 'update', 'report')).filter((f) => f.endsWith('.new')),
        [],
      )
      assert.equal(statSync(join(c.dir, 'update', 'report', 'updater.json')).mode & 0o777, 0o644)
    })

    it('checks for a new version at the start and then every 6 hours, and writes check.json with the version and the notes', () => {
      const c = fresh()
      const first = tick(c, {}, sh)
      assert.equal(checks(first.calls).length, 1, first.calls.join('\n'))
      assert.equal(checks(first.calls)[0], `update --check --json --dir ${c.dir}`)
      assert.deepEqual(report(c, 'check.json'), {
        checkedAt: new Date(NOW * 1000).toISOString().replace('.000Z', 'Z'),
        ok: true,
        reason: null,
        products: { brain: { latest: 'v0.9.0', notes: '- It is faster.' } },
      })
      const soon = tick(c, {}, { ...sh, at: NOW + 6 * 3600 - 1 })
      assert.equal(checks(soon.calls).length, 1, 'not again before 6 hours')
      const later = tick(c, { FAKE_CHECK: NEWER('v1.0.0', 'Whole.') }, { ...sh, at: NOW + 6 * 3600 })
      assert.equal(checks(later.calls).length, 2)
      assert.equal(report(c, 'check.json').products.brain.latest, 'v1.0.0')
    })

    it('notes with quotes, line breaks and backslashes reach check.json whole', () => {
      const c = fresh()
      const notes = 'He said "go".\n- a \\ b\n- tab\there'
      tick(c, { FAKE_CHECK: NEWER('v0.9.0', notes) }, sh)
      assert.equal(report(c, 'check.json').products.brain.notes, notes)
    })

    it('a check that cannot say: ok false with the reason, and what was known stays', () => {
      const c = fresh()
      tick(c, {}, sh)
      const failed = JSON.stringify({
        installed: 'v0.2.0',
        latest: null,
        newer: false,
        notes: '',
        error: 'no_access',
      })
      tick(c, { FAKE_CHECK: failed, FAKE_CHECK_EXIT: '3' }, { ...sh, at: NOW + 6 * 3600 })
      const k = report(c, 'check.json')
      assert.equal(k.ok, false)
      assert.equal(k.reason, 'no_access')
      assert.deepEqual(k.products, { brain: { latest: 'v0.9.0', notes: '- It is faster.' } })
    })

    it('a check that says nothing readable: ok false, reason network, and no stray file', () => {
      const c = fresh()
      tick(c, { FAKE_CHECK: 'garbage', FAKE_CHECK_EXIT: '1' }, sh)
      const k = report(c, 'check.json')
      assert.equal(k.ok, false)
      assert.equal(k.reason, 'network')
      assert.equal('products' in k, true)
    })

    it('a request: the update starts once, for the version the loop saw, with the same arguments whatever the mark holds', () => {
      const hostile = [
        '',
        '; touch /tmp/rscb-pwned\n--version v9.9.9 --repo ssh://evil/x\n',
        '$(reboot) `id` --image evil:1',
        'x'.repeat(100_000),
      ]
      for (const body of hostile) {
        const c = fresh()
        writeFileSync(mark(c), body)
        const t = tick(c, {}, sh)
        assert.equal(t.code, 0, t.stderr)
        assert.deepEqual(updates(t.calls), [`update --yes --json --dir ${c.dir} --version v0.9.0`])
        assert.equal(existsSync(mark(c)), false, 'the mark is taken')
        assert.equal(existsSync('/tmp/rscb-pwned'), false)
      }
    })

    it('a mark nobody can read still counts: it is looked at, never opened', () => {
      const c = fresh()
      writeFileSync(mark(c), 'x')
      chmodSync(mark(c), 0)
      const t = tick(c, {}, sh)
      assert.equal(updates(t.calls).length, 1, t.stderr)
    })

    it('the status says running before the mark goes, and the mark is gone while the update runs', () => {
      const c = fresh()
      writeFileSync(mark(c), '')
      tick(c, {}, sh)
      const snap = readFileSync(`${c.log}.snapshot`, 'utf8')
      assert.match(snap, /^request_mark=gone$/m)
      assert.match(snap, /^running=[1-9]/m)
    })

    it('the mark is removed only after updater.json says running (a recording rm sees it)', () => {
      const c = fresh()
      const bin = join(BASE, `rm-bin-${n}`)
      mkdirSync(bin)
      const seen = join(BASE, `rm-seen-${n}`)
      writeFileSync(
        join(bin, 'rm'),
        `#!/bin/sh\ncase " $* " in *"/update/request/request"*) cp "${join(c.dir, 'update', 'report', 'updater.json')}" "${seen}" 2>/dev/null ;; esac\nexec /bin/rm "$@"\n`,
      )
      chmodSync(join(bin, 'rm'), 0o755)
      writeFileSync(mark(c), '')
      tick(c, { PATH: `${bin}:${process.env.PATH ?? '/usr/bin:/bin'}` }, sh)
      assert.match(readFileSync(seen, 'utf8'), /"running":\{"to":"v0\.9\.0"/)
    })

    it('a mark that cannot be removed starts nothing, and the status already said running', (t) => {
      if (process.getuid?.() === 0) return t.skip('root removes anything')
      const c = fresh()
      writeFileSync(mark(c), '')
      chmodSync(join(c.dir, 'update', 'request'), 0o500)
      try {
        const r = tick(c, {}, sh)
        assert.equal(updates(r.calls).length, 0)
        assert.equal(report(c, 'updater.json').requestAcceptedAt !== undefined, true)
      } finally {
        chmodSync(join(c.dir, 'update', 'request'), 0o700)
      }
    })

    it('a FIFO in place of the mark does not hang the loop, starts nothing and is removed', () => {
      const c = fresh()
      const made = spawnSync('mkfifo', [mark(c)])
      assert.equal(made.status, 0)
      const t = tick(c, {}, { ...sh, timeout: 10_000 })
      assert.equal(t.code, 0, t.stderr)
      assert.equal(updates(t.calls).length, 0)
      assert.equal(existsSync(mark(c)), false)
    })

    it('a link in place of the mark is not followed, starts nothing, is removed and its target stays as it was', () => {
      const c = fresh()
      const target = join(BASE, 'target.txt')
      writeFileSync(target, 'do not touch')
      for (const to of [target, '/etc/passwd', join(BASE, 'nowhere'), join(c.dir, 'update')]) {
        symlinkSync(to, mark(c))
        const t = tick(c, {}, sh)
        assert.equal(updates(t.calls).length, 0, to)
        assert.equal(existsSync(mark(c)) || spawnSync('test', ['-L', mark(c)]).status === 0, false, to)
      }
      assert.equal(readFileSync(target, 'utf8'), 'do not touch')
    })

    it('a directory in place of the mark starts nothing and is left alone', () => {
      const c = fresh()
      mkdirSync(mark(c))
      writeFileSync(join(mark(c), 'inner'), 'x')
      const t = tick(c, {}, sh)
      assert.equal(updates(t.calls).length, 0)
      assert.equal(existsSync(join(mark(c), 'inner')), true)
    })

    it('other names in the folder start nothing', () => {
      const c = fresh()
      for (const name of ['update', 'request.bak', 'requests', 'retry2']) writeFileSync(mark(c, name), '')
      assert.equal(updates(tick(c, {}, sh).calls).length, 0)
    })

    it('no new version: the mark is taken and nothing runs', () => {
      const c = fresh()
      writeFileSync(mark(c), '')
      const t = tick(c, { FAKE_CHECK: UP_TO_DATE }, sh)
      assert.equal(updates(t.calls).length, 0)
      assert.equal(existsSync(mark(c)), false)
    })

    it('a request when the check cannot say: nothing runs', () => {
      const c = fresh()
      writeFileSync(mark(c), '')
      const failed = JSON.stringify({
        installed: 'v0.2.0',
        latest: null,
        newer: false,
        notes: '',
        error: 'network',
      })
      const t = tick(c, { FAKE_CHECK: failed, FAKE_CHECK_EXIT: '3' }, sh)
      assert.equal(updates(t.calls).length, 0)
    })

    it('no mark: no update, ever', () => {
      const c = fresh()
      assert.equal(updates(tick(c, {}, sh).calls).length, 0)
    })

    it('a good update clears what a failure had left for that version', () => {
      const c = fresh()
      writeFileSync(mark(c), '')
      tick(c, { FAKE_UPDATE_EXIT: '4' }, sh)
      assert.equal(existsSync(join(c.dir, 'update', 'state', 'attempts', 'v0.9.0')), true)
      writeFileSync(mark(c, 'retry'), '')
      const t = tick(c, {}, { ...sh, at: NOW + 900 })
      assert.equal(updates(t.calls).length, 2)
      assert.equal(existsSync(join(c.dir, 'update', 'state', 'attempts', 'v0.9.0')), false)
      assert.deepEqual(report(c, 'updater.json').attempts ?? {}, {})
    })

    it('refused (2) or not possible now (3): no attempt is spent, and the next request tries again at once', () => {
      for (const code of ['2', '3']) {
        const c = fresh()
        writeFileSync(mark(c), '')
        tick(c, { FAKE_UPDATE_EXIT: code, FAKE_UPDATE_SAYS: 'Cannot update: 2 steps are running.' }, sh)
        assert.equal(
          existsSync(join(c.dir, 'update', 'state', 'attempts')) &&
            readdirSync(join(c.dir, 'update', 'state', 'attempts')).length > 0,
          false,
          code,
        )
        writeFileSync(mark(c), '')
        const t = tick(c, {}, { ...sh, at: NOW + 1 })
        assert.equal(updates(t.calls).length, 2, code)
      }
    })

    it('a failure is one attempt: later requests start nothing, and the page can read since when and why', () => {
      const c = fresh()
      writeFileSync(mark(c), '')
      const first = tick(
        c,
        { FAKE_UPDATE_EXIT: '4', FAKE_UPDATE_SAYS: 'The migration of v0.9.0 failed.' },
        sh,
      )
      assert.equal(updates(first.calls).length, 1)
      const u = report(c, 'updater.json')
      assert.equal(u.attempts['v0.9.0'].reason, 'The migration of v0.9.0 failed.')
      assert.equal(u.attempts['v0.9.0'].failedAt, new Date(NOW * 1000).toISOString().replace('.000Z', 'Z'))
      assert.equal(
        u.attempts['v0.9.0'].retryFrom,
        new Date((NOW + 900) * 1000).toISOString().replace('.000Z', 'Z'),
      )
      for (let i = 1; i <= 5; i++) {
        writeFileSync(mark(c), '')
        const t = tick(c, {}, { ...sh, at: NOW + i * 3600 })
        assert.equal(updates(t.calls).length, 1, `request ${i}: still the one attempt`)
        assert.equal(existsSync(mark(c)), false, 'the mark is taken, and nothing is made of it')
      }
      // No copy, no stop: the launcher was not even called again for an update.
      assert.equal(updates(readFileSync(c.log, 'utf8').trim().split('\n')).length, 1)
    })

    it('a failed attempt is dated when it ended, so the 15 minutes run from the end', () => {
      const c = fresh()
      // A clock that moves 1000 s every time it is read: the end of the attempt is later than its start.
      const bin = join(BASE, `date-bin-${n}`)
      mkdirSync(bin)
      const counter = join(BASE, `date-count-${n}`)
      writeFileSync(counter, String(NOW))
      writeFileSync(
        join(bin, 'date'),
        `#!/bin/sh\nif [ "$1" = "+%s" ]; then v=$(cat "${counter}"); echo $((v + 1000)) >"${counter}"; echo "$v"; exit 0; fi\nexec /bin/date "$@"\n`,
      )
      chmodSync(join(bin, 'date'), 0o755)
      writeFileSync(mark(c), '')
      const t = tick(
        c,
        {
          PATH: `${bin}:${process.env.PATH ?? '/usr/bin:/bin'}`,
          RSC_BRAIN_UPDATER_NOW: '',
          FAKE_UPDATE_EXIT: '4',
          FAKE_UPDATE_SAYS: 'It failed.',
        },
        sh,
      )
      assert.equal(t.code, 0, t.stderr)
      const u = report(c, 'updater.json')
      const failed = Date.parse(u.attempts['v0.9.0'].failedAt)
      const accepted = Date.parse(u.requestAcceptedAt)
      assert.ok(failed > accepted, `${u.attempts['v0.9.0'].failedAt} is not after ${u.requestAcceptedAt}`)
      assert.equal(Date.parse(u.attempts['v0.9.0'].retryFrom) - failed, 900_000)
    })

    it('a check that failed is asked again after 15 minutes, not before', () => {
      const c = fresh()
      const failed = JSON.stringify({
        installed: 'v0.2.0',
        latest: null,
        newer: false,
        notes: '',
        error: 'network',
      })
      const env = { FAKE_CHECK: failed, FAKE_CHECK_EXIT: '3' }
      assert.equal(checks(tick(c, env, sh).calls).length, 1)
      assert.equal(checks(tick(c, env, { ...sh, at: NOW + 899 }).calls).length, 1, 'too early')
      assert.equal(checks(tick(c, env, { ...sh, at: NOW + 900 }).calls).length, 2, 'at 15 minutes')
    })

    it('Try again: at most 3 retries, 15 minutes apart, then only the terminal', () => {
      const c = fresh()
      const fail = { FAKE_UPDATE_EXIT: '4', FAKE_UPDATE_SAYS: 'It failed.' }
      writeFileSync(mark(c), '')
      tick(c, fail, sh)
      let count = 1
      const retry = (at: number) => {
        writeFileSync(mark(c, 'retry'), '')
        const t = tick(c, fail, { ...sh, at })
        return updates(t.calls).length
      }
      assert.equal(retry(NOW + 899), count, '14 min 59 s: too early')
      assert.equal(retry(NOW + 900), ++count, '15 minutes: the first retry')
      assert.equal(retry(NOW + 900 + 899), count, 'again too early, counted from the last retry')
      assert.equal(retry(NOW + 1800), ++count, 'the second retry')
      assert.equal(retry(NOW + 2700), ++count, 'the third retry')
      assert.equal(report(c, 'updater.json').attempts['v0.9.0'].retryFrom, null, 'no retry left: no time')
      assert.equal(retry(NOW + 3600), count, 'a fourth retry never starts')
      assert.equal(retry(NOW + 99 * 3600), count, 'not even much later')
      assert.equal(count, 4)
      // A retry mark is a plain request when nothing failed before: another version starts as the first time.
      const other = tick(c, { FAKE_CHECK: NEWER('v1.0.0') }, { ...sh, at: NOW + 100 * 3600 })
      assert.equal(updates(other.calls).length, count, 'no mark: nothing')
      writeFileSync(mark(c, 'retry'), '')
      const again = tick(c, { FAKE_CHECK: NEWER('v1.0.0') }, { ...sh, at: NOW + 100 * 3600 + 1 })
      assert.equal(updates(again.calls).length, count + 1)
    })

    it('a retry mark without a failure behind it is a request, and a request mark after a failure is not a retry', () => {
      const c = fresh()
      writeFileSync(mark(c, 'retry'), '')
      const t = tick(c, { FAKE_UPDATE_EXIT: '4' }, sh)
      assert.equal(updates(t.calls).length, 1)
      writeFileSync(mark(c), '')
      const u = tick(c, {}, { ...sh, at: NOW + 5000 })
      assert.equal(updates(u.calls).length, 1, 'a request is not a retry, whenever it comes')
    })

    it('what the failure says is shortened and carries no credential', () => {
      const c = fresh()
      writeFileSync(join(c.dir, 'updater', 'credentials', 'token'), `${TOKEN}\n`)
      writeFileSync(mark(c), '')
      const says = `fatal: could not read https://x-access-token:${TOKEN}@github.com/o/r: ${TOKEN}\n${'x'.repeat(9000)}`
      tick(c, { FAKE_UPDATE_EXIT: '4', FAKE_UPDATE_SAYS: says }, sh)
      const reason = report(c, 'updater.json').attempts['v0.9.0'].reason as string
      assert.ok(reason.length <= 4000, `${reason.length}`)
      assert.equal(reason.includes(TOKEN), false)
      assert.match(reason, /\[redacted\]/)
      assert.equal(everything(c).includes(TOKEN), false, 'nowhere in the files the loop writes')
    })

    it('the launcher gets the credentials by file, never by value', () => {
      const c = fresh()
      writeFileSync(join(c.dir, 'updater', 'credentials', 'token'), `${TOKEN}\n`)
      writeFileSync(mark(c), '')
      tick(c, {}, sh)
      const snap = readFileSync(`${c.log}.snapshot`, 'utf8')
      assert.match(snap, /^env GIT_ASKPASS=.*credentials\.sh$/m)
      assert.match(snap, /^env GIT_TERMINAL_PROMPT=0$/m)
      assert.equal(snap.includes(TOKEN), false, 'not in its environment')
      assert.equal(readFileSync(c.log, 'utf8').includes(TOKEN), false, 'not in its arguments')
    })

    it('with a key: ssh uses that key alone, never asks, and keeps its own list of hosts', () => {
      const c = fresh()
      writeFileSync(
        join(c.dir, 'updater', 'credentials', 'key'),
        '-----BEGIN OPENSSH PRIVATE KEY-----\nabc\n',
      )
      writeFileSync(mark(c), '')
      tick(c, {}, sh)
      const snap = readFileSync(`${c.log}.snapshot`, 'utf8')
      const line = /^env GIT_SSH_COMMAND=(.*)$/m.exec(snap)?.[1] ?? ''
      assert.ok(line.includes(`-i '${join(c.dir, 'updater', 'credentials', 'key')}'`), line)
      assert.match(line, /IdentitiesOnly=yes/)
      assert.match(line, /BatchMode=yes/)
      assert.match(line, /StrictHostKeyChecking=accept-new/)
      assert.ok(
        line.includes(`UserKnownHostsFile='${join(c.dir, 'updater', 'credentials', 'known_hosts')}'`),
        line,
      )
      assert.equal(/GIT_ASKPASS=$/m.test(snap), true, 'no token, no helper')
    })

    it('without credentials the launcher gets none', () => {
      const c = fresh()
      writeFileSync(mark(c), '')
      tick(c, {}, sh)
      const snap = readFileSync(`${c.log}.snapshot`, 'utf8')
      assert.match(snap, /^env GIT_ASKPASS=$/m)
      assert.match(snap, /^env GIT_SSH_COMMAND=$/m)
    })

    it("what the loop was given by the test is not the launcher's: the web-facing files hold no path of the host", () => {
      const c = fresh()
      writeFileSync(mark(c), '')
      tick(c, {}, sh)
      assert.equal(JSON.stringify(report(c, 'updater.json')).includes(c.dir), false)
    })

    it('stopping it while an update runs hands the stop to the launcher, which puts things back, and waits for it', async () => {
      const c = fresh()
      writeFileSync(mark(c), '')
      const child = spawn(SHELLS[0] ?? '/bin/sh', [LOOP], {
        stdio: ['ignore', 'pipe', 'pipe'],
        env: {
          PATH: process.env.PATH ?? '/usr/bin:/bin',
          HOME: join(c.dir, 'updater', 'home'),
          RSC_BRAIN_UPDATER_DIR: c.dir,
          RSC_BRAIN_UPDATER_LAUNCHER: FAKE,
          RSC_BRAIN_UPDATER_ONCE: '1',
          RSC_BRAIN_UPDATER_NOW: String(NOW),
          FAKE_LOG: c.log,
          FAKE_CHECK: NEWER(),
          FAKE_UPDATE_SLEEP: '30',
        },
      })
      const exited = new Promise<number | null>((resolve) => child.on('exit', (code) => resolve(code)))
      for (let i = 0; i < 200 && !existsSync(`${c.log}.started`); i++)
        await new Promise((r) => setTimeout(r, 50))
      assert.equal(existsSync(`${c.log}.started`), true, 'the update started')
      child.kill('SIGTERM')
      await exited
      assert.equal(existsSync(`${c.log}.signals`), true, 'the launcher heard it')
    })
  })
}

describe('the scripts', () => {
  const which = (tool: string) => {
    const r = spawnSync('/bin/sh', ['-c', `command -v ${tool}`], { encoding: 'utf8' })
    return r.status === 0 ? r.stdout.trim() : ''
  }
  it('pass shellcheck as POSIX sh, when it is installed', {
    skip: which('shellcheck') ? false : 'shellcheck is not installed here',
  }, () => {
    const r = spawnSync(which('shellcheck'), ['-s', 'sh', LOOP, CREDENTIALS], { encoding: 'utf8' })
    assert.equal(r.status, 0, r.stdout)
  })
})

describe('the credential helper (GIT_ASKPASS)', () => {
  const ask = (c: Case, prompt: string, env: Record<string, string> = {}) =>
    spawnSync('/bin/sh', [CREDENTIALS, prompt], {
      encoding: 'utf8',
      env: {
        PATH: process.env.PATH ?? '/usr/bin:/bin',
        RSC_BRAIN_UPDATER_DIR: c.dir,
        RSC_BRAIN_UPDATER_REPO_HOST: 'github.com',
        ...env,
      },
    })
  it('answers the user name and the token for the host of the repository, and nothing else', () => {
    const c = fresh()
    writeFileSync(join(c.dir, 'updater', 'credentials', 'token'), `${TOKEN}\n`)
    const user = ask(c, "Username for 'https://github.com': ")
    assert.equal(user.status, 0)
    assert.equal(user.stdout, 'x-access-token\n')
    const pass = ask(c, "Password for 'https://x-access-token@github.com': ")
    assert.equal(pass.status, 0)
    assert.equal(pass.stdout, `${TOKEN}\n`)
    assert.equal(pass.stderr, '')
    for (const prompt of [
      "Password for 'https://github.com.evil.example': ",
      "Password for 'https://evil.example/github.com': ",
      'Password: ',
    ]) {
      const r = ask(c, prompt)
      assert.notEqual(r.status, 0, prompt)
      assert.equal(r.stdout.includes(TOKEN), false, prompt)
    }
  })
  it('without a token, or when the host is not named, it says nothing and fails', () => {
    const c = fresh()
    assert.notEqual(ask(c, "Password for 'https://github.com': ").status, 0)
    writeFileSync(join(c.dir, 'updater', 'credentials', 'token'), `${TOKEN}\n`)
    const r = ask(c, "Password for 'https://github.com': ", { RSC_BRAIN_UPDATER_REPO_HOST: '' })
    assert.notEqual(r.status, 0)
    assert.equal(r.stdout, '')
  })
  it('a token file that is a link or holds a second line is refused', () => {
    const c = fresh()
    const other = join(BASE, 'other-token')
    writeFileSync(other, `${TOKEN}\n`)
    symlinkSync(other, join(c.dir, 'updater', 'credentials', 'token'))
    assert.notEqual(ask(c, "Password for 'https://github.com': ").status, 0)
    rmSync(join(c.dir, 'updater', 'credentials', 'token'))
    writeFileSync(join(c.dir, 'updater', 'credentials', 'token'), `${TOKEN}\nsecond\n`)
    const r = ask(c, "Password for 'https://github.com': ")
    assert.notEqual(r.status, 0)
    assert.equal(r.stdout.includes('second'), false)
  })
})

describe('what the updater may reach (CA15, CA25, CA25b)', () => {
  const compose = readFileSync(COMPOSE_UPDATER, 'utf8')
  const lines = compose.split('\n').filter((l) => !/^\s*#/.test(l))
  const body = lines.join('\n')

  it('publishes no port', () => {
    assert.equal(/^\s*ports:/m.test(body), false)
    assert.equal(/\b(expose|network_mode|privileged|cap_add|pid|ipc|devices)\s*:/.test(body), false)
  })

  it('is on a network of its own project: none of the others', () => {
    assert.equal(/^\s*networks:/m.test(body), false, 'the project network only')
    assert.equal(/rsc-shared|steps|inside|outbound|control|external/.test(body), false)
  })

  it('mounts the socket, the installation in its own path and the list of users, and nothing else', () => {
    const VAR = '$' + '{RSC_BRAIN_UPDATER_DIR}'
    const volumes: string[] = []
    let inside = false
    for (const l of lines) {
      if (/^\s{4}volumes:/.test(l)) inside = true
      else if (inside && /^\s{6}- /.test(l)) volumes.push(l.replace(/^\s*- /, '').trim())
      else if (inside && !/^\s*$/.test(l)) inside = false
    }
    assert.deepEqual(
      volumes.sort(),
      [
        `${VAR}:${VAR}`,
        `${VAR}/updater/passwd:/etc/passwd:ro`,
        '/var/run/docker.sock:/var/run/docker.sock',
      ].sort(),
    )
  })

  it('runs as the owner of the installation with the group of the socket, restarts, and gets time to put things back', () => {
    assert.match(body, /user: "\$\{RSC_BRAIN_UPDATER_UID\}:\$\{RSC_BRAIN_UPDATER_GID\}"/)
    assert.match(body, /group_add:\s*\n\s*- "\$\{RSC_BRAIN_UPDATER_SOCKET_GID\}"/)
    assert.match(body, /restart: unless-stopped/)
    assert.match(body, /stop_grace_period: 10m/)
    assert.match(body, /init: true/)
    assert.match(body, /HOME: \$\{RSC_BRAIN_UPDATER_DIR\}\/updater\/home/)
    assert.match(body, /hostname: \$\{RSC_BRAIN_UPDATER_HOSTNAME\}/)
    assert.match(body, /working_dir: \$\{RSC_BRAIN_UPDATER_DIR\}/)
    assert.equal(
      /RSC_BRAIN_(TEST|UPDATER_NOW|UPDATER_ONCE|UPDATER_LAUNCHER)/.test(body),
      false,
      'no variables for tests',
    )
  })

  it('is a project of its own: the main compose file does not know it, and it needs no profile of the main one', () => {
    const main = readFileSync(COMPOSE, 'utf8')
    assert.equal(/updater/i.test(main.replace(/^\s*#.*$/gm, '')), false)
    assert.equal(/^\s*name:/m.test(body), false, 'the project name comes from -p')
  })

  it('the web gets the report to read and the folder of its marks, and nothing of the updater: no socket, no credentials', () => {
    const main = readFileSync(COMPOSE, 'utf8').replace(/^\s*#.*$/gm, '')
    assert.equal(main.includes('docker.sock'), false)
    assert.equal(main.includes('updater'), false)
    assert.equal(/credentials|passphrase|token-file/i.test(main), false)
    const app = main.slice(main.indexOf('  app:'), main.indexOf('  postgres:'))
    const mounts = [...app.matchAll(/^\s{6}- (\.\/[^\n]+)$/gm)].map((m) => m[1])
    assert.deepEqual(mounts.sort(), [
      './backups:/backups',
      './update/report:/update/report:ro',
      './update/request:/update/request',
    ])
    assert.match(app, /RSC_BRAIN_UPDATE_REPORT: \/update\/report/)
    assert.match(app, /RSC_BRAIN_UPDATE_REQUEST: \/update\/request/)
  })

  it('the image is the pinned docker cli with only the tools the launcher needs', () => {
    const d = readFileSync(DOCKERFILE, 'utf8')
    assert.match(d, /^FROM docker:29\.1\.5-cli@sha256:[0-9a-f]{64}$/m)
    assert.match(d, /apk add --no-cache git openssh-client perl/)
    assert.equal(/\b(curl|wget|sudo)\b/.test(d), false)
  })
})
