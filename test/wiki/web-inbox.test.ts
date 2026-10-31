// What the proposals inbox of the web needs from v1 (spec B6 «Proposals: la bandeja», CA17; PR21): any member
// reads a proposal as the curator does (its pages before and after), in the web, without deciding; the
// review says whether the person may decide, so the web offers only what the server allows. The list and
// the review name who proposed and who decided, and the first page of the list counts each status (the
// tabs of the inbox). Deciding stays the curators', in the web only.
import assert from 'node:assert/strict'
import { after, before, describe, it } from 'node:test'
import { skipPg } from '../helpers/pg.ts'
import { type World, world } from '../helpers/world.ts'

type Named = { authorName: string; decidedByName: string | null; status: string }

describe('the proposals inbox of the web (PR21)', { skip: skipPg }, () => {
  let w: World
  let eric: { id: string; key: string }
  let rita: { id: string; key: string }
  let ana: { id: string; key: string }
  let factory: { id: string; key: string }
  let ericWeb: string
  let ritaWeb: string
  let anaWeb: string
  let entry = ''

  const propose = async (address: string, title = `Create ${address}`) => {
    const r = await w.call(factory.key, 'POST', '/v1/brains/inbox/proposals', {
      title,
      reason: 'The journal says so.',
      agent: 'Claude Code',
      ops: [
        {
          op: 'create',
          address,
          type: 'topic',
          title: `Page ${address}`,
          summary: 'A page.',
          body: 'Text.',
          sources: [{ entryId: entry }],
          reason: 'One learning.',
        },
      ],
    })
    assert.equal(r.status, 201, r.text)
    return (r.body.proposal as { id: string }).id
  }

  before(async () => {
    w = await world()
    eric = await w.person('Eric')
    rita = await w.person('Rita')
    ana = await w.person('Ana')
    factory = await w.service('Factory')
    await w.call(eric.key, 'POST', '/v1/brains', { slug: 'inbox', purpose: 'Inbox.' })
    await w.member('inbox', rita.id, 'reader')
    await w.member('inbox', ana.id, 'contributor')
    await w.member('inbox', factory.id, 'contributor')
    ericWeb = await w.web(eric.id)
    ritaWeb = await w.web(rita.id)
    anaWeb = await w.web(ana.id)
    const saved = await w.call(factory.key, 'POST', '/v1/brains/inbox/entries', {
      type: 'learning',
      title: 'One',
      content: 'One learning.',
    })
    entry = (saved.body.receipt as { entryId: string }).entryId
  })
  after(async () => w.close())

  it('CA17: a reader and a contributor read the review in the web, and are told they cannot decide', async () => {
    const id = await propose('read/only')
    for (const session of [ritaWeb, anaWeb]) {
      const r = await w.callWeb(session, 'GET', `/v1/proposals/${id}/review`)
      assert.equal(r.status, 200, r.text)
      assert.equal(r.body.canDecide, false)
      assert.equal((r.body.ops as unknown[]).length, 1)
      const fp = String(r.body.fingerprint)
      const tried = await w.callWeb(session, 'POST', `/v1/proposals/${id}/approve`, { fingerprint: fp })
      assert.deepEqual([tried.status, tried.body.error?.code], [403, 'forbidden'])
      const back = await w.callWeb(session, 'POST', `/v1/proposals/${id}/return`, {
        fingerprint: fp,
        comment: 'No.',
      })
      assert.deepEqual([back.status, back.body.error?.code], [403, 'forbidden'])
    }
    const mine = await w.callWeb(ericWeb, 'GET', `/v1/proposals/${id}/review`)
    assert.equal(mine.body.canDecide, true)
    // A key still reads no review: reviewing and deciding are the web's (B2 CA9).
    const byKey = await w.call(rita.key, 'GET', `/v1/proposals/${id}/review`)
    assert.deepEqual([byKey.status, byKey.body.error?.code], [403, 'web_only'])
    // Someone outside the brain sees nothing.
    const stranger = await w.person('Stranger')
    assert.equal((await w.callWeb(await w.web(stranger.id), 'GET', `/v1/proposals/${id}/review`)).status, 404)
  })

  it('an archived brain: its curator reads the review but cannot decide', async () => {
    await w.call(eric.key, 'POST', '/v1/brains', { slug: 'inbox-old', purpose: 'Old.' })
    await w.member('inbox-old', factory.id, 'contributor')
    const saved = await w.call(factory.key, 'POST', '/v1/brains/inbox-old/entries', {
      type: 'learning',
      title: 'Old',
      content: 'Old learning.',
    })
    const p = await w.call(factory.key, 'POST', '/v1/brains/inbox-old/proposals', {
      title: 'Old',
      ops: [
        {
          op: 'create',
          address: 'old/page',
          type: 'topic',
          title: 'Old page',
          summary: 'Old.',
          body: 'Old.',
          sources: [{ entryId: (saved.body.receipt as { entryId: string }).entryId }],
          reason: 'Old.',
        },
      ],
    })
    const id = (p.body.proposal as { id: string }).id
    const archived = await w.callWeb(ericWeb, 'POST', '/v1/brains/inbox-old/archive')
    assert.equal(archived.status, 200, archived.text)
    const r = await w.callWeb(ericWeb, 'GET', `/v1/proposals/${id}/review`)
    assert.equal(r.status, 200, r.text)
    assert.equal(r.body.canDecide, false)
  })

  it('the list and the review name who proposed and who decided; the first page counts each status', async () => {
    const a = await propose('named/a', 'Named A')
    const b = await propose('named/b', 'Named B')
    await propose('named/c', 'Named C')
    const fp = String((await w.callWeb(ericWeb, 'GET', `/v1/proposals/${a}/review`)).body.fingerprint)
    const done = await w.callWeb(ericWeb, 'POST', `/v1/proposals/${a}/approve`, { fingerprint: fp })
    assert.equal(done.status, 200, done.text)
    assert.equal((done.body.proposal as Named).decidedByName, 'Eric')
    assert.equal((done.body.proposal as Named).authorName, 'Factory')
    const fpb = String((await w.callWeb(ericWeb, 'GET', `/v1/proposals/${b}/review`)).body.fingerprint)
    const back = await w.callWeb(ericWeb, 'POST', `/v1/proposals/${b}/return`, {
      fingerprint: fpb,
      comment: 'Not yet.',
    })
    assert.equal((back.body.proposal as Named).decidedByName, 'Eric')

    const approved = await w.callWeb(ritaWeb, 'GET', '/v1/brains/inbox/proposals?status=approved')
    const item = (approved.body.items as Array<Named & { title: string }>).find((x) => x.title === 'Named A')
    assert.deepEqual([item?.authorName, item?.decidedByName], ['Factory', 'Eric'])
    const counts = approved.body.counts as Record<string, number>
    assert.equal(counts.approved, 1)
    assert.equal(counts.returned, 1)
    assert.ok((counts.pending ?? 0) >= 1)
    for (const k of ['partially_approved', 'withdrawn', 'superseded']) assert.equal(counts[k], 0, k)
    const pending = await w.callWeb(ritaWeb, 'GET', '/v1/brains/inbox/proposals?limit=1')
    assert.equal((pending.body.items as Named[])[0]?.decidedByName, null)
    assert.ok(pending.body.next, 'more than one pending')
    const second = await w.callWeb(
      ritaWeb,
      'GET',
      `/v1/brains/inbox/proposals?limit=1&cursor=${String(pending.body.next)}`,
    )
    assert.equal(second.body.counts, undefined, 'counts come with the first page only')

    const review = await w.callWeb(anaWeb, 'GET', `/v1/proposals/${a}/review`)
    const p = review.body.proposal as Named
    assert.deepEqual([p.status, p.authorName, p.decidedByName], ['approved', 'Factory', 'Eric'])
  })
})
