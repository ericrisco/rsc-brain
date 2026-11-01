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
import { AGENT_IDS, type AgentId, connectKit } from '../../../src/mcp/kit.ts'
import { type GenPage, generate } from '../../../web/test/data/generate.ts'
import * as G from './graph.ts'
import * as J from './journal.ts'
import * as P from './proposals.ts'
import {
  changeWiki,
  decisionsOf,
  editBehind,
  editPage,
  freshWiki,
  graphDataOf,
  listOf,
  logOf,
  mapOf,
  readersOf,
  readPage,
  type Wiki,
} from './wiki.ts'

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
  | 'sign-out'
  | 'reset'
  | 'branding'
  | 'overview'
  | 'people'
  | 'map'
  | 'page'
  | 'pages'
  | 'graph'
  | 'decisions'
  | 'log'
  | 'trail'
  | 'entry'
  | 'sessions'
  | 'session'
  | 'entries'
  | 'conflicts'
  | 'forgotten'
  | 'to-review'
  | 'members'
  | 'proposals'
  | 'proposal'
  | 'health'
export type State = 'normal' | 'loading' | 'empty' | 'filtered-empty' | 'error' | 'forbidden' | 'much-data'
// member: signed in as a person who is not an administrator (Ana).
// alone: the administrator the setup made, the only person in the installation.
export type Preset = 'signed-out' | 'signed-in' | 'member' | 'fresh' | 'insecure' | 'alone'

// `alone`: in no brain, and the only person it sees in the installation (the administrator the setup
// creates). `canCreate`: may create brains without administering.
type Account = {
  id: string
  name: string
  email: string
  isAdmin: boolean
  totp: boolean
  password: string
  alone?: boolean
  canCreate?: boolean
  joined?: boolean
}
type Brain = ReturnType<typeof brain>
type Invitation = {
  id: string
  email: string
  status: 'pending' | 'expired' | 'used' | 'revoked'
  brains: Array<{ slug: string; role: string }>
  isAdmin: boolean
  invitedBy: string
  createdAt: string
  expiresAt: string
}
// What has happened in a brain of the scenario (the overview's first steps, its numbers).
type Life = { entries: number; agent: boolean }
type Scen = {
  id: string
  setupDone: boolean
  insecure: boolean
  // The installation can send email (reset links, invitations).
  mail: boolean
  name: string
  // The address people open, as the setup gave it (the connection kit is built from it).
  publicUrl: string
  accounts: Account[]
  sessions: Set<string>
  failures: Map<string, number>
  inviteUsed: boolean
  resetUsed: boolean
  states: Map<Screen, State>
  brains: Brain[]
  life: Map<string, Life>
  invitations: Invitation[]
  // Live event streams open in this scenario, by brain, with who follows (pack rule 7).
  streams: Set<Follower>
  // The server is down for the live events (a lost connection): open streams were cut, new ones refused.
  streamsDown: boolean
  // The address of RSC Factory the administration set (G4, PR25); null when none.
  factoryUrl: string | null
  seq: number
  // Every event of the scenario, so a stream that comes back with Last-Event-ID gets what it missed.
  log: Array<{ seq: number; brain: string; frame: string; kind: string; who: string | null }>
  // The wiki of each brain, made when first read.
  wikis: Map<string, Wiki>
  // The journal of each brain, made when first read ("<slug>#big" for the much-data state).
  journals: Map<string, J.Journal>
  // The proposals of each brain, made when first read ("<slug>#big" for the much-data state).
  inboxes: Map<string, P.Inbox>
  // The wiki of every brain is a seeded one of this many pages (the graph's load tests, CA5 and CA6).
  seeded?: Seeded
}

type Follower = { brain: string; res: ServerResponse; viewer: { id: string; curator: boolean } }
// Pack rule 7, as the server applies it: a curator gets everything; anyone else every change and proposal,
// and only their own searches and reads.
const LOOKS = ['search', 'read']
const sees = (v: Follower['viewer'], e: { kind: string; who: string | null }) =>
  v.curator || !LOOKS.includes(e.kind) || e.who === v.id

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
  'Try again; if it keeps failing, give the reference to an administrator.',
)
const CSRF = err(
  403,
  'csrf',
  'This request lacks the header of the rsc-brain web.',
  'Use the rsc-brain web to do this.',
)
const SHORT = err(
  400,
  'invalid_request',
  'A password has 12 to 200 characters.',
  'Choose a longer one; a few unrelated words make a good password.',
)

type Stats = {
  pages: number
  entries: number
  uncompiled: number
  conflicts: number
  pendingProposals: number
  lastActivityAt: string | null
}
const ZERO: Stats = {
  pages: 0,
  entries: 0,
  uncompiled: 0,
  conflicts: 0,
  pendingProposals: 0,
  lastActivityAt: null,
}

function brain(
  slug: string,
  name: string,
  purpose: string,
  role: string,
  status = 'active',
  stats: Partial<Stats> = {},
) {
  return {
    id: `brn_${slug.replace(/-/g, '')}`,
    slug,
    name,
    description: '',
    purpose,
    status,
    pendingCuratorEmail: null as string | null,
    createdAt: AT,
    updatedAt: AT,
    role,
    stats: { ...ZERO, ...stats },
    notifyProposals: false,
  }
}

const RECENT = '2026-10-29T09:12:00.000Z'
const BRAINS = () => [
  brain('growth', 'Growth', 'What we learn about audience, retention and intros.', 'curator', 'active', {
    pages: 300,
    entries: 1284,
    uncompiled: 37,
    conflicts: 2,
    pendingProposals: 3,
    lastActivityAt: RECENT,
  }),
  brain(
    'support',
    'Support',
    'How customers get unstuck, and what keeps breaking.',
    'contributor',
    'active',
    {
      pages: 42,
      entries: 310,
      uncompiled: 5,
      pendingProposals: 1,
      lastActivityAt: '2026-10-27T16:40:00.000Z',
    },
  ),
  brain(
    'legal-archive',
    'Legal archive',
    'Contracts and consent decisions, kept for reference.',
    'reader',
    'archived',
    { pages: 18, entries: 96, lastActivityAt: '2026-08-02T10:00:00.000Z' },
  ),
]
const MANY = Array.from({ length: 60 }, (_, i) =>
  brain(
    `team-${String(i + 1).padStart(2, '0')}`,
    `Team ${i + 1}`,
    `Notes of team ${i + 1}.`,
    i % 3 === 0 ? 'curator' : 'reader',
    'active',
    { pages: i * 3, entries: i * 11, pendingProposals: i % 7 === 0 ? 1 : 0 },
  ),
)
const WIKI = generate({ pages: 300, seed: 48291 })
// A wiki with many pages a group, for the map's "much data" (each group shows a few, then opens whole).
const BIG = generate({ pages: 2000, seed: 48291 })
// The seeded wikis of the graph (plan §4: the same data the real server is seeded with), made when first used.
// The seeded wikis: 300 or 5 000 pages, or a lumpy one (pages at every level beside the groups).
type Seeded = 300 | 5000 | 'lumpy'
const SEEDED = new Map<Seeded, G.GraphData>()
function seededWiki(pages: Seeded): G.GraphData {
  let d = SEEDED.get(pages)
  if (!d) {
    d =
      pages === 'lumpy'
        ? G.lumpyData()
        : G.seededData(pages === 300 ? WIKI : generate({ pages, seed: 48291 }))
    SEEDED.set(pages, d)
  }
  return d
}
// What the graph and the list of a brain hold: its seeded wiki, or its hand-made one.
const wikiData = (c: Ctx, w: Wiki, extra: GenPage[] = []) =>
  c.s.seeded ? seededWiki(c.s.seeded) : graphDataOf(w, extra)

function freshScenario(id: string, preset: Preset): Scen {
  const s: Scen = {
    id,
    setupDone: preset !== 'fresh' && preset !== 'insecure',
    insecure: preset === 'insecure',
    mail: true,
    name: preset === 'fresh' || preset === 'insecure' ? '' : 'rsc-brain',
    // Never the address the browser is on: the web must show the installation's own.
    publicUrl: preset === 'fresh' || preset === 'insecure' ? '' : 'https://brain.example.test',
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
    brains: BRAINS(),
    life: new Map([
      ['growth', { entries: 1284, agent: true }],
      ['support', { entries: 310, agent: true }],
      ['legal-archive', { entries: 96, agent: true }],
    ]),
    invitations: [
      {
        id: 'inv_pending_bo',
        email: 'bo@example.test',
        status: 'pending',
        brains: [{ slug: 'growth', role: 'reader' }],
        isAdmin: false,
        invitedBy: 'Eric',
        createdAt: '2026-10-28T10:00:00.000Z',
        expiresAt: '2026-10-31T10:00:00.000Z',
      },
      {
        id: 'inv_expired_cy',
        email: 'cy@example.test',
        status: 'expired',
        brains: [],
        isAdmin: false,
        invitedBy: 'Eric',
        createdAt: '2026-10-21T10:00:00.000Z',
        expiresAt: '2026-10-24T10:00:00.000Z',
      },
      {
        id: 'inv_used_ana',
        email: 'ana@example.test',
        status: 'used',
        brains: [{ slug: 'support', role: 'contributor' }],
        isAdmin: false,
        invitedBy: 'Eric',
        createdAt: '2026-10-20T10:00:00.000Z',
        expiresAt: '2026-10-23T10:00:00.000Z',
      },
    ],
    streams: new Set(),
    streamsDown: false,
    factoryUrl: null,
    seq: 100,
    log: [],
    wikis: new Map(),
    journals: new Map(),
    inboxes: new Map(),
  }
  if (preset === 'alone') {
    s.accounts.push({
      id: 'acc_admin',
      name: 'Eric',
      email: 'admin@example.test',
      isAdmin: true,
      totp: false,
      password: PASSWORD,
      alone: true,
    })
    s.sessions.add('fx.acc_admin')
  }
  if (preset === 'signed-in') s.sessions.add('fx.acc_eric')
  if (preset === 'member') s.sessions.add('fx.acc_ana')
  return s
}

const account = (a: Account) => ({ id: a.id, name: a.name, email: a.email, isAdmin: a.isAdmin })
const sessionCookie = (a: Account) => `rscb_session=fx.${a.id}; Path=/; HttpOnly; SameSite=Lax`

// The operations the fixture answers, in the server's own words where the server has words.
const OPS: Record<string, { screen?: Screen; run: (c: Ctx) => Answer }> = {
  'GET /v1/branding': {
    screen: 'branding',
    run: ({ s }) => ({
      status: 200,
      body: { name: s.name, logo: null, setupRequired: !s.setupDone, canSendMail: s.mail },
    }),
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
          'This connection is not encrypted, so rsc-brain does not accept a password over it.',
          'Open rsc-brain over HTTPS (a domain with a certificate, or a tunnel), or on its local address from the same machine.',
        )
      const admin = (body.admin ?? {}) as Record<string, unknown>
      const name = typeof body.name === 'string' ? body.name.trim() : ''
      if (!name || name.length > 80)
        return err(
          400,
          'invalid_request',
          'The installation needs a name of 1 to 80 characters.',
          'For example "Acme rsc-brain".',
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
        alone: true,
      }
      s.accounts.push(a)
      s.setupDone = true
      s.name = name
      s.publicUrl = body.publicUrl.replace(/\/+$/, '')
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
    screen: 'sign-out',
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
          'If that email has an account, a reset link is on its way. No mail? Ask an administrator for a link.',
      },
    }),
  },
  'POST /v1/auth/reset/look': {
    screen: 'reset',
    run: ({ s, body }) =>
      body.token === RESET_TOKEN && !s.resetUsed
        ? { status: 200, body: { valid: true } }
        : err(
            400,
            'link_invalid',
            'This reset link is not valid: it expired, was already used, or is wrong.',
            'Ask for a new one.',
          ),
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
          'Ask an administrator to send a new one.',
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
          'Ask an administrator to send a new one.',
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
        // An administrator alone in the installation now sees her.
        joined: true,
      }
      s.accounts.push(a)
      s.inviteUsed = true
      s.sessions.add(`fx.${a.id}`)
      return {
        status: 201,
        body: {
          account: account(a),
          brains: [
            { slug: 'growth', name: 'Growth', role: 'contributor' },
            { slug: 'support', name: 'Support', role: 'reader' },
          ],
        },
        headers: { 'set-cookie': sessionCookie(a) },
      }
    },
  },
  // The server's own kit, built from the installation's public address.
  'GET /v1/connect': {
    run: ({ s, query }) => {
      const agent = query.get('agent') || undefined
      if (agent !== undefined && !(AGENT_IDS as readonly string[]).includes(agent))
        return err(
          400,
          'invalid_request',
          `There is no kit for the agent "${agent}".`,
          `Use one of: ${AGENT_IDS.join(', ')}.`,
        )
      if (!s.publicUrl)
        return err(
          400,
          'invalid_request',
          'This installation has no public address yet.',
          'An administrator sets it in the settings of the installation.',
        )
      return {
        status: 200,
        body: connectKit({
          mcpUrl: `${s.publicUrl}/mcp`,
          brain: query.get('brain') || null,
          ...(agent ? { agent: agent as AgentId } : {}),
        }),
      }
    },
  },
  'GET /v1/me': {
    screen: 'me',
    run: ({ s, who }) =>
      who
        ? {
            status: 200,
            body: {
              account: {
                ...account(who),
                kind: 'person',
                canCreateBrains: who.isAdmin || Boolean(who.canCreate),
                canInvite: who.isAdmin,
                totp: who.totp,
              },
              key: { id: `crd_web_${who.id}`, kind: 'web', perm: 'write', ref: null, agent: null },
              installation: { name: s.name, factoryUrl: s.factoryUrl },
            },
          }
        : UNAUTHORIZED,
  },
  'GET /v1/brains': {
    screen: 'home',
    run: ({ s, who }) => {
      const st = s.states.get('home')
      const mine = brainsOf(s, who)
      if (st === 'empty') return { status: 200, body: { brains: [] } }
      if (st === 'much-data') return { status: 200, body: { brains: [...mine, ...MANY] } }
      return { status: 200, body: { brains: mine } }
    },
  },
  'POST /v1/brains': {
    run: ({ s, who, body }) => {
      if (!who?.isAdmin && !who?.canCreate)
        return err(
          403,
          'forbidden',
          'You are not allowed to create brains.',
          'Ask the administration of this installation for the "can create brains" permission.',
        )
      const slug = typeof body.slug === 'string' ? body.slug.trim() : ''
      if (!/^[a-z0-9]+(-[a-z0-9]+)*$/.test(slug) || slug.length < 2 || slug.length > 64)
        return err(
          400,
          'invalid_request',
          'A brain name (slug) is 2 to 64 lowercase letters, digits and single hyphens.',
          'Use something like "youtube-channel".',
        )
      if ([...s.brains, ...MANY].some((b) => b.slug === slug))
        return err(409, 'brain_exists', `A brain named "${slug}" already exists.`, 'Choose another name.')
      const name = typeof body.name === 'string' && body.name.trim() ? body.name.trim() : slug
      const purpose = typeof body.purpose === 'string' ? body.purpose.trim() : ''
      const made = brain(slug, name, purpose, 'curator')
      s.brains.push(made)
      s.life.set(slug, { entries: 0, agent: false })
      if (who.alone) who.joined = true
      const { role: _role, stats: _stats, notifyProposals: _n, ...plain } = made
      return { status: 201, body: { brain: plain } }
    },
  },
  'GET /v1/brains/{slug}': {
    screen: 'brain',
    run: ({ s, who, params }) => {
      const b = [...brainsOf(s, who), ...MANY].find((x) => x.slug === params.slug)
      return b ? { status: 200, body: { brain: b } } : NO_BRAIN
    },
  },
  'GET /v1/brains/{slug}/overview': {
    screen: 'overview',
    run: ({ s, who, params }) => {
      const b = [...brainsOf(s, who), ...MANY].find((x) => x.slug === params.slug)
      if (!b) return NO_BRAIN
      const st = s.states.get('overview')
      const life =
        st === 'empty' ? { entries: 0, agent: false } : (s.life.get(b.slug) ?? { entries: 0, agent: false })
      const fresh = life.entries === 0
      return {
        status: 200,
        body: {
          cursor: String(s.seq),
          stats: fresh && st === 'empty' ? ZERO : b.stats,
          todaySessions: fresh || st === 'empty' ? [] : sessionsOf(b.slug, st === 'much-data' ? 20 : 3),
          pending: fresh
            ? []
            : (pendingIn(s, b.slug) ?? pendingOf(b.slug, Math.min(5, b.stats.pendingProposals))),
          health: fresh
            ? {
                orphans: 0,
                broken: 0,
                conflicts: 0,
                stale: 0,
                unavailableSources: 0,
                long: 0,
                similarTitles: 0,
              }
            : b.slug === 'growth'
              ? {
                  orphans: 4,
                  broken: 3,
                  conflicts: 2,
                  stale: 1,
                  unavailableSources: 0,
                  long: 0,
                  similarTitles: 1,
                }
              : {
                  orphans: 0,
                  broken: 0,
                  conflicts: 0,
                  stale: 0,
                  unavailableSources: 0,
                  long: 0,
                  similarTitles: 0,
                },
          firstSteps: { agentConnected: life.agent, firstEntry: life.entries > 0, imported: false },
        },
      }
    },
  },
  'GET /v1/invitations': {
    screen: 'people',
    run: ({ s, who }) => {
      if (!who?.isAdmin) return ONLY_ADMIN_INVITES
      const list = s.states.get('people') === 'empty' ? [] : s.invitations
      return { status: 200, body: { invitations: list } }
    },
  },
  'POST /v1/invitations': {
    run: ({ s, who, body }) => {
      if (!who?.isAdmin) return ONLY_ADMIN_INVITES
      const raw = Array.isArray(body.emails) ? body.emails : [body.emails]
      if (raw.length === 0 || raw.length > 50)
        return err(400, 'invalid_request', 'Invite 1 to 50 emails at a time.', 'Send "emails" as a list.')
      const brains = Array.isArray(body.brains) ? (body.brains as Array<{ slug: string; role: string }>) : []
      for (const g of brains) if (!s.brains.some((b) => b.slug === g.slug)) return NO_BRAIN
      const out = []
      for (const v of raw) {
        const email = String(v).trim().toLowerCase()
        if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))
          return err(
            400,
            'invalid_request',
            `"${String(v).slice(0, 80)}" is not an email.`,
            'Give plain emails such as ana@example.com.',
          )
        if (s.accounts.some((a) => a.email === email))
          return err(
            409,
            'email_taken',
            `${email} already has an account.`,
            'Add that person to the brain as a member instead.',
          )
        const id = `inv_${randomBytes(4).toString('hex')}`
        const inv: Invitation = {
          id,
          email,
          status: 'pending',
          brains: brains.map((g) => ({ slug: g.slug, role: g.role })),
          isAdmin: body.isAdmin === true,
          invitedBy: who.name,
          createdAt: AT,
          expiresAt: '2026-11-01T10:00:00.000Z',
        }
        s.invitations = [inv, ...s.invitations.filter((x) => !(x.email === email && x.status === 'pending'))]
        out.push(invited(s, inv))
      }
      return { status: 201, body: { invitations: out } }
    },
  },
  'POST /v1/invitations/{id}/resend': {
    run: ({ s, who, params }) => {
      if (!who?.isAdmin) return ONLY_ADMIN_INVITES
      const inv = s.invitations.find((x) => x.id === params.id)
      if (!inv)
        return err(
          404,
          'not_found',
          'No invitation with that id is available to you.',
          'Check the invitation id.',
        )
      if (inv.status === 'used' || inv.status === 'revoked')
        return err(
          409,
          'invitation_closed',
          'This invitation was already used or withdrawn.',
          'Invite the email again if it still needs access.',
        )
      inv.status = 'pending'
      inv.expiresAt = '2026-11-01T10:00:00.000Z'
      return { status: 200, body: { invitation: invited(s, inv) } }
    },
  },
  // A personal token, shown once (the profile page that lists them arrives with PR24).
  'POST /v1/me/tokens': {
    run: ({ s, who, body, web }) => {
      if (!who) return UNAUTHORIZED
      if (!web) return CSRF
      const slugs = Array.isArray(body.brains) ? (body.brains as string[]) : null
      if (slugs && !slugs.every((x) => brainsOf(s, who).some((b) => b.slug === x))) return NO_BRAIN
      const secret = `rscb_fixturetoken${String(Date.now()).padStart(26, '0')}`
      return {
        status: 201,
        body: {
          token: {
            id: 'crd_fixture_token',
            secret,
            last4: secret.slice(-4),
            expiresAt: '2027-01-27T10:00:00.000Z',
          },
          message: 'Copy it now: rsc-brain shows it only this once.',
          ...(slugs
            ? {}
            : {
                note: 'This token reaches every brain you are a member of, including brains you join later.',
              }),
        },
      }
    },
  },
  'DELETE /v1/invitations/{id}': {
    run: ({ s, who, params }) => {
      if (!who?.isAdmin) return ONLY_ADMIN_INVITES
      const inv = s.invitations.find((x) => x.id === params.id)
      if (!inv)
        return err(
          404,
          'not_found',
          'No invitation with that id is available to you.',
          'Check the invitation id.',
        )
      if (inv.status === 'used')
        return err(
          409,
          'invitation_closed',
          'This invitation was already used.',
          'Remove the person, or change their roles.',
        )
      inv.status = 'revoked'
      return { status: 200, body: { revoked: inv.id } }
    },
  },
  'GET /v1/admin/accounts': {
    screen: 'people',
    run: ({ s, who }) => {
      if (!who?.isAdmin) return ADMIN_ONLY
      const seen = who.alone ? s.accounts.filter((a) => a === who || a.joined) : s.accounts
      return {
        status: 200,
        body: {
          accounts: seen.map((a) => ({
            id: a.id,
            kind: 'person',
            name: a.name,
            email: a.email,
            isAdmin: a.isAdmin,
            canCreateBrains: a.isAdmin || Boolean(a.canCreate),
            canInvite: false,
            status: 'active',
            secondFactor: a.totp,
            brains: a.alone
              ? s.brains.filter((b) => s.life.has(b.slug) && !BRAINS().some((x) => x.slug === b.slug)).length
              : 3,
            lastSeenAt: a === who ? AT : a.id === 'acc_ana' ? '2026-10-28T08:00:00.000Z' : null,
            createdAt: '2026-10-01T10:00:00.000Z',
          })),
        },
      }
    },
  },
  'POST /v1/admin/accounts/{id}/reset-link': {
    run: ({ s, who, params, web }) => {
      if (!web) return CSRF
      if (!who?.isAdmin)
        return err(403, 'forbidden', 'Only the administration makes reset links.', 'Ask the administration.')
      if (!s.accounts.some((a) => a.id === params.id))
        return err(404, 'not_found', 'No account with that id is available to you.', 'Check the account id.')
      return {
        status: 201,
        body: { link: `${s.publicUrl}/reset#token=${RESET_TOKEN}`, expiresAt: '2026-10-29T11:00:00.000Z' },
      }
    },
  },
  'GET /v1/admin/brains': {
    run: ({ s, who }) => {
      if (!who?.isAdmin) return ADMIN_ONLY
      return {
        status: 200,
        body: {
          brains: s.brains.map((b) => ({
            slug: b.slug,
            name: b.name,
            status: b.status,
            members: 3,
            curators: [{ id: 'acc_eric', name: 'Eric' }],
            pendingCurator: null,
            youAreMember: true,
          })),
        },
      }
    },
  },
  'GET /v1/brains/{slug}/wiki/map': {
    screen: 'map',
    run: (c) =>
      inWiki(c, (w) => {
        const st = c.s.states.get('map')
        if (st === 'empty') return { status: 200, body: { intro: '', groups: [], count: 0 } }
        return {
          status: 200,
          body: mapOf(w, st === 'much-data' ? BIG.pages : [], c.query.get('status') === 'all'),
        }
      }),
  },
  'GET /v1/brains/{slug}/wiki/pages': {
    screen: 'pages',
    run: (c) =>
      inWiki(c, (w) => {
        const st = c.s.states.get('pages')
        if (st === 'empty') return { status: 200, body: { items: [], next: null, total: 0 } }
        if (c.s.seeded) return G.listPagesOf(wikiData(c, w), c.query)
        return listOf(w, st === 'much-data' ? WIKI.pages : [], c.query)
      }),
  },
  'GET /v1/brains/{slug}/wiki/graph': {
    screen: 'graph',
    run: (c) =>
      inWiki(c, (w) => {
        const st = c.s.states.get('graph')
        const d = st === 'empty' ? { pages: [], links: [] } : wikiData(c, w)
        return G.graphOf(d, c.query)
      }),
  },
  'GET /v1/brains/{slug}/wiki/decisions': {
    screen: 'decisions',
    run: (c) =>
      inWiki(c, (w) => {
        const st = c.s.states.get('decisions')
        if (st === 'empty') return { status: 200, body: { decisions: [] } }
        return { status: 200, body: { decisions: decisionsOf(w, st === 'much-data' ? WIKI.pages : []) } }
      }),
  },
  'GET /v1/brains/{slug}/wiki/log': {
    screen: 'log',
    run: (c) =>
      inWiki(c, (w) => {
        const st = c.s.states.get('log')
        if (st === 'empty') return { status: 200, body: { items: [], next: null, total: 0 } }
        return logOf(w, c.query, st === 'much-data')
      }),
  },
  'GET /v1/brains/{slug}/pages/{address}': {
    screen: 'page',
    run: (c) =>
      inWiki(c, (w) => {
        const seeded = c.s.seeded ? G.seededReading(wikiData(c, w), c.params.address as string) : null
        return seeded ?? readPage(w, c.params.address as string, c.query)
      }),
  },
  'PATCH /v1/brains/{slug}/pages/{address}': {
    run: (c) =>
      inWiki(c, (w, curator) => editPage(w, c.who as Account, curator, c.params.address as string, c.body)),
  },
  'POST /v1/brains/{slug}/wiki/changes': {
    run: (c) => inWiki(c, (w, curator) => changeWiki(w, c.who as Account, curator, c.body)),
  },
  'GET /v1/brains/{slug}/trail': {
    screen: 'trail',
    run: (c) =>
      inWiki(c, (w, curator) =>
        readersOf(w, c.query.get('page') ?? '', curator, { id: c.who?.id ?? '', name: c.who?.name ?? '' }),
      ),
  },
  'GET /v1/entries/{id}': {
    screen: 'entry',
    run: (c) =>
      withEntry(c, (j, e, w) => J.entryRead(j, e, w.role === 'curator', c.query.get('history') === '1')),
  },
  'GET /v1/brains/{slug}/members': {
    screen: 'members',
    run: (c) =>
      inJournal(c, 'members', (_j, w) => {
        const roleOf = (id: string) =>
          brainsOf(c.s, c.s.accounts.find((a) => a.id === id) ?? null).find((b) => b.slug === c.params.slug)
            ?.role
        const listed = c.s.accounts
          .filter((a) => !a.alone && roleOf(a.id))
          .map((a) => ({
            accountId: a.id,
            kind: 'person',
            name: a.name,
            email: w.role === 'curator' ? a.email : null,
            role: roleOf(a.id) as string,
          }))
        // Every brain of the fixture has a curator: Eric, where his own role says otherwise.
        const members = listed.some((m) => m.role === 'curator')
          ? listed
          : listed.map((m) => (m.accountId === 'acc_eric' ? { ...m, role: 'curator' } : m))
        const order = ['curator', 'contributor', 'reader']
        members.sort((a, b) => order.indexOf(a.role) - order.indexOf(b.role))
        return {
          status: 200,
          body: { members, former: [], pendingCurator: w.role === 'curator' ? null : false },
        }
      }),
  },
  'GET /v1/brains/{slug}/sessions': {
    screen: 'sessions',
    run: (c) =>
      inJournal(c, 'sessions', (j) => {
        const st = c.s.states.get('sessions')
        if (st === 'empty' || st === 'filtered-empty')
          return {
            status: 200,
            body: {
              items: [],
              total: 0,
              next: null,
              liveFrom: String(c.s.seq),
              ...(c.query.get('cursor') ? {} : { facets: { clients: [], authors: [] } }),
            },
          }
        return J.sessionsOf(j, c.query, String(c.s.seq))
      }),
  },
  'GET /v1/sessions/{id}': {
    screen: 'session',
    run: (c) => {
      for (const j of journalsOf(c)) {
        const a = J.sessionOf(j, c.params.id as string)
        if (a) return a
      }
      return J.NO_SESSION
    },
  },
  'GET /v1/brains/{slug}/entries': {
    screen: 'entries',
    run: (c) =>
      inJournal(c, 'entries', (j) =>
        c.s.states.get('entries') === 'empty'
          ? { status: 200, body: { items: [], total: 0, next: null } }
          : J.entriesOf(j, c.query),
      ),
  },
  'PATCH /v1/entries/{id}': {
    run: (c) => withEntry(c, (j, e, w) => J.editEntry(j, e, w, c.body)),
  },
  'POST /v1/entries/{id}/forget': {
    run: (c) => withEntry(c, (_j, e, w) => J.forgetEntry(e, w, c.body)),
  },
  'POST /v1/entries/{id}/recover': {
    run: (c) => withEntry(c, (_j, e, w) => J.recoverEntry(e, w)),
  },
  'POST /v1/entries/{id}/pin': {
    run: (c) => withEntry(c, (_j, e, w) => J.pinEntry(e, w, true)),
  },
  'POST /v1/entries/{id}/unpin': {
    run: (c) => withEntry(c, (_j, e, w) => J.pinEntry(e, w, false)),
  },
  'POST /v1/entries/{id}/schedule': {
    run: (c) => withEntry(c, (_j, e, w) => J.scheduleEntry(e, w, c.body)),
  },
  'POST /v1/brains/{slug}/relations': {
    run: (c) => inJournal(c, null, (j, w) => J.relate(j, w, c.body)),
  },
  'GET /v1/brains/{slug}/conflicts': {
    screen: 'conflicts',
    run: (c) =>
      inJournal(c, 'conflicts', (j) =>
        c.s.states.get('conflicts') === 'empty'
          ? { status: 200, body: { conflicts: [], total: 0, next: null } }
          : J.conflictsOf(j, c.query),
      ),
  },
  'GET /v1/brains/{slug}/forgotten': {
    screen: 'forgotten',
    run: (c) =>
      inJournal(c, 'forgotten', (j, w) =>
        c.s.states.get('forgotten') === 'empty' && w.role === 'curator'
          ? { status: 200, body: { items: [], total: 0, next: null } }
          : J.forgottenOf(j, w, c.query),
      ),
  },
  'GET /v1/brains/{slug}/to-review': {
    screen: 'to-review',
    run: (c) =>
      inJournal(c, 'to-review', (j) =>
        c.s.states.get('to-review') === 'empty'
          ? { status: 200, body: { items: [], total: 0, next: null } }
          : J.toReviewOf(j, c.query),
      ),
  },
  'POST /v1/brains/{slug}/corrections': {
    run: (c) =>
      inJournal(c, null, (j, w) => {
        const wiki = c.s.wikis.get(c.params.slug as string) ?? freshWiki()
        return J.addCorrection(j, w, c.body, (a) =>
          wiki.pages.some((p) => p.addresses.includes(a) && p.revs[p.revs.length - 1]?.status !== 'retired'),
        )
      }),
  },
  'GET /v1/brains/{slug}/proposals': {
    screen: 'proposals',
    run: (c) => {
      const b = brainsOf(c.s, c.who).find((x) => x.slug === c.params.slug)
      if (!b) return NO_BRAIN
      const st = c.s.states.get('proposals')
      return P.listOf(inboxOf(c.s, b.slug, st === 'much-data'), c.query, st === 'empty')
    },
  },
  'GET /v1/proposals/{id}/review': {
    screen: 'proposal',
    // A session of the fixture is always the web's (a program's key would get 403 web_only).
    run: (c) =>
      withProposal(c, (inbox, p, b) =>
        P.reviewOf(inbox, p, wikiOf(c.s, b.slug), b.role === 'curator' && b.status === 'active'),
      ),
  },
  'POST /v1/proposals/{id}/approve': {
    run: (c) =>
      withProposal(c, (inbox, p, b) =>
        decision(
          c,
          b,
          p,
          P.approve(
            p,
            wikiOf(c.s, b.slug),
            whoOf(c),
            b.role === 'curator' && b.status === 'active',
            c.body,
            () => P.reviewOf(inbox, p, wikiOf(c.s, b.slug), true),
            NOW(),
          ),
        ),
      ),
  },
  'POST /v1/proposals/{id}/return': {
    run: (c) =>
      withProposal(c, (inbox, p, b) =>
        decision(
          c,
          b,
          p,
          P.giveBack(
            p,
            whoOf(c),
            b.role === 'curator' && b.status === 'active',
            c.body,
            () => P.reviewOf(inbox, p, wikiOf(c.s, b.slug), true),
            NOW(),
          ),
        ),
      ),
  },
  'GET /v1/brains/{slug}/wiki/health': {
    screen: 'health',
    run: (c) => {
      const b = brainsOf(c.s, c.who).find((x) => x.slug === c.params.slug)
      if (!b) return NO_BRAIN
      return { status: 200, body: healthOf(b.slug, c.s.states.get('health')) }
    },
  },
  'GET /v1/search': {
    screen: 'search',
    run: ({ s, query, who }) => {
      const st = s.states.get('search')
      const q = (query.get('q') ?? '').toLowerCase()
      const limit = Math.min(50, Number(query.get('limit') ?? 20) || 20)
      const offset = Number(query.get('offset') ?? 0) || 0
      const mine = brainsOf(s, who).map((b) => b.slug)
      const asked = (query.get('brains') ?? '').split(',').filter(Boolean)
      const brains = asked.length ? asked.filter((b) => mine.includes(b)) : mine
      const types = (query.get('types') ?? '').split(',').filter(Boolean)
      const scope = query.get('in') ?? 'both'
      const words = { why: 'words', reason: 'matched by words' }
      // Journal entries only, with no words (a page's sources in the editor): the newest.
      if (scope === 'entries' && !q) {
        const brain = brains[0] ?? 'growth'
        const found = journalOf(s, brain)
          .entries.filter((e) => e.state === 'active' && e.supersededBy === null)
          .slice(0, limit)
          .map((e) => ({
            kind: 'entry',
            id: e.id,
            brain,
            type: e.type,
            state: e.state,
            title: e.title,
            snippet: e.content,
            why: 'recent',
            reason: 'most recent',
            at: e.createdAt,
          }))
        return { status: 200, body: { items: found, next: null } }
      }
      if (st === 'empty' || st === 'filtered-empty' || !q)
        return { status: 200, body: { items: [], next: null } }
      // The pages of the hand-made wiki first (they open), then the seeded ones; all in the first brain.
      // A snippet is a piece of the body, markdown and all, as the server's.
      const hand = freshWiki().pages.map((p) => {
        const r = p.revs[p.revs.length - 1] as {
          address: string
          type: string
          status: string
          title: string
          summary: string
          body: string
        }
        return {
          address: r.address,
          type: r.type,
          status: r.status,
          title: r.title,
          summary: r.summary,
          snippet: r.body.slice(0, 160),
        }
      })
      const pages =
        scope === 'entries' || !brains.includes('growth')
          ? []
          : [...hand, ...WIKI.pages.map((p) => ({ ...p, snippet: p.summary }))]
              .filter((p) => p.title.toLowerCase().includes(q) || p.summary.toLowerCase().includes(q))
              .filter((p) => !types.length || types.includes(p.type))
              .map((p) => ({
                kind: 'page',
                id: `pg_${p.address.replace(/\W/g, '_')}`,
                address: p.address,
                brain: 'growth',
                type: p.type,
                state: p.status,
                title: p.title,
                snippet: p.snippet,
                ...words,
                at: AT,
              }))
      // Journal entries of each brain asked, as the server mixes them in.
      const entries =
        scope === 'pages'
          ? []
          : brains.flatMap((brain) =>
              journalOf(s, brain)
                .entries.filter(
                  (e) =>
                    e.state === 'active' &&
                    (e.title.toLowerCase().includes(q) ||
                      // Asked for entries only (a page's sources), the text counts too.
                      (scope === 'entries' &&
                        e.supersededBy === null &&
                        e.content.toLowerCase().includes(q))),
                )
                .filter((e) => !types.length || types.includes(e.type))
                .map((e) => ({
                  kind: 'entry',
                  id: e.id,
                  brain,
                  type: e.type,
                  state: e.state,
                  title: e.title,
                  snippet: e.content,
                  // Found by meaning, not by its words: the reason says so.
                  ...(e.title.toLowerCase().startsWith(q)
                    ? words
                    : { why: 'meaning', reason: 'matched by meaning' }),
                  at: e.createdAt,
                })),
            )
      const from = query.get('from') ?? ''
      const all = [...pages, ...entries].filter((h) => !from || h.at >= from)
      const much = st === 'much-data'
      const items = (much ? Array.from({ length: 3 }, () => all).flat() : all).slice(offset, offset + limit)
      const next = offset + limit < (much ? all.length * 3 : all.length) ? offset + limit : null
      return { status: 200, body: { items, next } }
    },
  },
}

// The health of a wiki (B2): the first brain has something in each common section; "much-data" a long list.
function healthOf(slug: string, st: State | undefined) {
  const none = {
    orphans: [] as Array<{ address: string; title: string }>,
    broken: [] as Array<{ from: string; to: string }>,
    conflicts: [] as Array<{ a: string; b: string }>,
    stale: [] as Array<{ address: string; title: string; updatedAt: string; newEntries: number }>,
    unavailableSources: [] as Array<{ address: string; entryId: string; state: 'forgotten' | 'purged' }>,
    long: [] as Array<{ address: string; title: string; chars: number }>,
    similarTitles: [] as Array<{ a: string; b: string }>,
    maintenance: { suggested: false, approvalsSince: 3, every: 20 },
  }
  if (st === 'empty' || slug !== 'growth') return none
  const h = {
    ...none,
    broken: [
      { from: 'audience/retention', to: 'drafts/hooks-that-work' },
      { from: 'audience/intros', to: 'audience/hook-length' },
      { from: 'product/pricing', to: 'product/plans' },
    ],
    conflicts: [
      { a: 'audience/intros', b: 'audience/old-intros' },
      { a: 'audience/retention', b: 'product/pricing' },
    ],
    orphans: [
      { address: 'misc/naming', title: 'Naming videos' },
      { address: 'misc/thumbnails', title: 'Thumbnails' },
      { address: 'misc/shorts', title: 'Shorts' },
      { address: 'misc/music', title: 'Music' },
    ],
    stale: [
      {
        address: 'audience/old-intros',
        title: 'Old intros',
        updatedAt: '2026-06-01T10:00:00.000Z',
        newEntries: 4,
      },
    ],
    similarTitles: [{ a: 'audience/intros', b: 'audience/old-intros' }],
    maintenance: { suggested: true, approvalsSince: 21, every: 20 },
  }
  if (st === 'much-data')
    h.orphans = Array.from({ length: 60 }, (_, i) => ({
      address: `misc/page-${String(i + 1).padStart(2, '0')}`,
      title: `Page ${i + 1}`,
    }))
  return h
}

// Paths that need a session; the rest are public, as on the server.
const PRIVATE = new Set([
  'POST /v1/auth/logout',
  'GET /v1/connect',
  'GET /v1/me',
  'GET /v1/brains',
  'POST /v1/brains',
  'GET /v1/brains/{slug}',
  'GET /v1/brains/{slug}/overview',
  'GET /v1/search',
  'GET /v1/brains/{slug}/wiki/health',
  'GET /v1/invitations',
  'POST /v1/invitations',
  'POST /v1/invitations/{id}/resend',
  'DELETE /v1/invitations/{id}',
  'POST /v1/me/tokens',
  'GET /v1/admin/accounts',
  'POST /v1/admin/accounts/{id}/reset-link',
  'GET /v1/admin/brains',
  'GET /v1/brains/{slug}/wiki/map',
  'GET /v1/brains/{slug}/wiki/pages',
  'GET /v1/brains/{slug}/wiki/graph',
  'GET /v1/brains/{slug}/wiki/decisions',
  'GET /v1/brains/{slug}/wiki/log',
  'GET /v1/brains/{slug}/pages/{address}',
  'PATCH /v1/brains/{slug}/pages/{address}',
  'POST /v1/brains/{slug}/wiki/changes',
  'GET /v1/brains/{slug}/trail',
  'GET /v1/entries/{id}',
  'GET /v1/brains/{slug}/members',
  'GET /v1/brains/{slug}/sessions',
  'GET /v1/sessions/{id}',
  'GET /v1/brains/{slug}/entries',
  'PATCH /v1/entries/{id}',
  'POST /v1/entries/{id}/forget',
  'POST /v1/entries/{id}/recover',
  'POST /v1/entries/{id}/pin',
  'POST /v1/entries/{id}/unpin',
  'POST /v1/entries/{id}/schedule',
  'POST /v1/brains/{slug}/relations',
  'GET /v1/brains/{slug}/conflicts',
  'GET /v1/brains/{slug}/forgotten',
  'GET /v1/brains/{slug}/to-review',
  'POST /v1/brains/{slug}/corrections',
  'GET /v1/brains/{slug}/proposals',
  'GET /v1/proposals/{id}/review',
  'POST /v1/proposals/{id}/approve',
  'POST /v1/proposals/{id}/return',
])

const NOW = () => new Date().toISOString()
const whoOf = (c: Ctx) => ({ id: c.who?.id ?? '', name: c.who?.name ?? '' })

function wikiOf(s: Scen, slug: string): Wiki {
  let w = s.wikis.get(slug)
  if (!w) {
    w = freshWiki()
    s.wikis.set(slug, w)
  }
  return w
}

// The proposals of a brain, made when first read.
function inboxOf(s: Scen, slug: string, big = false): P.Inbox {
  const key = big ? `${slug}#big` : slug
  let i = s.inboxes.get(key)
  if (!i) {
    i = big ? P.bigInbox(slug) : P.freshInbox(slug)
    s.inboxes.set(key, i)
  }
  return i
}

// The newest pending proposals of a brain whose inbox the fixture holds, as the overview lists them.
function pendingIn(s: Scen, slug: string) {
  const inbox = inboxOf(s, slug)
  if (!inbox.proposals.length) return null
  return inbox.proposals
    .filter((p) => p.status === 'pending')
    .slice(0, 5)
    .map((p) => ({
      id: p.id,
      brainId: `brn_${slug.replace(/-/g, '')}`,
      title: p.title,
      reason: p.reason,
      authorId: p.author.id,
      agent: p.agent,
      status: p.status,
      old: p.old,
      supersedes: p.supersedes,
      supersededBy: p.supersededBy,
      collected: p.collected,
      comment: null,
      decidedBy: null,
      decidedAt: null,
      lastError: null,
      createdAt: p.createdAt,
      purged: false,
      opCount: p.ops.length,
    }))
}

// A proposal of a brain the person is in, by its id alone (also among the many of "much data").
function withProposal(c: Ctx, run: (i: P.Inbox, p: P.FxProposal, b: Brain) => Answer): Answer {
  for (const b of brainsOf(c.s, c.who)) {
    for (const i of [inboxOf(c.s, b.slug), c.s.inboxes.get(`${b.slug}#big`)]) {
      const p = i?.proposals.find((x) => x.id === c.params.id)
      if (i && p) return run(i, p, b)
    }
  }
  return P.NO_PROPOSAL
}

// A decision taken: the brain's count of what waits goes down and its live stream hears who decided.
function decision(c: Ctx, b: Brain, p: P.FxProposal, d: P.Decided): Answer {
  if (d.event) {
    const brain = c.s.brains.find((x) => x.slug === b.slug)
    if (brain)
      brain.stats = { ...brain.stats, pendingProposals: Math.max(0, brain.stats.pendingProposals - 1) }
    emit(c.s, b.slug, 'proposal.decided', { who: d.event.who, target: { id: p.id, label: d.event.status } })
  }
  return d.answer
}

// The wiki of a brain the person is in, made when first read; `curator`: may edit it by hand.
function inWiki(c: Ctx, run: (w: Wiki, curator: boolean) => Answer): Answer {
  const b = brainsOf(c.s, c.who).find((x) => x.slug === c.params.slug)
  const slug = b?.slug ?? 'growth'
  if (c.params.slug !== undefined && !b) return NO_BRAIN
  let w = c.s.wikis.get(slug)
  if (!w) {
    w = freshWiki()
    c.s.wikis.set(slug, w)
  }
  // A page lists the corrections about it from the brain's journal.
  w.corrections = (addresses) => J.correctionsAbout(journalOf(c.s, slug), addresses)
  return run(w, b?.role === 'curator')
}

// The journal of a brain, made when first read.
function journalOf(s: Scen, slug: string, big = false): J.Journal {
  const key = big ? `${slug}#big` : slug
  let j = s.journals.get(key)
  if (!j) {
    j = big ? J.bigJournal(slug) : J.freshJournal(slug)
    s.journals.set(key, j)
  }
  return j
}

type JWho = { role: string | null; me: { id: string; name: string }; archived: boolean }
const jwho = (c: Ctx, b: Brain): JWho => ({
  role: b.role,
  me: { id: c.who?.id ?? '', name: c.who?.name ?? '' },
  archived: b.status === 'archived',
})

// The journal of a brain the person is in; `screen`: its much-data state reads the big journal.
function inJournal(c: Ctx, screen: Screen | null, run: (j: J.Journal, w: JWho) => Answer): Answer {
  const b = brainsOf(c.s, c.who).find((x) => x.slug === c.params.slug)
  if (!b) return NO_BRAIN
  return run(journalOf(c.s, b.slug, screen !== null && c.s.states.get(screen) === 'much-data'), jwho(c, b))
}

// The journals of the brains the person is in (an entry or a session is found by its id alone).
function journalsOf(c: Ctx): J.Journal[] {
  return brainsOf(c.s, c.who).flatMap((b) => {
    const big = c.s.journals.get(`${b.slug}#big`)
    return [journalOf(c.s, b.slug), ...(big ? [big] : [])]
  })
}

function withEntry(c: Ctx, run: (j: J.Journal, e: J.FxEntry, w: JWho) => Answer): Answer {
  for (const b of brainsOf(c.s, c.who)) {
    for (const j of [journalOf(c.s, b.slug), c.s.journals.get(`${b.slug}#big`)]) {
      const e = j?.entries.find((x) => x.id === c.params.id)
      if (j && e && e.state !== 'purged') {
        if (e.state === 'forgotten' && b.role !== 'curator') return J.NO_ENTRY
        return run(j, e, jwho(c, b))
      }
    }
  }
  return J.NO_ENTRY
}

// The brains a person of the scenario is in: the setup's administrator only in those it made.
// Ana is not a curator anywhere: her roles are her own.
const ANA_ROLES: Record<string, string> = {
  growth: 'contributor',
  support: 'reader',
  'legal-archive': 'reader',
}
function brainsOf(s: Scen, who: Account | null): Brain[] {
  if (who?.alone) return s.brains.filter((b) => !BRAINS().some((x) => x.slug === b.slug))
  if (who?.id === 'acc_ana') return s.brains.map((b) => ({ ...b, role: ANA_ROLES[b.slug] ?? b.role }))
  return s.brains
}

const CLIENTS = ['Claude Code', 'Codex', 'RSC Factory', 'Cursor']
function sessionsOf(slug: string, n: number) {
  return Array.from({ length: n }, (_, i) => ({
    id: `ses_${slug.replace(/-/g, '')}${String(i + 1).padStart(3, '0')}`,
    who: i % 2 ? 'Ana' : 'Eric',
    // The third: a program that opened no session of its own (no purpose, a raw user agent).
    client: i === 2 ? 'curl/8.7.1' : (CLIENTS[i % CLIENTS.length] ?? null),
    purpose: ['Review the intros of October', 'Fix the onboarding emails', ''][i % 3] ?? '',
    ref: i % 3 === 2 ? `r_${slug.slice(0, 3)}${i}` : null,
    status: i === 0 ? 'open' : i % 4 === 3 ? 'closed_no_summary' : 'closed',
    entries: (i * 7) % 13,
    summary:
      i === 0 || i % 4 === 3
        ? null
        : 'Short intros keep viewers past 30 seconds; the long ones lose a third of them before the hook.',
    openedAt: '2026-10-29T08:00:00.000Z',
    lastActivityAt: '2026-10-29T09:12:00.000Z',
  }))
}
function pendingOf(slug: string, n: number) {
  return Array.from({ length: n }, (_, i) => ({
    id: `prp_${slug.replace(/-/g, '')}${i + 1}`,
    brainId: `brn_${slug.replace(/-/g, '')}`,
    title:
      ['Intros: keep them under 10 seconds', 'Merge the two retention pages', 'New page: hooks that work'][
        i % 3
      ] ?? '',
    reason: 'The journal says so.',
    authorId: 'acc_eric',
    agent: 'Claude Code',
    status: 'pending',
    old: i === 2,
    supersedes: null,
    supersededBy: null,
    collected: [],
    comment: null,
    decidedBy: null,
    decidedAt: null,
    lastError: null,
    createdAt: '2026-10-28T10:00:00.000Z',
    purged: false,
    opCount: i + 1,
  }))
}

// The answer of a new invitation: the link travels in it once; with mail off it was not sent.
function invited(s: Scen, inv: Invitation) {
  return {
    id: inv.id,
    email: inv.email,
    link: `${s.publicUrl}/invite#token=${INVITE_TOKEN}`,
    expiresAt: inv.expiresAt,
    mailed: s.mail,
    mailError: s.mail ? null : 'This installation has no mail set up.',
  }
}

const ONLY_ADMIN_INVITES = err(
  403,
  'forbidden',
  'Only the administration invites new people to this installation.',
  'Ask the administration, or add someone who already has an account to your brain.',
)
const ADMIN_ONLY = err(
  403,
  'forbidden',
  'Only the administration of this installation does this.',
  'Ask an administrator.',
)

function match(method: string, path: string): { op: string; params: Record<string, string> } | null {
  for (const op of Object.keys(OPS)) {
    const [m, template] = op.split(' ') as [string, string]
    if (m !== method) continue
    const keys: string[] = []
    const re = new RegExp(
      `^${template.replace(/\{(\w+)\}/g, (_, k: string) => {
        keys.push(k)
        // A page address keeps its slashes.
        return k === 'address' ? '(.+)' : '([^/]+)'
      })}$`,
    )
    const hit = re.exec(path)
    if (!hit) continue
    const params: Record<string, string> = {}
    keys.forEach((k, i) => {
      params[k] = (hit[i + 1] ?? '').split('/').map(decodeURIComponent).join('/')
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

export type EmitOptions = {
  who?: { id: string; name: string } | null
  target?: { id: string; label: string }
  client?: string | null
  ref?: string | null
  query?: string | null
}

function emit(s: Scen, slug: string, kind: string, o: EmitOptions = {}): void {
  const b = s.brains.find((x) => x.slug === slug)
  const life = s.life.get(slug) ?? { entries: 0, agent: false }
  // An agent asked for context: step 1 is done, but the brain says nothing (no event, as the server).
  if (kind === 'context') {
    s.life.set(slug, { ...life, agent: true })
    return
  }
  if (kind === 'proposal.submitted' && b)
    b.stats = { ...b.stats, pendingProposals: b.stats.pendingProposals + 1 }
  if (kind === 'entry.saved' || kind === 'session.opened') {
    life.agent = true
    if (kind === 'entry.saved') life.entries += 1
    s.life.set(slug, life)
    if (b) {
      b.stats = {
        ...b.stats,
        entries: kind === 'entry.saved' ? b.stats.entries + 1 : b.stats.entries,
        uncompiled: kind === 'entry.saved' ? b.stats.uncompiled + 1 : b.stats.uncompiled,
        lastActivityAt: AT,
      }
    }
  }
  s.seq += 1
  const who = o.who === undefined ? { id: 'acc_eric', name: 'Eric' } : o.who
  const event = {
    id: String(s.seq),
    at: NOW(),
    brain: slug,
    kind,
    who,
    key: { id: o.ref ? 'crd_short' : 'crd_agent', ref: o.ref ?? null },
    target:
      kind === 'search' ? null : (o.target ?? { id: 'ent_fixture', label: 'First thing the agent learnt' }),
    query: kind === 'search' ? (o.query ?? 'retention') : null,
    client: o.client === undefined ? 'claude-code' : o.client,
  }
  const frame = `id: ${s.seq}\ndata: ${JSON.stringify(event)}\n\n`
  const line = { seq: s.seq, brain: slug, frame, kind, who: who?.id ?? null }
  s.log.push(line)
  for (const st of s.streams) if (st.brain === slug && sees(st.viewer, line)) st.res.write(frame)
}

export type ScenarioHandle = {
  id: string
  cookie: string
  set(screen: Screen, state: State): void
  // Every session of the scenario ends, as when the server revokes them while the web is open.
  endSessions(): void
}
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
    endSessions: () => s.sessions.clear(),
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
        if (b.mail === false) s.mail = false
        if (b.seeded === 300 || b.seeded === 5000 || b.seeded === 'lumpy') s.seeded = b.seeded
        if (typeof b.factoryUrl === 'string') s.factoryUrl = b.factoryUrl
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
      const ending = /^\/__fixture\/scenarios\/([\w]+)\/end-sessions$/.exec(url.pathname)
      if (ending && method === 'POST') {
        const s = scenarios.get(ending[1] as string)
        if (!s) return send(res, { status: 404, body: {} })
        handle(s).endSessions()
        return send(res, { status: 200, body: {} })
      }
      // An event in a brain, as an agent's write makes it: the brain changes and open streams hear it.
      const emitting = /^\/__fixture\/scenarios\/([\w]+)\/emit$/.exec(url.pathname)
      if (emitting && method === 'POST') {
        const s = scenarios.get(emitting[1] as string)
        if (!s) return send(res, { status: 404, body: {} })
        const b = await bodyOf(req)
        const o: EmitOptions = {}
        if (b.who !== undefined) o.who = b.who as { id: string; name: string } | null
        if (b.target !== undefined) o.target = b.target as { id: string; label: string }
        if (b.client !== undefined) o.client = b.client as string | null
        if (b.ref !== undefined) o.ref = b.ref as string | null
        if (b.query !== undefined) o.query = b.query as string | null
        emit(s, String(b.brain), String(b.kind ?? 'entry.saved'), o)
        return send(res, { status: 200, body: {} })
      }
      // The live events go down (open streams are cut and new ones refused) or come back: a lost connection.
      const down = /^\/__fixture\/scenarios\/([\w]+)\/streams$/.exec(url.pathname)
      if (down && method === 'POST') {
        const s = scenarios.get(down[1] as string)
        if (!s) return send(res, { status: 404, body: {} })
        s.streamsDown = (await bodyOf(req)).down === true
        if (s.streamsDown) for (const st of [...s.streams]) st.res.destroy()
        return send(res, { status: 200, body: {} })
      }
      // Another curator edits a page of the wiki meanwhile (an edit conflict, CA10).
      const behind = /^\/__fixture\/scenarios\/([\w]+)\/wiki-edit$/.exec(url.pathname)
      if (behind && method === 'POST') {
        const s = scenarios.get(behind[1] as string)
        if (!s) return send(res, { status: 404, body: {} })
        const b = await bodyOf(req)
        const brain = String(b.brain)
        if (!s.wikis.has(brain)) s.wikis.set(brain, freshWiki())
        editBehind(
          s.wikis.get(brain) as Wiki,
          String(b.address),
          typeof b.body === 'string' ? b.body : undefined,
          {
            ...(Array.isArray(b.tags) ? { tags: b.tags as string[] } : {}),
            ...(typeof b.to === 'string' ? { address: b.to } : {}),
          },
        )
        return send(res, { status: 200, body: {} })
      }
      // Another person corrects a journal entry meanwhile (the conflict of an edit).
      const entryBehind = /^\/__fixture\/scenarios\/([\w]+)\/entry-edit$/.exec(url.pathname)
      if (entryBehind && method === 'POST') {
        const s = scenarios.get(entryBehind[1] as string)
        if (!s) return send(res, { status: 404, body: {} })
        const b = await bodyOf(req)
        const e = journalOf(s, String(b.brain)).entries.find((x) => x.id === b.id)
        if (e) J.editBehind(e, String(b.content))
        return send(res, { status: e ? 200 : 404, body: {} })
      }
      // An agent's key asks for a relation about a person's correction: it waits for a person.
      const agentRelate = /^\/__fixture\/scenarios\/([\w]+)\/agent-relate$/.exec(url.pathname)
      if (agentRelate && method === 'POST') {
        const s = scenarios.get(agentRelate[1] as string)
        if (!s) return send(res, { status: 404, body: {} })
        const b = await bodyOf(req)
        J.agentAsks(journalOf(s, String(b.brain)), String(b.from), String(b.to), String(b.kind))
        return send(res, { status: 200, body: {} })
      }
      // Another curator decides a proposal meanwhile, or its author sends a new version of it.
      const behindProposal = /^\/__fixture\/scenarios\/([\w]+)\/proposal-(decided|changed)$/.exec(
        url.pathname,
      )
      if (behindProposal && method === 'POST') {
        const s = scenarios.get(behindProposal[1] as string)
        if (!s) return send(res, { status: 404, body: {} })
        const b = await bodyOf(req)
        const brain = String(b.brain ?? 'growth')
        const p = inboxOf(s, brain).proposals.find((x) => x.id === b.id)
        if (!p) return send(res, { status: 404, body: {} })
        if (behindProposal[2] === 'changed') P.changeBehind(p)
        else {
          const by = { id: 'acc_eva', name: String(b.by ?? 'Eva') }
          const status = (b.status as 'approved' | 'returned' | 'withdrawn' | undefined) ?? 'approved'
          P.decideBehind(p, by, status, NOW())
          const br = s.brains.find((x) => x.slug === brain)
          if (br) br.stats = { ...br.stats, pendingProposals: Math.max(0, br.stats.pendingProposals - 1) }
          emit(s, brain, 'proposal.decided', { who: by, target: { id: p.id, label: status } })
        }
        return send(res, { status: 200, body: {} })
      }
      // The administration purges text from a brain's wiki: its purge count goes up; open reviews hear it.
      const purging = /^\/__fixture\/scenarios\/([\w]+)\/purge$/.exec(url.pathname)
      if (purging && method === 'POST') {
        const s = scenarios.get(purging[1] as string)
        if (!s) return send(res, { status: 404, body: {} })
        const b = await bodyOf(req)
        const brain = String(b.brain ?? 'growth')
        const inbox = inboxOf(s, brain)
        inbox.purges = (inbox.purges ?? 0) + 1
        emit(s, brain, 'wiki.changed', { target: { id: 'pg_intros', label: 'purge' } })
        return send(res, { status: 200, body: {} })
      }
      // For a person walking the fixture by hand: /__fixture/use?preset=fresh&next=/setup
      if (url.pathname === '/__fixture/use') {
        const s = make((url.searchParams.get('preset') as Preset) ?? 'signed-in')
        if (url.searchParams.get('mail') === 'off') s.mail = false
        const seeded = url.searchParams.get('seeded')
        if (seeded === '300' || seeded === '5000') s.seeded = Number(seeded) as 300 | 5000
        else if (seeded === 'lumpy') s.seeded = 'lumpy'
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
      // The live events of a brain (Server-Sent Events), never JSON: answered here, as the server does.
      const live = /^\/v1\/brains\/([^/]+)\/events$/.exec(url.pathname)
      if (live && method === 'GET') {
        const session = c.rscb_session && s.sessions.has(c.rscb_session) ? c.rscb_session : null
        const who = session ? (s.accounts.find((a) => `fx.${a.id}` === session) ?? null) : null
        if (!who) return send(res, UNAUTHORIZED)
        const slug = decodeURIComponent(live[1] as string)
        const mine = [...brainsOf(s, who), ...MANY].find((b) => b.slug === slug)
        if (!mine) return send(res, NO_BRAIN)
        if (s.streamsDown)
          return send(
            res,
            err(
              503,
              'busy',
              'The installation is restarting.',
              'Try again in a moment; the web does so by itself.',
            ),
          )
        const viewer = { id: who.id, curator: mine.role === 'curator' }
        res.writeHead(200, {
          'content-type': 'text/event-stream; charset=utf-8',
          'cache-control': 'no-store',
          'x-content-type-options': 'nosniff',
        })
        res.write(': following\n\n')
        // Resuming: what came after the id the client sends, as the server replays it.
        const given = String(req.headers['last-event-id'] ?? url.searchParams.get('lastEventId') ?? '')
        if (/^\d+$/.test(given))
          for (const e of s.log)
            if (e.brain === slug && e.seq > Number(given) && sees(viewer, e)) res.write(e.frame)
        const stream = { brain: slug, res, viewer }
        s.streams.add(stream)
        req.on('close', () => s.streams.delete(stream))
        return
      }
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
        for (const sc of scenarios.values()) for (const st of sc.streams) st.res.end()
        server.closeAllConnections()
        server.close(() => r())
      }),
  }
}
