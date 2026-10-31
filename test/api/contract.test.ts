// Spec B5 «La API» and CA18: version 1 of the API is a contract. The routes of /v1 and the main fields
// of their answers are pinned here: removing or renaming one fails this test, so a breaking change has
// to become /v2 and leave /v1 working. The description at /v1/openapi.json is generated from the same
// route table, so it cannot leave a route out, and it documents the pinned fields.
import assert from 'node:assert/strict'
import { after, before, describe, it } from 'node:test'
import { hashPassword } from '../../src/auth/password.ts'
import { stepOf, totpAt } from '../../src/auth/totp.ts'
import { ROUTES } from '../../src/http/app.ts'
import { skipPg } from '../helpers/pg.ts'
import { type Call, type World, world } from '../helpers/world.ts'
import { ERROR_STATUS, V1 } from './v1.ts'

const WEB = { 'x-requested-with': 'rsc-brain-web' }
const PW = 'correct horse battery staple'
const tokenOf = (link: unknown) => /#token=([A-Za-z0-9_-]+)/.exec(String(link))?.[1] ?? ''

// The fields a program relies on in the main answers. `[]` marks the items of a list.
const SHAPES: Record<string, Record<string, string[]>> = {
  'GET /v1/me': {
    account: ['id', 'kind', 'name', 'email', 'isAdmin', 'canCreateBrains', 'canInvite', 'totp'],
    key: ['id', 'kind', 'perm', 'ref', 'agent'],
    installation: ['name', 'factoryUrl'],
  },
  'POST /v1/brains': {
    brain: ['id', 'slug', 'name', 'description', 'purpose', 'status', 'createdAt', 'updatedAt'],
  },
  'GET /v1/brains': {
    'brains[]': ['id', 'slug', 'name', 'purpose', 'status', 'role', 'stats', 'notifyProposals'],
    'brains[].stats': ['pages', 'entries', 'uncompiled', 'conflicts', 'pendingProposals', 'lastActivityAt'],
  },
  // Home and the overview of a brain (spec B6, PR18: G5, G7, G8).
  'GET /v1/brains/{slug}': {
    brain: ['id', 'slug', 'name', 'purpose', 'status', 'role', 'stats', 'notifyProposals'],
    'brain.stats': ['pages', 'entries', 'uncompiled', 'conflicts', 'pendingProposals', 'lastActivityAt'],
  },
  'GET /v1/brains/{slug}/overview': {
    '': ['cursor', 'stats', 'todaySessions', 'pending', 'health', 'firstSteps'],
    stats: ['pages', 'entries', 'uncompiled', 'conflicts', 'pendingProposals', 'lastActivityAt'],
    'todaySessions[]': [
      'id',
      'who',
      'client',
      'purpose',
      'ref',
      'status',
      'entries',
      'summary',
      'openedAt',
      'lastActivityAt',
    ],
    'pending[]': ['id', 'title', 'agent', 'opCount', 'old', 'createdAt'],
    health: ['orphans', 'broken', 'conflicts', 'stale', 'unavailableSources', 'long', 'similarTitles'],
    firstSteps: ['agentConnected', 'firstEntry', 'imported'],
  },
  // Inviting people and making reset links from the web (spec B4 through B6, PR18).
  'POST /v1/invitations': {
    'invitations[]': ['id', 'email', 'link', 'expiresAt', 'mailed', 'mailError'],
  },
  'GET /v1/invitations': {
    'invitations[]': ['id', 'email', 'status', 'brains', 'isAdmin', 'invitedBy', 'createdAt', 'expiresAt'],
  },
  'POST /v1/invitations/{id}/resend': {
    invitation: ['id', 'email', 'link', 'expiresAt', 'mailed', 'mailError'],
  },
  'DELETE /v1/invitations/{id}': {
    '': ['revoked'],
  },
  'GET /v1/admin/accounts': {
    'accounts[]': [
      'id',
      'kind',
      'name',
      'email',
      'isAdmin',
      'canCreateBrains',
      'status',
      'brains',
      'lastSeenAt',
      'createdAt',
    ],
  },
  'POST /v1/admin/accounts/{id}/reset-link': {
    '': ['link', 'expiresAt'],
  },
  'GET /v1/admin/brains': {
    'brains[]': ['slug', 'name', 'status', 'members', 'curators', 'pendingCurator', 'youAreMember'],
  },
  'POST /v1/brains/{slug}/sessions': {
    session: ['id', 'brainId', 'purpose', 'ref', 'status', 'openedAt', 'closedAt'],
  },
  'POST /v1/brains/{slug}/entries': {
    receipt: ['entryId', 'revision', 'at', 'deduplicated', 'repeatCount', 'redactions', 'similar'],
  },
  'GET /v1/entries/{id}': {
    // Review of PR20: the session it is in, named by its purpose.
    '': ['entry', 'relations', 'session'],
    session: ['id', 'purpose', 'day'],
    entry: [
      'id',
      'brainId',
      'sessionId',
      'type',
      'topic',
      'title',
      'content',
      'appliesTo',
      'tags',
      'refs',
      'authorId',
      'ref',
      'revision',
      'repeatCount',
      'pinned',
      'reviewAfter',
      'expiresAt',
      'state',
      'supersededBy',
      'compiled',
      'createdAt',
      'updatedAt',
      // The journal in the web (spec B6, PR20): who wrote it and with what, and who forgot it.
      'author',
      'onBehalf',
      'client',
      'forgotten',
    ],
    'entry.author': ['id', 'name'],
    'relations[]': ['id', 'kind', 'status', 'direction', 'other', 'reason', 'by', 'createdAt'],
    'relations[].other': ['id', 'title', 'type', 'state'],
  },
  'GET /v1/search': {
    '': ['items', 'next'],
    'items[]': ['kind', 'id', 'brain', 'title', 'snippet', 'at'],
  },
  'GET /v1/brains/{slug}/context': {
    '': ['text', 'chars', 'included', 'omitted', 'max'],
  },
  'GET /v1/brains/{slug}/proposals': {
    '': ['items', 'next'],
  },
  // The inbox of the web (PR21): a page of proposals with who proposed and decided, and the count of each
  // status on the first page; the review a person reads before deciding; what a decision answers.
  'GET /v1/brains/{slug}/proposals +inbox': {
    '': ['items', 'next', 'total'],
    'items[]': [
      'id',
      'title',
      'reason',
      'status',
      'old',
      'agent',
      'authorId',
      'authorName',
      'decidedBy',
      'decidedByName',
      'decidedAt',
      'comment',
      'createdAt',
      'opCount',
    ],
    counts: ['pending', 'approved', 'partially_approved', 'returned', 'withdrawn', 'superseded'],
  },
  'GET /v1/proposals/{id}/review': {
    '': ['proposal', 'fingerprint', 'ops', 'warnings', 'canDecide'],
    proposal: ['id', 'title', 'reason', 'status', 'old', 'agent', 'authorName', 'decidedByName', 'collected'],
    'ops[]': ['index', 'op', 'status', 'corrected', 'before', 'after', 'dependsOn', 'stale', 'warnings'],
  },
  'POST /v1/proposals/{id}/approve': {
    '': ['proposal', 'ops', 'applied'],
    proposal: ['id', 'status', 'decidedBy', 'decidedByName', 'decidedAt', 'comment'],
    'ops[]': ['index', 'op', 'status'],
    'applied[]': ['pageId', 'address', 'revision'],
  },
  'POST /v1/proposals/{id}/return': {
    '': ['proposal', 'ops', 'applied'],
    proposal: ['id', 'status', 'decidedBy', 'decidedByName', 'decidedAt', 'comment'],
  },
  'GET /v1/brains/{slug}/trail': {
    '': ['items', 'next'],
  },
  'GET /v1/connect': {
    '': ['mcpUrl', 'tokenEnv', 'tokenPlaceholder', 'agents'],
    'agents[]': ['id', 'name', 'signIn', 'token', 'reminder', 'check'],
  },
  'GET /v1/me/sessions': {
    'items[]': ['id', 'brainId', 'brain', 'status', 'openedAt', 'lastActivityAt'],
  },
  'GET /v1/branding': {
    '': ['name', 'logo', 'setupRequired', 'canSendMail'],
  },
  // The screens before a session (spec B6, PR17): the web's fixture answers them in CI, so the real
  // server's answers are pinned here (plan risk 2: a fixture that drifts lets CI pass with the web broken).
  'GET /v1/setup': {
    '': ['done', 'connection', 'warning'],
    connection: ['encrypted', 'local'],
  },
  'POST /v1/setup': {
    '': ['done', 'publicUrl', 'warning', 'adminId'],
  },
  'POST /v1/auth/login': {
    account: ['id', 'name', 'email', 'isAdmin'],
  },
  // The second step: signing in with the authenticator code answers the same.
  'POST /v1/auth/login +code': {
    account: ['id', 'name', 'email', 'isAdmin'],
  },
  'POST /v1/auth/logout': {
    '': ['signedOut'],
  },
  'POST /v1/invitations/look': {
    invitation: ['email', 'installation', 'brains', 'isAdmin', 'expiresAt'],
  },
  'POST /v1/invitations/accept': {
    '': ['account', 'brains'],
    account: ['id', 'name', 'email', 'isAdmin'],
    'brains[]': ['slug', 'name', 'role'],
  },
  'POST /v1/auth/reset': {
    '': ['message'],
  },
  'POST /v1/auth/reset/look': {
    '': ['valid'],
  },
  'POST /v1/auth/reset/confirm': {
    '': ['reset'],
  },
  // The journal in the web (spec B6, PR20; plan G12): the fixture answers these in CI.
  'GET /v1/brains/{slug}/sessions': {
    // facets come with the first page only (not required by the description), and are pinned below.
    '': ['items', 'total', 'next', 'liveFrom'],
    'items[]': [
      'id',
      'brainId',
      'purpose',
      'ref',
      'status',
      'day',
      'client',
      'author',
      'entries',
      'summary',
      'openedAt',
      'lastActivityAt',
      'closedAt',
      // Review of PR20: the entries of it forgotten since, so its count of entries never drops unexplained.
      'forgotten',
    ],
    'items[].author': ['id', 'name'],
    facets: ['clients', 'authors'],
  },
  'GET /v1/brains/{slug}/members': {
    '': ['members', 'former', 'pendingCurator'],
    'members[]': ['accountId', 'kind', 'name', 'email', 'role'],
  },
  'GET /v1/sessions/{id}': {
    session: [
      'id',
      'purpose',
      'ref',
      'status',
      'day',
      'client',
      'author',
      'entries',
      'forgotten',
      'summary',
      'openedAt',
    ],
  },
  'GET /v1/brains/{slug}/entries': {
    '': ['items', 'total', 'next'],
    'items[]': [
      'id',
      'type',
      'title',
      'content',
      'tags',
      'state',
      'pinned',
      'revision',
      'createdAt',
      // Review of PR20: an open conflict about it, for its badge in a session.
      'conflict',
    ],
  },
  'GET /v1/entries/{id} +history': {
    'history[]': [
      'revision',
      'type',
      'title',
      'content',
      'appliesTo',
      'tags',
      'refs',
      'authorId',
      'authorName',
      'createdAt',
    ],
  },
  'POST /v1/brains/{slug}/corrections': {
    receipt: ['entryId', 'revision', 'at', 'deduplicated', 'repeatCount', 'redactions', 'similar'],
  },
  'PATCH /v1/entries/{id}': {
    entry: ['id', 'type', 'title', 'content', 'revision', 'state', 'updatedAt'],
  },
  'POST /v1/entries/{id}/forget': { entry: ['id', 'state', 'revision'] },
  'POST /v1/entries/{id}/recover': { entry: ['id', 'state', 'revision'] },
  'POST /v1/entries/{id}/pin': { entry: ['id', 'pinned'] },
  'POST /v1/entries/{id}/unpin': { entry: ['id', 'pinned'] },
  'POST /v1/entries/{id}/schedule': { entry: ['id', 'reviewAfter', 'expiresAt'] },
  'POST /v1/brains/{slug}/relations': {
    relation: ['id', 'fromId', 'toId', 'kind', 'status', 'reason', 'createdBy', 'createdAt'],
  },
  'GET /v1/brains/{slug}/conflicts': {
    '': ['conflicts', 'total', 'next'],
    'conflicts[]': ['relation', 'from', 'to', 'why'],
    'conflicts[].relation': ['id', 'fromId', 'toId', 'kind', 'status', 'reason', 'createdBy', 'createdAt'],
    'conflicts[].from': [
      'id',
      'type',
      'title',
      'content',
      'state',
      'createdAt',
      'author',
      'client',
      'session',
    ],
    'conflicts[].from.session': ['id', 'purpose', 'day'],
  },
  'GET /v1/brains/{slug}/forgotten': {
    '': ['items', 'total', 'next'],
    'items[]': ['id', 'type', 'title', 'content', 'state', 'author', 'forgotten'],
    'items[].forgotten': ['by', 'reason', 'at'],
  },
  'GET /v1/brains/{slug}/to-review': {
    '': ['items', 'total', 'next'],
    'items[]': ['id', 'type', 'title', 'content', 'reviewAfter', 'author'],
  },
  // The wiki in the web (spec B6, PR19): the fixture answers these in CI, so the real answers are pinned.
  'GET /v1/brains/{slug}/wiki/pages': {
    '': ['items', 'next', 'total'],
    'items[]': ['address', 'title', 'type', 'status', 'tags', 'in', 'out', 'updatedAt'],
  },
  'GET /v1/brains/{slug}/wiki/map': {
    '': ['intro', 'groups', 'count'],
    'groups[]': ['type', 'area', 'pages'],
    'groups[].pages[]': ['address', 'title', 'summary', 'tags', 'status'],
  },
  'GET /v1/brains/{slug}/wiki/decisions': {
    'decisions[]': ['address', 'title', 'summary', 'status', 'createdAt', 'updatedAt'],
  },
  'GET /v1/brains/{slug}/wiki/log': {
    '': ['items', 'next', 'total'],
    'items[]': ['id', 'at', 'actorId', 'actorName', 'kind', 'proposalId', 'summary', 'reason', 'pages'],
  },
  'GET /v1/brains/{slug}/pages/{address}': {
    page: [
      'id',
      'address',
      'type',
      'title',
      'summary',
      'body',
      'tags',
      'status',
      'supersededBy',
      'revision',
      'createdAt',
      'updatedAt',
    ],
    links: ['out', 'in'],
    'links.out[]': ['kind', 'address', 'pageId', 'title', 'state'],
    'sources[]': ['title'],
    lastChange: ['revision', 'authorId', 'authorName', 'at'],
    // Review of PR20: the corrections in force about the page («Something wrong here?»).
    'corrections[]': ['id', 'title', 'appliesTo', 'author', 'createdAt'],
  },
  'GET /v1/brains/{slug}/pages/{address} +history': {
    'history[]': [
      'revision',
      'address',
      'title',
      'status',
      'kind',
      'change',
      'restoredFrom',
      'reason',
      'authorId',
      'authorName',
      'createdAt',
    ],
  },
  'GET /v1/brains/{slug}/pages/{address} +compare': {
    a: ['revision', 'title', 'summary', 'body', 'tags', 'sources', 'links', 'authorName', 'createdAt'],
    b: ['revision', 'title', 'summary', 'body', 'tags', 'sources', 'links', 'authorName', 'createdAt'],
  },
  'PATCH /v1/brains/{slug}/pages/{address}': {
    '': ['revised', 'page'],
    'revised[]': ['pageId', 'address', 'revision'],
    page: ['page', 'links', 'sources'],
  },
  'POST /v1/brains/{slug}/wiki/changes': {
    '': ['revised', 'page'],
    'revised[]': ['pageId', 'address', 'revision'],
  },
}

type Json = Record<string, unknown>
type Schema = { type?: string; properties?: Record<string, Schema>; required?: string[]; items?: Schema }

// `where` walks down: "brains[].stats" is the stats of the first brain.
function fieldsAt(body: Json, where: string): Json {
  if (where === '') return body
  let at: Json = body
  for (const part of where.split('.')) {
    const list = part.endsWith('[]')
    const v = at[list ? part.slice(0, -2) : part]
    const one = list ? (v as Json[])[0] : v
    assert.ok(one && typeof one === 'object', `no "${where}" in ${JSON.stringify(body).slice(0, 300)}`)
    at = one as Json
  }
  return at
}

function opOf(paths: Record<string, Record<string, Json>>, path: string, method: string): Json {
  const op = paths[path]?.[method]
  assert.ok(op, `the description has no ${method} ${path}`)
  return op
}

function schemaAt(s: Schema, where: string): Schema {
  if (where === '') return s
  let at = s
  for (const part of where.split('.')) {
    const list = part.endsWith('[]')
    const p = at.properties?.[list ? part.slice(0, -2) : part]
    assert.ok(p, `the description has no "${where}"`)
    at = (list ? p.items : p) as Schema
  }
  return at
}

describe('the v1 contract', { skip: skipPg }, () => {
  let w: World
  // An installation whose first-time setup is still to do.
  let fresh: World
  let eric: { id: string; key: string }
  let doc: Json

  before(async () => {
    w = await world()
    fresh = await world({ fresh: true })
    eric = await w.person('Eric')
  })
  after(async () => {
    await w.close()
    await fresh.close()
  })

  const login = (body: Json, headers: Record<string, string> = WEB) =>
    w.raw('POST', '/v1/auth/login', { headers, body })
  const withPassword = async (name: string, o: { isAdmin?: boolean } = {}) => {
    const p = await w.person(name, o)
    await w.db.query('UPDATE accounts SET password_hash = $2 WHERE id = $1', [p.id, await hashPassword(PW)])
    const email = String((await w.db.one('SELECT email FROM accounts WHERE id = $1', [p.id]))?.email)
    return { ...p, email }
  }
  // A person whose sign-in asks for the authenticator code; `code()` gives the next unused one.
  const withCode = async (name: string) => {
    const p = await withPassword(name)
    const web = await w.web(p.id)
    const secret = String((await w.callWeb(web, 'POST', '/v1/me/totp')).body.secret)
    await w.callWeb(web, 'POST', '/v1/me/totp/confirm', { code: totpAt(secret, stepOf(w.now)) })
    return {
      ...p,
      code: () => {
        w.advance(30_000)
        return totpAt(secret, stepOf(w.now))
      },
    }
  }

  it('the description is public JSON (OpenAPI 3.1) and needs no key: it holds no data', async () => {
    const r = await w.raw('GET', '/v1/openapi.json')
    assert.equal(r.status, 200, r.text)
    assert.match(r.headers.get('content-type') ?? '', /application\/json/)
    doc = r.body
    assert.equal(doc.openapi, '3.1.0')
    assert.equal((doc.info as Json).title, 'rsc-brain API')
    assert.equal((doc.servers as Json[])[0]?.url, 'http://localhost')
  })

  it('CA18: the operations of v1 are exactly the pinned ones, and the description covers every route', async () => {
    const paths = doc.paths as Record<string, Record<string, Json>>
    const described = Object.entries(paths)
      .flatMap(([p, ops]) => Object.keys(ops).map((m) => `${m.toUpperCase()} ${p}`))
      .sort()
    assert.deepEqual(described, [...V1].sort())
    const routed = ROUTES.filter((r) => r.path.startsWith('/v1/'))
      .map((r) => `${r.method} ${r.path.replace(/[:*](\w+)/g, '{$1}')}`)
      .concat('GET /v1/health')
      .sort()
    assert.deepEqual(routed, [...V1].sort())
    for (const [p, ops] of Object.entries(paths)) {
      for (const [m, op] of Object.entries(ops)) {
        const where = `${m.toUpperCase()} ${p}`
        assert.ok(op.operationId && op.summary, `${where}: operationId and summary`)
        assert.ok((op.responses as Json).default, `${where}: the error answer`)
        const params = ((op.parameters as Json[]) ?? []).filter((x) => x.in === 'path').map((x) => x.name)
        assert.deepEqual(
          params,
          [...p.matchAll(/\{(\w+)\}/g)].map((x) => x[1]),
          `${where}: path parameters`,
        )
      }
    }
    // Keys are required except where nobody has one yet.
    const open = (p: string, m: string) => opOf(paths, p, m).security
    assert.deepEqual(open('/v1/openapi.json', 'get'), [])
    assert.deepEqual(open('/v1/auth/login', 'post'), [])
    assert.deepEqual(open('/v1/branding', 'get'), [])
    assert.deepEqual(open('/v1/branding/logo', 'get'), [])
    assert.equal(open('/v1/brains', 'get'), undefined)
    assert.deepEqual(doc.security, [{ bearer: [] }])
  })

  it('CA18: the main answers keep their fields, and the description documents them', async () => {
    const brain = await w.call(eric.key, 'POST', '/v1/brains', { slug: 'contract', purpose: 'Pinned.' })
    const session = await w.call(eric.key, 'POST', '/v1/brains/contract/sessions', { purpose: 'pin' })
    const saved = await w.call(eric.key, 'POST', '/v1/brains/contract/entries', {
      type: 'decision',
      title: 'Retention first',
      content: 'We measure retention before anything else.',
    })
    const entryId = (saved.body.receipt as Json).entryId as string
    const proposed = await w.call(eric.key, 'POST', '/v1/brains/contract/proposals', {
      title: 'Retention',
      reason: 'The journal says so.',
      ops: [
        {
          op: 'create',
          address: 'growth/retention',
          type: 'topic',
          title: 'Retention',
          summary: 'Retention first.',
          body: 'We measure retention before anything else.',
          sources: [{ entryId }],
          reason: 'One decision.',
        },
      ],
    })
    assert.equal(proposed.status, 201, proposed.text)
    const answers: Record<string, Json> = {
      'GET /v1/me': (await w.call(eric.key, 'GET', '/v1/me')).body,
      'POST /v1/brains': brain.body,
      'GET /v1/brains': (await w.call(eric.key, 'GET', '/v1/brains')).body,
      'GET /v1/brains/{slug}': (await w.call(eric.key, 'GET', '/v1/brains/contract')).body,
      'GET /v1/brains/{slug}/overview': (await w.call(eric.key, 'GET', '/v1/brains/contract/overview')).body,
      'POST /v1/brains/{slug}/sessions': session.body,
      'POST /v1/brains/{slug}/entries': saved.body,
      'GET /v1/entries/{id}': (await w.call(eric.key, 'GET', `/v1/entries/${entryId}`)).body,
      'GET /v1/search': (await w.call(eric.key, 'GET', '/v1/search?q=retention')).body,
      'GET /v1/brains/{slug}/context': (await w.call(eric.key, 'GET', '/v1/brains/contract/context')).body,
      'GET /v1/brains/{slug}/proposals': (await w.call(eric.key, 'GET', '/v1/brains/contract/proposals'))
        .body,
      'GET /v1/brains/{slug}/trail': (await w.call(eric.key, 'GET', '/v1/brains/contract/trail?ref=x')).body,
      'GET /v1/connect': (await w.call(eric.key, 'GET', '/v1/connect')).body,
      'GET /v1/me/sessions': (await w.call(eric.key, 'GET', '/v1/me/sessions')).body,
      'GET /v1/branding': (await w.call(null, 'GET', '/v1/branding')).body,
      ...(await doors()),
      ...(await people()),
      ...(await wiki(entryId)),
      ...(await journal()),
      ...(await inbox(entryId)),
    }
    const paths = doc.paths as Record<string, Record<string, Json>>
    for (const [op, shape] of Object.entries(SHAPES)) {
      const [method, path] = op.split(' ') as [string, string]
      const body = answers[op] as Json
      assert.equal(body.error, undefined, `${op}: ${JSON.stringify(body.error)}`)
      const responses = opOf(paths, path, method.toLowerCase()).responses as Json
      const ok = (responses['200'] ?? responses['201'] ?? responses['202']) as Json
      const schema = ((ok.content as Json)['application/json'] as Json).schema as Schema
      for (const [where, fields] of Object.entries(shape)) {
        const got = fieldsAt(body, where)
        for (const f of fields) assert.ok(f in got, `${op}: "${where || 'body'}" lost "${f}"`)
        const described = schemaAt(schema, where)
        for (const f of fields) {
          assert.ok(described.required?.includes(f), `${op}: the description does not pin "${where}.${f}"`)
        }
      }
    }
  })

  // The real answers of the screens before a session, in the order a person meets them.
  async function doors(): Promise<Record<string, Json>> {
    const out: Record<string, Json> = {}
    const setupBody = {
      name: 'Contract',
      publicUrl: 'http://localhost',
      admin: { name: 'Ada', email: 'ada@example.com', password: PW },
    }
    out['GET /v1/setup'] = (await fresh.raw('GET', '/v1/setup?publicUrl=http%3A%2F%2Flocalhost')).body
    const setup = await fresh.raw('POST', '/v1/setup', { headers: WEB, body: setupBody })
    assert.equal(setup.status, 201, setup.text)
    out['POST /v1/setup'] = setup.body
    const lou = await withPassword('Lou')
    const signedIn = await login({ email: lou.email, password: PW })
    assert.equal(signedIn.status, 200, signedIn.text)
    out['POST /v1/auth/login'] = signedIn.body
    const mo = await withCode('Mo')
    const asked = await login({ email: mo.email, password: PW })
    assert.equal(asked.body.error?.code, 'code_required', asked.text)
    const coded = await login({ email: mo.email, password: PW, code: mo.code() })
    assert.equal(coded.status, 200, coded.text)
    out['POST /v1/auth/login +code'] = coded.body
    const session = /rscb_session=([^;]+)/.exec(signedIn.headers.get('set-cookie') ?? '')?.[1] ?? ''
    out['POST /v1/auth/logout'] = (await w.callWeb(session, 'POST', '/v1/auth/logout', {})).body
    const admin = await withPassword('Admin', { isAdmin: true })
    const adminWeb = await w.web(admin.id)
    await w.call(eric.key, 'POST', '/v1/brains', { slug: 'doors', purpose: 'Where Iris lands.' })
    await w.call(eric.key, 'POST', '/v1/brains/doors/members', { account: admin.id, role: 'curator' })
    const invited = await w.callWeb(adminWeb, 'POST', '/v1/invitations', {
      emails: ['iris@example.com'],
      brains: [{ slug: 'doors', role: 'reader' }],
    })
    assert.equal(invited.status, 201, invited.text)
    const invite = tokenOf((invited.body.invitations as Json[])[0]?.link)
    out['POST /v1/invitations/look'] = (
      await w.raw('POST', '/v1/invitations/look', { body: { token: invite } })
    ).body
    out['POST /v1/invitations/accept'] = (
      await w.raw('POST', '/v1/invitations/accept', {
        headers: WEB,
        body: { token: invite, name: 'Iris', password: PW },
      })
    ).body
    const asking = await w.raw('POST', '/v1/auth/reset', { body: { email: lou.email } })
    assert.equal(asking.status, 202, asking.text)
    out['POST /v1/auth/reset'] = asking.body
    const link = await w.callWeb(adminWeb, 'POST', `/v1/admin/accounts/${lou.id}/reset-link`)
    out['POST /v1/auth/reset/look'] = (
      await w.raw('POST', '/v1/auth/reset/look', { body: { token: tokenOf(link.body.link) } })
    ).body
    out['POST /v1/auth/reset/confirm'] = (
      await w.raw('POST', '/v1/auth/reset/confirm', {
        body: { token: tokenOf(link.body.link), password: 'another long passphrase' },
      })
    ).body
    return out
  }

  // The administration invites and makes reset links from the web (PR18).
  async function people(): Promise<Record<string, Json>> {
    const out: Record<string, Json> = {}
    const admin = await withPassword('Admina', { isAdmin: true })
    const web = await w.web(admin.id)
    const made = await w.callWeb(web, 'POST', '/v1/invitations', {
      emails: ['people-contract@example.com'],
      brains: [{ slug: 'contract', role: 'reader' }],
    })
    assert.equal(made.status, 201, made.text)
    out['POST /v1/invitations'] = made.body
    out['GET /v1/invitations'] = (await w.callWeb(web, 'GET', '/v1/invitations')).body
    const id = String((made.body.invitations as Json[])[0]?.id)
    out['POST /v1/invitations/{id}/resend'] = (
      await w.callWeb(web, 'POST', `/v1/invitations/${id}/resend`)
    ).body
    out['DELETE /v1/invitations/{id}'] = (await w.callWeb(web, 'DELETE', `/v1/invitations/${id}`)).body
    out['GET /v1/admin/accounts'] = (await w.callWeb(web, 'GET', '/v1/admin/accounts')).body
    const link = await w.callWeb(web, 'POST', `/v1/admin/accounts/${eric.id}/reset-link`)
    assert.equal(link.status, 201, link.text)
    out['POST /v1/admin/accounts/{id}/reset-link'] = link.body
    out['GET /v1/admin/brains'] = (await w.callWeb(web, 'GET', '/v1/admin/brains')).body
    return out
  }

  // The wiki as the web reads and edits it (PR19): two pages, a link, an edit by hand.
  async function wiki(entryId: string): Promise<Record<string, Json>> {
    const out: Record<string, Json> = {}
    const web = await w.web(eric.id)
    const changed = await w.callWeb(web, 'POST', '/v1/brains/contract/wiki/changes', {
      op: 'create',
      address: 'growth/intros',
      type: 'decision',
      title: 'Intros',
      summary: 'Short intros.',
      body: 'Keep them short. See [[growth/retention]].',
      tags: ['q4'],
      sources: [{ entryId }],
      reason: 'From the journal.',
    })
    assert.equal(changed.status, 201, changed.text)
    out['POST /v1/brains/{slug}/wiki/changes'] = changed.body
    const edited = await w.callWeb(web, 'PATCH', '/v1/brains/contract/pages/growth/intros', {
      baseRevision: 1,
      body: 'Keep them under ten seconds. See [[growth/retention]].',
    })
    assert.equal(edited.status, 200, edited.text)
    out['PATCH /v1/brains/{slug}/pages/{address}'] = edited.body
    const corrected = await w.callWeb(web, 'POST', '/v1/brains/contract/corrections', {
      title: 'Ten seconds at most',
      content: 'Cut every intro to ten seconds.',
      page: 'growth/intros',
    })
    assert.equal(corrected.status, 201, corrected.text)
    const get = async (path: string) => (await w.call(eric.key, 'GET', `/v1/brains/contract${path}`)).body
    out['GET /v1/brains/{slug}/wiki/pages'] = await get('/wiki/pages')
    out['GET /v1/brains/{slug}/wiki/map'] = await get('/wiki/map')
    out['GET /v1/brains/{slug}/wiki/decisions'] = await get('/wiki/decisions')
    out['GET /v1/brains/{slug}/wiki/log'] = await get('/wiki/log')
    out['GET /v1/brains/{slug}/pages/{address}'] = await get('/pages/growth/intros')
    out['GET /v1/brains/{slug}/pages/{address} +history'] = await get('/pages/growth/intros?history=1')
    out['GET /v1/brains/{slug}/pages/{address} +compare'] = await get('/pages/growth/intros?compare=1,2')
    return out
  }

  // The journal as the web works it (PR20): sessions, one session, entries, an entry with its relations
  // and history, a person's correction, the curator's actions, a contradiction and the curator's lists.
  async function journal(): Promise<Record<string, Json>> {
    const out: Record<string, Json> = {}
    const web = await w.web(eric.id)
    const save = async (title: string, content: string) =>
      String(
        (
          (
            await w.call(eric.key, 'POST', '/v1/brains/contract/entries', {
              type: 'learning',
              title,
              content,
            })
          ).body.receipt as Json
        ).entryId,
      )
    const a = await save('Thirty seconds', 'Intros of thirty seconds.')
    const b = await save('Ten seconds', 'Intros of ten seconds.')
    const get = async (path: string) => (await w.call(eric.key, 'GET', path)).body
    const sessions = await get('/v1/brains/contract/sessions')
    out['GET /v1/brains/{slug}/sessions'] = sessions
    out['GET /v1/brains/{slug}/members'] = await get('/v1/brains/contract/members')
    const sessionId = String(((sessions.items as Json[])[0] as Json).id)
    out['GET /v1/sessions/{id}'] = await get(`/v1/sessions/${sessionId}`)
    out['GET /v1/brains/{slug}/entries'] = await get(`/v1/brains/contract/entries?session=${sessionId}`)
    const related = await w.callWeb(web, 'POST', '/v1/brains/contract/relations', {
      from: b,
      to: a,
      kind: 'contradicts',
      reason: 'Different numbers.',
    })
    assert.equal(related.status, 201, related.text)
    out['POST /v1/brains/{slug}/relations'] = related.body
    out['GET /v1/brains/{slug}/conflicts'] = await get('/v1/brains/contract/conflicts')
    out['GET /v1/entries/{id}'] = await get(`/v1/entries/${a}`)
    const edited = await w.callWeb(web, 'PATCH', `/v1/entries/${a}`, {
      baseRevision: 1,
      content: 'Thirty, tested.',
    })
    assert.equal(edited.status, 200, edited.text)
    out['PATCH /v1/entries/{id}'] = edited.body
    out['GET /v1/entries/{id} +history'] = await get(`/v1/entries/${a}?history=1`)
    const corrected = await w.callWeb(web, 'POST', '/v1/brains/contract/corrections', {
      title: 'Ten is right',
      content: 'Ten seconds, every time.',
      entry: a,
    })
    assert.equal(corrected.status, 201, corrected.text)
    out['POST /v1/brains/{slug}/corrections'] = corrected.body
    const act = async (op: string, path: string, body?: Json) => {
      const r = await w.callWeb(web, 'POST', path, body)
      assert.equal(r.status, 200, `${op}: ${r.text}`)
      out[op] = r.body
    }
    await act('POST /v1/entries/{id}/pin', `/v1/entries/${b}/pin`)
    await act('POST /v1/entries/{id}/unpin', `/v1/entries/${b}/unpin`)
    w.advance(1000)
    await act('POST /v1/entries/{id}/schedule', `/v1/entries/${b}/schedule`, {
      reviewAfter: new Date(w.now.getTime() - 60_000).toISOString(),
    })
    out['GET /v1/brains/{slug}/to-review'] = await get('/v1/brains/contract/to-review')
    await act('POST /v1/entries/{id}/forget', `/v1/entries/${b}/forget`, { reason: 'Wrong.' })
    out['GET /v1/brains/{slug}/forgotten'] = await get('/v1/brains/contract/forgotten')
    await act('POST /v1/entries/{id}/recover', `/v1/entries/${b}/recover`)
    return out
  }

  // The proposals inbox as the web works it (PR21): three changes, two approved and one returned with a
  // comment; another proposal returned whole.
  async function inbox(entryId: string): Promise<Record<string, Json>> {
    const out: Record<string, Json> = {}
    const web = await w.web(eric.id)
    const create = (address: string) => ({
      op: 'create',
      address,
      type: 'topic',
      title: `Page ${address}`,
      summary: 'A page.',
      body: 'Text.',
      sources: [{ entryId }],
      reason: 'From the journal.',
    })
    const send = async (title: string, ops: Json[]) => {
      const r = await w.call(eric.key, 'POST', '/v1/brains/contract/proposals', { title, ops })
      assert.equal(r.status, 201, r.text)
      return String((r.body.proposal as Json).id)
    }
    const three = await send('Three pages', [create('inbox/a'), create('inbox/b'), create('inbox/c')])
    const whole = await send('Back whole', [create('inbox/d')])
    out['GET /v1/brains/{slug}/proposals +inbox'] = (
      await w.callWeb(web, 'GET', '/v1/brains/contract/proposals')
    ).body
    const review = await w.callWeb(web, 'GET', `/v1/proposals/${three}/review`)
    assert.equal(review.status, 200, review.text)
    out['GET /v1/proposals/{id}/review'] = review.body
    const approved = await w.callWeb(web, 'POST', `/v1/proposals/${three}/approve`, {
      fingerprint: review.body.fingerprint,
      approve: [0, 1],
      comment: 'The third page is not needed.',
    })
    assert.equal(approved.status, 200, approved.text)
    out['POST /v1/proposals/{id}/approve'] = approved.body
    const fp = (await w.callWeb(web, 'GET', `/v1/proposals/${whole}/review`)).body.fingerprint
    const returned = await w.callWeb(web, 'POST', `/v1/proposals/${whole}/return`, {
      fingerprint: fp,
      comment: 'Not now.',
    })
    assert.equal(returned.status, 200, returned.text)
    out['POST /v1/proposals/{id}/return'] = returned.body
    return out
  }

  it('every refusal the web meets keeps its status within v1 (ERROR_STATUS, which the fixture obeys)', async () => {
    const lou = await withPassword('Louis')
    const reader = await withPassword('Rita')
    const mo = await withCode('Moira')
    const got: Array<[string, Call]> = []
    const add = async (code: string, r: Promise<Call>) => got.push([code, await r])
    await add(
      'invalid_request',
      w.raw('POST', '/v1/auth/reset/confirm', { body: { token: 'x', password: 1 } }),
    )
    await add('invitation_invalid', w.raw('POST', '/v1/invitations/look', { body: { token: 'nope-nope' } }))
    await add(
      'link_invalid',
      w.raw('POST', '/v1/auth/reset/confirm', { body: { token: 'nope', password: PW } }),
    )
    await add('link_invalid', w.raw('POST', '/v1/auth/reset/look', { body: { token: 'nope-nope' } }))
    await add('unauthorized', w.raw('GET', '/v1/me'))
    await add('bad_credentials', login({ email: lou.email, password: 'not the password at all' }))
    await add('code_required', login({ email: mo.email, password: PW }))
    await add('bad_code', login({ email: mo.email, password: PW, code: '000000' }))
    await add(
      'forbidden',
      w.callWeb(await w.web(reader.id), 'POST', `/v1/admin/accounts/${lou.id}/reset-link`),
    )
    await add('csrf', login({ email: lou.email, password: PW }, {}))
    await add(
      'insecure_connection',
      login(
        { email: lou.email, password: PW },
        { ...WEB, 'x-forwarded-for': '203.0.113.7', 'x-forwarded-proto': 'http' },
      ),
    )
    await add('brain_not_found', w.call(eric.key, 'GET', '/v1/brains/nowhere'))
    await add('brain_not_found', w.call(eric.key, 'GET', '/v1/brains/nowhere/overview'))
    // Creating a brain and inviting people from the web (PR18).
    await add('brain_exists', w.call(eric.key, 'POST', '/v1/brains', { slug: 'contract' }))
    const boss = await withPassword('Boss', { isAdmin: true })
    const bossWeb = await w.web(boss.id)
    await add('email_taken', w.callWeb(bossWeb, 'POST', '/v1/invitations', { emails: [lou.email] }))
    await add('not_found', w.callWeb(bossWeb, 'POST', '/v1/invitations/inv_nope/resend'))
    const once = await w.callWeb(bossWeb, 'POST', '/v1/invitations', { emails: ['once@example.com'] })
    const onceId = String((once.body.invitations as Json[])[0]?.id)
    await w.callWeb(bossWeb, 'DELETE', `/v1/invitations/${onceId}`)
    await add('invitation_closed', w.callWeb(bossWeb, 'POST', `/v1/invitations/${onceId}/resend`))
    // A curator, once the installation allows it, cannot take over an invitation still open.
    await w.callWeb(bossWeb, 'PUT', '/v1/admin/settings', { curatorsInvite: true })
    const cura = await withPassword('Cura')
    await w.member('contract', cura.id, 'curator')
    await w.callWeb(bossWeb, 'POST', '/v1/invitations', { emails: ['open@example.com'] })
    await add(
      'invitation_open',
      w.callWeb(await w.web(cura.id), 'POST', '/v1/invitations', {
        emails: ['open@example.com'],
        brains: [{ slug: 'contract', role: 'reader' }],
      }),
    )
    await w.callWeb(bossWeb, 'PUT', '/v1/admin/settings', { curatorsInvite: false })
    // The wiki (PR19): a page that does not exist, and an edit made on a revision that moved on.
    await add('page_not_found', w.call(eric.key, 'GET', '/v1/brains/contract/pages/no/such-page'))
    await add(
      'revision_not_found',
      w.call(eric.key, 'GET', '/v1/brains/contract/pages/growth/intros?revision=99'),
    )
    const ericWeb = await w.web(eric.id)
    await w.callWeb(ericWeb, 'POST', '/v1/brains/contract/wiki/changes', {
      op: 'create',
      address: 'conflict/page',
      type: 'topic',
      title: 'Conflict',
      summary: 'Two edits.',
      body: 'One.',
      reason: 'Contract.',
    })
    await w.callWeb(ericWeb, 'PATCH', '/v1/brains/contract/pages/conflict/page', {
      baseRevision: 1,
      body: 'Two.',
    })
    await add(
      'page_changed',
      w.callWeb(ericWeb, 'PATCH', '/v1/brains/contract/pages/conflict/page', {
        baseRevision: 1,
        body: 'Three.',
      }),
    )
    // The journal (PR20): an edit on a moved revision, a forgotten entry pinned, a topic taken while one
    // waited forgotten, and a supersede that closes a loop.
    const saved = async (body: Json) =>
      String(
        ((await w.call(eric.key, 'POST', '/v1/brains/contract/entries', body)).body.receipt as Json).entryId,
      )
    const e1 = await saved({ type: 'note', title: 'One', content: 'Contract one.' })
    await w.callWeb(ericWeb, 'PATCH', `/v1/entries/${e1}`, {
      baseRevision: 1,
      content: 'Contract one, again.',
    })
    await add(
      'entry_changed',
      w.callWeb(ericWeb, 'PATCH', `/v1/entries/${e1}`, { baseRevision: 1, content: 'x' }),
    )
    await w.callWeb(ericWeb, 'POST', `/v1/entries/${e1}/forget`, { reason: 'Contract.' })
    await add('entry_forgotten', w.callWeb(ericWeb, 'POST', `/v1/entries/${e1}/pin`))
    const t1 = await saved({ type: 'note', title: 'Topic', content: 'First.', topic: 'contract/topic' })
    await w.callWeb(ericWeb, 'POST', `/v1/entries/${t1}/forget`, { reason: 'Contract.' })
    await saved({ type: 'note', title: 'Topic', content: 'Second.', topic: 'contract/topic' })
    await add('topic_taken', w.callWeb(ericWeb, 'POST', `/v1/entries/${t1}/recover`))
    const x = await saved({ type: 'note', title: 'X', content: 'Contract x.' })
    const y = await saved({ type: 'note', title: 'Y', content: 'Contract y.' })
    await w.callWeb(ericWeb, 'POST', '/v1/brains/contract/relations', { from: x, to: y, kind: 'supersedes' })
    await add(
      'relation_cycle',
      w.callWeb(ericWeb, 'POST', '/v1/brains/contract/relations', { from: y, to: x, kind: 'supersedes' }),
    )
    // The inbox (PR21): a key never decides; a proposal decided already, or changed since it was read; an
    // edit written on a revision that moved on; part of a proposal approved without what it needs.
    const created = await w.call(eric.key, 'POST', '/v1/brains/contract/entries', {
      type: 'learning',
      title: 'Inbox',
      content: 'Inbox refusals.',
    })
    const inboxEntry = String((created.body.receipt as Json).entryId)
    const page = (address: string) => ({
      op: 'create',
      address,
      type: 'topic',
      title: `Page ${address}`,
      summary: 'A page.',
      body: 'Text.',
      sources: [{ entryId: inboxEntry }],
      reason: 'Refusals.',
    })
    const propose = async (ops: Json[]) =>
      String(
        (
          (await w.call(eric.key, 'POST', '/v1/brains/contract/proposals', { title: 'Refusals', ops })).body
            .proposal as Json
        ).id,
      )
    const seen = async (id: string) =>
      String((await w.callWeb(ericWeb, 'GET', `/v1/proposals/${id}/review`)).body.fingerprint)
    const decided = await propose([page('refusal/once')])
    await add('web_only', w.call(eric.key, 'GET', `/v1/proposals/${decided}/review`))
    const fpOnce = await seen(decided)
    await w.callWeb(ericWeb, 'POST', `/v1/proposals/${decided}/approve`, { fingerprint: fpOnce })
    await add(
      'already_decided',
      w.callWeb(ericWeb, 'POST', `/v1/proposals/${decided}/approve`, { fingerprint: fpOnce }),
    )
    const old = await propose([page('refusal/replaced')])
    const fpOld = await seen(old)
    await w.call(eric.key, 'POST', '/v1/brains/contract/proposals', {
      title: 'Refusals, again',
      supersedes: old,
      ops: [page('refusal/replaced')],
    })
    await add(
      'proposal_changed',
      w.callWeb(ericWeb, 'POST', `/v1/proposals/${old}/approve`, { fingerprint: fpOld }),
    )
    const behind = await propose([
      { op: 'edit', address: 'conflict/page', baseRevision: 1, body: 'Four.', reason: 'Old base.' },
    ])
    await add(
      'stale_base',
      w.callWeb(ericWeb, 'POST', `/v1/proposals/${behind}/approve`, { fingerprint: await seen(behind) }),
    )
    const chain = await propose([
      page('refusal/moved'),
      { op: 'move', address: 'refusal/moved', to: 'refusal/moved-on', reason: 'Rename.' },
    ])
    await add(
      'missing_dependencies',
      w.callWeb(ericWeb, 'POST', `/v1/proposals/${chain}/approve`, {
        fingerprint: await seen(chain),
        approve: [1],
        comment: 'Only the move.',
      }),
    )
    await add('no_logo', w.raw('GET', '/v1/branding/logo'))
    await add('no_such_route', w.raw('GET', '/v1/nowhere'))
    await add('setup_done', w.raw('GET', '/v1/setup'))
    await add(
      'setup_done',
      w.raw('POST', '/v1/setup', {
        headers: WEB,
        body: {
          name: 'Again',
          publicUrl: 'http://localhost',
          admin: { name: 'A', email: 'a@example.com', password: PW },
        },
      }),
    )
    // The brake: five failures in a row, then the sixth attempt is refused for a while.
    for (let i = 0; i < 5; i++) await login({ email: 'brake@example.com', password: 'nope nope nope' })
    await add('too_many_attempts', login({ email: 'brake@example.com', password: 'nope nope nope' }))
    for (const [code, r] of got) {
      assert.deepEqual([r.status, r.body.error?.code], [ERROR_STATUS[code], code], `${code}: ${r.text}`)
    }
    // Every code of the table was provoked here, but the one no request causes on purpose.
    assert.deepEqual(
      Object.keys(ERROR_STATUS)
        .filter((c) => c !== 'internal' && !got.some(([g]) => g === c))
        .sort(),
      [],
    )
  })

  it('CA18: every refusal keeps its shape: code, message, how to proceed', async () => {
    const r = await w.call(eric.key, 'GET', '/v1/brains/nowhere')
    assert.deepEqual(Object.keys(r.body.error ?? {}).sort(), ['code', 'howToProceed', 'message'])
    const err = ((doc.components as Json).schemas as Record<string, Schema>).Error as Schema
    assert.deepEqual(err.required, ['error'])
    assert.deepEqual(err.properties?.error?.required, ['code', 'message', 'howToProceed'])
  })
})
