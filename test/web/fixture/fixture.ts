// The fixture API (plan §3.6): the built web, served by the same code as the server (src/http/web.ts),
// next to answers for the v1 operations the web uses, with seeded data. It lets the browser tests run in
// CI without PostgreSQL. Every answer is checked against the description of v1 (test/web/fixture.test.ts),
// so the fixture cannot drift from the server unnoticed.
//
// Each browser test gets its own scenario (its own sign-ins, setup and forced states), named by the
// header x-fixture-scenario or the cookie fixture_scenario, so tests run in parallel without sharing.
import { randomBytes } from 'node:crypto'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { fileURLToPath } from 'node:url'
import { answerWeb, openWeb } from '../../../src/http/web.ts'
import { generate } from '../../../web/test/data/generate.ts'

export const PASSWORD = 'correct horse battery staple'
export const CODE = '424242'
export const INVITE_TOKEN = 'inv_fixture_good_token_0001'
export const RESET_TOKEN = 'rst_fixture_good_token_0001'

export type Screen =
  | 'home'
  | 'brain'
  | 'search'
  | 'invite'
  | 'setup'
  | 'me'
  | 'sign-in'
  | 'reset'
  | 'branding'
export type State = 'normal' | 'loading' | 'empty' | 'filtered-empty' | 'error' | 'forbidden' | 'much-data'
export type Preset = 'signed-out' | 'signed-in' | 'fresh' | 'insecure'

type Account = { id: string; name: string; email: string; isAdmin: boolean; totp: boolean; password: string }
type Scen = {
  id: string
  setupDone: boolean
  insecure: boolean
  name: string
  accounts: Account[]
  sessions: Set<string>
  failures: Map<string, number>
  inviteUsed: boolean
  resetUsed: boolean
  states: Map<Screen, State>
}

type Answer = { status: number; body: unknown; headers?: Record<string, string> }
type Ctx = {
  s: Scen
  params: Record<string, string>
  query: URLSearchParams
  body: Record<string, unknown>
  who: Account | null
  web: boolean
}

const AT = '2026-10-29T10:00:00.000Z'
const err = (status: number, code: string, message: string, howToProceed: string): Answer => ({
  status,
  body: { error: { code, message, howToProceed } },
})
const UNAUTHORIZED = err(
  401,
  'unauthorized',
  'Missing or unknown key.',
  'Send "Authorization: Bearer <key>" with a key of this installation.',
)
const NO_BRAIN = err(
  404,
  'brain_not_found',
  'No brain with that name is available to you.',
  'Check the name with GET /v1/brains, or ask a curator of that brain to add you.',
)
const INTERNAL = err(
  500,
  'internal',
  'Something went wrong on the server (reference fx000001).',
  'Try again; if it keeps failing, give the reference to the administration.',
)
const CSRF = err(
  403,
  'csrf',
  'This request lacks the header of the Brain web.',
  'Use the Brain web to do this.',
)
const SHORT = err(
  400,
  'invalid_request',
  'A password has 12 to 200 characters.',
  'Choose a longer one; a few unrelated words make a good password.',
)

function brain(slug: string, name: string, purpose: string, role: string, status = 'active') {
  return {
    id: `brn_${slug.replace(/-/g, '')}`,
    slug,
    name,
    description: '',
    purpose,
    status,
    pendingCuratorEmail: null,
    createdAt: AT,
    updatedAt: AT,
    role,
  }
}

const BRAINS = [
  brain('growth', 'Growth', 'What we learn about audience, retention and intros.', 'curator'),
  brain('support', 'Support', 'How customers get unstuck, and what keeps breaking.', 'contributor'),
  brain(
    'legal-archive',
    'Legal archive',
    'Contracts and consent decisions, kept for reference.',
    'reader',
    'archived',
  ),
]
const MANY = Array.from({ length: 60 }, (_, i) =>
  brain(
    `team-${String(i + 1).padStart(2, '0')}`,
    `Team ${i + 1}`,
    `Notes of team ${i + 1}.`,
    i % 3 === 0 ? 'curator' : 'reader',
  ),
)
const WIKI = generate({ pages: 300, seed: 48291 })

function freshScenario(id: string, preset: Preset): Scen {
  const s: Scen = {
    id,
    setupDone: preset !== 'fresh' && preset !== 'insecure',
    insecure: preset === 'insecure',
    name: preset === 'fresh' || preset === 'insecure' ? '' : 'Risco Brain',
    accounts: [
      {
        id: 'acc_eric',
        name: 'Eric',
        email: 'eric@example.test',
        isAdmin: true,
        totp: false,
        password: PASSWORD,
      },
      {
        id: 'acc_ana',
        name: 'Ana',
        email: 'ana@example.test',
        isAdmin: false,
        totp: true,
        password: PASSWORD,
      },
    ],
    sessions: new Set(),
    failures: new Map(),
    inviteUsed: false,
    resetUsed: false,
    states: new Map(),
  }
  if (preset === 'signed-in') s.sessions.add('fx.acc_eric')
  return s
}

const account = (a: Account) => ({ id: a.id, name: a.name, email: a.email, isAdmin: a.isAdmin })
const sessionCookie = (a: Account) => `rscb_session=fx.${a.id}; Path=/; HttpOnly; SameSite=Lax`

// The operations the fixture answers, in the server's own words where the server has words.
const OPS: Record<string, { screen?: Screen; run: (c: Ctx) => Answer }> = {
  'GET /v1/branding': {
    screen: 'branding',
    run: ({ s }) => ({ status: 200, body: { name: s.name, logo: null, setupRequired: !s.setupDone } }),
  },
  'GET /v1/branding/logo': {
    run: () =>
      err(
        404,
        'no_logo',
        'This installation has no logo.',
        'The administration can add one in Admin › Branding; until then the web shows the RSC mark.',
      ),
  },
  'GET /v1/setup': {
    screen: 'setup',
    run: ({ s, query }) => {
      if (s.setupDone)
        return err(404, 'setup_done', 'This installation is already set up.', 'Sign in instead.')
      const url = query.get('publicUrl') ?? ''
      const unsafe = /^http:\/\//.test(url) && !/^http:\/\/(localhost|127\.0\.0\.1|\[::1\])(:|\/|$)/.test(url)
      return {
        status: 200,
        body: {
          done: false,
          connection: { encrypted: false, local: !s.insecure },
          warning: unsafe
            ? 'This address is not local and not encrypted: passwords would travel in clear over the network. Give Brain a domain with HTTPS, open it on its local address (http://localhost), or reach it through a tunnel.'
            : null,
        },
      }
    },
  },
  'POST /v1/setup': {
    run: ({ s, body, web }) => {
      if (!web) return CSRF
      if (s.setupDone)
        return err(404, 'setup_done', 'This installation is already set up.', 'Sign in instead.')
      if (s.insecure)
        return err(
          403,
          'insecure_connection',
          'This connection is not encrypted, so Brain does not accept a password over it.',
          'Open Brain over HTTPS (a domain with a certificate, or a tunnel), or on its local address from the same machine.',
        )
      const admin = (body.admin ?? {}) as Record<string, unknown>
      const name = typeof body.name === 'string' ? body.name.trim() : ''
      if (!name || name.length > 80)
        return err(
          400,
          'invalid_request',
          'The installation needs a name of 1 to 80 characters.',
          'For example "Risco Brain".',
        )
      if (typeof body.publicUrl !== 'string' || !/^https?:\/\/[^\s#?]+$/.test(body.publicUrl))
        return err(
          400,
          'invalid_request',
          '"publicUrl" is not an address.',
          'Give an address such as https://brain.example.com.',
        )
      if (typeof admin.password !== 'string' || admin.password.length < 12 || admin.password.length > 200)
        return SHORT
      const a: Account = {
        id: 'acc_admin',
        name: String(admin.name ?? 'Admin'),
        email: String(admin.email ?? ''),
        isAdmin: true,
        totp: false,
        password: admin.password,
      }
      s.accounts.push(a)
      s.setupDone = true
      s.name = name
      s.sessions.add(`fx.${a.id}`)
      return {
        status: 201,
        body: { done: true, publicUrl: body.publicUrl.replace(/\/+$/, ''), warning: null, adminId: a.id },
        headers: { 'set-cookie': sessionCookie(a) },
      }
    },
  },
  'POST /v1/auth/login': {
    screen: 'sign-in',
    run: ({ s, body, web }) => {
      if (!web) return CSRF
      const email = String(body.email ?? '')
        .trim()
        .toLowerCase()
      const fails = s.failures.get(email) ?? 0
      if (fails >= 5)
        return {
          ...err(
            429,
            'too_many_attempts',
            'Too many failed attempts in a row. Try again in 60 seconds (at 10:01:00 UTC).',
            'Wait, then try again; or reset your password.',
          ),
          headers: { 'retry-after': '60' },
        }
      const a = s.accounts.find((x) => x.email === email)
      if (!a || a.password !== body.password) {
        s.failures.set(email, fails + 1)
        return err(
          401,
          'bad_credentials',
          'The email or the password is not right.',
          'Check them, or reset your password.',
        )
      }
      if (a.totp) {
        const code = typeof body.code === 'string' ? body.code.trim() : ''
        if (!code)
          return err(
            401,
            'code_required',
            'This account asks for the code of its authenticator app.',
            'Send "code" with the 6 digits.',
          )
        if (code !== CODE) {
          s.failures.set(email, fails + 1)
          return err(
            401,
            'bad_code',
            'The code is not right, or was already used.',
            'Wait for the next code and try again.',
          )
        }
      }
      s.failures.delete(email)
      s.sessions.add(`fx.${a.id}`)
      return { status: 200, body: { account: account(a) }, headers: { 'set-cookie': sessionCookie(a) } }
    },
  },
  'POST /v1/auth/logout': {
    run: ({ s, who }) => {
      if (who) s.sessions.delete(`fx.${who.id}`)
      return {
        status: 200,
        body: { signedOut: true },
        headers: { 'set-cookie': 'rscb_session=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0' },
      }
    },
  },
  'POST /v1/auth/reset': {
    screen: 'reset',
    run: () => ({
      status: 202,
      body: {
        message:
          'If that email has an account, a reset link is on its way. No mail? Ask the administration for a link.',
      },
    }),
  },
  'POST /v1/auth/reset/confirm': {
    run: ({ s, body }) => {
      if (typeof body.password !== 'string' || body.password.length < 12) return SHORT
      if (body.token !== RESET_TOKEN || s.resetUsed)
        return err(
          400,
          'link_invalid',
          'This reset link is not valid: it expired, was already used, or is wrong.',
          'Ask for a new one.',
        )
      s.resetUsed = true
      return { status: 200, body: { reset: true } }
    },
  },
  'POST /v1/invitations/look': {
    screen: 'invite',
    run: ({ s, body }) => {
      if (body.token !== INVITE_TOKEN || s.inviteUsed)
        return err(
          400,
          'invitation_invalid',
          'This invitation link is not valid: it expired, was already used, or was withdrawn.',
          'Ask the administration to send a new one.',
        )
      return {
        status: 200,
        body: {
          invitation: {
            email: 'marta@example.test',
            installation: s.name,
            brains: [
              { slug: 'growth', name: 'Growth', role: 'contributor' },
              { slug: 'support', name: 'Support', role: 'reader' },
            ],
            isAdmin: false,
            expiresAt: '2026-11-05T10:00:00.000Z',
          },
        },
      }
    },
  },
  'POST /v1/invitations/accept': {
    run: ({ s, body, web }) => {
      if (!web) return CSRF
      if (body.token !== INVITE_TOKEN || s.inviteUsed)
        return err(
          400,
          'invitation_invalid',
          'This invitation link is not valid: it expired, was already used, or was withdrawn.',
          'Ask the administration to send a new one.',
        )
      const name = typeof body.name === 'string' ? body.name.trim() : ''
      if (!name || name.length > 80)
        return err(
          400,
          'invalid_request',
          'Your name has 1 to 80 characters.',
          'Type the name others will see.',
        )
      if (typeof body.password !== 'string' || body.password.length < 12) return SHORT
      const a: Account = {
        id: 'acc_marta',
        name,
        email: 'marta@example.test',
        isAdmin: false,
        totp: false,
        password: body.password,
      }
      s.accounts.push(a)
      s.inviteUsed = true
      s.sessions.add(`fx.${a.id}`)
      return { status: 201, body: { account: account(a) }, headers: { 'set-cookie': sessionCookie(a) } }
    },
  },
  'GET /v1/me': {
    screen: 'me',
    run: ({ who }) =>
      who
        ? {
            status: 200,
            body: {
              account: { ...account(who), kind: 'person' },
              key: { id: `crd_web_${who.id}`, kind: 'web', perm: 'write', ref: null, agent: null },
            },
          }
        : UNAUTHORIZED,
  },
  'GET /v1/brains': {
    screen: 'home',
    run: ({ s }) => {
      const st = s.states.get('home')
      if (st === 'empty') return { status: 200, body: { brains: [] } }
      if (st === 'much-data') return { status: 200, body: { brains: [...BRAINS, ...MANY] } }
      return { status: 200, body: { brains: BRAINS } }
    },
  },
  'GET /v1/brains/{slug}': {
    screen: 'brain',
    run: ({ params }) => {
      const b = [...BRAINS, ...MANY].find((x) => x.slug === params.slug)
      return b ? { status: 200, body: { brain: b } } : NO_BRAIN
    },
  },
  'GET /v1/search': {
    screen: 'search',
    run: ({ s, query }) => {
      const st = s.states.get('search')
      const q = (query.get('q') ?? '').toLowerCase()
      const limit = Math.min(50, Number(query.get('limit') ?? 20) || 20)
      const hits =
        st === 'empty' || st === 'filtered-empty'
          ? []
          : WIKI.pages
              .filter((p) => q && (p.title.toLowerCase().includes(q) || p.summary.toLowerCase().includes(q)))
              .slice(0, limit)
              .map((p) => ({
                kind: 'page',
                id: p.address,
                brain: 'growth',
                title: p.title,
                snippet: p.summary,
                at: AT,
              }))
      return { status: 200, body: { items: hits, next: null } }
    },
  },
}

// Paths that need a session; the rest are public, as on the server.
const PRIVATE = new Set([
  'POST /v1/auth/logout',
  'GET /v1/me',
  'GET /v1/brains',
  'GET /v1/brains/{slug}',
  'GET /v1/search',
])

function match(method: string, path: string): { op: string; params: Record<string, string> } | null {
  for (const op of Object.keys(OPS)) {
    const [m, template] = op.split(' ') as [string, string]
    if (m !== method) continue
    const keys: string[] = []
    const re = new RegExp(
      `^${template.replace(/\{(\w+)\}/g, (_, k: string) => {
        keys.push(k)
        return '([^/]+)'
      })}$`,
    )
    const hit = re.exec(path)
    if (!hit) continue
    const params: Record<string, string> = {}
    keys.forEach((k, i) => {
      params[k] = decodeURIComponent(hit[i + 1] ?? '')
    })
    return { op, params }
  }
  return null
}

function cookies(req: IncomingMessage): Record<string, string> {
  const out: Record<string, string> = {}
  for (const part of String(req.headers.cookie ?? '').split(';')) {
    const [k, ...v] = part.trim().split('=')
    if (k) out[k] = v.join('=')
  }
  return out
}

async function bodyOf(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = []
  for await (const c of req) chunks.push(c as Buffer)
  const text = Buffer.concat(chunks).toString('utf8')
  if (!text) return {}
  try {
    const v = JSON.parse(text) as unknown
    return v && typeof v === 'object' ? (v as Record<string, unknown>) : {}
  } catch {
    return {}
  }
}

export type ScenarioHandle = { id: string; cookie: string; set(screen: Screen, state: State): void }
export type Fixture = {
  url: string
  password: string
  code: string
  inviteToken: string
  resetToken: string
  operations: Set<string>
  operationOf(method: string, path: string): string | undefined
  scenario(preset?: Preset): ScenarioHandle
  close(): Promise<void>
}

export const DIST_WEB = fileURLToPath(new URL('../../../dist/web/', import.meta.url))

export async function startFixture(
  o: { web?: string | false; port?: number; loadingMs?: number } = {},
): Promise<Fixture> {
  const web = o.web === false ? null : openWeb(o.web ?? DIST_WEB)
  const loadingMs = o.loadingMs ?? 3000
  const scenarios = new Map<string, Scen>()
  const make = (preset: Preset): Scen => {
    const s = freshScenario(`fx${randomBytes(6).toString('hex')}`, preset)
    scenarios.set(s.id, s)
    return s
  }
  const fallback = make('signed-in')
  const handle = (s: Scen): ScenarioHandle => ({
    id: s.id,
    cookie: 'rscb_session=fx.acc_eric',
    set: (screen, state) => {
      if (state === 'normal') s.states.delete(screen)
      else s.states.set(screen, state)
    },
  })

  const send = (res: ServerResponse, a: Answer) => {
    const text = JSON.stringify(a.body)
    res.writeHead(a.status, {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
      'x-content-type-options': 'nosniff',
      ...(a.headers ?? {}),
    })
    res.end(text)
  }

  const server = createServer((req, res) => {
    void (async () => {
      const url = new URL(req.url ?? '/', 'http://localhost')
      const method = req.method ?? 'GET'
      const c = cookies(req)
      // Control routes of the tests, never part of the product.
      if (url.pathname === '/__fixture/scenarios' && method === 'POST') {
        const b = await bodyOf(req)
        const s = make((b.preset as Preset) ?? 'signed-out')
        for (const [screen, state] of Object.entries((b.states ?? {}) as Record<string, State>))
          s.states.set(screen as Screen, state)
        return send(res, { status: 201, body: { id: s.id } })
      }
      const control = /^\/__fixture\/scenarios\/([\w]+)\/state$/.exec(url.pathname)
      if (control && method === 'POST') {
        const s = scenarios.get(control[1] as string)
        if (!s) return send(res, { status: 404, body: {} })
        const b = await bodyOf(req)
        handle(s).set(b.screen as Screen, b.state as State)
        return send(res, { status: 200, body: {} })
      }
      // For a person walking the fixture by hand: /__fixture/use?preset=fresh&next=/setup
      if (url.pathname === '/__fixture/use') {
        const s = make((url.searchParams.get('preset') as Preset) ?? 'signed-in')
        const states = url.searchParams.getAll('state')
        for (const x of states) {
          const [screen, state] = x.split(':')
          s.states.set(screen as Screen, state as State)
        }
        const signed = [...s.sessions][0]
        res.writeHead(303, {
          location: url.searchParams.get('next') ?? '/',
          'set-cookie': [
            `fixture_scenario=${s.id}; Path=/; SameSite=Lax`,
            signed
              ? `rscb_session=${signed}; Path=/; HttpOnly; SameSite=Lax`
              : 'rscb_session=; Path=/; Max-Age=0',
          ],
        })
        return res.end()
      }
      if (url.pathname === '/v1/health') return send(res, { status: 200, body: { ok: true } })

      const sid = String(req.headers['x-fixture-scenario'] ?? c.fixture_scenario ?? '')
      const s = scenarios.get(sid) ?? fallback
      const m = match(method, url.pathname)
      if (!m) {
        if (web) {
          const page = answerWeb(web, method, req.url ?? '/', String(req.headers['accept-encoding'] ?? ''))
          if (page !== 'pass') {
            res.writeHead(page.status, page.headers)
            return res.end(method === 'HEAD' ? undefined : page.body)
          }
        }
        return send(
          res,
          err(404, 'no_such_route', `Nothing at ${method} ${url.pathname}.`, 'Check the method and path.'),
        )
      }
      const def = OPS[m.op] as (typeof OPS)[string]
      const session = c.rscb_session && s.sessions.has(c.rscb_session) ? c.rscb_session : null
      const who = session ? (s.accounts.find((a) => `fx.${a.id}` === session) ?? null) : null
      const isWeb = req.headers['x-requested-with'] === 'rsc-brain-web'
      const body = await bodyOf(req)
      const state = def.screen ? s.states.get(def.screen) : undefined
      if (state === 'loading') await new Promise((r) => setTimeout(r, loadingMs))
      if (state === 'error') return send(res, INTERNAL)
      if (state === 'forbidden') {
        if (m.op === 'GET /v1/brains/{slug}') return send(res, NO_BRAIN)
        return send(
          res,
          err(
            403,
            'forbidden',
            'Your role does not allow this.',
            'Ask a curator of this brain for a role that does.',
          ),
        )
      }
      if (PRIVATE.has(m.op)) {
        if (!who) return send(res, UNAUTHORIZED)
        if (method !== 'GET' && !isWeb) return send(res, CSRF)
      }
      send(res, def.run({ s, params: m.params, query: url.searchParams, body, who, web: isWeb }))
    })().catch((e: unknown) => {
      process.stderr.write(`fixture: ${e instanceof Error ? e.stack : String(e)}\n`)
      if (!res.headersSent) send(res, INTERNAL)
    })
  })
  await new Promise<void>((r) => server.listen(o.port ?? 0, '127.0.0.1', r))
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  return {
    url,
    password: PASSWORD,
    code: CODE,
    inviteToken: INVITE_TOKEN,
    resetToken: RESET_TOKEN,
    operations: new Set(Object.keys(OPS)),
    operationOf: (method, path) => match(method, path)?.op,
    scenario: (preset = 'signed-out') => handle(make(preset)),
    close: () =>
      new Promise<void>((r) => {
        server.closeAllConnections()
        server.close(() => r())
      }),
  }
}
