import assert from 'node:assert/strict'
import { after, before, describe, it } from 'node:test'
import type { Review } from '../../src/domain/wiki/review.ts'
import { MAX_REPLY_CHARS } from '../../src/http/bounds.ts'
import { createClient } from '../../web/src/api/client.ts'
import { skipPg } from '../helpers/pg.ts'
import { type World, world } from '../helpers/world.ts'

describe('large proposal reviews (#52)', { skip: skipPg }, () => {
  let w: World
  let session: string
  let key: string
  const create = (address: string, body = 'Words '.repeat(1000)) => ({
    op: 'create',
    address,
    type: 'topic',
    title: address,
    summary: 'Evidence',
    body,
    sources: [{ url: 'https://example.test/evidence' }],
    reason: 'Evidence',
  })
  const propose = async (ops: unknown[]) => {
    const r = await w.call(key, 'POST', '/v1/brains/large/proposals', { title: 'Large review', ops })
    assert.equal(r.status, 201, r.text)
    return (r.body.proposal as { id: string }).id
  }
  const get = (id: string, query = '') => w.callWeb(session, 'GET', `/v1/proposals/${id}/review${query}`)
  const client = (sizes: number[]) =>
    createClient({
      here: () => '/',
      onSignedOut: () => assert.fail('unexpected sign-out'),
      transport: async (url, init) => {
        const r = await fetch(`${w.base}${url}`, {
          ...init,
          headers: { ...init.headers, cookie: `rscb_session=${session}` },
        })
        const text = await r.text()
        sizes.push(text.length)
        assert.ok(text.length <= MAX_REPLY_CHARS)
        return { status: r.status, text: async () => text, headers: r.headers }
      },
    })
  before(async () => {
    w = await world()
    const p = await w.person('Reviewer')
    key = p.key
    session = await w.web(p.id)
    assert.equal((await w.call(key, 'POST', '/v1/brains', { slug: 'large' })).status, 201)
    for (let i = 0; i < 24; i += 6) {
      const id = await propose(Array.from({ length: 6 }, (_, n) => create(`page/${i + n}`)))
      const r = await get(id)
      assert.equal(
        (await w.callWeb(session, 'POST', `/v1/proposals/${id}/approve`, { fingerprint: r.body.fingerprint }))
          .status,
        200,
      )
    }
  })
  after(async () => w?.close())

  it('loads every operation and full page states, then approves the review the browser received', async () => {
    const id = await propose(
      Array.from({ length: 24 }, (_, i) => ({
        op: 'link',
        address: `page/${i}`,
        to: `page/${(i + 1) % 24}`,
        kind: 'related',
        reason: 'Connect',
      })),
    )
    const sizes: number[] = []
    const review = await client(sizes).call<Review>('proposalReview', { path: { id } })
    assert.ok(Array.isArray(review.ops), 'a successful review must contain operations, never {cut,partial}')
    assert.equal(review.ops.length, 24)
    assert.ok(sizes.length > 1, 'the oversized review is retrieved in bounded parts')
    for (const op of review.ops) assert.equal(op.before?.body, 'Words '.repeat(1000))
    assert.equal(
      (await w.callWeb(session, 'POST', `/v1/proposals/${id}/approve`, { fingerprint: review.fingerprint }))
        .status,
      200,
    )
  })

  it('keeps all text even when one stale edit alone exceeds the response limit', async () => {
    const body = '😀 "\\\n'.repeat(12000)
    const made = await propose([create('large-edit', body)])
    const seed = await client([]).call<Review>('proposalReview', { path: { id: made } })
    assert.equal(
      (await w.callWeb(session, 'POST', `/v1/proposals/${made}/approve`, { fingerprint: seed.fingerprint }))
        .status,
      200,
    )
    assert.equal(
      (
        await w.callWeb(session, 'PATCH', '/v1/brains/large/pages/large-edit', {
          body: `${body}changed`,
          baseRevision: 1,
          reason: 'New evidence',
        })
      ).status,
      200,
    )
    const id = await propose([
      { op: 'edit', address: 'large-edit', body: `${body}proposal`, baseRevision: 1, reason: 'Edit' },
    ])
    const sizes: number[] = []
    const review = await client(sizes).call<Review>('proposalReview', { path: { id } })
    assert.ok(Array.isArray(review.ops), 'one large operation is still reviewable')
    assert.equal(review.ops[0]?.before?.body, `${body}changed`)
    assert.equal(review.ops[0]?.after?.body, `${body}proposal`)
    assert.equal(review.ops[0]?.stale?.base?.body, body)
    assert.ok(sizes.length > 1)
  })

  it('refuses to mix parts when a page changes between requests', async () => {
    const id = await propose([
      { op: 'link', address: 'page/0', to: 'page/2', kind: 'related', reason: 'Connect' },
    ])
    const first = await get(id, '?offset=0&max=1024')
    const part = first.body.reviewChunk as { next: number; snapshot: string }
    assert.ok(part?.next, 'explicit pagination works for a small review too')
    const stranger = await w.person('OtherReader')
    const other = await w.web(stranger.id)
    assert.equal(
      (
        await w.callWeb(
          other,
          'GET',
          `/v1/proposals/${id}/review?offset=${part.next}&snapshot=${part.snapshot}`,
        )
      ).status,
      404,
    )
    const current = (await w.call(key, 'GET', '/v1/brains/large/pages/page/0')).body.page as {
      revision: number
    }
    assert.equal(
      (
        await w.callWeb(session, 'PATCH', '/v1/brains/large/pages/page/0', {
          body: 'Changed after first part',
          baseRevision: current.revision,
          reason: 'New evidence',
        })
      ).status,
      200,
    )
    const next = await get(id, `?offset=${part.next}&snapshot=${part.snapshot}`)
    assert.equal(next.status, 409)
    assert.equal(next.body.error?.code, 'review_changed')
    assert.equal((await get(id, '?offset=1')).status, 400)
    assert.equal((await get(id, '?offset=-1')).status, 400)
  })
})
