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
import { repoKey } from '../../../src/domain/repos.ts'
import { DEFAULT_GUIDE } from '../../../src/domain/wiki/pages.ts'
import { answerWeb, openWeb } from '../../../src/http/web.ts'
import { AGENT_IDS, type AgentId, connectKit } from '../../../src/mcp/kit.ts'
import { type GenPage, generate } from '../../../web/test/data/generate.ts'
import {
  ADMIN_OPS,
  ADMIN_PRIVATE,
  adminBehind,
  brandingLogo,
  FIXTURE_KEY,
  FIXTURE_KEY_ID,
  logoAnswer,
  MAINTENANCE_REFUSAL,
  underMaintenance,
} from './admin.ts'
import { exportZip } from './export.ts'
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
  | 'tokens'
  | 'apps'
  | 'notify'
  | 'settings'
  | 'repos'
  | 'keys'
  | 'admin-settings'
  | 'admin-email'
  | 'admin-meaning'
  | 'admin-audit'
  | 'admin-system'
  | 'admin-backups'
  | 'connect'
  | 'export'
  | 'import'
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
  // Deactivated by the administration (B4): it cannot sign in; what it wrote stays.
  removed?: boolean
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
// A long history of invitations (the «much-data» state of People): accepted ones stay in the list.
const manyInvitations = (): Invitation[] =>
  Array.from({ length: 45 }, (_, i) => ({
    id: `inv_many_${i}`,
    email: `guest${i}@example.test`,
    status: 'used' as const,
    brains: [{ slug: 'growth', role: 'reader' }],
    isAdmin: false,
    invitedBy: 'Eric',
    createdAt: '2026-09-01T10:00:00.000Z',
    expiresAt: '2026-09-04T10:00:00.000Z',
  }))
// What has happened in a brain of the scenario (the overview's first steps, its numbers).
type Life = { entries: number; agent: boolean; imported?: boolean }
type Scen = {
  id: string
  setupDone: boolean
  // The installation key of the wizard's last step: ready right after the setup, given once (B7 PR30).
  setupKey?: 'ready' | 'given'
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
  // The profile (PR24): personal tokens and connected apps by account, email notices by "account:brain",
  // and a second factor being set up.
  tokens: FxToken[]
  apps: FxApp[]
  notify: Map<string, boolean>
  totpPending: Set<string>
  made: number
  // Brain settings and the administration (PR25a): the members of each brain once read or changed, the
  // role changes made meanwhile (by "account:brain"; null: no longer a member), linked repositories, the
  // settings of each brain, service accounts and their main keys.
  members: Map<string, FxMember[]>
  roleChanges: Map<string, string | null>
  repos: Map<string, Array<{ repo: string; linkedAt: string }>>
  settings: Map<string, FxSettings>
  services: FxService[]
  keys: FxKey[]
  // When each invitation last got a new link (one a minute).
  resent: Map<string, number>
}

type FxMember = { accountId: string; kind: string; name: string; email: string | null; role: string }
type FxSettings = {
  guide: string | null
  mapIntro: string
  usageNote: string
  meaningExcluded: boolean
  staleDays: number
  longChars: number
  maintenanceEvery: number
  approvalsSince: number
}
type FxService = {
  id: string
  name: string
  removed: boolean
  canCreate: boolean
  roles: Array<{ slug: string; role: string }>
  createdAt: string
  lastSeenAt: string | null
}
type FxKey = {
  account: string
  id: string
  name: string
  last4: string
  createdAt: string
  lastUsedAt: string | null
  lastClient: string | null
  revoked: boolean
  liveShortKeys: number
  liveShortRefs: string[]
}

type FxToken = {
  account: string
  id: string
  expired: boolean
  name: string
  last4: string
  perm: string
  allBrains: boolean
  brains: string[] | null
  createdAt: string
  expiresAt: string
  expiresSoon: boolean
  lastUsedAt: string | null
  lastClient: string | null
}
type FxApp = {
  account: string
  id: string
  name: string
  nameNote: string
  returnsTo: string
  brains: string[]
  perm: string
  createdAt: string
  lastUsedAt: string
  lastRequestAt: string | null
  endsAt: string
  ended: boolean
}
const tokenView = ({ account: _a, ...t }: FxToken) => t
const appView = ({ account: _a, ...a }: FxApp) => a
const TOTP_SECRET = 'JBSWY3DPEHPK3PXPJBSWY3DP'

type Follower = { brain: string; res: ServerResponse; viewer: { id: string; curator: boolean } }
// Pack rule 7, as the server applies it: a curator gets everything; anyone else every change and proposal,
// and only their own searches and reads.
const LOOKS = ['search', 'read']
const sees = (v: Follower['viewer'], e: { kind: string; who: string | null }) =>
  v.curator || !LOOKS.includes(e.kind) || e.who === v.id

type Answer = { status: number; body: unknown; headers?: Record<string, string>; raw?: Buffer | string }
type Ctx = {
  s: Scen
  params: Record<string, string>
  query: URLSearchParams
  body: Record<string, unknown>
  // The body as it came (a zip sent to import).
  raw?: Buffer
  who: Account | null
  web: boolean
}

const AT = '2026-10-29T10:00:00.000Z'
const err = (status: number, code: string, message: string, howToProceed: string): Answer => ({
  status,
  body: { error: { code, message, howToProceed } },
})
const NOT_THE_CODE = err(
  400,
  'invalid_request',
  'The code is not right.',
  'Type the 6 digits your app shows now.',
)
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
    // Whether the account asking created it: the scenario's brains were made by the setup, not by its people.
    createdByYou: false,
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
    tokens: [
      {
        account: 'acc_eric',
        id: 'crd_tok_laptop',
        expired: false,
        name: 'Claude Code laptop',
        last4: 'k3Qa',
        perm: 'write',
        allBrains: true,
        brains: null,
        createdAt: '2026-09-02T10:00:00.000Z',
        expiresAt: '2026-12-01T10:00:00.000Z',
        expiresSoon: false,
        lastUsedAt: '2026-10-29T09:40:00.000Z',
        lastClient: 'claude-code/2.1.3',
      },
      {
        account: 'acc_eric',
        id: 'crd_tok_ci',
        expired: false,
        name: 'CI reader',
        last4: 'Zp09',
        perm: 'read',
        allBrains: false,
        brains: ['growth', 'support'],
        createdAt: '2026-08-05T10:00:00.000Z',
        expiresAt: '2026-11-05T10:00:00.000Z',
        expiresSoon: true,
        lastUsedAt: null,
        lastClient: null,
      },
      {
        account: 'acc_eric',
        id: 'crd_tok_old',
        expired: true,
        name: 'Old laptop',
        last4: 'Q7dd',
        perm: 'write',
        allBrains: true,
        brains: null,
        createdAt: '2026-06-01T10:00:00.000Z',
        expiresAt: '2026-08-30T10:00:00.000Z',
        expiresSoon: false,
        lastUsedAt: '2026-08-29T10:00:00.000Z',
        lastClient: 'codex/0.40',
      },
    ],
    apps: [
      {
        account: 'acc_eric',
        id: 'app_cursor',
        name: 'Cursor',
        nameNote: 'Declared by the app, not verified.',
        returnsTo: '127.0.0.1',
        brains: ['growth'],
        perm: 'write',
        createdAt: '2026-10-01T10:00:00.000Z',
        lastUsedAt: '2026-10-28T18:00:00.000Z',
        lastRequestAt: '2026-10-28T18:00:00.000Z',
        endsAt: '2027-01-26T18:00:00.000Z',
        ended: false,
      },
    ],
    notify: new Map(),
    totpPending: new Set(),
    made: 0,
    members: new Map(),
    roleChanges: new Map(),
    resent: new Map(),
    repos: new Map([
      ['growth', [{ repo: 'github.com/acme/growth-site', linkedAt: '2026-10-02T10:00:00.000Z' }]],
    ]),
    settings: new Map(),
    services: [
      {
        id: 'acc_svc_factory',
        name: 'Factory runner',
        removed: false,
        canCreate: false,
        roles: [{ slug: 'growth', role: 'contributor' }],
        createdAt: '2026-09-10T10:00:00.000Z',
        lastSeenAt: '2026-10-29T09:30:00.000Z',
      },
      {
        id: 'acc_svc_old',
        name: 'Old importer',
        removed: true,
        canCreate: false,
        roles: [],
        createdAt: '2026-05-10T10:00:00.000Z',
        lastSeenAt: '2026-06-01T10:00:00.000Z',
      },
    ],
    keys: [
      {
        account: 'acc_svc_factory',
        id: 'crd_main_factory',
        name: 'main',
        last4: 'F4ct',
        createdAt: '2026-09-10T10:00:00.000Z',
        lastUsedAt: '2026-10-29T09:30:00.000Z',
        lastClient: 'rsc-factory/0.3.0',
        revoked: false,
        liveShortKeys: 3,
        liveShortRefs: ['run r_8kq2, step 3', 'run r_9zz1'],
      },
    ],
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
  // The rest of the administration (PR25b), in its own module.
  ...(ADMIN_OPS as unknown as Record<string, { screen?: Screen; run: (c: Ctx) => Answer }>),
  'GET /v1/branding': {
    screen: 'branding',
    run: ({ s }) => ({
      status: 200,
      body: { name: s.name, logo: brandingLogo(s), setupRequired: !s.setupDone, canSendMail: s.mail },
    }),
  },
  'GET /v1/branding/logo': {
    run: ({ s }) =>
      logoAnswer(s) ??
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
      s.setupKey = 'ready'
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
  'POST /v1/setup/key': {
    run: ({ s, who, web }) => {
      if (!web) return CSRF
      // Whoever ran the setup, once, right after it.
      if (who?.id !== 'acc_admin' || s.setupKey !== 'ready')
        return err(
          404,
          'not_found',
          'The installation key is shown once, right after the first-time setup, to whoever ran it.',
          'Download it again in Admin › Backups & system, typing your password.',
        )
      s.setupKey = 'given'
      return { status: 200, body: { key: FIXTURE_KEY, keyId: FIXTURE_KEY_ID } }
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
    screen: 'connect',
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
              installation: {
                name: s.name,
                factoryUrl: s.factoryUrl,
                admins: s.accounts.filter((a) => a.isAdmin && !a.removed).map((a) => a.name),
              },
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
      const made = { ...brain(slug, name, purpose, 'curator'), createdByYou: true }
      s.brains.push(made)
      s.life.set(slug, { entries: 0, agent: false })
      if (who.alone) who.joined = true
      const { role: _role, stats: _stats, notifyProposals: _n, createdByYou: _c, ...plain } = made
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
          firstSteps: {
            agentConnected: life.agent,
            firstEntry: life.entries > 0,
            imported: Boolean(life.imported),
            // As the import route below decides it.
            importable: !(life.imported || life.entries > 0 || b.stats.pages > 0 || b.stats.entries > 0),
          },
        },
      }
    },
  },
  'GET /v1/invitations': {
    screen: 'people',
    // By pages, as the server: `status`, `cursor` (an offset here) and `limit` (default 50).
    run: ({ s, who, query }) => {
      if (!who?.isAdmin) return ONLY_ADMIN_INVITES
      const st = s.states.get('people')
      const all =
        st === 'empty' ? [] : st === 'much-data' ? [...s.invitations, ...manyInvitations()] : s.invitations
      const status = query.get('status')
      if (status && !['pending', 'expired', 'used', 'revoked'].includes(status))
        return err(
          400,
          'invalid_request',
          `There is no invitation status "${status}".`,
          'Use one of: pending, expired, used, revoked.',
        )
      const list = status ? all.filter((i) => i.status === status) : all
      const from = Number(query.get('cursor') || 0)
      const limit = Math.min(200, Number(query.get('limit')) || 50)
      const page = list.slice(from, from + limit)
      const next = from + limit < list.length ? String(from + limit) : null
      return { status: 200, body: { invitations: page, next } }
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
      const wait = Math.ceil(((s.resent.get(inv.id) ?? 0) + 60_000 - Date.now()) / 1000)
      if (wait > 0)
        return {
          status: 429,
          headers: { 'retry-after': String(wait) },
          body: {
            error: {
              code: 'too_soon',
              message: 'A new link for this invitation was made less than a minute ago.',
              howToProceed: `Wait ${wait} s, then make another; the last link still works.`,
              retryAfter: wait,
            },
          },
        }
      s.resent.set(inv.id, Date.now())
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
      s.made += 1
      const id = `crd_fixture_token${s.made}`
      const days = typeof body.days === 'number' ? body.days : 90
      s.tokens.unshift({
        account: who.id,
        id,
        expired: false,
        name: String(body.name ?? ''),
        last4: secret.slice(-4),
        perm: String(body.perm ?? 'write'),
        allBrains: !slugs,
        brains: slugs,
        createdAt: NOW(),
        expiresAt: new Date(Date.now() + days * 86_400_000).toISOString(),
        expiresSoon: false,
        lastUsedAt: null,
        lastClient: null,
      })
      return {
        status: 201,
        body: {
          token: {
            id,
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
  'GET /v1/me/tokens': {
    screen: 'tokens',
    run: ({ s, who }) => {
      if (!who) return UNAUTHORIZED
      const mine = s.tokens.filter((t) => t.account === who.id).map(tokenView)
      if (s.states.get('tokens') === 'empty') return { status: 200, body: { tokens: [] } }
      if (s.states.get('tokens') === 'much-data')
        return {
          status: 200,
          body: {
            tokens: [
              ...mine,
              ...Array.from({ length: 40 }, (_, i) => ({
                ...(mine[0] ?? tokenView(s.tokens[0] as FxToken)),
                id: `crd_tok_many${i}`,
                name: `Agent ${i + 1}`,
              })),
            ],
          },
        }
      return { status: 200, body: { tokens: mine } }
    },
  },
  'DELETE /v1/me/tokens/{id}': {
    run: ({ s, who, params }) => {
      const t = s.tokens.find((x) => x.id === params.id && x.account === who?.id)
      if (!t)
        return err(404, 'not_found', 'No token with that id is available to you.', 'Check the token id.')
      s.tokens = s.tokens.filter((x) => x !== t)
      return { status: 200, body: { revoked: t.id } }
    },
  },
  'GET /v1/me/apps': {
    screen: 'apps',
    run: ({ s, who }) => {
      if (!who) return UNAUTHORIZED
      const now = new Date().toISOString()
      if (s.states.get('apps') === 'empty') return { status: 200, body: { apps: [], now } }
      return { status: 200, body: { apps: s.apps.filter((a) => a.account === who.id).map(appView), now } }
    },
  },
  'DELETE /v1/me/apps/{id}': {
    run: ({ s, who, params }) => {
      const a = s.apps.find((x) => x.id === params.id && x.account === who?.id)
      if (!a)
        return err(
          404,
          'not_found',
          'No connected app with that id is available to you.',
          'Check the connected app id.',
        )
      s.apps = s.apps.filter((x) => x !== a)
      return { status: 200, body: { revoked: a.id } }
    },
  },
  'PUT /v1/brains/{slug}/notify': {
    screen: 'notify',
    run: ({ s, who, params, body }) => {
      const b = brainsOf(s, who).find((x) => x.slug === params.slug)
      if (!b || !who) return NO_BRAIN
      if (typeof body.notifyProposals !== 'boolean')
        return err(
          400,
          'invalid_request',
          '"notifyProposals" is true or false.',
          'Send {"notifyProposals": true}.',
        )
      if (b.role !== 'curator')
        return err(
          400,
          'invalid_request',
          'Only curators get notices of new proposals.',
          'Ask a curator of the brain.',
        )
      s.notify.set(`${who.id}:${b.slug}`, body.notifyProposals)
      return { status: 200, body: { notifyProposals: body.notifyProposals } }
    },
  },
  'POST /v1/me/password': {
    run: ({ who, body }) => {
      if (!who) return UNAUTHORIZED
      if (typeof body.current !== 'string' || !body.current)
        return err(
          400,
          'invalid_request',
          'Send your current password in "current".',
          'Type the password you sign in with now.',
        )
      if (typeof body.next !== 'string' || body.next.length < 12 || body.next.length > 200) return SHORT
      if (body.current === who.password && who.totp && body.code !== CODE)
        return body.code
          ? NOT_THE_CODE
          : err(
              400,
              'invalid_request',
              'This account has a second factor: send the code of the authenticator app in "code" too.',
              'Type the 6 digits your app shows now.',
            )
      if (body.current !== who.password)
        return err(
          400,
          'wrong_password',
          'The current password is not right.',
          'Type it again. Forgot it? Sign out and reset it from the sign-in page ("Forgot your password?").',
        )
      who.password = body.next
      // Every other web session of the person ends; this one stays (the fixture keeps one per person).
      return { status: 204, body: null }
    },
  },
  'POST /v1/me/revoke-all': {
    run: ({ s, who }) => {
      if (!who) return UNAUTHORIZED
      const tokens = s.tokens.filter((t) => t.account === who.id).length
      const apps = s.apps.filter((a) => a.account === who.id).length
      s.tokens = s.tokens.filter((t) => t.account !== who.id)
      s.apps = s.apps.filter((a) => a.account !== who.id)
      return { status: 200, body: { tokens, apps } }
    },
  },
  'POST /v1/me/totp': {
    run: ({ s, who, body }) => {
      if (!who) return UNAUTHORIZED
      if (who.totp && body.code !== CODE) return NOT_THE_CODE
      s.totpPending.add(who.id)
      return {
        status: 200,
        body: {
          secret: TOTP_SECRET,
          otpauthUrl: `otpauth://totp/${encodeURIComponent(`${s.name || 'rsc-brain'}:${who.email}`)}?secret=${TOTP_SECRET}&issuer=${encodeURIComponent(s.name || 'rsc-brain')}`,
        },
      }
    },
  },
  'POST /v1/me/totp/confirm': {
    run: ({ s, who, body }) => {
      if (!who) return UNAUTHORIZED
      if (!s.totpPending.has(who.id))
        return err(400, 'invalid_request', 'There is no second factor being set up.', 'Start it first.')
      if (body.code !== CODE) return NOT_THE_CODE
      s.totpPending.delete(who.id)
      who.totp = true
      return { status: 200, body: { enabled: true } }
    },
  },
  'DELETE /v1/me/totp': {
    run: ({ who, body }) => {
      if (!who) return UNAUTHORIZED
      if (!who.totp) return { status: 200, body: { enabled: false } }
      if (body.code !== CODE)
        return err(
          400,
          'invalid_request',
          'The code is not right.',
          'Type the 6 digits your current app shows now.',
        )
      who.totp = false
      return { status: 200, body: { enabled: false } }
    },
  },
  'POST /v1/auth/logout-everywhere': {
    run: ({ s, who }) => {
      if (!who) return UNAUTHORIZED
      const n = s.sessions.delete(`fx.${who.id}`) ? 1 : 0
      return {
        status: 200,
        body: { signedOut: n },
        headers: { 'set-cookie': 'rscb_session=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0' },
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
      // Empty: no one but the administration looking (no service accounts yet).
      const all = adminAccounts(s, who)
      const accounts = s.states.get('people') === 'empty' ? all.filter((a) => a.id === who.id) : all
      return { status: 200, body: { accounts } }
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
  // A brain's settings (PR25a, G11): any member reads them; a curator saves them, on the revision read.
  'GET /v1/brains/{slug}/wiki/settings': {
    screen: 'settings',
    run: (c) => {
      const b = brainsOf(c.s, c.who).find((x) => x.slug === c.params.slug)
      if (!b) return NO_BRAIN
      return { status: 200, body: settingsView(settingsOf(c.s, b.slug)) }
    },
  },
  // Exporting a brain (B7 PR31): its curators download a zip; the name says brain, format and moment.
  'GET /v1/brains/{slug}/export': {
    screen: 'export',
    run: (c) => {
      const b = brainsOf(c.s, c.who).find((x) => x.slug === c.params.slug)
      if (!b) return NO_BRAIN
      const format = c.query.get('format') ?? ''
      const forgotten = c.query.get('includeForgotten')
      if (!['readable', 'faithful'].includes(format))
        return err(
          400,
          'invalid_request',
          '"format" is "readable" or "faithful".',
          'Send format=readable (to read) or format=faithful (to import elsewhere).',
        )
      if (forgotten !== null && forgotten !== '0' && forgotten !== '1')
        return err(
          400,
          'invalid_request',
          '"includeForgotten" is 1 or 0.',
          'Send includeForgotten=1 to include forgotten entries, or leave it out.',
        )
      if (b.role !== 'curator')
        return err(
          403,
          'forbidden',
          `This needs the curator role in the brain; you are ${b.role}.`,
          'Ask a curator of the brain (Eric) for the curator role.',
        )
      const stamp = NOW()
        .replace(/[-:]/g, '')
        .replace(/\.\d{3}/, '')
      return {
        status: 200,
        body: null,
        raw: exportZip(format, forgotten === '1'),
        headers: {
          'content-type': 'application/zip',
          'content-disposition': `attachment; filename="rsc-brain-${b.slug}-${format}-${stamp}.zip"`,
        },
      }
    },
  },
  // Importing a folder (B7 PR32): its curators, into an empty brain; the zip must at least look like one. The report
  // is the one of the sample docs (test/fixtures/docs-sample/), and the brain fills, as the server's would.
  'POST /v1/brains/{slug}/import': {
    screen: 'import',
    run: (c) => {
      const b = brainsOf(c.s, c.who).find((x) => x.slug === c.params.slug)
      if (!b) return NO_BRAIN
      if (b.role !== 'curator')
        return err(
          403,
          'forbidden',
          `This needs the curator role in the brain; you are ${b.role}.`,
          'Ask a curator of the brain (Eric) for the curator role.',
        )
      if (b.status === 'archived')
        return err(
          403,
          'forbidden',
          'This brain is archived, so it is read-only.',
          'A curator of the brain can unarchive it (POST /v1/brains/:slug/unarchive).',
        )
      const life = c.s.life.get(b.slug) ?? { entries: 0, agent: false }
      if (life.imported || life.entries > 0 || b.stats.pages > 0 || b.stats.entries > 0)
        return err(
          409,
          'brain_not_empty',
          'This brain already has pages, entries or proposals; an import goes only into an empty brain. Nothing was changed.',
          'Create a new brain and import into it.',
        )
      if (c.raw?.subarray(0, 2).toString('latin1') !== 'PK')
        return err(
          422,
          'invalid_archive',
          'This is not a zip rsc-brain can read: its end record is missing.',
          'Make the zip again from the folder (with no links in it) and import it.',
        )
      c.s.life.set(b.slug, { ...life, imported: true })
      b.stats = { ...b.stats, pages: 5, entries: 4 }
      emit(c.s, b.slug, 'brain.imported', {
        who: c.who ? { id: c.who.id, name: c.who.name } : null,
        target: { id: '', label: 'docs' },
        client: 'web',
      })
      const ignored = [
        { path: '.obsidian/', why: 'hidden' },
        { path: 'README.md', why: 'outside' },
        { path: 'archive/', why: 'outside' },
        { path: 'raw/images/photo.jpg', why: 'binary' },
        { path: 'raw/keys/admin.totp', why: 'secret' },
        { path: 'wiki/data.json', why: 'not_markdown' },
        { path: 'wiki/diagram.png', why: 'binary' },
      ]
      const many = c.s.states.get('import') === 'much-data'
      return {
        status: 200,
        body: {
          report: {
            kind: 'docs',
            pages: 5,
            entries: 4,
            links: 5,
            unresolved: [
              { from: 'decisions/use-postgres', target: 'wiki/nowhere', why: 'missing' },
              { from: 'topics/retention', target: 'missing-page', why: 'missing' },
              { from: 'topics/retention', target: 'wiki/diagram.png', why: 'left_out' },
            ],
            ignored: many
              ? Array.from({ length: 500 }, (_, i) => ({ path: `raw/images/${i}.png`, why: 'binary' }))
              : ignored,
            renamed: [{ path: 'wiki/topics/Audience Notes.md', address: 'topics/audience-notes' }],
            recoded: ['wiki/latin.md'],
            totals: { unresolved: 3, ignored: many ? 1234 : ignored.length, renamed: 1, recoded: 1 },
          },
        },
      }
    },
  },
  'PUT /v1/brains/{slug}/wiki/settings': {
    run: (c) => {
      const b = brainsOf(c.s, c.who).find((x) => x.slug === c.params.slug)
      if (!b) return NO_BRAIN
      if (!c.web)
        return err(
          403,
          'web_only',
          'Deciding about the wiki is done in the rsc-brain web, signed in as a person.',
          'Open the rsc-brain web.',
        )
      if (b.role !== 'curator')
        return err(
          403,
          'forbidden',
          `This needs the curator role in the brain; you are ${b.role}.`,
          'Ask a curator of the brain (Eric) for the curator role.',
        )
      if (b.status === 'archived') return ARCHIVED
      const x = settingsOf(c.s, b.slug)
      const body = c.body
      const FIELDS = [
        'guide',
        'mapIntro',
        'usageNote',
        'meaningExcluded',
        'staleDays',
        'longChars',
        'maintenanceEvery',
      ]
      const base = body.base
      if (
        base !== undefined &&
        (typeof base !== 'object' ||
          base === null ||
          Array.isArray(base) ||
          Object.keys(base).some((k) => !FIELDS.includes(k)))
      )
        return err(
          400,
          'invalid_request',
          '"base" holds what each field was when you read it.',
          'Fix "base".',
        )
      if (base) {
        const moved = Object.entries(base as Record<string, unknown>)
          .filter(([k, v]) => x[k as keyof FxSettings] !== v)
          .map(([k]) => k)
        if (moved.length)
          return {
            status: 409,
            body: {
              error: {
                code: 'settings_changed',
                message: `Someone changed ${moved.join(', ')} of "${b.slug}" since you read ${moved.length === 1 ? 'it' : 'them'}.`,
                howToProceed:
                  'Read the current values in "current", then save your change again on top of them.',
                current: settingsView(x),
              },
            },
          }
      }
      const range = (k: 'staleDays' | 'longChars' | 'maintenanceEvery', min: number, max: number) => {
        const v = body[k]
        return v === undefined || (Number.isSafeInteger(v) && (v as number) >= min && (v as number) <= max)
          ? null
          : err(400, 'invalid_request', `"${k}" goes from ${min} to ${max}.`, `Fix "${k}".`)
      }
      const bad =
        range('staleDays', 1, 3650) ?? range('longChars', 1000, 100000) ?? range('maintenanceEvery', 1, 1000)
      if (bad) return bad
      // Only a base: nothing changed; what the person sees is still what is there.
      if (base && FIELDS.every((k) => body[k] === undefined))
        return { status: 200, body: { ...settingsView(x), unchanged: true } }
      if (typeof body.usageNote === 'string' && body.usageNote.trim().length > 2000)
        return err(400, 'invalid_request', 'The usage note has at most 2 000 characters.', 'Shorten it.')
      if (body.guide === null) x.guide = null
      else if (typeof body.guide === 'string') {
        const g = body.guide.trim()
        if (!g || g.length > 20000)
          return err(
            400,
            'invalid_request',
            'The guide has 1 to 20 000 characters.',
            'Shorten it, or send null to go back to the default.',
          )
        x.guide = g === DEFAULT_GUIDE.trim() ? null : g
      }
      if (typeof body.usageNote === 'string') x.usageNote = body.usageNote.trim()
      if (typeof body.meaningExcluded === 'boolean') x.meaningExcluded = body.meaningExcluded
      for (const k of ['staleDays', 'longChars', 'maintenanceEvery'] as const)
        if (typeof body[k] === 'number') x[k] = body[k] as number
      return { status: 200, body: settingsView(x) }
    },
  },
  'POST /v1/brains/{slug}/members': {
    run: (c) => {
      const m = manages(c)
      if ('status' in m) return m
      const slug = m.brain.slug
      const role = String(c.body.role ?? '')
      if (!['reader', 'contributor', 'curator'].includes(role))
        return err(
          400,
          'invalid_request',
          '"role" is curator, contributor or reader.',
          'Choose one of the three.',
        )
      const ref = String(c.body.account ?? '')
        .trim()
        .toLowerCase()
      const person = c.s.accounts.find((a) => !a.alone && (a.id === ref || a.email === ref))
      const service = c.s.services.find((v) => v.id === ref)
      if (!person && !service)
        return err(
          400,
          'invalid_request',
          'There is no account with that id or email.',
          'Only people who already have an account can be added; the administration invites new ones.',
        )
      if (person?.removed || service?.removed)
        return err(
          400,
          'invalid_request',
          'That account was deactivated.',
          'The administration can reactivate it first.',
        )
      if (service && role === 'curator')
        return err(
          400,
          'invalid_request',
          'A service account is never a curator.',
          'Give it the contributor or reader role.',
        )
      const list = membersOf(c.s, slug)
      const id = (person?.id ?? service?.id) as string
      const had = list.find((x) => x.accountId === id)
      if (had)
        return err(
          409,
          'already_member',
          `${had.name} is already a ${had.role} of "${slug}" — change their role in the list.`,
          `Change the role with PUT /v1/brains/${slug}/members/${id}.`,
        )
      list.push({
        accountId: id,
        kind: person ? 'person' : 'service',
        name: (person?.name ?? service?.name) as string,
        email: person?.email ?? null,
        role,
      })
      c.s.roleChanges.set(`${id}:${slug}`, role)
      return {
        status: 201,
        body: { member: { accountId: id, name: (person?.name ?? service?.name) as string, role } },
      }
    },
  },
  'PUT /v1/brains/{slug}/members/{account}': {
    run: (c) => {
      const m = manages(c)
      if ('status' in m) return m
      const slug = m.brain.slug
      const role = String(c.body.role ?? '')
      if (!['reader', 'contributor', 'curator'].includes(role))
        return err(
          400,
          'invalid_request',
          '"role" is curator, contributor or reader.',
          'Choose one of the three.',
        )
      const list = membersOf(c.s, slug)
      const had = list.find((x) => x.accountId === c.params.account)
      if (!had)
        return err(
          400,
          'invalid_request',
          'There is no account with that id or email.',
          'Only people who already have an account can be added; the administration invites new ones.',
        )
      if (had.kind === 'service' && role === 'curator')
        return err(
          400,
          'invalid_request',
          'A service account is never a curator.',
          'Give it the contributor or reader role.',
        )
      if (
        had.role === 'curator' &&
        role !== 'curator' &&
        list.filter((x) => x.role === 'curator').length === 1
      )
        return LAST_CURATOR(slug)
      had.role = role
      c.s.roleChanges.set(`${had.accountId}:${slug}`, role)
      return { status: 200, body: { member: { accountId: had.accountId, name: had.name, role } } }
    },
  },
  'DELETE /v1/brains/{slug}/members/{account}': {
    run: (c) => {
      const self = c.params.account === c.who?.id
      const own = brainsOf(c.s, c.who).find((x) => x.slug === c.params.slug)
      const m = self ? (own ? { brain: own } : NO_BRAIN) : manages(c)
      if ('status' in m) return m
      const slug = m.brain.slug
      const list = membersOf(c.s, slug)
      const i = list.findIndex((x) => x.accountId === c.params.account)
      const had = list[i]
      if (!had)
        return err(404, 'not_found', 'No member with that id is available to you.', 'Check the member id.')
      if (had.role === 'curator' && list.filter((x) => x.role === 'curator').length === 1)
        return LAST_CURATOR(slug)
      list.splice(i, 1)
      c.s.roleChanges.set(`${had.accountId}:${slug}`, null)
      return { status: 200, body: { removed: had.accountId } }
    },
  },
  'GET /v1/brains/{slug}/repos': {
    screen: 'repos',
    run: (c) => {
      const b = brainsOf(c.s, c.who).find((x) => x.slug === c.params.slug)
      if (!b) return NO_BRAIN
      return { status: 200, body: { repos: c.s.repos.get(b.slug) ?? [] } }
    },
  },
  'POST /v1/brains/{slug}/repos': {
    run: (c) => {
      if (!c.web) return WEB_ONLY('Linking repositories')
      const b = brainsOf(c.s, c.who).find((x) => x.slug === c.params.slug)
      if (!b) return NO_BRAIN
      if (b.role !== 'curator')
        return err(
          400,
          'invalid_request',
          `Only curators of "${b.slug}" link repositories to it.`,
          'Ask a curator of the brain.',
        )
      if (b.status === 'archived')
        return err(
          403,
          'forbidden',
          'This brain is archived, so no repository can be linked to it.',
          'A curator of the brain can unarchive it first.',
        )
      const key = repoKey(c.body.repo)
      if (!key)
        return err(
          400,
          'invalid_request',
          'That is not a repository address.',
          'Use the full address, e.g. github.com/org/repo (or the output of "git remote get-url origin").',
        )
      const list = c.s.repos.get(b.slug) ?? []
      if (!list.some((x) => x.repo === key)) list.push({ repo: key, linkedAt: NOW() })
      list.sort((x, y) => x.repo.localeCompare(y.repo))
      c.s.repos.set(b.slug, list)
      return { status: 201, body: { repo: key } }
    },
  },
  'DELETE /v1/brains/{slug}/repos': {
    run: (c) => {
      if (!c.web) return WEB_ONLY('Linking repositories')
      const b = brainsOf(c.s, c.who).find((x) => x.slug === c.params.slug)
      if (!b) return NO_BRAIN
      if (b.role !== 'curator')
        return err(
          400,
          'invalid_request',
          `Only curators of "${b.slug}" link repositories to it.`,
          'Ask a curator of the brain.',
        )
      const key = repoKey(c.body.repo)
      const list = c.s.repos.get(b.slug) ?? []
      const i = list.findIndex((x) => x.repo === key)
      if (i < 0)
        return err(
          404,
          'not_found',
          'No linked repository with that id is available to you.',
          'Check the linked repository id.',
        )
      list.splice(i, 1)
      return { status: 200, body: { unlinked: true } }
    },
  },
  'POST /v1/brains/{slug}/archive': {
    run: (c) => archiving(c, true),
  },
  'POST /v1/brains/{slug}/unarchive': {
    run: (c) => archiving(c, false),
  },
  'DELETE /v1/brains/{slug}': {
    run: (c) => {
      if (!c.web) return WEB_ONLY('Deleting a brain')
      if (!c.who?.isAdmin)
        return err(
          403,
          'forbidden',
          'Only the administration can delete a brain.',
          'Ask the administration of this installation.',
        )
      const i = c.s.brains.findIndex((x) => x.slug === c.params.slug)
      if (i < 0) return NO_BRAIN
      if (c.body.confirm !== c.params.slug)
        return err(
          400,
          'invalid_request',
          'To delete a brain, type its name to confirm.',
          `Send {"confirm": "${c.params.slug}"}.`,
        )
      c.s.brains.splice(i, 1)
      return { status: 200, body: { deleted: c.params.slug } }
    },
  },
  'PATCH /v1/admin/accounts/{id}': {
    run: ({ s, who, params, body, web }) => {
      if (!web) return WEB_ONLY('This')
      if (!who?.isAdmin) return ADMIN_ONLY
      for (const k of ['isAdmin', 'canCreateBrains', 'canInvite'])
        if (body[k] !== undefined && typeof body[k] !== 'boolean')
          return err(400, 'invalid_request', `"${k}" is true or false.`, `Fix "${k}".`)
      const a = s.accounts.find((x) => x.id === params.id)
      const v = s.services.find((x) => x.id === params.id)
      if (!a && !v)
        return err(404, 'not_found', 'No account with that id is available to you.', 'Check the account id.')
      if (v) {
        if (body.isAdmin === true)
          return err(
            400,
            'invalid_request',
            'A service account cannot be an administrator.',
            'Choose a person.',
          )
        if (typeof body.canCreateBrains === 'boolean') v.canCreate = body.canCreateBrains
        return {
          status: 200,
          body: { account: { id: v.id, isAdmin: false, canCreateBrains: v.canCreate, canInvite: false } },
        }
      }
      const p = a as Account
      const admins = s.accounts.filter((x) => x.isAdmin && !x.removed && x.id !== p.id).length
      if (p.isAdmin && body.isAdmin === false && admins === 0) return LAST_ADMIN
      if (typeof body.isAdmin === 'boolean') p.isAdmin = body.isAdmin
      if (typeof body.canCreateBrains === 'boolean') p.canCreate = body.canCreateBrains
      return {
        status: 200,
        body: {
          account: {
            id: p.id,
            isAdmin: p.isAdmin,
            canCreateBrains: p.isAdmin || Boolean(p.canCreate),
            canInvite: false,
          },
        },
      }
    },
  },
  'POST /v1/admin/accounts/{id}/remove': {
    run: ({ s, who, params, web }) => {
      if (!web) return WEB_ONLY('This')
      if (!who?.isAdmin) return ADMIN_ONLY
      if (params.id === who.id)
        return err(
          400,
          'invalid_request',
          'You cannot remove your own account.',
          'Ask another administrator.',
        )
      const a = s.accounts.find((x) => x.id === params.id)
      const v = s.services.find((x) => x.id === params.id)
      if (!a && !v)
        return err(404, 'not_found', 'No account with that id is available to you.', 'Check the account id.')
      if (a?.isAdmin && s.accounts.filter((x) => x.isAdmin && !x.removed && x.id !== a.id).length === 0)
        return LAST_ADMIN
      const orphan = s.brains
        .filter((b) => {
          const ms = membersOf(s, b.slug)
          return (
            ms.some((m) => m.accountId === params.id && m.role === 'curator') &&
            ms.filter((m) => m.role === 'curator').length === 1
          )
        })
        .map((b) => b.slug)
      let keysRevoked = 0
      if (a) {
        if (!a.removed) keysRevoked = s.tokens.filter((t) => t.account === a.id).length
        a.removed = true
        for (const sid of [...s.sessions]) if (sid === `fx.${a.id}`) s.sessions.delete(sid)
      }
      if (v) {
        for (const k of s.keys)
          if (k.account === v.id && !k.revoked) {
            k.revoked = true
            k.liveShortKeys = 0
            k.liveShortRefs = []
            keysRevoked += 1
          }
        v.removed = true
      }
      return { status: 200, body: { removed: true, keysRevoked, brainsWithoutCurator: orphan } }
    },
  },
  'POST /v1/admin/accounts/{id}/restore': {
    run: ({ s, who, params, web }) => {
      if (!web) return WEB_ONLY('This')
      if (!who?.isAdmin) return ADMIN_ONLY
      const a = s.accounts.find((x) => x.id === params.id)
      const v = s.services.find((x) => x.id === params.id)
      if (!a && !v)
        return err(404, 'not_found', 'No account with that id is available to you.', 'Check the account id.')
      if (a) a.removed = false
      if (v) v.removed = false
      return { status: 200, body: { restored: true } }
    },
  },
  'GET /v1/admin/accounts/{id}/keys': {
    screen: 'keys',
    run: ({ s, who, params }) => {
      if (!who?.isAdmin) return ADMIN_ONLY
      if (!s.accounts.some((x) => x.id === params.id) && !s.services.some((x) => x.id === params.id))
        return err(404, 'not_found', 'No account with that id is available to you.', 'Check the account id.')
      return {
        status: 200,
        body: {
          keys: s.keys
            .filter((k) => k.account === params.id)
            .map((k) => ({
              id: k.id,
              kind: 'main',
              name: k.name,
              last4: k.last4,
              perm: 'write',
              createdAt: k.createdAt,
              expiresAt: null,
              lastUsedAt: k.lastUsedAt,
              lastClient: k.lastClient,
              status: k.revoked ? 'revoked' : 'active',
              liveShortKeys: k.liveShortKeys,
              liveShortRefs: k.liveShortRefs,
            })),
        },
      }
    },
  },
  'POST /v1/admin/services': {
    run: ({ s, who, body, web }) => {
      if (!web) return WEB_ONLY('This')
      if (!who?.isAdmin) return ADMIN_ONLY
      const name = typeof body.name === 'string' ? body.name.trim() : ''
      if (!name || name.length > 80)
        return err(400, 'invalid_request', 'An account name has 1 to 80 characters.', 'Shorten the name.')
      const brains = Array.isArray(body.brains)
        ? (body.brains as Array<{ slug?: unknown; role?: unknown }>)
        : []
      for (const g of brains) {
        if (typeof g?.slug !== 'string' || (g.role !== 'contributor' && g.role !== 'reader'))
          return err(
            400,
            'invalid_request',
            'A service account joins a brain as contributor or reader, never curator.',
            'Give each brain a "slug" and a "role" of contributor or reader.',
          )
        if (!s.brains.some((b) => b.slug === g.slug)) return NO_BRAIN
      }
      s.made += 1
      const id = `acc_svc_new${s.made}`
      const roles = brains.map((g) => ({ slug: g.slug as string, role: g.role as string }))
      s.services.push({
        id,
        name,
        removed: false,
        canCreate: body.canCreateBrains === true,
        roles,
        createdAt: NOW(),
        lastSeenAt: null,
      })
      for (const r of roles) {
        const list = s.members.get(r.slug)
        if (list) list.push({ accountId: id, kind: 'service', name, email: null, role: r.role })
      }
      const secret = secretOf()
      const keyId = `crd_main_new${s.made}`
      s.keys.push({
        account: id,
        id: keyId,
        name: 'main',
        last4: secret.slice(-4),
        createdAt: NOW(),
        lastUsedAt: null,
        lastClient: null,
        revoked: false,
        liveShortKeys: 0,
        liveShortRefs: [],
      })
      return {
        status: 201,
        body: {
          account: { id },
          key: { id: keyId, secret },
          message: 'Copy the key now: rsc-brain shows it only this once.',
        },
      }
    },
  },
  'POST /v1/admin/services/{id}/keys': {
    run: ({ s, who, params, body, web }) => {
      if (!web) return WEB_ONLY('This')
      if (!who?.isAdmin) return ADMIN_ONLY
      const v = s.services.find((x) => x.id === params.id)
      if (!v)
        return err(
          404,
          'not_found',
          'No service account with that id is available to you.',
          'Check the service account id.',
        )
      if (v.removed)
        return err(400, 'invalid_request', 'This service account is deactivated.', 'Reactivate it first.')
      if (s.keys.filter((k) => k.account === v.id && !k.revoked).length >= 2)
        return err(
          409,
          'too_many_main_keys',
          'A service account has at most 2 main keys at once.',
          'Revoke the old key once the program uses the new one, then make another.',
        )
      s.made += 1
      const secret = secretOf()
      const keyId = `crd_main_new${s.made}`
      s.keys.unshift({
        account: v.id,
        id: keyId,
        name: typeof body.name === 'string' && body.name.trim() ? body.name.trim() : 'main',
        last4: secret.slice(-4),
        createdAt: NOW(),
        lastUsedAt: null,
        lastClient: null,
        revoked: false,
        liveShortKeys: 0,
        liveShortRefs: [],
      })
      return {
        status: 201,
        body: { key: { id: keyId, secret }, message: 'Copy the key now: rsc-brain shows it only this once.' },
      }
    },
  },
  'DELETE /v1/keys/{id}': {
    run: ({ s, who, params }) => {
      const k = s.keys.find((x) => x.id === params.id)
      if (!k || !who?.isAdmin)
        return err(404, 'not_found', 'No key with that id is available to you.', 'Check the key id.')
      k.revoked = true
      k.liveShortKeys = 0
      k.liveShortRefs = []
      return { status: 200, body: { revoked: k.id } }
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
        const members = membersOf(c.s, c.params.slug as string).map((m) => ({
          ...m,
          email: w.role === 'curator' ? m.email : null,
        }))
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
      // The words matched are marked «…», as the server marks them.
      const matched = new RegExp(q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi')
      const all = [...pages, ...entries]
        .filter((h) => !from || h.at >= from)
        .map((h) => ({ ...h, snippet: String(h.snippet).replace(matched, (m) => `«${m}»`) }))
      const much = st === 'much-data'
      const items = (much ? Array.from({ length: 3 }, () => all).flat() : all).slice(offset, offset + limit)
      const next = offset + limit < (much ? all.length * 3 : all.length) ? offset + limit : null
      return { status: 200, body: { items, next } }
    },
  },
}

// The health of a wiki (B2): the first brain (and Support, where Ana reads) has something in each common
// section; "much-data" a long list. Every page comes with its title.
function healthOf(slug: string, st: State | undefined) {
  const none = {
    orphans: [] as Array<{ address: string; title: string }>,
    broken: [] as Array<{ from: string; fromTitle: string; to: string }>,
    conflicts: [] as Array<{ a: string; aTitle: string; b: string; bTitle: string }>,
    stale: [] as Array<{ address: string; title: string; updatedAt: string; newEntries: number }>,
    unavailableSources: [] as Array<{
      address: string
      title: string
      entryId: string
      state: 'forgotten' | 'purged'
    }>,
    long: [] as Array<{ address: string; title: string; chars: number }>,
    similarTitles: [] as Array<{ a: string; aTitle: string; b: string; bTitle: string }>,
    maintenance: { suggested: false, approvalsSince: 3, every: 20 },
  }
  if (st === 'empty' || (slug !== 'growth' && slug !== 'support')) return none
  const h = {
    ...none,
    broken: [
      { from: 'audience/retention', fromTitle: 'Retention', to: 'drafts/hooks-that-work' },
      { from: 'audience/intros', fromTitle: 'Writing intros', to: 'audience/hook-length' },
      { from: 'product/pricing', fromTitle: 'Pricing', to: 'product/plans' },
    ],
    conflicts: [
      { a: 'audience/intros', aTitle: 'Writing intros', b: 'audience/old-intros', bTitle: 'Old intros' },
      { a: 'audience/retention', aTitle: 'Retention', b: 'product/pricing', bTitle: 'Pricing' },
    ],
    orphans: [
      { address: 'misc/naming', title: 'Naming videos' },
      { address: 'misc/thumbnails', title: 'Thumbnails' },
      { address: 'misc/shorts', title: 'Shorts' },
      { address: 'misc/music', title: 'Music' },
    ],
    stale: [
      {
        address: 'audience/retention',
        title: 'Retention',
        updatedAt: '2026-06-01T10:00:00.000Z',
        newEntries: 4,
      },
    ],
    similarTitles: [
      { a: 'audience/intros', aTitle: 'Writing intros', b: 'audience/old-intros', bTitle: 'Old intros' },
      // A templated wiki: long titles almost the same, which wrap on a phone (axe target-size at 375 px).
      {
        a: 'reports/weekly-retention-report-for-the-onboarding-funnel-2026-w43',
        aTitle: 'Weekly retention report for the onboarding funnel, week 43 of 2026',
        b: 'reports/weekly-retention-report-for-the-onboarding-funnel-2026-w44',
        bTitle: 'Weekly retention report for the onboarding funnel, week 44 of 2026',
      },
      {
        a: 'reports/monthly-retention-report-for-the-support-channel-2026-10',
        aTitle: 'Monthly retention report for the support channel, October 2026',
        b: 'reports/monthly-retention-report-for-the-support-channel-2026-09',
        bTitle: 'Monthly retention report for the support channel, September 2026',
      },
    ],
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
  ...ADMIN_PRIVATE,
  'POST /v1/setup/key',
  'GET /v1/brains/{slug}/export',
  'POST /v1/brains/{slug}/import',
  'GET /v1/brains/{slug}/wiki/settings',
  'PUT /v1/brains/{slug}/wiki/settings',
  'POST /v1/brains/{slug}/members',
  'PUT /v1/brains/{slug}/members/{account}',
  'DELETE /v1/brains/{slug}/members/{account}',
  'GET /v1/brains/{slug}/repos',
  'POST /v1/brains/{slug}/repos',
  'DELETE /v1/brains/{slug}/repos',
  'POST /v1/brains/{slug}/archive',
  'POST /v1/brains/{slug}/unarchive',
  'DELETE /v1/brains/{slug}',
  'PATCH /v1/admin/accounts/{id}',
  'POST /v1/admin/accounts/{id}/remove',
  'POST /v1/admin/accounts/{id}/restore',
  'GET /v1/admin/accounts/{id}/keys',
  'POST /v1/admin/services',
  'POST /v1/admin/services/{id}/keys',
  'DELETE /v1/keys/{id}',
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
  'GET /v1/me/tokens',
  'DELETE /v1/me/tokens/{id}',
  'GET /v1/me/apps',
  'DELETE /v1/me/apps/{id}',
  'PUT /v1/brains/{slug}/notify',
  'POST /v1/me/password',
  'POST /v1/me/revoke-all',
  'POST /v1/me/totp',
  'POST /v1/me/totp/confirm',
  'DELETE /v1/me/totp',
  'POST /v1/auth/logout-everywhere',
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
  const told = (bs: Brain[]) =>
    bs.map((b) => {
      const on = s.notify.get(`${who?.id}:${b.slug}`)
      return on === undefined ? b : { ...b, notifyProposals: on }
    })
  // A role changed (or a membership ended) in the settings of a brain.
  const changed = (bs: Brain[]) =>
    bs.flatMap((b) => {
      const k = `${who?.id}:${b.slug}`
      if (!s.roleChanges.has(k)) return [b]
      const role = s.roleChanges.get(k)
      return role ? [{ ...b, role }] : []
    })
  if (who?.alone) return told(changed(s.brains.filter((b) => !BRAINS().some((x) => x.slug === b.slug))))
  if (who?.id === 'acc_ana')
    return told(changed(s.brains.map((b) => ({ ...b, role: ANA_ROLES[b.slug] ?? b.role }))))
  return told(changed(s.brains))
}

// The members of a brain as the fixture first shows them (each person with their role there, Eric a
// curator wherever no one else is, and the service accounts the administration added), kept once read
// so the settings can change them.
function membersOf(s: Scen, slug: string): FxMember[] {
  let m = s.members.get(slug)
  if (m) return m
  const roleOf = (id: string) =>
    brainsOf(s, s.accounts.find((a) => a.id === id) ?? null).find((b) => b.slug === slug)?.role
  const listed: FxMember[] = s.accounts
    .filter((a) => !a.alone && !a.removed && roleOf(a.id))
    .map((a) => ({
      accountId: a.id,
      kind: 'person',
      name: a.name,
      email: a.email,
      role: roleOf(a.id) as string,
    }))
  const people = listed.some((x) => x.role === 'curator')
    ? listed
    : listed.map((x) => (x.accountId === 'acc_eric' ? { ...x, role: 'curator' } : x))
  const services = s.services.flatMap((v) => {
    const r = v.roles.find((x) => x.slug === slug)
    return r && !v.removed
      ? [{ accountId: v.id, kind: 'service', name: v.name, email: null, role: r.role }]
      : []
  })
  const order = ['curator', 'contributor', 'reader']
  m = [...people, ...services].sort((a, b) => order.indexOf(a.role) - order.indexOf(b.role))
  s.members.set(slug, m)
  return m
}

// Who manages the members of a brain: its curators and the administration (B4); a member who is not a
// curator is told why, and a stranger gets the 404 of a missing brain.
function manages(c: Ctx): { brain: Brain } | Answer {
  if (!c.web) return WEB_ONLY('Changing who is in a brain')
  const b = brainsOf(c.s, c.who).find((x) => x.slug === c.params.slug)
  const exists = c.s.brains.find((x) => x.slug === c.params.slug)
  if (b?.role === 'curator') return { brain: b }
  if (c.who?.isAdmin && exists) return { brain: exists }
  if (!b) return NO_BRAIN
  return err(
    403,
    'forbidden',
    `Only curators of "${b.slug}" change its members; you are ${b.role}.`,
    'Ask a curator of the brain.',
  )
}

const LAST_CURATOR = (slug: string) =>
  err(
    409,
    'last_curator',
    `This is the last curator of "${slug}"; a brain always keeps one.`,
    'Make another member curator first, then change this one.',
  )
const LAST_ADMIN = err(
  409,
  'last_admin',
  'This is the last administrator of the installation.',
  'Make another person an administrator first.',
)
const WEB_ONLY = (what: string) =>
  err(
    403,
    'web_only',
    `${what} is done in the rsc-brain web, signed in as a person.`,
    'Open the rsc-brain web. Keys of agents and programs cannot manage people or keys.',
  )
const ARCHIVED = err(
  403,
  'forbidden',
  'This brain is archived, so it is read-only.',
  'A curator of the brain can unarchive it (POST /v1/brains/:slug/unarchive).',
)

function settingsOf(s: Scen, slug: string): FxSettings {
  let x = s.settings.get(slug)
  if (!x) {
    x = {
      guide: null,
      mapIntro: '',
      usageNote: '',
      meaningExcluded: false,
      staleDays: 90,
      longChars: 20000,
      maintenanceEvery: 20,
      approvalsSince: 3,
    }
    s.settings.set(slug, x)
  }
  return x
}
const settingsView = (x: FxSettings) => ({
  guide: x.guide ?? DEFAULT_GUIDE,
  guideDefault: DEFAULT_GUIDE,
  customGuide: x.guide !== null,
  mapIntro: x.mapIntro,
  usageNote: x.usageNote,
  usageNoteDefault: '',
  meaningExcluded: x.meaningExcluded,
  staleDays: x.staleDays,
  longChars: x.longChars,
  maintenanceEvery: x.maintenanceEvery,
  approvalsSince: x.approvalsSince,
})

// Another curator changes the settings of a brain meanwhile (the conflict of a save).
export function settingsBehind(s: Scen, slug: string, change: Partial<FxSettings>): void {
  const x = settingsOf(s, slug)
  Object.assign(x, change)
}

// A curator archives or unarchives a brain (B4: archiving is a curator's; deleting the administration's).
function archiving(c: Ctx, archived: boolean): Answer {
  const b = brainsOf(c.s, c.who).find((x) => x.slug === c.params.slug)
  if (!b) return NO_BRAIN
  if (b.role !== 'curator')
    return err(
      403,
      'forbidden',
      `This needs the curator role in the brain; you are ${b.role}.`,
      'Ask a curator of the brain (Eric) for the curator role.',
    )
  const row = c.s.brains.find((x) => x.slug === b.slug) as Brain
  row.status = archived ? 'archived' : 'active'
  const { role: _r, stats: _s, notifyProposals: _n, createdByYou: _c, ...brain } = row
  return { status: 200, body: { brain } }
}

// The accounts as the administration lists them: people with their role in each brain, then services.
function adminAccounts(s: Scen, who: Account) {
  const seen = who.alone ? s.accounts.filter((a) => a === who || a.joined) : s.accounts
  const people = seen.map((a) => {
    const roles = brainsOf(s, a).map((b) => ({ slug: b.slug, name: b.name, role: b.role }))
    return {
      id: a.id,
      kind: 'person',
      name: a.name,
      email: a.email,
      isAdmin: a.isAdmin,
      canCreateBrains: a.isAdmin || Boolean(a.canCreate),
      canInvite: false,
      status: a.removed ? 'removed' : 'active',
      secondFactor: a.totp,
      brains: roles.length,
      roles,
      lastSeenAt: a === who ? AT : a.id === 'acc_ana' ? '2026-10-28T08:00:00.000Z' : null,
      createdAt: '2026-10-01T10:00:00.000Z',
    }
  })
  // Many people (paging and the filter of the administration).
  if (s.states.get('people') === 'much-data')
    for (let i = 1; i <= 45; i++)
      people.push({
        ...(people[1] ?? people[0]),
        id: `acc_many${i}`,
        name: `Person ${String(i).padStart(2, '0')}`,
        email: `person${i}@example.test`,
        isAdmin: false,
        canCreateBrains: false,
        roles: [],
        brains: 0,
      } as (typeof people)[number])
  if (who.alone) return people
  const services = s.services.map((v) => {
    const roles = v.roles.flatMap((r) => {
      const b = s.brains.find((x) => x.slug === r.slug)
      return b ? [{ slug: b.slug, name: b.name, role: r.role }] : []
    })
    return {
      id: v.id,
      kind: 'service',
      name: v.name,
      email: null,
      isAdmin: false,
      canCreateBrains: v.canCreate,
      canInvite: false,
      status: v.removed ? 'removed' : 'active',
      secondFactor: false,
      brains: roles.length,
      roles,
      mainKeys: s.keys.filter((k) => k.account === v.id && !k.revoked).length,
      lastSeenAt: v.lastSeenAt,
      createdAt: v.createdAt,
    }
  })
  return [...people, ...services]
}

const secretOf = () => `rscb_fx_${randomBytes(12).toString('hex')}`

const CLIENTS = ['Claude Code', 'Codex', 'RSC Factory', 'Cursor']
function sessionsOf(slug: string, n: number) {
  return Array.from({ length: n }, (_, i) => ({
    id: `ses_${slug.replace(/-/g, '')}${String(i + 1).padStart(3, '0')}`,
    who: i % 2 ? 'Ana' : 'Eric',
    // The third: a program that opened no session of its own (no purpose, a raw user agent).
    client: i === 2 ? 'curl/8.7.1' : (CLIENTS[i % CLIENTS.length] ?? null),
    purpose: ['Review the intros of October', 'Fix the onboarding emails', ''][i % 3] ?? '',
    // The one with no purpose is the session of the day a key got by writing without opening one.
    day: i % 3 === 2 ? '2026-10-29' : null,
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

async function rawOf(req: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = []
  for await (const c of req) chunks.push(c as Buffer)
  return Buffer.concat(chunks)
}

async function bodyOf(req: IncomingMessage): Promise<Record<string, unknown>> {
  return parsed(await rawOf(req))
}

function parsed(raw: Buffer): Record<string, unknown> {
  const text = raw.toString('utf8')
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
  sessionRef?: string | null
  summaryEntryId?: string | null
  onBehalf?: { id: string; name: string } | null
  target?: { id: string; label: string }
  client?: string | null
  ref?: string | null
  query?: string | null
  // A service account's key did it; by default when it has a reference (only short keys have one).
  service?: boolean
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
  // Another curator imported a folder: the brain fills and its third step is done.
  if (kind === 'brain.imported') {
    s.life.set(slug, { ...life, imported: true })
    if (b) b.stats = { ...b.stats, pages: Math.max(b.stats.pages, 5), entries: Math.max(b.stats.entries, 4) }
  }
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
    key: { id: o.ref ? 'crd_short' : 'crd_agent', ref: o.ref ?? null, service: o.service ?? o.ref != null },
    target:
      kind === 'search' ? null : (o.target ?? { id: 'ent_fixture', label: 'First thing the agent learnt' }),
    query: kind === 'search' ? (o.query ?? 'retention') : null,
    client: o.client === undefined ? 'claude-code' : o.client,
    sessionRef: o.sessionRef ?? null,
    onBehalf: o.onBehalf ?? null,
    summaryEntryId: kind === 'session.closed' ? (o.summaryEntryId ?? null) : null,
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
    if (a.status === 204) {
      res.writeHead(204, { 'cache-control': 'no-store', ...(a.headers ?? {}) })
      return res.end()
    }
    if (a.raw !== undefined) {
      res.writeHead(a.status, {
        'cache-control': 'no-store',
        'x-content-type-options': 'nosniff',
        ...(a.headers ?? {}),
      })
      return res.end(a.raw)
    }
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
        if (b.service !== undefined) o.service = b.service === true
        if (b.sessionRef !== undefined) o.sessionRef = b.sessionRef as string | null
        if (b.summaryEntryId !== undefined) o.summaryEntryId = b.summaryEntryId as string | null
        if (b.onBehalf !== undefined) o.onBehalf = b.onBehalf as { id: string; name: string } | null
        emit(s, String(b.brain), String(b.kind ?? 'entry.saved'), o)
        return send(res, { status: 200, body: {} })
      }
      // The server ends the open streams of a brain, saying why (a role changed, a key revoked, an error).
      const closing = /^\/__fixture\/scenarios\/([\w]+)\/close$/.exec(url.pathname)
      if (closing && method === 'POST') {
        const s = scenarios.get(closing[1] as string)
        if (!s) return send(res, { status: 404, body: {} })
        const b = await bodyOf(req)
        for (const st of [...s.streams])
          if (st.brain === String(b.brain)) {
            st.res.end(`event: closed\ndata: ${JSON.stringify({ reason: b.reason, message: b.message })}\n\n`)
            s.streams.delete(st)
          }
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
      // Another administrator saves the installation's settings or mail meanwhile (PR25b).
      const adminEdit = /^\/__fixture\/scenarios\/([\w]+)\/admin-edit$/.exec(url.pathname)
      if (adminEdit && method === 'POST') {
        const s = scenarios.get(adminEdit[1] as string)
        if (!s) return send(res, { status: 404, body: {} })
        adminBehind(s, await bodyOf(req))
        return send(res, { status: 200, body: {} })
      }
      // Another curator saves the settings of a brain meanwhile (the conflict of a save, PR25a).
      const settingsEdit = /^\/__fixture\/scenarios\/([\w]+)\/settings-edit$/.exec(url.pathname)
      if (settingsEdit && method === 'POST') {
        const s = scenarios.get(settingsEdit[1] as string)
        if (!s) return send(res, { status: 404, body: {} })
        const b = await bodyOf(req)
        const { brain, ...change } = b
        settingsBehind(s, String(brain ?? 'growth'), change as Partial<FxSettings>)
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
      // An agent reaches the installation: the newest token of the person makes its first request, or a
      // connection made with the standard sign-in appears (the live check of «Connect your agent»).
      const agent = /^\/__fixture\/scenarios\/([\w]+)\/agent$/.exec(url.pathname)
      if (agent && method === 'POST') {
        const s = scenarios.get(agent[1] as string)
        if (!s) return send(res, { status: 404, body: {} })
        const b = await bodyOf(req)
        const account = String(b.account ?? 'acc_eric')
        if (b.via === 'app') {
          s.made += 1
          s.apps.unshift({
            account,
            id: `app_fixture${s.made}`,
            name: String(b.client ?? 'Claude Code'),
            nameNote: 'Declared by the app, not verified.',
            returnsTo: '127.0.0.1',
            brains: s.brains.map((x) => x.slug),
            perm: 'write',
            createdAt: NOW(),
            lastUsedAt: NOW(),
            // requested: false is the moment of the code exchange, before the app's first request.
            lastRequestAt: b.requested === false ? null : NOW(),
            endsAt: new Date(Date.now() + 90 * 86_400_000).toISOString(),
            ended: false,
          })
        } else if (b.via === 'app-request') {
          // `id`: an app already in use asks again; else the one approved that has not asked yet.
          const a = b.id
            ? s.apps.find((x) => x.account === account && x.id === b.id)
            : s.apps.find((x) => x.account === account && x.lastRequestAt === null)
          if (!a) return send(res, { status: 404, body: {} })
          a.lastRequestAt = NOW()
        } else {
          const t = s.tokens.find((x) => x.account === account)
          if (!t) return send(res, { status: 404, body: {} })
          t.lastUsedAt = NOW()
          t.lastClient = String(b.client ?? 'claude-code/2.1.3')
        }
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
      const sid = String(req.headers['x-fixture-scenario'] ?? c.fixture_scenario ?? '')
      const s = scenarios.get(sid) ?? fallback
      // Health says whether an update runs (B7 PR35); while it does, every write is refused as the server does.
      if (url.pathname === '/v1/health')
        return send(res, {
          status: 200,
          body: { ok: true, database: 'ok', maintenance: underMaintenance(s) },
        })
      if (underMaintenance(s) && url.pathname.startsWith('/v1/') && method !== 'GET' && method !== 'HEAD')
        return send(res, MAINTENANCE_REFUSAL)
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
      const raw = await rawOf(req)
      const body = parsed(raw)
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
      send(res, def.run({ s, params: m.params, query: url.searchParams, body, raw, who, web: isWeb }))
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
