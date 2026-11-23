// E2E findings 8a and 8b (health): two pages that contradict each other on purpose are marked as a known debate by a
// curator in the web, and then leave the problems and the cleanup an agent is asked for; and a brain just filled by
// an import is not told it was never cleaned.
import assert from 'node:assert/strict'
import { after, before, describe, it } from 'node:test'
import { skipPg } from '../helpers/pg.ts'
import { type World, world } from '../helpers/world.ts'

type Pair = { a: string; b: string }
type Health = {
  conflicts: Pair[]
  debates: Pair[]
  maintenance: { suggested: boolean; lastAt: string | null }
}

describe('known debates and the import baseline', { skip: skipPg }, () => {
  let w: World
  let eric: { id: string; key: string }
  let ana: { id: string; key: string }
  let ericWeb: string
  let anaWeb: string
  const health = async () => (await w.call(eric.key, 'GET', '/v1/brains/yt/wiki/health')).body as Health
  const make = (address: string, extra: Record<string, unknown> = {}) =>
    w.callWeb(ericWeb, 'POST', '/v1/brains/yt/wiki/changes', {
      op: 'create',
      address,
      type: 'topic',
      title: `Paper ${address}`,
      summary: 's',
      body: `Body of ${address}.`,
      ...extra,
    })
  const debate = (session: string, known: boolean, a = 'papers/awq', b = 'papers/gptq') =>
    w.callWeb(session, 'PUT', '/v1/brains/yt/wiki/debates', { a, b, known })

  before(async () => {
    w = await world()
    eric = await w.person('Eric')
    ana = await w.person('Ana')
    await w.call(eric.key, 'POST', '/v1/brains', { slug: 'yt', purpose: 'Our channel.' })
    await w.member('yt', ana.id, 'contributor')
    ericWeb = await w.web(eric.id)
    anaWeb = await w.web(ana.id)
    assert.equal((await make('papers/gptq')).status, 201)
    assert.equal(
      (await make('papers/awq', { links: [{ kind: 'contradicts', to: 'papers/gptq' }] })).status,
      201,
    )
    assert.equal((await make('papers/solo', { links: [{ kind: 'related', to: 'papers/gptq' }] })).status, 201)
  })
  after(async () => w.close())

  it('a contradiction is a problem until a curator marks it as a known debate; unmarking brings it back', async () => {
    let h = await health()
    assert.deepEqual(h.conflicts, [{ ...h.conflicts[0], a: 'papers/awq', b: 'papers/gptq' }])
    assert.deepEqual(h.debates, [])
    const r = await debate(ericWeb, true)
    assert.equal(r.status, 200, r.text)
    h = await health()
    assert.deepEqual(
      [h.conflicts.length, h.debates.map((d) => [d.a, d.b])],
      [0, [['papers/awq', 'papers/gptq']]],
    )
    // Marking twice is once; the order of the pair does not matter.
    assert.equal((await debate(ericWeb, true, 'papers/gptq', 'papers/awq')).status, 200)
    assert.equal((await health()).debates.length, 1)
    assert.equal((await debate(ericWeb, false)).status, 200)
    h = await health()
    assert.deepEqual([h.conflicts.length, h.debates.length], [1, 0])
  })

  it('a known debate does not make the wiki need a cleanup, and the agent is not told to settle it', async () => {
    w.advance(25 * 3_600_000)
    assert.equal((await health()).maintenance.suggested, true)
    await debate(ericWeb, true)
    const h = await health()
    assert.equal(h.maintenance.suggested, false)
    const ctx = (await w.call(ana.key, 'GET', '/v1/brains/yt/context')).body as { cleanup?: unknown }
    assert.equal(ctx.cleanup ?? null, null)
    await debate(ericWeb, false)
    assert.equal((await health()).maintenance.suggested, true)
  })

  it('only a curator, in the web, marks a debate, and only between pages that contradict each other', async () => {
    assert.equal((await debate(anaWeb, true)).status, 403)
    assert.equal(
      (
        await w.call(eric.key, 'PUT', '/v1/brains/yt/wiki/debates', {
          a: 'papers/awq',
          b: 'papers/gptq',
          known: true,
        })
      ).body.error?.code,
      'web_only',
    )
    assert.equal((await debate(ericWeb, true, 'papers/awq', 'papers/solo')).status, 400)
    assert.equal((await debate(ericWeb, true, 'papers/awq', 'papers/nowhere')).status, 400)
    assert.equal((await debate(ericWeb, true, 'papers/awq', 'papers/awq')).status, 400)
  })

  it('a debate does not outlive its contradicts link, nor hide a later real contradiction', async () => {
    assert.equal((await make('papers/zeta')).status, 201)
    assert.equal(
      (await make('papers/eta', { links: [{ kind: 'contradicts', to: 'papers/zeta' }] })).status,
      201,
    )
    assert.equal((await debate(ericWeb, true, 'papers/eta', 'papers/zeta')).status, 200)
    const change = (op: Record<string, unknown>) =>
      w.callWeb(ericWeb, 'POST', '/v1/brains/yt/wiki/changes', op)
    assert.equal(
      (await change({ op: 'unlink', address: 'papers/eta', kind: 'contradicts', to: 'papers/zeta' })).status,
      201,
    )
    assert.equal(
      (await health()).debates.some((d) => d.a === 'papers/eta'),
      false,
    )
    assert.equal(
      (await change({ op: 'link', address: 'papers/zeta', kind: 'contradicts', to: 'papers/eta' })).status,
      201,
    )
    const h = await health()
    assert.equal(
      h.conflicts.some((c) => c.a === 'papers/eta'),
      true,
    )
    assert.equal(
      h.debates.some((d) => d.a === 'papers/eta'),
      false,
    )
  })

  it('merging a page keeps its known debates on the page that survives', async () => {
    assert.equal((await make('papers/zz')).status, 201)
    assert.equal((await make('papers/xx')).status, 201)
    assert.equal((await make('papers/yy', { links: [{ kind: 'contradicts', to: 'papers/zz' }] })).status, 201)
    assert.equal((await debate(ericWeb, true, 'papers/yy', 'papers/zz')).status, 200)
    const r = await w.callWeb(ericWeb, 'POST', '/v1/brains/yt/wiki/changes', {
      op: 'merge',
      address: 'papers/xx',
      from: 'papers/yy',
      body: 'Merged.',
      reason: 'same paper',
    })
    assert.equal(r.status, 201, r.text)
    const h = await health()
    assert.equal(
      h.conflicts.some((c) => c.a === 'papers/xx' || c.b === 'papers/xx'),
      false,
    )
    assert.equal(
      h.debates.some((d) => d.a === 'papers/xx' && d.b === 'papers/zz'),
      true,
    )
  })

  it('an import is a baseline: the cleanup is not due for 24 hours after it', async () => {
    assert.equal((await health()).maintenance.suggested, true)
    await w.db.query("UPDATE brains SET imported_at = $1, imported_from = 'a folder' WHERE slug = 'yt'", [
      w.clock(),
    ])
    assert.equal((await health()).maintenance.suggested, false)
    w.advance(25 * 3_600_000)
    assert.equal((await health()).maintenance.suggested, true)
  })
})
