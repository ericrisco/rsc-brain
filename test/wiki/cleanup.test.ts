// Spec v0.6 «Limpieza diaria», CA10, CA11: when nobody cleaned the wiki in the last 24 hours and its health has
// problems, an agent starting a session gets the suggestion to clean it, with the health report. A cleanup is a
// proposal or a direct write marked as maintenance; one approved or written in the last 24 hours, one waiting for
// approval, or a healthy wiki: no suggestion. It replaces the nudge every so many approvals.
import assert from 'node:assert/strict'
import { after, before, describe, it } from 'node:test'
import { skipPg } from '../helpers/pg.ts'
import { type World, world } from '../helpers/world.ts'

type Json = Record<string, unknown>
type Cleanup = {
  lastAt: string | null
  problems: number
  counts: Record<string, number>
  health: Json
  suggestion: string
}

const DAY = 24 * 3_600_000

describe('the daily cleanup suggestion (v0.6)', { skip: skipPg }, () => {
  let w: World
  let eric: { id: string; key: string }
  let ana: { id: string; key: string }
  let rita: { id: string; key: string }
  let ericWeb: string
  let writer: string
  let source: string

  const context = async (key: string, slug = 'yt') => {
    const r = await w.call(key, 'GET', `/v1/brains/${slug}/context`)
    assert.equal(r.status, 200, r.text)
    return r.body as { text: string; cleanup?: Cleanup }
  }
  const health = async () =>
    (await w.call(eric.key, 'GET', '/v1/brains/yt/wiki/health')).body.maintenance as {
      suggested: boolean
      lastAt: string | null
      pending: boolean
    }
  const linkOp = (to: string) => ({ op: 'link', address: 'hooks', kind: 'related', to, reason: 'Tidy.' })

  before(async () => {
    w = await world()
    eric = await w.person('Eric')
    ana = await w.person('Ana')
    rita = await w.person('Rita')
    await w.call(eric.key, 'POST', '/v1/brains', { slug: 'yt', purpose: 'Our channel.' })
    await w.call(eric.key, 'POST', '/v1/brains', { slug: 'clean', purpose: 'Healthy.' })
    await w.member('yt', ana.id, 'contributor')
    await w.member('yt', rita.id, 'reader')
    ericWeb = await w.web(eric.id)
    const anaWeb = await w.web(ana.id)
    const t = await w.callWeb(anaWeb, 'POST', '/v1/me/tokens', {
      name: 'Ana agent',
      perm: 'write',
      brains: ['yt'],
      days: 30,
    })
    writer = (t.body.token as { secret: string }).secret
    await w.callWeb(ericWeb, 'PUT', `/v1/brains/yt/wiki/writers/${(t.body.token as { id: string }).id}`)
    // Three pages that link nowhere: three orphans.
    for (const a of ['hooks', 'intros', 'endings'])
      await w.callWeb(ericWeb, 'POST', '/v1/brains/yt/wiki/changes', {
        op: 'create',
        address: a,
        type: 'topic',
        title: a,
        summary: '',
        body: `About ${a}.`,
      })
    const e = await w.call(ana.key, 'POST', '/v1/brains/yt/entries', {
      type: 'fact',
      title: 'F',
      content: 'A fact.',
    })
    source = (e.body.receipt as { entryId: string }).entryId
  })
  after(async () => w.close())

  it('CA10: no cleanup ever and problems in the health: the context brings the suggestion and the report', async () => {
    const c = await context(ana.key)
    assert.ok(c.cleanup, JSON.stringify(c))
    assert.equal(c.cleanup.lastAt, null)
    assert.equal(c.cleanup.problems, 3)
    assert.equal(c.cleanup.counts.orphans, 3)
    assert.equal((c.cleanup.health.orphans as unknown[]).length, 3)
    assert.match(c.cleanup.suggestion, /maintenance/)
    assert.match(c.text, /## Wiki cleanup suggested/)
    assert.equal((await health()).suggested, true)
  })

  it('CA11: not for someone who cannot change the wiki', async () => {
    assert.equal((await context(rita.key)).cleanup, undefined)
  })

  it('CA11: a maintenance proposal waiting for approval: no other is suggested', async () => {
    const r = await w.call(ana.key, 'POST', '/v1/brains/yt/proposals', {
      title: 'Link the orphans',
      maintenance: true,
      ops: [linkOp('intros')],
    })
    assert.equal(r.status, 201, r.text)
    assert.equal((r.body.proposal as { maintenance: boolean }).maintenance, true)
    assert.equal((await context(ana.key)).cleanup, undefined)
    assert.deepEqual([(await health()).suggested, (await health()).pending], [false, true])
    // Approved: the cleanup counts from then.
    const id = (r.body.proposal as { id: string }).id
    const fp = (await w.callWeb(ericWeb, 'GET', `/v1/proposals/${id}/review`)).body.fingerprint
    const ok = await w.callWeb(ericWeb, 'POST', `/v1/proposals/${id}/approve`, { fingerprint: fp })
    assert.equal(ok.status, 200, ok.text)
    const h = await health()
    assert.equal(h.pending, false)
    assert.equal(h.lastAt, w.clock().toISOString())
    assert.equal((await context(ana.key)).cleanup, undefined)
  })

  it('CA10: more than 24 hours later, with problems still there, it is suggested again', async () => {
    w.advance(DAY - 60_000)
    assert.equal((await context(ana.key)).cleanup, undefined)
    w.advance(2 * 60_000)
    const c = await context(ana.key)
    assert.ok(c.cleanup)
    assert.equal(c.cleanup.lastAt, (await health()).lastAt)
  })

  it('CA11: a direct write marked as maintenance is a cleanup too', async () => {
    const r = await w.call(writer, 'POST', '/v1/brains/yt/wiki/write', {
      title: 'Link the endings',
      maintenance: true,
      ops: [linkOp('endings')],
    })
    assert.equal(r.status, 201, r.text)
    assert.equal((await context(ana.key)).cleanup, undefined)
    const log = (await w.call(eric.key, 'GET', '/v1/brains/yt/wiki/log')).body.items as Json[]
    assert.equal(log[0]?.maintenance, true)
    // A write that is not a cleanup does not count as one.
    w.advance(DAY + 60_000)
    const plain = await w.call(writer, 'POST', '/v1/brains/yt/wiki/write', {
      title: 'A new page',
      ops: [
        {
          op: 'create',
          address: 'news',
          type: 'topic',
          title: 'News',
          summary: '',
          body: 'New.',
          sources: [{ entryId: source }],
          reason: 'x',
        },
      ],
    })
    assert.equal(plain.status, 201, plain.text)
    assert.ok((await context(ana.key)).cleanup)
  })

  it('CA11: a healthy wiki gets no suggestion', async () => {
    assert.equal((await context(eric.key, 'clean')).cleanup, undefined)
  })
})
