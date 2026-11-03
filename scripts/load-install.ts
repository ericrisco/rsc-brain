// The load of CA18 (spec B7: «5 people and 50 000 entries on a machine of 2 GB and 2 cores: 95 % of searches under
// 1 second, no process of the service out of memory»), with the targets the plan fixed before measuring (plan §5.2,
// P7): 5 people, 50 000 entries in 3 brains, 600 pages; for 10 minutes, 4 agents (a search every 2 s, a save every
// 15 s) and 5 people in the web (overview, the map of the wiki, the activity followed live, the counters every 30 s);
// the app limited to 1 GB and PostgreSQL to 1 GB, both on CPUs 0-1. It passes when the p95 of the searches is under
// 1 000 ms, neither container was killed for memory (OOMKilled=false) and neither restarted.
//
//   node scripts/load-install.ts [--minutes 10] [--keep]
//
// Real containers through the launcher (deploy/rsc-brain.sh) with the image built from this tree; Docker resources
// named rscb-load-<id>, removed at the end (--keep leaves the installation). The pages come in through the import
// (a generated documentation folder per brain, 200 linked pages each); a few entries through the API (so the agents'
// sessions exist), then the rest straight into the database as the journal stores them (one row in entries and its
// first revision), since 50 000 saves through the API would measure the seeding, not the load. Prints the machine,
// the numbers and PASS or FAIL; exits 1 on FAIL.
import { execFile, spawn } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { cpus, platform, release, tmpdir, totalmem } from 'node:os'
import { join } from 'node:path'
import { parseArgs, promisify } from 'node:util'

const run = promisify(execFile)
const ROOT = new URL('..', import.meta.url).pathname
const LAUNCHER = join(ROOT, 'deploy', 'rsc-brain.sh')
const { values } = parseArgs({
  options: { minutes: { type: 'string', default: '10' }, keep: { type: 'boolean', default: false } },
})
const MINUTES = Number(values.minutes)
const ID = randomBytes(3).toString('hex')
const NAME = `rscb-load-${ID}`
const DB = NAME.replaceAll('-', '_')
const IMAGE = `rscb-load-image:${ID}`
const BRAINS = ['alpha', 'beta', 'gamma']
const ENTRIES = 50_000
const PAGES_PER_BRAIN = 200
const PASSWORD = 'a long load password 18'
const WEB = { 'x-requested-with': 'rsc-brain-web', 'content-type': 'application/json' }
const WORDS =
  'release deploy schema index cache queue billing invoice customer refund latency timeout retry backup restore migration token session password search ranking embedding wiki journal proposal curator reader contributor audit export import vault graph health budget roadmap pricing onboarding support incident outage postmortem metric alert dashboard quarter launch partner contract'.split(
    ' ',
  )

const say = (s: string) => process.stderr.write(`${s}\n`)
const docker = async (...args: string[]) => (await run('docker', args, { maxBuffer: 64 << 20 })).stdout.trim()
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
const pick = <T>(xs: T[]) => xs[Math.floor(Math.random() * xs.length)] as T
const freePort = () =>
  new Promise<number>((resolve) => {
    const s = createServer().listen(0, '127.0.0.1', () => {
      const p = (s.address() as { port: number }).port
      s.close(() => resolve(p))
    })
  })
const launcher = (args: string[]) =>
  new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve) => {
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
    })
    p.on('close', (code) => resolve({ code, stdout, stderr }))
  })
const psql = (sql: string) =>
  docker('exec', `${NAME}-postgres-1`, 'psql', '-U', 'postgres', '-d', DB, '-Atqc', sql)
const pct = (xs: number[], p: number) => {
  const s = [...xs].sort((a, b) => a - b)
  return s.length ? (s[Math.min(s.length - 1, Math.ceil((p / 100) * s.length) - 1)] as number) : Number.NaN
}

async function main(): Promise<number> {
  const base = mkdtempSync(join(tmpdir(), 'rscb-load-'))
  const dir = join(base, 'install')
  mkdirSync(dir)
  let site = ''
  try {
    // ------------------------------------------------------------------------------------------------ the machine
    const vm = JSON.parse(await docker('info', '--format', '{{json .}}')) as {
      NCPU: number
      MemTotal: number
    }
    const machine = `${platform()} ${release()}, ${cpus()[0]?.model ?? 'cpu'} × ${cpus().length}, ${(totalmem() / 2 ** 30).toFixed(0)} GB; Docker VM ${vm.NCPU} CPUs, ${(vm.MemTotal / 2 ** 30).toFixed(1)} GB`
    say(`machine: ${machine}`)
    // ------------------------------------------------------------------------------------------- the installation
    say('building the image')
    await run('docker', ['build', '-q', '-t', IMAGE, ROOT], { maxBuffer: 64 << 20 })
    // The limits of CA18: 1 GB each, both on CPUs 0-1 (the person's own additions go in this file).
    writeFileSync(
      join(dir, 'compose.override.yaml'),
      'services:\n  app:\n    mem_limit: 1g\n    memswap_limit: 1g\n    cpuset: "0-1"\n  postgres:\n    mem_limit: 1g\n    memswap_limit: 1g\n    cpuset: "0-1"\n',
    )
    const port = await freePort()
    const inst = await launcher([
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
      IMAGE,
    ])
    if (inst.code !== 0) throw new Error(`install failed: ${inst.stderr}`)
    site = JSON.parse(inst.stdout).url as string
    const post = (path: string, body: unknown, headers: Record<string, string> = {}) =>
      fetch(`${site}${path}`, { method: 'POST', headers: { ...WEB, ...headers }, body: JSON.stringify(body) })
    const setup = await post('/v1/setup', {
      name: 'Load',
      publicUrl: site,
      admin: { name: 'Admin', email: 'admin@example.test', password: PASSWORD },
    })
    if (setup.status !== 201) throw new Error(`setup: ${setup.status} ${await setup.text()}`)
    const signIn = async (email: string) => {
      const r = await post('/v1/auth/login', { email, password: PASSWORD })
      if (r.status !== 200) throw new Error(`sign in ${email}: ${r.status}`)
      return (r.headers.get('set-cookie') ?? '').split(';')[0] as string
    }
    const admin = await signIn('admin@example.test')
    for (const slug of BRAINS) {
      const r = await post(
        '/v1/brains',
        { slug, name: slug[0]?.toUpperCase() + slug.slice(1) },
        { cookie: admin },
      )
      if (r.status !== 201) throw new Error(`brain ${slug}: ${r.status}`)
    }
    // ------------------------------------------------------------------------------- 600 pages, by the import
    say('importing 600 linked pages')
    for (const slug of BRAINS) {
      const folder = join(dir, 'backups', `load-${slug}`, 'wiki')
      mkdirSync(folder, { recursive: true })
      for (let i = 0; i < PAGES_PER_BRAIN; i++) {
        const links = [1, 7, 31].map((k) => `[[page-${(i + k) % PAGES_PER_BRAIN}]]`).join(', ')
        const words = Array.from({ length: 120 }, () => pick(WORDS)).join(' ')
        writeFileSync(
          join(folder, `page-${i}.md`),
          `---\ntitle: Page ${i} of ${slug}\n---\n\n# Page ${i}\n\nAbout ${pick(WORDS)} and ${pick(WORDS)}. See ${links}.\n\n${words}\n`,
        )
      }
      const imp = await run(
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
          'exec',
          '-T',
          'app',
          'rsc-brain',
          'import',
          '--brain',
          slug,
          '--from',
          `/backups/load-${slug}`,
          '--as',
          'admin@example.test',
          '--json',
        ],
        { maxBuffer: 64 << 20 },
      )
      const rep = JSON.parse(imp.stdout) as { pages?: { imported?: number } }
      say(`  ${slug}: ${JSON.stringify(rep.pages ?? rep).slice(0, 120)}`)
    }
    // ----------------------------------------------------------------------------------- 5 people, 4 agents
    say('inviting 4 people and making their agents')
    const people: Array<{ email: string; cookie: string; token: string }> = []
    for (const n of ['ana', 'bob', 'cai', 'dee']) {
      const email = `${n}@example.test`
      const made = await post(
        '/v1/invitations',
        { emails: [email], brains: BRAINS.map((slug) => ({ slug, role: 'contributor' })) },
        { cookie: admin },
      )
      const link =
        ((await made.json()) as { invitations: Array<{ link: string }> }).invitations[0]?.link ?? ''
      const acc = await post('/v1/invitations/accept', {
        token: /#token=([\w-]+)/.exec(link)?.[1] ?? '',
        name: n,
        password: PASSWORD,
      })
      if (acc.status !== 201) throw new Error(`accept ${email}: ${acc.status} ${await acc.text()}`)
      const cookie = (acc.headers.get('set-cookie') ?? '').split(';')[0] as string
      const t = await post(
        '/v1/me/tokens',
        { name: `${n}'s agent`, perm: 'write', allBrains: true, days: 30 },
        { cookie },
      )
      const token = ((await t.json()) as { token: { secret: string } }).token.secret
      people.push({ email, cookie, token })
    }
    const save = (token: string, slug: string, i: number) =>
      post(
        `/v1/brains/${slug}/entries`,
        {
          type: pick(['decision', 'learning', 'fact', 'note']),
          title: `Agent note ${i} on ${pick(WORDS)}`,
          content: Array.from({ length: 40 }, () => pick(WORDS)).join(' '),
        },
        { authorization: `Bearer ${token}` },
      )
    // --------------------------------------------------------------------------- 50 000 entries in 3 brains
    say('seeding 50 000 entries')
    let viaApi = 0
    for (const p of people)
      for (const slug of BRAINS) {
        const r = await save(p.token, slug, viaApi)
        if (r.status !== 201) throw new Error(`save: ${r.status} ${await r.text()}`)
        viaApi++
      }
    const per = Math.ceil((ENTRIES - viaApi) / BRAINS.length)
    // A word drawn at random for each use (a volatile function, so every row and column gets its own).
    const w = 'pg_temp.word()'
    const content = `concat_ws(' ', ${Array.from({ length: 30 }, () => w).join(', ')})`
    await psql(`
      CREATE FUNCTION pg_temp.word() RETURNS text VOLATILE LANGUAGE sql
        AS $$ SELECT (ARRAY[${WORDS.map((x) => `'${x}'`).join(',')}])[1 + floor(random() * ${WORDS.length})::int] $$;
      CREATE TEMP TABLE src AS
        SELECT DISTINCT ON (e.brain_id) e.brain_id, e.session_id, e.author_id, b.slug
          FROM entries e JOIN brains b ON b.id = e.brain_id ORDER BY e.brain_id, e.created_at;
      CREATE TEMP TABLE seed AS
        SELECT 'load_' || s.slug || '_' || g AS id, s.brain_id, s.session_id, s.author_id,
               (ARRAY['decision','learning','fact','note'])[1 + g % 4] AS type,
               'Load entry ' || g || ' on ' || ${w} || ' and ' || ${w} AS title,
               ${content} AS content,
               now() - (g || ' minutes')::interval AS at
          FROM src s CROSS JOIN generate_series(1, ${per}) g;
      INSERT INTO entries (id, brain_id, session_id, type, title, content, author_id, norm_hash, created_at, updated_at)
        SELECT id, brain_id, session_id, type, title, content, author_id, md5(content), at, at FROM seed;
      INSERT INTO entry_revisions (entry_id, revision, type, title, content, author_id, created_at)
        SELECT id, 1, type, title, content, author_id, at FROM seed;
      ANALYZE;`)
    const counts = await psql(
      "SELECT (SELECT count(*) FROM entries) || ' entries, ' || (SELECT count(*) FROM pages) || ' pages, ' || (SELECT count(*) FROM accounts WHERE kind = 'person') || ' people'",
    )
    say(`seeded: ${counts}`)

    // ---------------------------------------------------------------------------------------------- the load
    const until = Date.now() + MINUTES * 60_000
    const searches: number[] = []
    const errors: Record<string, number> = {}
    let saves = 0
    let reads = 0
    let streams = 0
    const fail = (what: string) => {
      errors[what] = (errors[what] ?? 0) + 1
    }
    const timed = async (what: string, f: () => Promise<Response>, into?: number[]) => {
      const t0 = performance.now()
      try {
        const r = await f()
        await r.arrayBuffer()
        const ms = performance.now() - t0
        if (r.status >= 400) fail(`${what} ${r.status}`)
        else into?.push(ms)
        return ms
      } catch {
        fail(`${what} network`)
        return Number.NaN
      }
    }
    const get = (path: string, h: Record<string, string>) => fetch(`${site}${path}`, { headers: h })
    const every = async (ms: number, f: () => Promise<unknown>) => {
      await sleep(Math.random() * ms)
      while (Date.now() < until) {
        const t0 = Date.now()
        await f()
        await sleep(Math.max(0, ms - (Date.now() - t0)))
      }
    }
    const agents = people.map((p, i) =>
      Promise.all([
        every(2000, () =>
          timed(
            'search',
            () =>
              get(`/v1/search?q=${encodeURIComponent(`${pick(WORDS)} ${pick(WORDS)}`)}&limit=10`, {
                authorization: `Bearer ${p.token}`,
              }),
            searches,
          ),
        ),
        every(15_000, async () => {
          const r = await save(p.token, pick(BRAINS), i)
          await r.arrayBuffer()
          if (r.status === 201) saves++
          else fail(`save ${r.status}`)
        }),
      ]),
    )
    const browsers = [{ cookie: admin }, ...people].map(async (p, i) => {
      const slug = BRAINS[i % BRAINS.length] as string
      const h = { cookie: p.cookie }
      const ac = new AbortController()
      // The activity, followed live for the whole run.
      const live = (async () => {
        try {
          const r = await fetch(`${site}/v1/brains/${slug}/events`, {
            headers: { ...h, accept: 'text/event-stream' },
            signal: ac.signal,
          })
          if (r.status !== 200) return fail(`events ${r.status}`)
          streams++
          const reader = r.body?.getReader()
          while (reader && !(await reader.read()).done) {}
        } catch {
          // Aborted at the end.
        }
      })()
      await timed('overview', () => get(`/v1/brains/${slug}/overview`, h))
      await timed('graph', () => get(`/v1/brains/${slug}/wiki/graph`, h))
      reads += 2
      await every(30_000, async () => {
        await timed('brains', () => get('/v1/brains', h))
        await timed('to-review', () => get(`/v1/brains/${slug}/to-review`, h))
        reads += 2
      })
      ac.abort()
      await live
    })
    // Memory, sampled every 15 s.
    let peakApp = 0
    let peakPg = 0
    const mem = (s: string) => {
      const m = /([\d.]+)\s*([KMG]i?B)/.exec(s)
      if (!m) return 0
      const n = Number(m[1])
      return m[2]?.startsWith('G') ? n * 1024 : m[2]?.startsWith('K') ? n / 1024 : n
    }
    const sampler = every(15_000, async () => {
      const out = await docker(
        'stats',
        '--no-stream',
        '--format',
        '{{.Name}} {{.MemUsage}}',
        `${NAME}-app-1`,
        `${NAME}-postgres-1`,
      ).catch(() => '')
      for (const line of out.split('\n')) {
        if (line.startsWith(`${NAME}-app-1`)) peakApp = Math.max(peakApp, mem(line))
        if (line.startsWith(`${NAME}-postgres-1`)) peakPg = Math.max(peakPg, mem(line))
      }
    })
    say(`running the load for ${MINUTES} min`)
    await Promise.all([...agents, ...browsers, sampler])

    // ------------------------------------------------------------------------------------------- the verdict
    const state = async (c: string): Promise<[{ OOMKilled: boolean }, number]> => [
      JSON.parse(await docker('inspect', '--format', '{{json .State}}', c)) as { OOMKilled: boolean },
      Number(await docker('inspect', '--format', '{{.RestartCount}}', c)),
    ]
    const [appState, appRestarts] = await state(`${NAME}-app-1`)
    const [pgState, pgRestarts] = await state(`${NAME}-postgres-1`)
    const limits = await docker(
      'inspect',
      '--format',
      '{{.HostConfig.Memory}} {{.HostConfig.CpusetCpus}}',
      `${NAME}-app-1`,
    )
    const p95 = pct(searches, 95)
    const result = {
      machine,
      limits: `app ${limits} (bytes, cpuset); postgres the same`,
      seeded: counts,
      minutes: MINUTES,
      searches: searches.length,
      searchMs: {
        p50: Math.round(pct(searches, 50)),
        p95: Math.round(p95),
        p99: Math.round(pct(searches, 99)),
        max: Math.round(Math.max(...searches)),
      },
      saves,
      reads,
      streams,
      errors,
      peakMemoryMiB: { app: Math.round(peakApp), postgres: Math.round(peakPg) },
      oomKilled: { app: appState.OOMKilled, postgres: pgState.OOMKilled },
      restarts: { app: appRestarts, postgres: pgRestarts },
    }
    const pass =
      p95 < 1000 &&
      !appState.OOMKilled &&
      !pgState.OOMKilled &&
      appRestarts === 0 &&
      pgRestarts === 0 &&
      searches.length > 0
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`)
    say(pass ? 'PASS: p95 of searches < 1000 ms, OOMKilled=false, 0 restarts' : 'FAIL')
    return pass ? 0 : 1
  } finally {
    if (!values.keep) {
      await launcher(['uninstall', '--delete-data', '--confirm', NAME, '--dir', dir]).catch(() => {})
      await docker('image', 'rm', '-f', IMAGE).catch(() => {})
      rmSync(base, { recursive: true, force: true })
    } else say(`kept: ${dir} (${site})`)
  }
}

main().then(
  (code) => process.exit(code),
  (err) => {
    say(String(err?.stack ?? err))
    process.exit(1)
  },
)
