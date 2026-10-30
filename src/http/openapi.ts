// The description of the API (spec B5 «La API»: a program can use it without reading the code). It is
// generated from the route table, so no route is left out, with hand-written shapes for the answers a
// program relies on most. Served at GET /v1/openapi.json without a key: it describes, it holds no data.
// The routes and the pinned fields are a contract (CA18, test/api/contract.test.ts).
import type { Route } from './router.ts'

type Schema = Record<string, unknown>
type Op = {
  summary: string
  status?: number
  body?: Schema
  reply?: Schema
  stream?: boolean
  // The answer is an image, not JSON (the logo of the installation).
  image?: boolean
  query?: Record<string, string>
}

const s = (description: string, extra: Schema = {}): Schema => ({ type: 'string', description, ...extra })
const n = (description: string): Schema => ({ type: 'integer', description })
const b = (description: string): Schema => ({ type: 'boolean', description })
const nul = (x: Schema): Schema => ({ ...x, type: [x.type, 'null'] })
const list = (items: Schema, description = ''): Schema => ({ type: 'array', items, description })
// An object whose listed fields are always there (more may be added within v1, none removed).
const obj = (properties: Record<string, Schema>, optional: string[] = []): Schema => ({
  type: 'object',
  properties,
  required: Object.keys(properties).filter((k) => !optional.includes(k)),
})
const NEXT = nul(s('The value to ask for the next page with; null on the last page.'))

const BRAIN = obj({
  id: s('Its id (brn_…).'),
  slug: s('Its name in addresses.'),
  name: s('Display name.'),
  description: s('More about it.'),
  purpose: s('What it is for.'),
  status: s('active or archived.', { enum: ['active', 'archived'] }),
  pendingCuratorEmail: nul(s('The email invited as its first curator, until accepted.')),
  createdAt: s('When.', { format: 'date-time' }),
  updatedAt: s('When it last changed.', { format: 'date-time' }),
})
const BRAIN_ROLE = {
  ...BRAIN,
  properties: { ...(BRAIN.properties as Schema), role: s('Your role through this key.') },
  required: [...(BRAIN.required as string[]), 'role'],
}
const SESSION = obj({
  id: s('Session id (ses_…).'),
  brainId: s('Its brain.'),
  accountId: s('Who opened it.'),
  credentialId: s('With which key.'),
  bound: b('Opened by a service for one of its short keys.'),
  purpose: s('What it is for.'),
  ref: nul(s('External reference.')),
  status: s('open, closed or closed_no_summary.'),
  summaryEntryId: nul(s('The summary entry, once closed with one.')),
  openedAt: s('When.', { format: 'date-time' }),
  lastActivityAt: s('Last write.', { format: 'date-time' }),
  closedAt: nul(s('When.', { format: 'date-time' })),
})
const ENTRY = obj({
  id: s('Entry id (ent_…).'),
  brainId: s('Its brain.'),
  sessionId: s('Its session.'),
  type: s('decision, learning, attempt, correction, preference, fact, step, summary or note.'),
  topic: nul(s('Topic key, for what evolves.')),
  title: s('Title.'),
  content: s('The entry, already redacted.'),
  revision: n('Its revision, for corrections against it.'),
  state: s('active, forgotten or purged.'),
  createdAt: s('When.', { format: 'date-time' }),
  updatedAt: s('When it last changed.', { format: 'date-time' }),
})
const ENTRY_IN = obj(
  {
    type: s('decision, learning, attempt, preference, fact, step, summary or note.'),
    title: s('A short title.', { maxLength: 260 }),
    content: s('The entry. Private parts in <private>…</private>.', { maxLength: 32000 }),
    topic: s('A topic key; saving the same topic revises it.'),
    appliesTo: s('Who or what it applies to.'),
    tags: list(s('A tag.')),
    refs: list(s('A file, link or id.')),
    reviewAfter: s('A day to review it.', { format: 'date' }),
    expiresAt: s('A day after which it no longer holds.', { format: 'date' }),
    sessionId: s('The session it belongs to.'),
    requestKey: s('Repeating the request with the same key returns the same receipt.'),
  },
  ['topic', 'appliesTo', 'tags', 'refs', 'reviewAfter', 'expiresAt', 'sessionId', 'requestKey'],
)
const RECEIPT = obj({
  entryId: s('The entry written or revised.'),
  revision: n('Its revision.'),
  at: s('When.', { format: 'date-time' }),
  deduplicated: b('The same entry was already there: nothing new was written.'),
  repeatCount: n('How many times it was saved.'),
  redactions: n('How many secrets were struck out.'),
  similar: list({ type: 'object' }, 'Similar entries to look at.'),
})
const HIT = obj({
  kind: s('entry or page.'),
  id: s('Its id.'),
  brain: s('Its brain (slug).'),
  title: s('Title.'),
  snippet: s('Where it matched.'),
  at: s('When it was written or changed.', { format: 'date-time' }),
})
export const EVENT = obj(
  {
    id: s('The event id: send it back as Last-Event-ID to resume.'),
    at: s('When.', { format: 'date-time' }),
    brain: s('The brain (slug).'),
    kind: s(
      'session.opened, session.closed, entry.saved, entry.revised, entry.repeated, entry.changed, search, read, proposal.submitted, proposal.withdrawn, proposal.decided, wiki.changed; and gap.',
    ),
    who: nul(obj({ id: s('Account id.'), name: s('Account name.') })),
    key: nul(obj({ id: s('Credential id.'), ref: nul(s('The external reference of a short key.')) })),
    target: nul(obj({ id: s('What it touches.'), label: nul(s('Its title or address.')) })),
    query: nul(s('For a search: the text searched, already redacted.')),
  },
  [],
)
const PAGE = obj({ items: list({ type: 'object' }), next: NEXT })

const ACCOUNT_SIGNED_IN = obj({
  id: s('Account id.'),
  name: s('Name.'),
  email: s('Email.'),
  isAdmin: b('An administrator of the installation.'),
})

const HAND: Record<string, Op> = {
  'GET /v1/branding': {
    summary:
      'The name and logo of the installation, and whether the first-time setup is still to do (no key; answers before the setup).',
    reply: obj({
      name: s('The name of the installation; empty until the first-time setup.'),
      logo: nul({
        ...obj({
          url: s('Where the logo is (GET /v1/branding/logo).'),
          updatedAt: s('When it last changed.', { format: 'date-time' }),
        }),
        type: ['object', 'null'],
      }),
      setupRequired: b('The first-time setup is still to do: the web leads to it.'),
      canSendMail: b(
        'The installation can send email (reset links, invitations); without it an administrator makes reset links by hand.',
      ),
    }),
  },
  'GET /v1/branding/logo': {
    summary: 'The logo of the installation (no key). 404 no_logo when there is none.',
    image: true,
  },
  'GET /v1/setup': {
    summary: 'Whether the first-time setup can run from this connection (404 setup_done once done).',
    query: { publicUrl: 'The address you are about to give, to warn if it is not safe.' },
    reply: obj({
      done: b('Always false: once done, this answers 404.'),
      connection: obj({ encrypted: b('Over TLS.'), local: b('From this machine.') }),
      warning: nul(s('Why the address would be unsafe for passwords.')),
    }),
  },
  'POST /v1/setup': {
    summary: 'The first-time setup (the Brain web only): name, address and the first administrator.',
    status: 201,
    body: obj({
      name: s('The name of the installation.', { maxLength: 80 }),
      publicUrl: s('The address people open.'),
      admin: obj({ name: s('Your name.'), email: s('Your email.'), password: s('12 to 200 characters.') }),
    }),
    reply: obj({
      done: b('True.'),
      publicUrl: s('The address, as stored.'),
      warning: nul(s('Why the address is unsafe for passwords, if it is.')),
      adminId: s('The administrator account.'),
    }),
  },
  'POST /v1/auth/login': {
    summary: 'Sign in to the web (the Brain web only): sets the session cookie.',
    body: obj(
      { email: s('Email.'), password: s('Password.'), code: s('The 6 digits of the authenticator app.') },
      ['code'],
    ),
    reply: obj({ account: ACCOUNT_SIGNED_IN }),
  },
  'POST /v1/auth/logout': {
    summary: 'Sign out of this web session.',
    reply: obj({ signedOut: b('True.') }),
  },
  'POST /v1/auth/reset': {
    summary:
      'Ask for a password reset link by email; the answer is the same whether the email exists or not.',
    status: 202,
    body: obj({ email: s('Email.') }),
    reply: obj({ message: s('What happens next.') }),
  },
  'POST /v1/auth/reset/look': {
    summary:
      'Whether a reset link still works, without spending it (the token travels in the body). Names no account.',
    body: obj({ token: s('The token after #token= in the link.') }),
    reply: obj({ valid: b('True; a link that does not work is refused with link_invalid.') }),
  },
  'POST /v1/auth/reset/confirm': {
    summary: 'Choose a new password with the token of a reset link.',
    body: obj({ token: s('The token after #token= in the link.'), password: s('12 to 200 characters.') }),
    reply: obj({ reset: b('True.') }),
  },
  'POST /v1/invitations/look': {
    summary: 'What an invitation offers, before accepting it (the token travels in the body).',
    body: obj({ token: s('The token after #token= in the link.') }),
    reply: obj({
      invitation: obj({
        email: s('Who it is for.'),
        installation: s('The name of the installation.'),
        brains: list(obj({ slug: s('Slug.'), name: s('Name.'), role: s('reader, contributor or curator.') })),
        isAdmin: b('It makes you an administrator.'),
        expiresAt: s('Until when it works.', { format: 'date-time' }),
      }),
    }),
  },
  'POST /v1/invitations/accept': {
    summary: 'Accept an invitation (the Brain web only): your account, your roles and a web session.',
    status: 201,
    body: obj({ token: s('The token.'), name: s('Your name.'), password: s('12 to 200 characters.') }),
    reply: obj({
      account: ACCOUNT_SIGNED_IN,
      brains: list(
        obj({ slug: s('Slug.'), name: s('Name.'), role: s('reader, contributor or curator.') }),
        'The brains you joined, with your role in each.',
      ),
    }),
  },
  'GET /v1/health': { summary: 'Whether the server answers.', reply: obj({ ok: b('Always true.') }) },
  'GET /v1/openapi.json': { summary: 'This description.', reply: { type: 'object' } },
  'GET /v1/me': {
    summary: 'Who this key is.',
    reply: obj({
      account: obj({
        id: s('Account id.'),
        kind: s('person or service.'),
        name: s('Name.'),
        email: nul(s('Email.')),
        isAdmin: b('Administration rights travel with this key.'),
      }),
      key: obj({
        id: s('Credential id.'),
        kind: s('web, token, app, main or short.'),
        perm: s('read or write.'),
        ref: nul(s('External reference of a short key.')),
        agent: nul(s('Agent of a short key.')),
      }),
    }),
  },
  'GET /v1/brains': { summary: 'The brains this key can use.', reply: obj({ brains: list(BRAIN_ROLE) }) },
  'POST /v1/brains': {
    summary: 'Create a brain (with the right to create brains).',
    status: 201,
    body: obj(
      {
        slug: s('Its name: lowercase letters, digits and hyphens.'),
        name: s('Display name.'),
        purpose: s('What it is for.'),
        description: s('More about it.'),
        firstCurator: s('For a service account: the email of its first curator.'),
      },
      ['name', 'purpose', 'description', 'firstCurator'],
    ),
    reply: obj({ brain: BRAIN }),
  },
  'GET /v1/brains/{slug}': { summary: 'One brain.', reply: obj({ brain: BRAIN_ROLE }) },
  'POST /v1/brains/{slug}/sessions': {
    summary: 'Open a session (a service: for one of its short keys, with forKey).',
    status: 201,
    body: obj(
      { purpose: s('What it is for.'), ref: s('External reference.'), forKey: s('A short key id.') },
      ['purpose', 'ref', 'forKey'],
    ),
    reply: obj({ session: SESSION }),
  },
  'GET /v1/brains/{slug}/sessions': {
    summary: 'Recent sessions.',
    reply: obj({ items: list(SESSION), total: n('How many.'), next: NEXT }),
  },
  'GET /v1/me/sessions': {
    summary:
      'The open sessions of this key, with their brain (API only: the reminder at the end of an agent session asks it).',
    reply: obj({
      items: list({
        ...SESSION,
        properties: { ...(SESSION.properties as Schema), brain: s('The slug of its brain.') },
        required: [...(SESSION.required as string[]), 'brain'],
      }),
    }),
  },
  'GET /v1/connect': {
    summary:
      'The connection kit: per agent, the standard sign-in, a config block with a token placeholder (never a secret), the optional reminder and the check.',
    query: {
      agent: 'Only this agent: claude-code, codex, opencode, cursor or other.',
      brain: 'Name this brain in the check and the start hook.',
    },
    reply: obj({
      mcpUrl: s('The MCP address of this installation.'),
      tokenEnv: s('The environment variable the config blocks read the token from.'),
      tokenPlaceholder: s('The text in the blocks that the token replaces.'),
      agents: list(
        obj({
          id: s('claude-code, codex, opencode, cursor or other.'),
          name: s('Display name.'),
          signIn: nul({
            type: 'object',
            description: 'Connecting with the standard sign-in (only the address).',
          }),
          token: { type: 'object', description: 'Connecting with a token: a note and config blocks.' },
          reminder: nul({
            type: 'object',
            description: 'The optional reminder: hooks, or a prompt and instructions text.',
          }),
          check: s('How to check that it works.'),
        }),
      ),
    }),
  },
  'POST /v1/brains/{slug}/entries': {
    summary: 'Save an entry; returns its receipt.',
    status: 201,
    body: ENTRY_IN,
    reply: obj({ receipt: RECEIPT }),
  },
  'GET /v1/entries/{id}': {
    summary: 'One entry (history=1 for its revisions).',
    query: { history: '1 for its revisions.' },
    reply: obj({ entry: ENTRY, history: list({ type: 'object' }) }, ['history']),
  },
  'GET /v1/search': {
    summary: 'Search entries and pages of the brains this key can read.',
    query: {
      q: 'What to look for.',
      brains: 'Comma-separated brains.',
      in: 'entries, pages or both.',
      types: 'Comma-separated entry types.',
      tags: 'Comma-separated tags.',
      prefix: 'Only under this topic or address.',
      from: 'From this day.',
      to: 'Up to this day.',
      neighbours: 'true for the pages linked to the results.',
      limit: 'At most this many (1–50).',
      offset: 'Skip this many (the "next" of the previous page).',
    },
    reply: obj({ items: list(HIT), next: nul(n('The offset of the next page.')), note: s('A hint.') }, [
      'note',
    ]),
  },
  'GET /v1/brains/{slug}/context': {
    summary: 'The start context of a brain, for a task and size.',
    query: { task: 'What you are about to do.', max: 'Characters (4000–128000).' },
    reply: obj({
      text: s('The context.'),
      chars: n('Its length.'),
      included: { type: 'object' },
      omitted: { type: 'object' },
      max: n('The size it was built for.'),
    }),
  },
  'GET /v1/brains/{slug}/proposals': {
    summary: 'Proposals of a brain (mine=1 for yours).',
    query: { status: 'A status, or all.', mine: '1 for yours only.', cursor: 'The next page.' },
    reply: PAGE,
  },
  'POST /v1/brains/{slug}/proposals': {
    summary: 'Send a wiki proposal for a person to approve.',
    status: 201,
    body: obj(
      {
        title: s('What it changes.'),
        reason: s('Why.'),
        ops: list({ type: 'object' }, 'The operations.'),
        collected: list(s('Entry id.')),
        supersedes: s('A pending proposal of yours it replaces.'),
      },
      ['reason', 'collected', 'supersedes'],
    ),
    reply: { type: 'object' },
  },
  'GET /v1/brains/{slug}/trail': {
    summary: 'What was searched and read, by ref, session or page.',
    query: { ref: 'External reference.', session: 'Session id.', page: 'Page address.', after: 'Line id.' },
    reply: PAGE,
  },
  'GET /v1/brains/{slug}/events': {
    summary:
      'Live events of a brain (Server-Sent Events). Last-Event-ID (or ?lastEventId=) replays up to 24 hours.',
    query: { lastEventId: 'Resume after this event (or the Last-Event-ID header).' },
    stream: true,
  },
  'GET /v1/admin/settings': {
    summary: 'The settings of the installation (administration).',
    reply: obj({
      name: s('Name.'),
      publicUrl: nul(s('Address.')),
      curatorsInvite: b('Curators may invite.'),
      rateLimit: n('Requests per minute of each key.'),
    }),
  },
  'PUT /v1/admin/settings': {
    summary: 'Change the settings of the installation (administration).',
    body: obj(
      {
        name: s('Name.'),
        curatorsInvite: b('Curators may invite.'),
        rateLimit: n('Requests per minute of each key (1–100000).'),
      },
      ['name', 'curatorsInvite', 'rateLimit'],
    ),
  },
}

const ERROR = obj({
  error: obj(
    {
      code: s('A stable code.'),
      message: s('What happened.'),
      howToProceed: s('What to do next.'),
      retryAfter: n('Seconds to wait (rate_limited).'),
      current: { description: 'The current version, after a conflict.' },
      problems: { description: 'Everything wrong with a request checked as a whole.' },
    },
    ['retryAfter', 'current', 'problems'],
  ),
})

const PUBLIC_OPS = new Set(['GET /v1/health'])

function operationId(method: string, path: string): string {
  const words = path
    .replace(/^\/v1\//, '')
    .split(/[/.-]/)
    .filter(Boolean)
    .map((w) => (w.startsWith('{') ? `By${w.slice(1, -1)}` : w))
  return [method.toLowerCase(), ...words.map((w) => w[0]?.toUpperCase() + w.slice(1))].join('')
}

export function openapi(routes: Route[], serverUrl: string | null): Schema {
  const ops: Array<{ method: string; path: string; public: boolean }> = [
    { method: 'GET', path: '/v1/health', public: true },
    ...routes
      .filter((r) => r.path.startsWith('/v1/'))
      .map((r) => ({
        method: r.method,
        path: r.path.replace(/[:*](\w+)/g, '{$1}'),
        public: Boolean(r.public),
      })),
  ]
  const paths: Record<string, Record<string, Schema>> = {}
  for (const o of ops) {
    const key = `${o.method} ${o.path}`
    const hand = HAND[key]
    const params = [...o.path.matchAll(/\{(\w+)\}/g)].map((m) => ({
      name: m[1],
      in: 'path',
      required: true,
      schema: { type: 'string' },
      ...(m[1] === 'address' ? { description: 'A page address; it may hold slashes.' } : {}),
    }))
    const query = Object.entries(hand?.query ?? {}).map(([name, description]) => ({
      name,
      in: 'query',
      required: false,
      description,
      schema: { type: 'string' },
    }))
    const ok = hand?.image
      ? {
          description: 'The image; its type comes from its first bytes (PNG, WebP or JPEG).',
          content: Object.fromEntries(
            ['image/png', 'image/webp', 'image/jpeg'].map((t) => [
              t,
              { schema: { type: 'string', format: 'binary' } },
            ]),
          ),
        }
      : hand?.stream
        ? {
            description: 'A stream of events: "id:", "event:" and "data:" lines; "data" is an Event.',
            content: { 'text/event-stream': { schema: { $ref: '#/components/schemas/Event' } } },
          }
        : {
            description: hand ? 'Success.' : 'Success (201 when something was created).',
            content: { 'application/json': { schema: hand?.reply ?? { type: 'object' } } },
          }
    const op: Schema = {
      operationId: operationId(o.method, o.path),
      summary: hand?.summary ?? `${o.method} ${o.path}`,
      ...(params.length || query.length ? { parameters: [...params, ...query] } : {}),
      ...(hand?.body
        ? { requestBody: { required: true, content: { 'application/json': { schema: hand.body } } } }
        : ['POST', 'PUT', 'PATCH'].includes(o.method)
          ? { requestBody: { content: { 'application/json': { schema: { type: 'object' } } } } }
          : {}),
      responses: {
        [String(hand?.status ?? 200)]: ok,
        default: {
          description: 'A refusal: what happened and how to proceed.',
          content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } },
        },
      },
      ...(o.public || PUBLIC_OPS.has(key) ? { security: [] } : {}),
    }
    paths[o.path] = { ...(paths[o.path] ?? {}), [o.method.toLowerCase()]: op }
  }
  return {
    openapi: '3.1.0',
    info: {
      title: 'RSC Brain API',
      version: '1',
      description:
        'The same operations as the MCP tools, with the same keys and permissions. Every refusal says what happened and how to proceed. Each key may make a limited number of requests per minute (429 with Retry-After beyond it). No answer passes 256000 characters: lists go by pages, and an answer that would pass the limit is cut and says so.',
    },
    servers: serverUrl ? [{ url: serverUrl }] : [],
    security: [{ bearer: [] }],
    paths,
    components: {
      securitySchemes: {
        bearer: { type: 'http', scheme: 'bearer', description: 'A key of this installation.' },
      },
      schemas: { Error: ERROR, Event: EVENT },
    },
  }
}
