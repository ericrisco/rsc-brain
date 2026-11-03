// The consumer contract of rsc-factory (plan rsc-factory-brain §3.2, T010): every call its rsc-brain client
// makes, sent with a body that fits the request shape rsc-factory sends (brain-shapes.json "requests"),
// answered by the real server with the reply shapes it reads. brain-shapes.json is a reviewed copy of
// rsc-factory's test/memory/brain-shapes.json: its fake rsc-brain answers with the same replies and refuses a
// body that breaks the same requests. Both sides pin the SHA-256 of their copy to the same constant (below):
// an edit to one copy fails its own side until the constant changes, and the constant changes in both
// repositories in the same pair of PRs. That catches a one-sided edit; it cannot see the other repository.
// It also pins what that fake models of rsc-brain's behaviour: relayed corrections and their refusals,
// request keys per credential, the start-up context of each agent, and "mine" among the pending proposals.
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { after, before, describe, it } from 'node:test'
import { skipPg } from '../helpers/pg.ts'
import { type Call, type World, world } from '../helpers/world.ts'

type Json = Record<string, unknown>
type Schema = {
  type?: string | string[]
  required?: string[]
  properties?: Record<string, Schema>
  items?: Schema
  enum?: unknown[]
  additionalProperties?: boolean
  minItems?: number
  maxItems?: number
}
type Shapes = {
  error: Schema
  operations: Record<string, { status: number; reply: Schema }>
  requests: Record<string, Schema>
}

// The same constant is in rsc-factory's test/memory/brain-client.test.ts: change both, with both copies.
const BRAIN_SHAPES_SHA256 = 'b4de57ce52c6a89ddbaf758562ec452920387c75ff5fabf2a1b4ce484e1af4aa'
const SHAPES_TEXT = readFileSync(new URL('./brain-shapes.json', import.meta.url), 'utf8')
const SHAPES = JSON.parse(SHAPES_TEXT) as Shapes

const typeOf = (v: unknown) =>
  v === null ? 'null' : Array.isArray(v) ? 'array' : Number.isInteger(v) ? 'integer' : typeof v

// The part of JSON Schema the shapes use: type (one or several), required, properties, additionalProperties
// (false only), items, minItems, maxItems, enum.
function problems(s: Schema, v: unknown, at = 'body', out: string[] = []): string[] {
  const types = s.type === undefined ? [] : Array.isArray(s.type) ? s.type : [s.type]
  const t = typeOf(v)
  if (types.length && !types.includes(t) && !(t === 'integer' && types.includes('number'))) {
    out.push(`${at}: ${t}, the shape says ${types.join(' or ')}`)
    return out
  }
  if (s.enum && !s.enum.includes(v))
    out.push(`${at}: ${JSON.stringify(v)} is not one of ${s.enum.join(', ')}`)
  if (t === 'object' && s.properties) {
    const o = v as Json
    for (const k of s.required ?? []) if (!(k in o)) out.push(`${at}: "${k}" is missing`)
    for (const [k, p] of Object.entries(s.properties)) if (k in o) problems(p, o[k], `${at}.${k}`, out)
    if (s.additionalProperties === false)
      for (const k of Object.keys(o)) if (!(k in s.properties)) out.push(`${at}: "${k}" is not in the shape`)
  }
  if (t === 'array') {
    const n = (v as unknown[]).length
    if (s.minItems !== undefined && n < s.minItems)
      out.push(`${at}: ${n} items, the shape says ${s.minItems} or more`)
    if (s.maxItems !== undefined && n > s.maxItems)
      out.push(`${at}: ${n} items, the shape says ${s.maxItems} or fewer`)
    if (s.items) for (const [i, x] of (v as unknown[]).entries()) problems(s.items, x, `${at}[${i}]`, out)
  }
  return out
}

describe('the consumer contract of rsc-factory', { skip: skipPg }, () => {
  let w: World
  let factory: { id: string; key: string }
  let eric: { id: string; key: string; email: string }
  let ana: { id: string; key: string; email: string }
  const seen = new Set<string>()
  const emailOf = async (id: string) =>
    (await w.db.one<{ email: string }>('SELECT email FROM accounts WHERE id = $1', [id]))?.email as string

  // One call as rsc-factory's client makes it, checked against the shape of its operation.
  async function call(op: string, path: string, body?: unknown, key: string | null = factory.key) {
    const shape = SHAPES.operations[op]
    assert.ok(shape, `no shape for ${op}`)
    const method = op.split(' ')[0] as string
    // Sent as rsc-factory sends it: an operation with a body has the request shape of rsc-factory's client.
    const request = SHAPES.requests[op]
    assert.equal(body === undefined, request === undefined, `${op}: a body exactly when the shapes give one`)
    if (request)
      assert.deepEqual(problems(request, body), [], `${op}: the body is not what rsc-factory sends`)
    const r = await w.call(key, method, path, body)
    assert.equal(r.status, shape.status, `${op}: ${r.text}`)
    assert.deepEqual(problems(shape.reply, r.body), [], `${op}: ${r.text.slice(0, 400)}`)
    seen.add(op)
    return r.body
  }
  // A refusal: its status and code, in the envelope rsc-factory reads.
  function refused(r: Call, status: number, code: string) {
    assert.equal(r.status, status, r.text)
    assert.equal(r.body.error?.code, code, r.text)
    assert.deepEqual(problems(SHAPES.error, r.body), [], r.text)
  }
  const relay = (slug: string, body: Json, key = factory.key) =>
    w.call(key, 'POST', `/v1/brains/${slug}/corrections/relay`, body)

  before(async () => {
    w = await world()
    factory = await w.service('rsc-factory', { canInvite: true })
    const e = await w.person('Eric')
    eric = { ...e, email: await emailOf(e.id) }
    const a = await w.person('Ana')
    ana = { ...a, email: await emailOf(a.id) }
    // A company brain Eric curates, which rsc-factory may only read.
    await w.call(eric.key, 'POST', '/v1/brains', { slug: 'company', purpose: 'How we work.' })
    await w.member('company', factory.id, 'reader')
  })
  after(async () => w.close())

  it('health, me, creating a brain and listing it', async () => {
    const h = await call('GET /v1/health', '/v1/health', undefined, null)
    assert.deepEqual(h, { ok: true, database: 'ok', maintenance: false })
    const me = await call('GET /v1/me', '/v1/me')
    assert.deepEqual(
      [(me.account as Json).kind, (me.key as Json).kind, (me.account as Json).canInvite],
      ['service', 'main', true],
    )
    const made = await call('POST /v1/brains', '/v1/brains', {
      slug: 'youtube-channel',
      name: 'YouTube channel',
      purpose: 'What we learn making videos.',
      firstCurator: eric.email,
    })
    assert.equal((made.brain as Json).slug, 'youtube-channel')
    refused(
      await w.call(factory.key, 'POST', '/v1/brains', {
        slug: 'youtube-channel',
        name: 'x',
        purpose: 'x',
        firstCurator: eric.email,
      }),
      409,
      'brain_exists',
    )
    const listed = await call('GET /v1/brains', '/v1/brains')
    const mine = Object.fromEntries((listed.brains as Json[]).map((b) => [b.slug, b.createdByYou]))
    assert.deepEqual(mine, { company: false, 'youtube-channel': true })
  })

  it('inviting, asking what a person may read, and the members', async () => {
    const inv = await call('POST /v1/brains/{slug}/invitations', '/v1/brains/youtube-channel/invitations', {
      people: [
        { email: ana.email, role: 'reader' },
        { email: 'new@example.com', role: 'curator' },
      ],
    })
    assert.deepEqual(
      (inv.invited as Json[]).map((x) => x.status),
      ['added', 'invited'],
    )
    // A reader asked for as curator rises (CA6b); a removed account is refused for that person alone.
    const rae = await w.person('Rae')
    await w.member('youtube-channel', rae.id, 'reader')
    const gone = await w.person('Gone')
    await w.db.query("UPDATE accounts SET status = 'removed' WHERE id = $1", [gone.id])
    const again = await call('POST /v1/brains/{slug}/invitations', '/v1/brains/youtube-channel/invitations', {
      people: [
        { email: await emailOf(rae.id), role: 'curator' },
        { email: await emailOf(gone.id), role: 'reader' },
      ],
    })
    assert.deepEqual(again.invited, [
      { email: await emailOf(rae.id), status: 'raised' },
      { email: await emailOf(gone.id), status: 'refused', reason: 'account_removed' },
    ])
    const acc = await call('POST /v1/access', '/v1/access', {
      person: eric.email,
      brains: ['youtube-channel', 'company'],
    })
    assert.deepEqual(acc.brains, [
      { slug: 'youtube-channel', serviceRole: 'contributor', personRole: 'curator' },
      { slug: 'company', serviceRole: 'reader', personRole: 'curator' },
    ])
    const m = await call('GET /v1/brains/{slug}/members', '/v1/brains/youtube-channel/members')
    assert.ok((m.members as Json[]).some((x) => x.role === 'curator'))
  })

  it("a step's key, its session, its context, its records; closing and revoking", async () => {
    const ref = 'run r_1234abcd step 1'
    const minted = await call('POST /v1/keys/short', '/v1/keys/short', {
      writeBrain: 'youtube-channel',
      readBrains: ['company'],
      ref,
      agent: 'narrator',
      onBehalf: eric.email,
      ttlMinutes: 60,
    })
    const key = minted.key as { id: string; secret: string }
    const session = await call('POST /v1/brains/{slug}/sessions', '/v1/brains/youtube-channel/sessions', {
      forKey: key.id,
      purpose: 'Narrate the intro',
      ref,
    })
    const step = await w.call(key.secret, 'POST', '/v1/brains/youtube-channel/entries', {
      type: 'step',
      title: 'Narrated the intro',
      content: 'The intro is 28 seconds long and opens with the question of the video.',
    })
    assert.equal(step.status, 201, step.text)
    const ctx = await call(
      'GET /v1/brains/{slug}/context',
      `/v1/brains/youtube-channel/context?${new URLSearchParams({ task: 'Narrate the intro', agent: 'narrator', ref, max: '12000' })}`,
    )
    assert.ok(Number(ctx.chars) <= 12000)
    const entries = await call(
      'GET /v1/brains/{slug}/entries',
      `/v1/brains/youtube-channel/entries?${new URLSearchParams({ ref, limit: '200' })}`,
    )
    assert.deepEqual(
      (entries.items as Json[]).map((x) => [x.type, x.ref]),
      [['step', ref]],
    )
    const ended = await call(
      'POST /v1/sessions/{id}/end',
      `/v1/sessions/${(session.session as Json).id}/end`,
      {},
    )
    assert.equal((ended.session as Json).status, 'closed_no_summary')
    const revoked = await call('DELETE /v1/keys/{id}', `/v1/keys/${key.id}`)
    assert.equal(revoked.revoked, key.id)
    refused(await w.call(key.secret, 'GET', '/v1/me'), 401, 'key_revoked')
  })

  it('relayed corrections: on behalf of a contributor or curator, refused for anyone else (403 forbidden)', async () => {
    const ok = await call(
      'POST /v1/brains/{slug}/corrections/relay',
      '/v1/brains/youtube-channel/corrections/relay',
      {
        onBehalf: eric.email,
        title: 'Returned at review',
        content: 'Intros under 30 seconds: the hook is too slow.',
        appliesTo: 'narrator',
        refs: ['rsc-factory:run/r_1234abcd'],
        requestKey: 'gate:1',
      },
    )
    assert.equal((ok.receipt as Json).deduplicated, false)
    // Ana reads the brain, nothing more; rsc-factory only reads "company"; an archived brain takes nothing.
    const body = { title: 't', content: 'c', refs: [], requestKey: 'gate:refused' }
    refused(await relay('youtube-channel', { ...body, onBehalf: ana.email }), 403, 'forbidden')
    refused(await relay('company', { ...body, onBehalf: eric.email }), 403, 'forbidden')
    await w.call(factory.key, 'POST', '/v1/brains', { slug: 'old-project', firstCurator: eric.email })
    assert.equal((await w.call(eric.key, 'POST', '/v1/brains/old-project/archive')).status, 200)
    refused(await relay('old-project', { ...body, onBehalf: eric.email }), 403, 'forbidden')
  })

  it('a request key belongs to the key that sent it: the same request again is the same receipt, any other is 409', async () => {
    const first = {
      onBehalf: eric.email,
      title: 'Returned at publish',
      content: 'The thumbnail text is too long.',
      appliesTo: 'designer',
      refs: [],
      requestKey: 'gate:2',
    }
    const a = await relay('youtube-channel', first)
    assert.equal(a.status, 201, a.text)
    const again = await relay('youtube-channel', first)
    // The very receipt of the first time (rsc-factory reads entryId; a retry is not a repeat of the text).
    assert.deepEqual(again.body.receipt, a.body.receipt)
    await w.call(factory.key, 'POST', '/v1/brains', { slug: 'second-project', firstCurator: eric.email })
    await w.member('youtube-channel', ana.id, 'contributor')
    await w.member('second-project', ana.id, 'contributor')
    refused(await relay('second-project', first), 409, 'request_key_reused')
    refused(await relay('youtube-channel', { ...first, content: 'Another text.' }), 409, 'request_key_reused')
    refused(await relay('youtube-channel', { ...first, onBehalf: ana.email }), 409, 'request_key_reused')
    // An entry with the key of a correction is another request too.
    refused(
      await w.call(factory.key, 'POST', '/v1/brains/youtube-channel/entries', {
        type: 'preference',
        title: first.title,
        content: first.content,
        refs: [],
        requestKey: 'gate:2',
      }),
      409,
      'request_key_reused',
    )
    // Another key of the same installation may use the same text as its own request key.
    const other = await w.service('Another service')
    await w.member('youtube-channel', other.id, 'contributor')
    const theirs = await relay('youtube-channel', first, other.key)
    assert.equal(theirs.status, 201, theirs.text)
    assert.equal((theirs.body.receipt as Json).deduplicated, false)
  })

  it('a preference entry, with its request key', async () => {
    const body = {
      type: 'preference',
      title: 'Lesson: short intros',
      content: 'Keep intros under 30 seconds.',
      appliesTo: 'narrator',
      refs: ['rsc-factory:lesson/l_1'],
      requestKey: 'lesson:l_1:youtube-channel:0123456789abcdef',
    }
    const saved = await call('POST /v1/brains/{slug}/entries', '/v1/brains/youtube-channel/entries', body)
    const again = await call('POST /v1/brains/{slug}/entries', '/v1/brains/youtube-channel/entries', body)
    assert.deepEqual(again.receipt, saved.receipt)
  })

  it('the start-up context of an agent never carries a correction meant for another agent', async () => {
    const ctx = async (agent: string) =>
      String(
        (
          await call(
            'GET /v1/brains/{slug}/context',
            `/v1/brains/youtube-channel/context?${new URLSearchParams({ task: 'Make the next video', agent, ref: 'run r_5678abcd step 1', max: '12000' })}`,
          )
        ).text,
      )
    const narrator = await ctx('narrator')
    const designer = await ctx('designer')
    assert.match(narrator, /the hook is too slow/)
    assert.doesNotMatch(narrator, /thumbnail text is too long/)
    assert.match(designer, /thumbnail text is too long/)
    assert.doesNotMatch(designer, /the hook is too slow/)
  })

  it('pending proposals: all of them oldest first, and "mine" counts only those of the service', async () => {
    const key = (
      await call('POST /v1/keys/short', '/v1/keys/short', {
        writeBrain: 'youtube-channel',
        readBrains: [],
        ref: 'run r_9abc0123 step 9',
        agent: 'brain-compiler',
        ttlMinutes: 30,
      })
    ).key as { secret: string }
    const source = await w.call(eric.key, 'POST', '/v1/brains/youtube-channel/entries', {
      type: 'decision',
      title: 'Retention first',
      content: 'We measure retention before anything else.',
    })
    const entryId = (source.body.receipt as Json).entryId
    const propose = (k: string, address: string) =>
      w.call(k, 'POST', '/v1/brains/youtube-channel/proposals', {
        title: `About ${address}`,
        reason: 'The journal says so.',
        ops: [
          {
            op: 'create',
            address,
            type: 'topic',
            title: address,
            summary: 'Retention first.',
            body: 'We measure retention before anything else.',
            sources: [{ entryId }],
            reason: 'One decision.',
          },
        ],
      })
    assert.equal((await propose(eric.key, 'growth/by-eric')).status, 201)
    w.advance(1000)
    assert.equal((await propose(key.secret, 'growth/by-the-compiler')).status, 201)
    const all = await call(
      'GET /v1/brains/{slug}/proposals',
      `/v1/brains/youtube-channel/proposals?${new URLSearchParams({ status: 'pending', limit: '200', order: 'oldest' })}`,
    )
    assert.deepEqual(
      (all.items as Json[]).map((x) => x.title),
      ['About growth/by-eric', 'About growth/by-the-compiler'],
    )
    const mine = await call(
      'GET /v1/brains/{slug}/proposals',
      `/v1/brains/youtube-channel/proposals?${new URLSearchParams({ status: 'pending', mine: '1', limit: '1' })}`,
    )
    assert.equal(mine.total, 1)
    const listed = await call('GET /v1/brains', '/v1/brains')
    const stats = (listed.brains as Json[]).find((b) => b.slug === 'youtube-channel')?.stats as Json
    assert.equal(stats.pendingProposals, 2)
  })

  it('the shapes are the copy rsc-factory pins (SHA-256), and every request names an operation', () => {
    assert.equal(createHash('sha256').update(SHAPES_TEXT).digest('hex'), BRAIN_SHAPES_SHA256)
    const ops = Object.keys(SHAPES.operations)
    for (const op of Object.keys(SHAPES.requests).filter((k) => k !== '$comment'))
      assert.ok(ops.includes(op), op)
    // The checker refuses what a request shape leaves out, so a renamed field cannot pass.
    const people = SHAPES.requests['POST /v1/brains/{slug}/invitations'] as Schema
    assert.deepEqual(problems(people, { people: [{ email: 'a@b.c', role: 'reader' }] }), [])
    assert.notDeepEqual(problems(people, { people: [{ mail: 'a@b.c', role: 'reader' }] }), [])
    assert.notDeepEqual(problems(people, { people: [{ email: 'a@b.c', role: 'reader', name: 'A' }] }), [])
    assert.notDeepEqual(problems(people, { people: [] }), [])
  })

  it('every operation of the shapes was called', () => {
    assert.deepEqual([...seen].sort(), Object.keys(SHAPES.operations).sort())
  })
})
