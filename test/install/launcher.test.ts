// The launcher with real containers (plan T039; spec B7 CA1, CA2, CA16): local only, never in CI (plan §5.1). Runs
// with RSC_BRAIN_INSTALL_TESTS=1 and Docker answering (npm run test:install). The folders it installs into are made
// under RSC_BRAIN_INSTALL_TMP (or the system's temporary folder); every Docker resource carries the prefix
// rscb-pr34-test- and a random id, and is removed after.
//
// CA1: from nothing to the first-time setup in a browser in under 300 s (building the image included; the images it
// starts from are already downloaded, plan §5.2). CA16: uninstall keeps everything; installing again brings the same
// data and the same administrator back; --delete-data without the right name deletes nothing. CA2: the server mode
// behind Caddy gets its certificate from an ACME test CA (Pebble) on the same network, with no certificate step in the
// launcher; the service believes X-Forwarded-* from Caddy's fixed address only (plan risk 7).
import assert from 'node:assert/strict'
import { execFile, spawn, spawnSync } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { request as httpRequest } from 'node:http'
import { request } from 'node:https'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { after, before, describe, it } from 'node:test'
import { promisify } from 'node:util'

const run = promisify(execFile)
const ROOT = new URL('../..', import.meta.url).pathname
const LAUNCHER = join(ROOT, 'deploy', 'rsc-brain.sh')
const ID = randomBytes(4).toString('hex')
const IMAGE = `rscb-pr34-test-image:${ID}`
const PEBBLE_IMAGE = 'ghcr.io/letsencrypt/pebble:2.8.0'
const WEB = { 'x-requested-with': 'rsc-brain-web', 'content-type': 'application/json' }

const why = (() => {
  if (process.env.CI) return 'CI has no Docker (plan §5.1)'
  if (process.env.RSC_BRAIN_INSTALL_TESTS !== '1')
    return 'set RSC_BRAIN_INSTALL_TESTS=1 to install with real containers'
  if (spawnSync('docker', ['info'], { stdio: 'ignore' }).status !== 0) return 'Docker does not answer'
  return null
})()

const docker = async (...args: string[]) => (await run('docker', args, { maxBuffer: 64 << 20 })).stdout.trim()
const projects: string[] = []
let BASE = ''

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
const measured = (line: string) => process.stdout.write(`# measured: ${line}\n`)

type Run = { code: number | null; stdout: string; stderr: string; seconds: number }
// The launcher, with no terminal to ask on; its error stream is passed through as it runs.
const launch = (
  args: string[],
  o: {
    argv?: string[]
    env?: Record<string, string>
    onStderr?: (all: string, kill: (s: NodeJS.Signals) => void) => void
  } = {},
): Promise<Run> =>
  new Promise((resolve) => {
    const started = Date.now()
    const p = spawn('sh', [...(o.argv ?? [LAUNCHER]), ...args], {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, RSC_BRAIN_TTY: '/nonexistent/tty', ...o.env },
    })
    let stdout = ''
    let stderr = ''
    p.stdout.on('data', (d) => {
      stdout += d
    })
    p.stderr.on('data', (d) => {
      stderr += d
      o.onStderr?.(stderr, (s) => p.kill(s))
    })
    p.on('close', (code) => resolve({ code, stdout, stderr, seconds: (Date.now() - started) / 1000 }))
  })

const ofProject = async (kind: 'ps' | 'volume' | 'network', name: string) => {
  const filter = `label=com.docker.compose.project=${name}`
  const args = kind === 'ps' ? ['ps', '-aq', '--filter', filter] : [kind, 'ls', '-q', '--filter', filter]
  return (await docker(...args)).split('\n').filter(Boolean)
}

const envOf = (dir: string) => {
  const out: Record<string, string> = {}
  for (const line of readFileSync(join(dir, '.env'), 'utf8').split('\n')) {
    const m = /^([A-Z_][A-Z0-9_]*)='(.*)'$/.exec(line)
    if (m) out[m[1] as string] = m[2] as string
  }
  return out
}

describe('the launcher with real containers', { skip: why ?? false }, () => {
  let buildSeconds = 0
  before(async () => {
    BASE = mkdtempSync(join(process.env.RSC_BRAIN_INSTALL_TMP ?? tmpdir(), 'rscb-pr34-test-'))
    const started = Date.now()
    await run('docker', ['build', '--no-cache', '-q', '-t', IMAGE, ROOT], { maxBuffer: 64 << 20 })
    buildSeconds = (Date.now() - started) / 1000
    measured(`docker build of rsc-brain ${buildSeconds.toFixed(1)} s`)
  })
  after(async () => {
    for (const name of projects) {
      for (const c of await ofProject('ps', name).catch(() => []))
        await docker('rm', '-f', '-v', c).catch(() => {})
      for (const v of await ofProject('volume', name).catch(() => []))
        await docker('volume', 'rm', '-f', v).catch(() => {})
      for (const n of await ofProject('network', name).catch(() => []))
        await docker('network', 'rm', n).catch(() => {})
    }
    await docker('image', 'rm', '-f', IMAGE).catch(() => {})
    if (BASE) rmSync(BASE, { recursive: true, force: true })
  })

  describe('on this machine (CA1, CA16)', () => {
    const name = `rscb-pr34-test-local-${ID}`
    let dir = ''
    let port = 0
    let site = ''
    const counts = async () =>
      docker(
        'exec',
        `${name}-postgres-1`,
        'psql',
        '-U',
        'postgres',
        '-d',
        name.replaceAll('-', '_'),
        '-Atc',
        "SELECT (SELECT count(*) FROM accounts) || ',' || (SELECT count(*) FROM brains) || ',' || (SELECT count(*) FROM audit)",
      )
    const signIn = async () => {
      const r = await fetch(`${site}/v1/auth/login`, {
        method: 'POST',
        headers: WEB,
        body: JSON.stringify({ email: 'ada@example.com', password: 'a long test password 34' }),
      })
      return { status: r.status, cookie: (r.headers.get('set-cookie') ?? '').split(';')[0] ?? '' }
    }

    before(() => {
      projects.push(name)
      dir = join(BASE, 'local')
    })

    it('CA1: install --local --yes, then the first-time setup in a browser, in under 300 s', async () => {
      port = await freePort()
      const r = await launch([
        'install',
        '--local',
        '--yes',
        '--json',
        '--dir',
        dir,
        '--name',
        name,
        '--port',
        String(port),
        '--image',
        IMAGE,
      ])
      assert.equal(r.code, 0, r.stderr)
      const s = JSON.parse(r.stdout)
      site = s.url
      assert.equal(site, `http://localhost:${port}`)
      assert.equal(s.installationKey, envOf(dir).RSC_BRAIN_SECRET)
      const branding = (await (await fetch(`${site}/v1/branding`)).json()) as { setupRequired: boolean }
      assert.equal(branding.setupRequired, true)
      // The web, in a browser, leads to the first-time setup.
      const { chromium } = await import('@playwright/test')
      const browser = await chromium.launch()
      try {
        const page = await browser.newPage()
        await page.goto(`${site}/`)
        await page.getByRole('heading', { name: 'Set up rsc-brain' }).waitFor({ timeout: 30_000 })
      } finally {
        await browser.close()
      }
      const total = buildSeconds + r.seconds
      measured(
        `CA1 build ${buildSeconds.toFixed(1)} s + install ${r.seconds.toFixed(1)} s = ${total.toFixed(1)} s (limit 300 s)`,
      )
      assert.ok(total < 300, `CA1 took ${total} s`)
    })

    it('C19 behind the containers: a password over http from this machine is accepted (the setup)', async () => {
      const setup = (await (await fetch(`${site}/v1/setup`)).json()) as { connection: { local: boolean } }
      assert.equal(setup.connection.local, true)
      const r = await fetch(`${site}/v1/setup`, {
        method: 'POST',
        headers: WEB,
        body: JSON.stringify({
          name: 'PR34 test',
          publicUrl: site,
          admin: { name: 'Ada', email: 'ada@example.com', password: 'a long test password 34' },
        }),
      })
      assert.equal(r.status, 201, await r.text())
      const { status, cookie } = await signIn()
      assert.equal(status, 200)
      const made = await fetch(`${site}/v1/brains`, {
        method: 'POST',
        headers: { ...WEB, cookie },
        body: JSON.stringify({ slug: 'kept', name: 'Kept' }),
      })
      assert.equal(made.status, 201, await made.text())
    })

    it('makes a copy into <dir>/backups, written by the service', async () => {
      const r = await launch(['backup', '--dir', dir])
      assert.equal(r.code, 0, r.stderr)
      assert.ok(readdirSync(join(dir, 'backups')).some((f) => f.endsWith('-manual.rscb')))
    })

    it('CA16: uninstall keeps the data, the copies and the key; installing again brings all of it back', async () => {
      const before = await counts()
      const key = envOf(dir).RSC_BRAIN_SECRET
      const u = await launch(['uninstall', '--dir', dir])
      assert.equal(u.code, 0, u.stderr)
      assert.deepEqual(await ofProject('ps', name), [])
      assert.ok((await ofProject('volume', name)).some((v) => v.endsWith('_pgdata')))
      assert.ok(readdirSync(join(dir, 'backups')).some((f) => f.endsWith('.rscb')))

      const started = Date.now()
      const again = await launch(['install', '--local', '--yes', '--json', '--dir', dir])
      assert.equal(again.code, 0, again.stderr)
      measured(`CA16 install again ${((Date.now() - started) / 1000).toFixed(1)} s`)
      assert.equal(JSON.parse(again.stdout).installationKey, key)
      assert.equal(await counts(), before)
      const { status, cookie } = await signIn()
      assert.equal(status, 200, 'the same administrator signs in')
      const brains = (await (await fetch(`${site}/v1/brains`, { headers: { ...WEB, cookie } })).json()) as {
        brains: Array<{ slug: string }>
      }
      assert.deepEqual(
        brains.brains.map((b) => b.slug),
        ['kept'],
      )
    })

    it('CA16: --delete-data with another name deletes nothing (exit 2); with the right one, its volumes go and the key stays', async () => {
      const wrong = await launch(['uninstall', '--delete-data', '--confirm', 'not-it', '--dir', dir])
      assert.equal(wrong.code, 2)
      assert.ok((await ofProject('ps', name)).length > 0)
      const key = envOf(dir).RSC_BRAIN_SECRET
      const right = await launch(['uninstall', '--delete-data', '--confirm', name, '--dir', dir])
      assert.equal(right.code, 0, right.stderr)
      assert.deepEqual(await ofProject('ps', name), [])
      assert.deepEqual(await ofProject('volume', name), [])
      assert.equal(readFileSync(join(dir, 'installation-key.txt'), 'utf8').trim(), key)
    })
  })

  describe('on a server with a domain (CA2)', () => {
    const name = `rscb-pr34-test-server-${ID}`
    let dir = ''
    let httpsPort = 0
    let httpPort = 0
    let pebblePort = 0

    // An HTTPS request to brain.test on this machine's port, trusting only `ca`.
    const get = (path: string, ca: string, port = httpsPort, servername = 'brain.test') =>
      new Promise<{ status: number; body: string }>((resolve, reject) => {
        const req = request(
          {
            host: '127.0.0.1',
            port,
            path,
            servername,
            ca,
            headers: { host: `${servername}:${port}` },
            timeout: 10_000,
          },
          (res) => {
            let body = ''
            res.on('data', (d) => {
              body += d
            })
            res.on('end', () => resolve({ status: res.statusCode ?? 0, body }))
          },
        )
        req.on('error', reject)
        req.on('timeout', () => req.destroy(new Error('timeout')))
        req.end()
      })

    before(async () => {
      projects.push(name)
      dir = join(BASE, 'server')
      // The folder holds only the person's own additions before the first install; Pebble's files live beside it.
      const pebble = join(BASE, 'pebble')
      mkdirSync(dir)
      mkdirSync(pebble)
      httpsPort = await freePort()
      httpPort = await freePort()
      pebblePort = await freePort()
      // Pebble's own root, to reach its directory over HTTPS.
      const probe = `rscb-pr34-test-pebble-probe-${ID}`
      await docker('create', '--name', probe, PEBBLE_IMAGE)
      try {
        await docker('cp', `${probe}:/test/certs/pebble.minica.pem`, join(pebble, 'pebble.minica.pem'))
      } finally {
        await docker('rm', probe).catch(() => {})
      }
      writeFileSync(
        join(pebble, 'pebble-config.json'),
        JSON.stringify({
          pebble: {
            listenAddress: '0.0.0.0:14000',
            managementListenAddress: '0.0.0.0:15000',
            certificate: 'test/certs/localhost/cert.pem',
            privateKey: 'test/certs/localhost/key.pem',
            httpPort: 80,
            tlsPort: 443,
            ocspResponderURL: '',
            externalAccountBindingRequired: false,
          },
        }),
      )
      // The test's own additions, in the file the launcher keeps and loads: an ACME test CA on the project's network,
      // Caddy pointed at it, and brain.test resolving to Caddy there.
      writeFileSync(
        join(dir, 'compose.override.yaml'),
        `services:
  caddy:
    environment:
      RSC_BRAIN_ACME_CA: https://pebble:14000/dir
      SSL_CERT_FILE: /pebble/pebble.minica.pem
    volumes:
      - ${pebble}/pebble.minica.pem:/pebble/pebble.minica.pem:ro
    networks:
      default:
        aliases: [brain.test]
  pebble:
    image: ${PEBBLE_IMAGE}
    command: ["-config", "/pebble/pebble-config.json"]
    environment:
      PEBBLE_VA_NOSLEEP: "1"
    volumes:
      - ${pebble}/pebble-config.json:/pebble/pebble-config.json:ro
    ports:
      - "127.0.0.1:${pebblePort}:15000"
`,
      )
    })

    it('CA2: install --domain brain.test --yes: HTTPS with a certificate from the ACME CA, and no certificate step', async () => {
      const r = await launch([
        'install',
        '--domain',
        'brain.test',
        '--yes',
        '--json',
        '--dir',
        dir,
        '--name',
        name,
        '--port',
        String(await freePort()),
        '--http-port',
        String(httpPort),
        '--https-port',
        String(httpsPort),
        '--image',
        IMAGE,
      ])
      assert.equal(r.code, 0, r.stderr)
      assert.equal(JSON.parse(r.stdout).url, `https://brain.test:${httpsPort}`)
      assert.doesNotMatch(r.stderr, /certificate/i)
      // The root Pebble issues from (it makes a new one each start).
      const minica = readFileSync(join(BASE, 'pebble', 'pebble.minica.pem'), 'utf8')
      const root = await until('the root of the ACME test CA', async () => {
        const g = await get('/roots/0', minica, pebblePort, 'localhost')
        return g.status === 200 ? g.body : null
      })
      const started = Date.now()
      const home = await until('the certificate for brain.test', async () => {
        const g = await get('/', root)
        return g.status === 200 ? g : null
      })
      measured(`CA2 certificate and first page ${((Date.now() - started) / 1000).toFixed(1)} s after install`)
      assert.match(home.body, /<html/i)
      // Caddy got it over ACME from the test CA (Pebble checked brain.test answers on the network).
      const logs = (await run('docker', ['logs', `${name}-caddy-1`], { maxBuffer: 64 << 20 })).stderr
      assert.match(logs, /certificate obtained successfully/)
      assert.match(logs, /pebble:14000/)
      // Through Caddy, the connection is the encrypted one the browser has.
      const setup = JSON.parse((await get('/v1/setup', root)).body) as {
        connection: { encrypted: boolean; local: boolean }
      }
      assert.deepEqual(setup.connection, { encrypted: true, local: false })
    })

    it('plain HTTP is sent to HTTPS', async () => {
      const r = await new Promise<{ status: number; location: string }>((resolve, reject) => {
        httpRequest(
          { host: '127.0.0.1', port: httpPort, path: '/', headers: { host: 'brain.test' } },
          (res) => {
            res.resume()
            resolve({ status: res.statusCode ?? 0, location: String(res.headers.location ?? '') })
          },
        )
          .on('error', reject)
          .end()
      })
      assert.ok([301, 308].includes(r.status), String(r.status))
      assert.match(r.location, /^https:\/\/brain\.test/)
    })

    it('risk 7: X-Forwarded-* is believed from Caddy’s fixed address only', async () => {
      const ask = (container: string) =>
        docker(
          'exec',
          container,
          'wget',
          '-q',
          '-O',
          '-',
          '--header',
          'X-Forwarded-Proto: https',
          'http://app:8090/v1/setup',
        ).then((b) => (JSON.parse(b) as { connection: { encrypted: boolean } }).connection.encrypted)
      assert.equal(await ask(`${name}-caddy-1`), true, 'from Caddy')
      assert.equal(await ask(`${name}-postgres-1`), false, 'from another container on the same network')
      const env = envOf(dir)
      assert.equal(env.RSC_BRAIN_TRUSTED_PROXIES, env.RSC_BRAIN_PROXY_IP)
      const ip = await docker(
        'inspect',
        '--format',
        '{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}',
        `${name}-caddy-1`,
      )
      assert.equal(ip, env.RSC_BRAIN_PROXY_IP)
    })

    it('uninstall --delete-data removes all of it', async () => {
      const r = await launch(['uninstall', '--delete-data', '--confirm', name, '--dir', dir])
      assert.equal(r.code, 0, r.stderr)
      assert.deepEqual(await ofProject('ps', name), [])
      assert.deepEqual(await ofProject('volume', name), [])
      assert.deepEqual(await ofProject('network', name), [])
    })
  })

  describe('from the source, as the README says: the launcher alone, from a 077 shell (review of PR #35)', () => {
    const name = `rscb-pr34-test-src-${ID}`
    // A version of its own, so the image it builds (rsc-brain:<version>) is this test's alone.
    const version = `v34.${Number.parseInt(ID.slice(0, 4), 16)}.0`
    let repo = ''
    let alone = ''
    before(async () => {
      projects.push(name)
      // A tagged clone of this tree (with what is not committed yet), as the public repository would serve it.
      repo = join(BASE, 'repo')
      const files = (
        await run('git', ['-C', ROOT, 'ls-files', '-co', '--exclude-standard'], { maxBuffer: 64 << 20 })
      ).stdout
        .split('\n')
        .filter((f) => f && existsSync(join(ROOT, f)))
      for (const f of files) {
        mkdirSync(dirname(join(repo, f)), { recursive: true })
        copyFileSync(join(ROOT, f), join(repo, f))
      }
      const git = (...a: string[]) =>
        run('git', ['-C', repo, '-c', 'user.name=test', '-c', 'user.email=test@example.com', ...a])
      await git('init', '-q')
      await git('add', '-A')
      await git('commit', '-q', '-m', 'test')
      await git('tag', version)
      alone = join(BASE, 'launcher-alone')
      mkdirSync(alone)
      copyFileSync(LAUNCHER, join(alone, 'rsc-brain.sh'))
    })
    after(async () => {
      await docker('image', 'rm', '-f', `rsc-brain:${version}`).catch(() => {})
    })

    it('clones the version, builds its image and answers', async () => {
      const dir = join(BASE, 'from-source')
      const port = await freePort()
      const r = await launch(
        [
          'install',
          '--local',
          '--yes',
          '--json',
          '--dir',
          dir,
          '--name',
          name,
          '--port',
          String(port),
          '--version',
          version,
        ],
        {
          argv: ['-c', 'umask 077 && exec sh "$0" "$@"', join(alone, 'rsc-brain.sh')],
          env: { RSC_BRAIN_REPO: `file://${repo}` },
        },
      )
      assert.equal(r.code, 0, r.stderr.slice(-3000))
      measured(`from the source, the launcher alone in a 077 shell: ${r.seconds.toFixed(1)} s`)
      const branding = (await (await fetch(`http://localhost:${port}/v1/branding`)).json()) as {
        setupRequired: boolean
      }
      assert.equal(branding.setupRequired, true)
      const u = await launch(['uninstall', '--delete-data', '--confirm', name, '--dir', dir], {
        argv: [join(alone, 'rsc-brain.sh')],
      })
      assert.equal(u.code, 0, u.stderr)
    })
  })

  describe('stopped while it makes its database in a real PostgreSQL (review of PR #35)', () => {
    const name = `rscb-pr34-test-hup-${ID}`
    const pg = `rscb-pr34-test-pg-${ID}`
    const db = name.replaceAll('-', '_')
    let adminFile = ''
    const sql = (q: string) => docker('exec', pg, 'psql', '-U', 'postgres', '-Atc', q)
    before(async () => {
      projects.push(name)
      const port = await freePort()
      await docker(
        'run',
        '-d',
        '--name',
        pg,
        '-p',
        `127.0.0.1:${port}:5432`,
        '-e',
        'POSTGRES_PASSWORD=pr34-test-only',
        'postgres:17.11-alpine',
      )
      await until('PostgreSQL', async () => ((await sql('SELECT 1')) === '1' ? true : null))
      adminFile = join(BASE, 'hup-admin-url')
      writeFileSync(adminFile, `postgres://postgres:pr34-test-only@host.docker.internal:${port}/postgres\n`)
    })
    after(async () => {
      await docker('rm', '-f', '-v', pg).catch(() => {})
    })

    it('HUP mid-provision: the role and database it was making are gone, and so is everything else it made; a rerun installs', async () => {
      const dir = join(BASE, 'hup')
      const args = [
        'install',
        '--local',
        '--yes',
        '--dir',
        dir,
        '--name',
        name,
        '--port',
        String(await freePort()),
        '--image',
        IMAGE,
        '--db',
        'existing',
        '--db-admin-url-file',
        adminFile,
      ]
      let sent = false
      const r = await launch(args, {
        onStderr: (all, kill) => {
          if (!sent && /Making the database/.test(all)) {
            sent = true
            kill('SIGHUP')
          }
        },
      })
      assert.ok(sent)
      assert.equal(r.code, 4, r.stderr)
      assert.equal(await sql(`SELECT count(*) FROM pg_database WHERE datname = '${db}'`), '0')
      assert.equal(await sql(`SELECT count(*) FROM pg_roles WHERE rolname = '${db}'`), '0')
      assert.equal(existsSync(dir), false)
      assert.deepEqual(await ofProject('ps', name), [])
      const again = await launch(args)
      assert.equal(again.code, 0, again.stderr)
      assert.equal(await sql(`SELECT count(*) FROM pg_database WHERE datname = '${db}'`), '1')
      const u = await launch([
        'uninstall',
        '--delete-data',
        '--confirm',
        name,
        '--dir',
        dir,
        '--db-admin-url-file',
        adminFile,
      ])
      assert.equal(u.code, 0, u.stderr)
      assert.equal(await sql(`SELECT count(*) FROM pg_roles WHERE rolname = '${db}'`), '0')
    })
  })

  describe('two launchers on one folder at once (second pass on PR #35)', () => {
    const name = `rscb-pr34-test-twice-${ID}`
    before(() => {
      projects.push(name)
    })

    it('the second exits 3 naming the first; the first completes with the key it wrote', async () => {
      const dir = join(BASE, 'twice')
      const args = [
        'install',
        '--local',
        '--yes',
        '--json',
        '--dir',
        dir,
        '--name',
        name,
        '--port',
        String(await freePort()),
        '--image',
        IMAGE,
      ]
      let second: Promise<Run> | null = null
      const first = await launch(args, {
        onStderr: (all) => {
          if (!second && /Starting PostgreSQL/.test(all)) second = launch(args)
        },
      })
      assert.ok(second, 'the second launcher ran while the first worked')
      const b = await (second as unknown as Promise<Run>)
      assert.equal(b.code, 3, b.stderr)
      assert.match(
        b.stderr,
        /Another rsc-brain launcher is working on .* \(process \d+\)\. Wait for it to finish\./,
      )
      assert.equal(first.code, 0, first.stderr)
      const key = JSON.parse(first.stdout).installationKey
      assert.equal(key, envOf(dir).RSC_BRAIN_SECRET)
      const branding = (await (await fetch(`${JSON.parse(first.stdout).url}/v1/branding`)).json()) as {
        setupRequired: boolean
      }
      assert.equal(branding.setupRequired, true)
      const u = await launch(['uninstall', '--delete-data', '--confirm', name, '--dir', dir])
      assert.equal(u.code, 0, u.stderr)
    })
  })
})
