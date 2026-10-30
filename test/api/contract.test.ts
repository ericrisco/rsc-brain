// Spec B5 «La API» and CA18: version 1 of the API is a contract. The routes of /v1 and the main fields
// of their answers are pinned here: removing or renaming one fails this test, so a breaking change has
// to become /v2 and leave /v1 working. The description at /v1/openapi.json is generated from the same
// route table, so it cannot leave a route out, and it documents the pinned fields.
import assert from 'node:assert/strict'
import { after, before, describe, it } from 'node:test'
import { ROUTES } from '../../src/http/app.ts'
import { skipPg } from '../helpers/pg.ts'
import { type World, world } from '../helpers/world.ts'

// Every operation of v1. Adding one means adding it here (and to the notes of the release); removing or
// changing one is a breaking change: it goes to v2.
const V1 = [
  'DELETE /v1/admin/accounts/{id}/totp',
  'DELETE /v1/admin/apps/{id}',
  'DELETE /v1/admin/mail',
  'DELETE /v1/admin/meaning',
  'DELETE /v1/brains/{slug}',
  'DELETE /v1/brains/{slug}/members/{account}',
  'DELETE /v1/brains/{slug}/repos',
  'DELETE /v1/invitations/{id}',
  'DELETE /v1/keys/{id}',
  'DELETE /v1/me/apps/{id}',
  'DELETE /v1/me/tokens/{id}',
  'DELETE /v1/me/totp',
  'GET /v1/admin/accounts',
  'GET /v1/admin/accounts/{id}/apps',
  'GET /v1/admin/accounts/{id}/keys',
  'GET /v1/admin/audit',
  'GET /v1/admin/audit/export',
  'GET /v1/admin/brains',
  'GET /v1/admin/mail',
  'GET /v1/admin/meaning',
  'GET /v1/admin/settings',
  'GET /v1/brains',
  'GET /v1/brains/{slug}',
  'GET /v1/brains/{slug}/audit',
  'GET /v1/brains/{slug}/conflicts',
  'GET /v1/brains/{slug}/context',
  'GET /v1/brains/{slug}/entries',
  'GET /v1/brains/{slug}/events',
  'GET /v1/brains/{slug}/forgotten',
  'GET /v1/brains/{slug}/members',
  'GET /v1/brains/{slug}/neighbours',
  'GET /v1/brains/{slug}/pages/{address}',
  'GET /v1/brains/{slug}/proposals',
  'GET /v1/brains/{slug}/repos',
  'GET /v1/brains/{slug}/sessions',
  'GET /v1/brains/{slug}/to-review',
  'GET /v1/brains/{slug}/trail',
  'GET /v1/brains/{slug}/uncompiled',
  'GET /v1/brains/{slug}/wiki/compile',
  'GET /v1/brains/{slug}/wiki/decisions',
  'GET /v1/brains/{slug}/wiki/guide',
  'GET /v1/brains/{slug}/wiki/health',
  'GET /v1/brains/{slug}/wiki/log',
  'GET /v1/brains/{slug}/wiki/map',
  'GET /v1/connect',
  'GET /v1/entries/{id}',
  'GET /v1/entries/{id}/around',
  'GET /v1/health',
  'GET /v1/invitations',
  'GET /v1/me',
  'GET /v1/me/apps',
  'GET /v1/me/notices',
  'GET /v1/me/sessions',
  'GET /v1/me/tokens',
  'GET /v1/openapi.json',
  'GET /v1/proposals/{id}',
  'GET /v1/proposals/{id}/review',
  'GET /v1/search',
  'GET /v1/setup',
  'PATCH /v1/admin/accounts/{id}',
  'PATCH /v1/brains/{slug}/pages/{address}',
  'PATCH /v1/entries/{id}',
  'POST /v1/admin/accounts/{id}/remove',
  'POST /v1/admin/accounts/{id}/reset-link',
  'POST /v1/admin/accounts/{id}/restore',
  'POST /v1/admin/brains/{slug}/curator',
  'POST /v1/admin/brains/{slug}/join',
  'POST /v1/admin/mail/test',
  'POST /v1/admin/services',
  'POST /v1/admin/services/{id}/keys',
  'POST /v1/auth/login',
  'POST /v1/auth/logout',
  'POST /v1/auth/logout-everywhere',
  'POST /v1/auth/reset',
  'POST /v1/auth/reset/confirm',
  'POST /v1/brains',
  'POST /v1/brains/{slug}/archive',
  'POST /v1/brains/{slug}/corrections/relay',
  'POST /v1/brains/{slug}/entries',
  'POST /v1/brains/{slug}/members',
  'POST /v1/brains/{slug}/proposals',
  'POST /v1/brains/{slug}/relations',
  'POST /v1/brains/{slug}/repos',
  'POST /v1/brains/{slug}/sessions',
  'POST /v1/brains/{slug}/topics/suggest',
  'POST /v1/brains/{slug}/unarchive',
  'POST /v1/brains/{slug}/wiki/changes',
  'POST /v1/brains/{slug}/wiki/maintenance-asked',
  'POST /v1/brains/{slug}/wiki/purge',
  'POST /v1/entries/{id}/forget',
  'POST /v1/entries/{id}/pin',
  'POST /v1/entries/{id}/purge',
  'POST /v1/entries/{id}/recover',
  'POST /v1/entries/{id}/schedule',
  'POST /v1/entries/{id}/unpin',
  'POST /v1/invitations',
  'POST /v1/invitations/accept',
  'POST /v1/invitations/look',
  'POST /v1/invitations/{id}/resend',
  'POST /v1/keys/short',
  'POST /v1/me/notices/read',
  'POST /v1/me/tokens',
  'POST /v1/me/totp',
  'POST /v1/me/totp/confirm',
  'POST /v1/proposals/{id}/approve',
  'POST /v1/proposals/{id}/purge',
  'POST /v1/proposals/{id}/return',
  'POST /v1/proposals/{id}/withdraw',
  'POST /v1/resolve',
  'POST /v1/sessions/{id}/end',
  'POST /v1/sessions/{id}/summary',
  'POST /v1/setup',
  'PUT /v1/admin/mail',
  'PUT /v1/admin/meaning',
  'PUT /v1/admin/settings',
  'PUT /v1/brains/{slug}/members/{account}',
  'PUT /v1/brains/{slug}/notify',
  'PUT /v1/brains/{slug}/wiki/settings',
]

// The fields a program relies on in the main answers. `[]` marks the items of a list.
const SHAPES: Record<string, Record<string, string[]>> = {
  'GET /v1/me': {
    account: ['id', 'kind', 'name', 'email', 'isAdmin'],
    key: ['id', 'kind', 'perm', 'ref', 'agent'],
  },
  'POST /v1/brains': {
    brain: ['id', 'slug', 'name', 'description', 'purpose', 'status', 'createdAt', 'updatedAt'],
  },
  'GET /v1/brains': {
    'brains[]': ['id', 'slug', 'name', 'purpose', 'status', 'role'],
  },
  'POST /v1/brains/{slug}/sessions': {
    session: ['id', 'brainId', 'purpose', 'ref', 'status', 'openedAt', 'closedAt'],
  },
  'POST /v1/brains/{slug}/entries': {
    receipt: ['entryId', 'revision', 'at', 'deduplicated', 'repeatCount', 'redactions', 'similar'],
  },
  'GET /v1/entries/{id}': {
    entry: ['id', 'brainId', 'type', 'title', 'content', 'revision', 'state', 'createdAt'],
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
}

type Json = Record<string, unknown>
type Schema = { type?: string; properties?: Record<string, Schema>; required?: string[]; items?: Schema }

function fieldsAt(body: Json, where: string): Json {
  if (where === '') return body
  const list = where.endsWith('[]')
  const v = body[list ? where.slice(0, -2) : where]
  const one = list ? (v as Json[])[0] : v
  assert.ok(one && typeof one === 'object', `no "${where}" in ${JSON.stringify(body).slice(0, 300)}`)
  return one as Json
}

function opOf(paths: Record<string, Record<string, Json>>, path: string, method: string): Json {
  const op = paths[path]?.[method]
  assert.ok(op, `the description has no ${method} ${path}`)
  return op
}

function schemaAt(s: Schema, where: string): Schema {
  if (where === '') return s
  const list = where.endsWith('[]')
  const p = s.properties?.[list ? where.slice(0, -2) : where]
  assert.ok(p, `the description has no "${where}"`)
  return (list ? p.items : p) as Schema
}

describe('the v1 contract', { skip: skipPg }, () => {
  let w: World
  let eric: { id: string; key: string }
  let doc: Json

  before(async () => {
    w = await world()
    eric = await w.person('Eric')
  })
  after(async () => w.close())

  it('the description is public JSON (OpenAPI 3.1) and needs no key: it holds no data', async () => {
    const r = await w.raw('GET', '/v1/openapi.json')
    assert.equal(r.status, 200, r.text)
    assert.match(r.headers.get('content-type') ?? '', /application\/json/)
    doc = r.body
    assert.equal(doc.openapi, '3.1.0')
    assert.equal((doc.info as Json).title, 'RSC Brain API')
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
    const answers: Record<string, Json> = {
      'GET /v1/me': (await w.call(eric.key, 'GET', '/v1/me')).body,
      'POST /v1/brains': brain.body,
      'GET /v1/brains': (await w.call(eric.key, 'GET', '/v1/brains')).body,
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
    }
    const paths = doc.paths as Record<string, Record<string, Json>>
    for (const [op, shape] of Object.entries(SHAPES)) {
      const [method, path] = op.split(' ') as [string, string]
      const body = answers[op] as Json
      assert.equal(body.error, undefined, `${op}: ${JSON.stringify(body.error)}`)
      const responses = opOf(paths, path, method.toLowerCase()).responses as Json
      const ok = (responses['200'] ?? responses['201']) as Json
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

  it('CA18: every refusal keeps its shape: code, message, how to proceed', async () => {
    const r = await w.call(eric.key, 'GET', '/v1/brains/nowhere')
    assert.deepEqual(Object.keys(r.body.error ?? {}).sort(), ['code', 'howToProceed', 'message'])
    const err = ((doc.components as Json).schemas as Record<string, Schema>).Error as Schema
    assert.deepEqual(err.required, ['error'])
    assert.deepEqual(err.properties?.error?.required, ['code', 'message', 'howToProceed'])
  })
})
