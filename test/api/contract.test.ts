// Spec B5 «La API» and CA18: version 1 of the API is a contract. The routes of /v1 and the main fields
// of their answers are pinned here: removing or renaming one fails this test, so a breaking change has
// to become /v2 and leave /v1 working. The description at /v1/openapi.json is generated from the same
// route table, so it cannot leave a route out, and it documents the pinned fields.
import assert from 'node:assert/strict'
import { after, before, describe, it } from 'node:test'
import { ROUTES } from '../../src/http/app.ts'
import { skipPg } from '../helpers/pg.ts'
import { type World, world } from '../helpers/world.ts'
import { V1 } from './v1.ts'

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
  'GET /v1/branding': {
    '': ['name', 'logo', 'setupRequired'],
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
      'GET /v1/branding': (await w.call(null, 'GET', '/v1/branding')).body,
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
