// A clean installation for the usage scripts of spec learning-memory (plan §6.3): a new database on the PostgreSQL in
// RSC_BRAIN_PG_URL (scripts/pg-test.sh), `node dist/cli/main.js serve` on a free port, the first-time setup by the
// route the web uses, a brain «demo» and three people with their tokens: its curator (the administrator who set it
// up), a contributor and a reader, invited and accepted as the web does it. Everything after the database is created
// goes over HTTP, as a client.
//
//   RSC_BRAIN_PG_URL=… node scripts/usage/clean-install.ts [--no-build]
//
// The scripts t1-*.ts import cleanInstall() and api(); run alone, this one installs, checks that each person reaches
// the brain with the role given, prints PASS or FAIL and removes what it made.
import { type ChildProcess, execFile, spawn } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { createServer } from 'node:net'
import { join } from 'node:path'
import { promisify } from 'node:util'
import pg from 'pg'
import { MODERN } from '../../src/mcp/server.ts'

const run = promisify(execFile)
export const ROOT = new URL('../..', import.meta.url).pathname
const WEB = 'rsc-brain-web'
const PASSWORD = 'a long usage password 25'

export const say = (s: string) => process.stdout.write(`${s}\n`)

export type Reply = { status: number; body: Record<string, unknown>; text: string }
export type Who = { name: string; email: string; cookie: string; token: string; id: string }
export type Install = {
  base: string
  dbUrl: string
  admin: Who
  curator: Who
  contributor: Who
  reader: Who
  stop(): Promise<void>
  drop(): Promise<void>
}

// A caller of the API: a token (Bearer) or a web session (cookie and the web's header). Each request is printed with
// its answer's status; `show` picks what of the answer is printed.
export function api(base: string) {
  return async (
    who: { token?: string; cookie?: string; name?: string } | null,
    method: string,
    path: string,
    body?: unknown,
    show: (b: Record<string, unknown>) => unknown = () => undefined,
  ): Promise<Reply> => {
    const headers: Record<string, string> = {}
    // A web session when there is one; else the token.
    if (who?.token && !who.cookie) headers.authorization = `Bearer ${who.token}`
    if (who?.cookie) {
      headers.cookie = who.cookie
      headers['x-requested-with'] = WEB
    }
    if (body !== undefined) headers['content-type'] = 'application/json'
    const res = await fetch(`${base}${path}`, {
      method,
      headers,
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    })
    const text = await res.text()
    let parsed: Record<string, unknown> = {}
    try {
      parsed = text ? (JSON.parse(text) as Record<string, unknown>) : {}
    } catch {
      parsed = { raw: text.slice(0, 200) }
    }
    const as = who ? ` as ${who.name ?? (who.cookie ? 'web' : 'token')}${who.cookie ? ' (web)' : ''}` : ''
    let shown: unknown
    try {
      shown = show(parsed)
    } catch {
      shown = parsed.error ?? Object.keys(parsed)
    }
    const error = (parsed.error as { code?: string } | undefined)?.code
    say(
      `> ${method} ${path}${as} -> ${res.status}${error ? ` ${error}` : ''}${shown === undefined ? '' : ` ${JSON.stringify(shown)}`}`,
    )
    return { status: res.status, body: parsed, text }
  }
}

// A caller of /mcp, as an MCP client: one tools/call with a token. Prints the tool and what `show` picks of its result.
export function mcp(base: string) {
  let n = 0
  return async (
    who: { token: string; name?: string },
    name: string,
    args: Record<string, unknown>,
    show: (b: Record<string, unknown>) => unknown = () => undefined,
  ): Promise<{ error?: string; result?: Record<string, unknown> }> => {
    n += 1
    const res = await fetch(`${base}/mcp`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${who.token}`,
        'content-type': 'application/json',
        'mcp-protocol-version': MODERN,
        'mcp-method': 'tools/call',
        'mcp-name': name,
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: n,
        method: 'tools/call',
        params: { name, arguments: args, _meta: { 'io.modelcontextprotocol/protocolVersion': MODERN } },
      }),
    })
    const body = (await res.json()) as { result?: { isError: boolean; content: Array<{ text: string }> } }
    const text = body.result?.content[0]?.text ?? JSON.stringify(body)
    const out = body.result?.isError || !body.result ? { error: text } : { result: JSON.parse(text) }
    let shown: unknown
    try {
      shown = out.result ? show(out.result) : String(out.error).slice(0, 200)
    } catch {
      shown = Object.keys(out.result ?? {})
    }
    say(
      `> mcp ${name} as ${who.name ?? 'token'} -> ${out.error ? 'error' : 'ok'}${shown === undefined ? '' : ` ${JSON.stringify(shown)}`}`,
    )
    return out
  }
}

const freePort = () =>
  new Promise<number>((resolve) => {
    const s = createServer().listen(0, '127.0.0.1', () => {
      const p = (s.address() as { port: number }).port
      s.close(() => resolve(p))
    })
  })

export async function build(root = ROOT): Promise<void> {
  say(`$ npm run build (${root})`)
  await run('npm', ['run', '--silent', 'build'], { cwd: root, maxBuffer: 64 << 20 })
}

export async function createDatabase(): Promise<string> {
  const admin = process.env.RSC_BRAIN_PG_URL
  if (!admin) throw new Error('Set RSC_BRAIN_PG_URL (eval "$(bash scripts/pg-test.sh env)").')
  const name = `usage_${randomBytes(5).toString('hex')}`
  const c = new pg.Client({ connectionString: admin })
  await c.connect()
  await c.query(`CREATE DATABASE ${name}`)
  await c.end()
  const u = new URL(admin)
  u.pathname = `/${name}`
  return u.toString()
}

export async function dropDatabase(url: string): Promise<void> {
  const admin = process.env.RSC_BRAIN_PG_URL as string
  const c = new pg.Client({ connectionString: admin })
  await c.connect()
  await c.query(`DROP DATABASE IF EXISTS ${new URL(url).pathname.slice(1)} WITH (FORCE)`)
  await c.end()
}

// `node dist/cli/main.js serve` of `root` on `dbUrl`, until /v1/health answers. Its log goes to stderr.
export async function serve(dbUrl: string, root = ROOT): Promise<{ base: string; stop(): Promise<void> }> {
  const port = await freePort()
  const child: ChildProcess = spawn('node', [join(root, 'dist/cli/main.js'), 'serve'], {
    cwd: root,
    env: {
      ...process.env,
      RSC_BRAIN_DATABASE_URL: dbUrl,
      RSC_BRAIN_PORT: String(port),
      RSC_BRAIN_HOST: '127.0.0.1',
      RSC_BRAIN_SECRET: 'usage-secret-of-at-least-thirty-two-characters',
      RSC_BRAIN_RELEASES_URL: '',
    },
    stdio: ['ignore', 'ignore', 'pipe'],
  })
  let log = ''
  child.stderr?.on('data', (d) => {
    log += d
  })
  const base = `http://127.0.0.1:${port}`
  const end = Date.now() + 30_000
  for (;;) {
    if (child.exitCode !== null) throw new Error(`serve exited ${child.exitCode}: ${log.slice(-2000)}`)
    try {
      const r = await fetch(`${base}/v1/health`)
      if (r.status === 200) break
    } catch {}
    if (Date.now() > end) throw new Error(`serve did not answer: ${log.slice(-2000)}`)
    await new Promise((r) => setTimeout(r, 200))
  }
  say(`$ node dist/cli/main.js serve  (${base})`)
  return {
    base,
    stop: () =>
      new Promise<void>((resolve) => {
        if (child.exitCode !== null) return resolve()
        child.once('exit', () => resolve())
        child.kill('SIGTERM')
      }),
  }
}

async function post(base: string, path: string, body: unknown, cookie?: string) {
  const res = await fetch(`${base}${path}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-requested-with': WEB,
      ...(cookie ? { cookie } : {}),
    },
    body: JSON.stringify(body),
  })
  const text = await res.text()
  return { status: res.status, body: text ? (JSON.parse(text) as Record<string, unknown>) : {}, res }
}

const cookieOf = (res: Response) => (res.headers.get('set-cookie') ?? '').split(';')[0] as string

async function tokenOf(base: string, cookie: string, name: string): Promise<string> {
  const r = await post(
    base,
    '/v1/me/tokens',
    { name: `${name} agent`, perm: 'write', allBrains: true, days: 30 },
    cookie,
  )
  if (r.status !== 201) throw new Error(`token for ${name}: ${r.status} ${JSON.stringify(r.body)}`)
  return (r.body.token as { secret: string }).secret
}

async function myId(base: string, cookie: string): Promise<string> {
  const r = await fetch(`${base}/v1/me`, { headers: { cookie, 'x-requested-with': WEB } })
  const b = (await r.json()) as { account?: { id: string } }
  return String(b.account?.id)
}

// The setup, the brain and the people, on a server already running.
export async function populate(base: string): Promise<Omit<Install, 'stop' | 'drop' | 'dbUrl' | 'base'>> {
  const setup = await post(base, '/v1/setup', {
    name: 'Usage',
    publicUrl: base,
    admin: { name: 'Cora Curator', email: 'cora@example.test', password: PASSWORD },
  })
  if (setup.status !== 201) throw new Error(`setup: ${setup.status} ${JSON.stringify(setup.body)}`)
  say('> POST /v1/setup (web) -> 201')
  const login = await post(base, '/v1/auth/login', { email: 'cora@example.test', password: PASSWORD })
  if (login.status !== 200) throw new Error(`login: ${login.status}`)
  const adminCookie = cookieOf(login.res)
  const brain = await post(base, '/v1/brains', { slug: 'demo', name: 'Demo' }, adminCookie)
  if (brain.status !== 201) throw new Error(`brain: ${brain.status} ${JSON.stringify(brain.body)}`)
  say('> POST /v1/brains {slug: demo} (web) -> 201')
  const admin: Who = {
    name: 'Cora Curator',
    email: 'cora@example.test',
    cookie: adminCookie,
    token: await tokenOf(base, adminCookie, 'Cora'),
    id: await myId(base, adminCookie),
  }
  const invite = async (name: string, role: 'contributor' | 'reader'): Promise<Who> => {
    const email = `${name.toLowerCase()}@example.test`
    const made = await post(
      base,
      '/v1/invitations',
      { emails: [email], brains: [{ slug: 'demo', role }] },
      adminCookie,
    )
    if (made.status !== 201) throw new Error(`invite ${email}: ${made.status} ${JSON.stringify(made.body)}`)
    const link = (made.body.invitations as Array<{ link: string }>)[0]?.link ?? ''
    const acc = await post(base, '/v1/invitations/accept', {
      token: /#token=([\w-]+)/.exec(link)?.[1] ?? '',
      name,
      password: PASSWORD,
    })
    if (acc.status !== 201) throw new Error(`accept ${email}: ${acc.status} ${JSON.stringify(acc.body)}`)
    const cookie = cookieOf(acc.res)
    say(`> POST /v1/invitations + /accept ${name} as ${role} (web) -> 201`)
    return { name, email, cookie, token: await tokenOf(base, cookie, name), id: await myId(base, cookie) }
  }
  return {
    admin,
    curator: admin,
    contributor: await invite('Cole', 'contributor'),
    reader: await invite('Rita', 'reader'),
  }
}

export async function cleanInstall(o: { build?: boolean; root?: string } = {}): Promise<Install> {
  const root = o.root ?? ROOT
  if (o.build !== false) await build(root)
  const dbUrl = await createDatabase()
  const server = await serve(dbUrl, root)
  const people = await populate(server.base)
  return { base: server.base, dbUrl, ...people, stop: server.stop, drop: () => dropDatabase(dbUrl) }
}

// Run alone: install, check each role, clean up.
if (import.meta.url === `file://${process.argv[1]}`) {
  const inst = await cleanInstall({ build: !process.argv.includes('--no-build') })
  const call = api(inst.base)
  let ok = true
  try {
    for (const [who, want] of [
      [inst.curator, 'curator'],
      [inst.contributor, 'contributor'],
      [inst.reader, 'reader'],
    ] as const) {
      const r = await call(
        { token: who.token, name: who.name },
        'GET',
        '/v1/brains/demo',
        undefined,
        (b) => ({
          role: (b.brain as { role?: string } | undefined)?.role,
        }),
      )
      const role = (r.body.brain as { role?: string } | undefined)?.role
      if (r.status !== 200 || role !== want) ok = false
    }
  } finally {
    await inst.stop()
    await inst.drop()
  }
  say(ok ? 'PASS' : 'FAIL')
  process.exit(ok ? 0 : 1)
}
