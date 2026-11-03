// Updating with real containers (plan T042, T043; spec B7 CA6, CA7, CA7b, CA17): local only, never in CI (plan
// §5.1). Runs with RSC_BRAIN_INSTALL_TESTS=1 and Docker answering (npm run test:install). Every Docker resource carries
// the prefix rscb-pr35-test- and a random id, and is removed after; the folders live under RSC_BRAIN_INSTALL_TMP (or
// the system's temporary folder).
//
// Three images are built here: the tree as it is (installed first); «next», the same with one more migration, added
// and harmless, that says 0.2.0; and «broken», next plus a migration that fails, saying 0.3.0.
// CA6: an installation with data (brains, accounts, entries, a token, the audit) updates to next: a pre-update copy
// exists, every table has the same rows (counted and fingerprinted), an earlier token and session still answer 200.
// CA7 + CA7b: during an update to broken, a loop of writes runs with a token: writes are refused with 503
// under_maintenance and Retry-After while it lasts, the update exits 4, the version before answers with every table as
// it was when the copy was made, every write that got 201 is there, the session and the token still work, and the web
// shows the failure. CA17: a day of use with canaries; `docker compose logs` of every service holds none of them.
import assert from 'node:assert/strict'
import { execFile, spawn, spawnSync } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, describe, it } from 'node:test'
import { promisify } from 'node:util'

const run = promisify(execFile)
const ROOT = new URL('../..', import.meta.url).pathname
const LAUNCHER = join(ROOT, 'deploy', 'rsc-brain.sh')
const ID = randomBytes(4).toString('hex')
const BASE_IMAGE = `rscb-pr35-test-image:${ID}`
const NEXT = `rscb-pr35-test-next:${ID}`
const BROKEN = `rscb-pr35-test-broken:${ID}`
const NAME = `rscb-pr35-test-update-${ID}`
const DB = NAME.replaceAll('-', '_')
const WEB = { 'x-requested-with': 'rsc-brain-web', 'content-type': 'application/json' }
const PASSWORD = 'a long test password 35'

const CANARY = {
  title: 'canary-title-35a1f0',
  content: 'canary-content-35b7c2 the plan nobody may log',
  query: 'canary-query-35d4e6',
  password: 'canary-password-35f9a8 horse battery',
  slug: 'canary-slug-35c3b1',
  tokenName: 'canary-token-name-35e2d7',
}

const why = (() => {
  if (process.env.CI) return 'CI has no Docker (plan §5.1)'
  if (process.env.RSC_BRAIN_INSTALL_TESTS !== '1')
    return 'set RSC_BRAIN_INSTALL_TESTS=1 to update with real containers'
  if (spawnSync('docker', ['info'], { stdio: 'ignore' }).status !== 0) return 'Docker does not answer'
  return null
})()

const docker = async (...args: string[]) => (await run('docker', args, { maxBuffer: 64 << 20 })).stdout.trim()
const measured = (line: string) => process.stdout.write(`# measured: ${line}\n`)
const freePort = () =>
  new Promise<number>((resolve) => {
    const s = createServer().listen(0, '127.0.0.1', () => {
      const p = (s.address() as { port: number }).port
      s.close(() => resolve(p))
    })
  })
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

type Run = { code: number | null; stdout: string; stderr: string; seconds: number }
const launch = (args: string[], onStderr?: (all: string) => void): Promise<Run> =>
  new Promise((resolve) => {
    const started = Date.now()
    const p = spawn('sh', [LAUNCHER, ...args], {
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
    p.on('close', (code) => resolve({ code, stdout, stderr, seconds: (Date.now() - started) / 1000 }))
  })

const envOf = (dir: string) => {
  const out: Record<string, string> = {}
  for (const line of readFileSync(join(dir, '.env'), 'utf8').split('\n')) {
    const m = /^([A-Z_][A-Z0-9_]*)='(.*)'$/.exec(line)
    if (m) out[m[1] as string] = m[2] as string
  }
  return out
}

const psql = (sql: string) =>
  docker('exec', `${NAME}-postgres-1`, 'psql', '-U', 'postgres', '-d', DB, '-Atc', sql)
// Every table: its rows counted and fingerprinted (all columns, in a fixed order). `installation` without the two
// maintenance columns (on while the copy is made, off after); `schema_migrations` apart (an update adds to it).
async function tables(): Promise<Record<string, string>> {
  const gen = await psql(
    "SELECT string_agg(format('SELECT %L || '' '' || count(*) || '' '' || md5(coalesce(string_agg(x::text, ''|'' ORDER BY x::text), '''')) FROM (SELECT %s FROM %I t) x', tablename, CASE WHEN tablename = 'installation' THEN '(to_jsonb(t) - ''maintenance_until'' - ''maintenance_reason'') AS j' ELSE 't.*' END, tablename), ' UNION ALL ' ORDER BY tablename) FROM pg_tables WHERE schemaname = 'public' AND tablename <> 'schema_migrations'",
  )
  const out: Record<string, string> = {}
  for (const line of (await psql(gen)).split('\n')) {
    const [t, n, h] = line.split(' ')
    out[t as string] = `${n} ${h}`
  }
  return out
}
const diff = (a: Record<string, string>, b: Record<string, string>) =>
  [...new Set([...Object.keys(a), ...Object.keys(b)])].filter((k) => a[k] !== b[k])

describe('updating with real containers (CA6, CA7, CA7b, CA17)', { skip: why ?? false }, () => {
  let BASE = ''
  let dir = ''
  let site = ''
  let cookie = ''
  let token = ''
  let tokenId = ''

  const signIn = async (password = PASSWORD) => {
    const r = await fetch(`${site}/v1/auth/login`, {
      method: 'POST',
      headers: WEB,
      body: JSON.stringify({ email: 'ada@example.com', password }),
    })
    return { status: r.status, cookie: (r.headers.get('set-cookie') ?? '').split(';')[0] ?? '' }
  }
  const asAdmin = (path: string, init: RequestInit = {}) =>
    fetch(`${site}${path}`, { ...init, headers: { ...WEB, cookie, ...(init.headers ?? {}) } })
  const asToken = (path: string, init: RequestInit = {}) =>
    fetch(`${site}${path}`, {
      ...init,
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': 'application/json',
        ...(init.headers ?? {}),
      },
    })
  const save = (title: string, content: string, slug = 'kept') =>
    asToken(`/v1/brains/${slug}/entries`, {
      method: 'POST',
      body: JSON.stringify({ type: 'decision', title, content }),
    })

  before(async () => {
    BASE = mkdtempSync(join(process.env.RSC_BRAIN_INSTALL_TMP ?? tmpdir(), 'rscb-pr35-test-'))
    dir = join(BASE, 'install')
    let started = Date.now()
    await run('docker', ['build', '-q', '-t', BASE_IMAGE, ROOT], { maxBuffer: 64 << 20 })
    measured(`docker build of rsc-brain ${((Date.now() - started) / 1000).toFixed(1)} s`)
    // next: one more migration, added and harmless; it says 0.2.0. broken: next and a migration that fails; 0.3.0.
    started = Date.now()
    const ctx = join(BASE, 'images')
    mkdirSync(ctx)
    writeFileSync(
      join(ctx, '0024_test_next.sql'),
      "COMMENT ON TABLE installation IS 'rsc-brain next (test)';\n",
    )
    writeFileSync(join(ctx, '0025_test_broken.sql'), 'SELECT 1 / 0;\n')
    const derive = (from: string, version: string, files: string[]) =>
      [
        `FROM ${from}`,
        'USER root',
        ...files.map((f) => `COPY ${f} /app/migrations/${f}`),
        `RUN chmod a+r /app/migrations/*.sql && sed -i "s/VERSION = '[^']*'/VERSION = '${version}'/" /app/dist/core/version.js`,
        'USER node',
      ].join('\n')
    writeFileSync(join(ctx, 'Dockerfile.next'), derive(BASE_IMAGE, '0.2.0', ['0024_test_next.sql']))
    writeFileSync(join(ctx, 'Dockerfile.broken'), derive(NEXT, '0.3.0', ['0025_test_broken.sql']))
    await run('docker', ['build', '-q', '-t', NEXT, '-f', join(ctx, 'Dockerfile.next'), ctx])
    await run('docker', ['build', '-q', '-t', BROKEN, '-f', join(ctx, 'Dockerfile.broken'), ctx])
    measured(`images next and broken ${((Date.now() - started) / 1000).toFixed(1)} s`)
    assert.equal(await docker('run', '--rm', NEXT, 'rsc-brain', 'version'), '0.2.0')
    assert.equal(await docker('run', '--rm', BROKEN, 'rsc-brain', 'version'), '0.3.0')

    // An installation with data: the administrator, a brain, entries, a token, the audit.
    const port = await freePort()
    const r = await launch([
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
    ])
    assert.equal(r.code, 0, r.stderr)
    site = JSON.parse(r.stdout).url
    const setup = await fetch(`${site}/v1/setup`, {
      method: 'POST',
      headers: WEB,
      body: JSON.stringify({
        name: 'PR35 test',
        publicUrl: site,
        admin: { name: 'Ada', email: 'ada@example.com', password: PASSWORD },
      }),
    })
    assert.equal(setup.status, 201, await setup.text())
    const s = await signIn()
    assert.equal(s.status, 200)
    cookie = s.cookie
    assert.equal(
      (await asAdmin('/v1/brains', { method: 'POST', body: JSON.stringify({ slug: 'kept', name: 'Kept' }) }))
        .status,
      201,
    )
    const made = await asAdmin('/v1/me/tokens', {
      method: 'POST',
      body: JSON.stringify({ name: 'before the update', perm: 'write', allBrains: true, days: 30 }),
    })
    assert.equal(made.status, 201, await made.clone().text())
    const t = ((await made.json()) as { token: { id: string; secret: string } }).token
    token = t.secret
    tokenId = t.id
    for (let i = 0; i < 20; i++)
      assert.equal((await save(`seed ${i}`, `what was decided, number ${i}`)).status, 201)
  })

  after(async () => {
    const ps = (
      await docker('ps', '-aq', '--filter', `label=com.docker.compose.project=${NAME}`).catch(() => '')
    )
      .split('\n')
      .filter(Boolean)
    for (const c of ps) await docker('rm', '-f', '-v', c).catch(() => {})
    const vols = (
      await docker('volume', 'ls', '-q', '--filter', `label=com.docker.compose.project=${NAME}`).catch(
        () => '',
      )
    )
      .split('\n')
      .filter(Boolean)
    for (const v of vols) await docker('volume', 'rm', '-f', v).catch(() => {})
    const nets = (
      await docker('network', 'ls', '-q', '--filter', `label=com.docker.compose.project=${NAME}`).catch(
        () => '',
      )
    )
      .split('\n')
      .filter(Boolean)
    for (const n of nets) await docker('network', 'rm', n).catch(() => {})
    for (const i of [BROKEN, NEXT, BASE_IMAGE]) await docker('image', 'rm', '-f', i).catch(() => {})
    if (BASE) rmSync(BASE, { recursive: true, force: true })
  })

  it('CA6: update to next: a pre-update copy first, every table as it was, the earlier token and session still answer', async () => {
    const before = await tables()
    const r = await launch(['update', '--yes', '--json', '--dir', dir, '--image', NEXT])
    assert.equal(r.code, 0, r.stderr)
    measured(`CA6 update 0.1.0 → 0.2.0 ${r.seconds.toFixed(1)} s`)
    const s = JSON.parse(r.stdout)
    assert.equal(s.from, '0.1.0')
    assert.equal(s.to, '0.2.0')
    assert.match(s.copy, /^rsc-brain-\d{8}T\d{6}Z-pre-update\.rscb$/)
    assert.ok(readdirSync(join(dir, 'backups')).includes(s.copy))
    const afterUpdate = await tables()
    assert.deepEqual(diff(before, afterUpdate), [], 'every table as it was')
    measured(
      `CA6 tables compared: ${Object.keys(before).length}, rows ${Object.values(before).reduce((n, v) => n + Number(v.split(' ')[0]), 0)}`,
    )
    assert.equal(await psql("SELECT count(*) FROM schema_migrations WHERE id LIKE '0024_test_next%'"), '1')
    assert.equal(envOf(dir).RSC_BRAIN_IMAGE, NEXT)
    assert.equal((await asToken('/v1/brains')).status, 200, 'the token from before')
    assert.equal((await asAdmin('/v1/me')).status, 200, 'the session from before')
    const copies = (await (await asAdmin('/v1/admin/backups')).json()) as {
      lastUpdate: { ok: boolean; from: string; to: string }
    }
    assert.deepEqual(
      { ok: copies.lastUpdate.ok, from: copies.lastUpdate.from, to: copies.lastUpdate.to },
      { ok: true, from: '0.1.0', to: '0.2.0' },
    )
  })

  it('CA7 + CA7b: an update to broken under a loop of writes: refused while it lasts, back to 0.2.0, no accepted write lost, keys kept, the failure on the web', async () => {
    const receipts: string[] = []
    let refused = 0
    let retryAfter = 0
    let unreachable = 0
    let others = 0
    let stop = false
    // Paused while the version before comes back, so its tables can be read as the rollback left them.
    let paused = false
    const loop = (async () => {
      for (let i = 0; !stop; i++) {
        while (paused && !stop) await sleep(50)
        try {
          const res = await save(`loop ${i}`, `written during the update, number ${i}`)
          if (res.status === 201)
            receipts.push(((await res.json()) as { receipt: { entryId: string } }).receipt.entryId)
          else if (res.status === 503) {
            const body = (await res.json()) as { error: { code: string }; retryAfter: number }
            assert.equal(body.error.code, 'under_maintenance')
            assert.ok(Number(res.headers.get('retry-after')) >= 5)
            retryAfter = Number(res.headers.get('retry-after'))
            refused++
          } else {
            others++
            await res.text()
          }
        } catch {
          unreachable++
        }
        await sleep(100)
      }
    })()
    // What the copy holds: the tables once the copy is made, just before the old version stops; and, during the
    // maintenance, the other writes CA7b names (revoking a key, signing in) refused too.
    const seen: {
      atCopy?: Promise<Record<string, string>>
      during?: Promise<Array<[string, number]>>
    } = {}
    await sleep(1500)
    const r = await launch(['update', '--yes', '--dir', dir, '--image', BROKEN], (all) => {
      if (!seen.during && all.includes('==> Making a copy')) {
        seen.during = (async (): Promise<Array<[string, number]>> => {
          const revoke = await asAdmin(`/v1/me/tokens/${tokenId}`, { method: 'DELETE' })
          const login = await signIn()
          return [
            ['DELETE /v1/me/tokens/:id', revoke.status],
            ['POST /v1/auth/login', login.status],
          ]
        })()
      }
      if (!seen.atCopy && all.includes('==> Stopping rsc-brain 0.2.0')) seen.atCopy = tables()
      if (all.includes('==> Going back to')) paused = true
    })
    const duringMaintenance = await seen.during
    const atCopy = await seen.atCopy
    // The tables as the rollback left them, before any write after it; then a few writes, and the loop ends.
    const afterRollback = await tables()
    paused = false
    await sleep(2000)
    stop = true
    await loop
    measured(
      `CA7b update to broken ${r.seconds.toFixed(1)} s: ${receipts.length} writes accepted (201), ${refused} refused with 503 under_maintenance (Retry-After ${retryAfter} s), ${unreachable} while stopped, ${others} other`,
    )
    assert.equal(r.code, 4, r.stderr)
    assert.match(r.stderr, /went back to 0\.2\.0/)
    assert.ok(refused > 0, 'writes were refused during the maintenance')
    assert.equal(others, 0, 'no other answer than 201, 503 or no connection')
    assert.deepEqual(duringMaintenance, [
      ['DELETE /v1/me/tokens/:id', 503],
      ['POST /v1/auth/login', 503],
    ])
    // Every write that was accepted is there.
    assert.ok(receipts.length > 0)
    const ids = receipts.map((x) => `'${x.replaceAll("'", '')}'`).join(',')
    assert.equal(await psql(`SELECT count(*) FROM entries WHERE id IN (${ids})`), String(receipts.length))
    // The version before answers; its tables are as the copy held them (the writes after it was back apart).
    const status = await launch(['status', '--json', '--dir', dir])
    assert.equal(JSON.parse(status.stdout).version, '0.2.0')
    assert.equal(envOf(dir).RSC_BRAIN_IMAGE, NEXT)
    assert.equal(await psql("SELECT count(*) FROM schema_migrations WHERE id LIKE '0025_test_broken%'"), '0')
    assert.ok(atCopy && Object.keys(atCopy).length > 0, 'the tables were read when the copy was made')
    // Every table as the copy held it: nothing refused got in, nothing accepted was lost.
    assert.deepEqual(diff(atCopy as Record<string, string>, afterRollback), [], 'every table as at the copy')
    measured(`CA7 tables compared after the rollback: ${Object.keys(afterRollback).length}`)
    // Session and token still work (the rollback keeps keys); writes are taken again.
    assert.equal((await asAdmin('/v1/me')).status, 200, 'the session')
    assert.equal((await asToken('/v1/brains')).status, 200, 'the token')
    assert.equal((await save('after the rollback', 'writes are taken again')).status, 201)
    // CA7: the failure on the web, without the key.
    const copies = (await (await asAdmin('/v1/admin/backups')).json()) as {
      lastUpdate: { ok: boolean; from: string; to: string; log?: string }
    }
    assert.equal(copies.lastUpdate.ok, false)
    assert.equal(copies.lastUpdate.to, '0.3.0')
    assert.ok(!String(copies.lastUpdate.log).includes(envOf(dir).RSC_BRAIN_SECRET as string))
    assert.match(String(copies.lastUpdate.log), /division by zero|0025_test_broken/)
    const { chromium } = await import('@playwright/test')
    const browser = await chromium.launch()
    try {
      const ctx = await browser.newContext()
      await ctx.addCookies([{ name: 'rscb_session', value: cookie.split('=').slice(1).join('='), url: site }])
      const page = await ctx.newPage()
      await page.goto(`${site}/admin/system`)
      await page
        .locator('[data-state="update-failed"]')
        .getByText('The update from 0.2.0 to 0.3.0 failed')
        .waitFor({ timeout: 30_000 })
    } finally {
      await browser.close()
    }
    assert.ok(existsSync(join(dir, 'last-failure.log')))
  })

  it('CA17: a day of use with canaries; docker compose logs of every service hold none of them', async () => {
    const secrets = [token, cookie.split('=').slice(1).join('='), envOf(dir).RSC_BRAIN_SECRET as string]
    assert.equal(
      (
        await asAdmin('/v1/brains', {
          method: 'POST',
          body: JSON.stringify({ slug: CANARY.slug, name: 'Canary' }),
        })
      ).status,
      201,
    )
    assert.equal((await save(CANARY.title, CANARY.content, CANARY.slug)).status, 201)
    assert.equal((await asToken(`/v1/search?q=${encodeURIComponent(CANARY.query)}`)).status, 200)
    assert.equal((await asAdmin(`/v1/search?q=${encodeURIComponent(CANARY.content)}`)).status, 200)
    assert.equal((await signIn(CANARY.password)).status, 401)
    const again = await signIn()
    assert.equal(again.status, 200)
    secrets.push(again.cookie.split('=').slice(1).join('='))
    const made = await asAdmin('/v1/me/tokens', {
      method: 'POST',
      body: JSON.stringify({ name: CANARY.tokenName, perm: 'read', allBrains: true, days: 30 }),
    })
    assert.equal(made.status, 201)
    secrets.push(((await made.json()) as { token: { secret: string } }).token.secret)
    // A wrong key in the header.
    assert.equal(
      (
        await fetch(`${site}/v1/me`, {
          headers: { authorization: 'Bearer rscb_canaryheaderthatisnokey0000000000' },
        })
      ).status,
      401,
    )
    await sleep(1000)
    const logs = (
      await run(
        'docker',
        [
          'compose',
          '--project-directory',
          dir,
          '-p',
          NAME,
          '--env-file',
          join(dir, '.env'),
          '--profile',
          'bundled',
          'logs',
          '--no-color',
        ],
        {
          maxBuffer: 64 << 20,
        },
      )
    ).stdout
    measured(`CA17 docker compose logs: ${logs.split('\n').length} lines from app and postgres`)
    assert.ok(logs.includes('"route":"/v1/brains/:slug/entries"'), 'the log is the service’s')
    for (const [name, canary] of Object.entries(CANARY))
      assert.ok(!logs.includes(canary), `the logs hold the ${name}`)
    for (const s of secrets)
      assert.ok(!logs.includes(s.slice(0, 16)), 'the logs hold (a prefix of) a key or session')
    assert.ok(!logs.includes('rscb_'), 'the logs hold something shaped like a key')
    assert.ok(!logs.includes(PASSWORD), 'the logs hold the password')
  })
})
