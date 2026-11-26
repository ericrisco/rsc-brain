// What the usability audit of T010 asked of the server (usability-t1.md, B1, B2, M1, M2, M4, M5): a partly undone change
// still awaits review; the wiki list says which pages are unreviewed and filters them; a page names the change that
// left it unreviewed; the tray lists the pages each change touched and filters by date; a part says what its operation
// did and why; an undo conflict names who wrote later and when, and an overwrite says what it replaced; an undone change
// keeps its comment and the correction it made. Spec learning-memory A2.
import assert from 'node:assert/strict'
import { after, before, describe, it } from 'node:test'
import { skipPg } from '../helpers/pg.ts'
import { type World, world } from '../helpers/world.ts'

type Json = Record<string, unknown>

describe('Review later, as people use it (usability T1)', { skip: skipPg }, () => {
  let w: World
  let cora: { id: string; key: string }
  let cole: { id: string; key: string }
  let coraWeb: string
  let source: string

  const plant = (address: string, extra: Json = {}) =>
    w.callWeb(coraWeb, 'POST', '/v1/brains/ru/wiki/changes', {
      op: 'create',
      address,
      type: 'topic',
      title: address,
      summary: address,
      body: address,
      ...extra,
    })
  const create = (address: string) => ({
    op: 'create',
    address,
    type: 'topic',
    title: `Page ${address}`,
    summary: `About ${address}.`,
    body: `Text of ${address}.`,
    sources: [{ entryId: source }],
    reason: `Why ${address}.`,
  })
  const propose = async (title: string, ops: Json[]) => {
    const r = await w.call(cole.key, 'POST', '/v1/brains/ru/proposals', { title, ops })
    assert.equal(r.status, 201, r.text)
    return String(r.body.undo)
  }
  const tray = async (query = '') =>
    (await w.callWeb(coraWeb, 'GET', `/v1/brains/ru/wiki/changes${query}`)).body as {
      items: Array<Json & { id: string; state: string; pages: Array<{ address: string; op: string | null }> }>
      total: number
    }
  const stats = async () =>
    ((await w.call(cora.key, 'GET', '/v1/brains/ru')).body.brain as { stats: { pendingReview: number } })
      .stats

  before(async () => {
    w = await world()
    cora = await w.person('Cora')
    cole = await w.person('Cole')
    await w.call(cora.key, 'POST', '/v1/brains', { slug: 'ru', purpose: 'Usability.' })
    await w.member('ru', cole.id, 'contributor')
    coraWeb = await w.web(cora.id)
    const e = await w.call(cole.key, 'POST', '/v1/brains/ru/entries', {
      type: 'learning',
      title: 'S',
      content: 'S.',
    })
    source = (e.body.receipt as { entryId: string }).entryId
  })
  after(async () => w.close())

  it('B2: a partly undone change still awaits review, in the tray and in the count, until kept', async () => {
    const id = await propose('Two pages', [create('two/a'), create('two/b')])
    assert.equal((await stats()).pendingReview, 1)
    const r = await w.callWeb(coraWeb, 'POST', `/v1/wiki/changes/${id}/undo`, { parts: [0] })
    assert.equal(r.status, 200, r.text)
    const t = await tray()
    const it = t.items.find((x) => x.id === id)
    assert.equal(it?.state, 'partly_undone')
    assert.equal((await stats()).pendingReview, 1)
    const kept = await w.callWeb(coraWeb, 'POST', `/v1/wiki/changes/${id}/keep`)
    assert.equal(kept.status, 200, kept.text)
    assert.equal(
      (await tray()).items.some((x) => x.id === id),
      false,
    )
    assert.equal((await stats()).pendingReview, 0)
  })

  it('B1: the wiki list marks and filters unreviewed pages; a page names its change', async () => {
    const id = await propose('Unreviewed', [create('un/one')])
    await plant('un/two')
    const all = (await w.call(cora.key, 'GET', '/v1/brains/ru/wiki/pages?prefix=un')).body.items as Array<{
      address: string
      unreviewed: boolean
    }>
    assert.deepEqual(
      all.map((p) => [p.address, p.unreviewed]),
      [
        ['un/one', true],
        ['un/two', false],
      ],
    )
    const only = (await w.call(cora.key, 'GET', '/v1/brains/ru/wiki/pages?unreviewed=1')).body
      .items as Array<{
      address: string
    }>
    assert.ok(only.some((p) => p.address === 'un/one'))
    assert.ok(!only.some((p) => p.address === 'un/two'))
    const page = (await w.callWeb(coraWeb, 'GET', '/v1/brains/ru/pages/un/one')).body as {
      reviewChange: string | null
    }
    assert.equal(page.reviewChange, id)
    const plain = (await w.callWeb(coraWeb, 'GET', '/v1/brains/ru/pages/un/two')).body as {
      reviewChange: string | null
    }
    assert.equal(plain.reviewChange, null)
    // The latest change awaiting review names the page (closing review N4); a reader is not told (R4).
    w.advance(60_000)
    const before = (await w.call(cole.key, 'GET', '/v1/brains/ru/pages/un/one')).body as {
      page: { revision: number }
    }
    const newer = await propose('Unreviewed, again', [
      { op: 'edit', address: 'un/one', baseRevision: before.page.revision, body: 'Again.', reason: 'Again.' },
    ])
    const again = (await w.callWeb(coraWeb, 'GET', '/v1/brains/ru/pages/un/one')).body as {
      reviewChange: string | null
    }
    assert.equal(again.reviewChange, newer)
    const asCole = (await w.call(cole.key, 'GET', '/v1/brains/ru/pages/un/one')).body as {
      reviewChange?: string | null
    }
    assert.equal(asCole.reviewChange ?? null, null)
  })

  it('M1 and M2: the tray lists the pages and operations; since filters; a part says what it did and why', async () => {
    await plant('m/target')
    await plant('m/old')
    const id = await propose('Link and move', [
      { op: 'link', address: 'm/target', kind: 'related', to: 'm/old', reason: 'They go together.' },
      { op: 'move', address: 'm/old', to: 'm/new', reason: 'A better name.' },
    ])
    const it = (await tray()).items.find((x) => x.id === id)
    assert.deepEqual(it?.pages, [
      { address: 'm/target', op: 'link' },
      { address: 'm/new', op: 'move' },
    ])
    const later = new Date(w.now.getTime() + 60_000).toISOString()
    assert.equal((await tray(`?since=${encodeURIComponent(later)}`)).items.length, 0)
    // The total counts with the same filter (closing review N2).
    assert.equal((await tray(`?since=${encodeURIComponent(later)}`)).total, 0)
    assert.ok((await tray()).total > 0)
    assert.ok(
      (await tray(`?since=${encodeURIComponent(w.now.toISOString())}`)).items.some((x) => x.id === id),
    )
    assert.equal((await w.callWeb(coraWeb, 'GET', '/v1/brains/ru/wiki/changes?since=yesterday')).status, 400)
    const parts = (await w.callWeb(coraWeb, 'GET', `/v1/wiki/changes/${id}`)).body.parts as Array<{
      operation: Json | null
    }>
    assert.deepEqual(parts[0]?.operation, {
      op: 'link',
      reason: 'They go together.',
      kind: 'related',
      to: 'm/old',
    })
    assert.deepEqual(parts[1]?.operation, {
      op: 'move',
      reason: 'A better name.',
      from: 'm/old',
      to: 'm/new',
    })
  })

  it('M4 and M5: a conflict names who wrote later and when; an overwrite says what it replaced; the comment and its correction stay', async () => {
    await plant('c/page')
    const id = await propose('Edit', [
      { op: 'edit', address: 'c/page', baseRevision: 1, body: 'Agent words.', reason: 'Clearer.' },
    ])
    w.advance(60_000)
    const at = w.now.toISOString()
    await w.callWeb(coraWeb, 'PATCH', '/v1/brains/ru/pages/c/page', { baseRevision: 2, body: 'Cora words.' })
    const clash = await w.callWeb(coraWeb, 'POST', `/v1/wiki/changes/${id}/undo`, {})
    assert.equal(clash.body.error?.code, 'undo_conflict')
    const pages = (clash.body.error as { pages?: Array<Json> }).pages ?? []
    assert.deepEqual(pages, [
      {
        address: 'c/page',
        changeRevision: 2,
        currentRevision: 3,
        editedBy: 'Cora',
        editedAt: at,
        differs: ['revision'],
        links: [],
      },
    ])
    const over = await w.callWeb(coraWeb, 'POST', `/v1/wiki/changes/${id}/undo`, {
      overwrite: ['c/page'],
      comment: 'Keep the page as it was.',
    })
    assert.equal(over.status, 200, over.text)
    assert.deepEqual(over.body.overwritten, [
      { address: 'c/page', revisions: [3], editedBy: ['Cora'], leftAsIs: [] },
    ])
    const change = (await w.callWeb(coraWeb, 'GET', `/v1/wiki/changes/${id}`)).body.change as Json
    assert.equal(change.comment, 'Keep the page as it was.')
    assert.equal(change.correction, over.body.correction)
  })
})
