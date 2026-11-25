// Review round 1 of T005–T008 (correctness): an undo puts back only what the change itself changed. What a later write
// did — a link into the page, an address another page took — is never lost silently: it stays, or it is a conflict a
// person decides. A part that cannot be put back (its revision before was purged) stops the whole undo. Parts of the
// proposal still waiting that need an undone part go with it. Spec learning-memory A2, CA-A10.
import assert from 'node:assert/strict'
import { after, before, describe, it } from 'node:test'
import { skipPg } from '../helpers/pg.ts'
import { type World, world } from '../helpers/world.ts'

type Json = Record<string, unknown>

describe('undo leaves later writes alone (review round 1)', { skip: skipPg }, () => {
  let w: World
  let cora: { id: string; key: string }
  let cole: { id: string; key: string }
  let coraWeb: string
  let writer: string
  let source: string

  const create = (address: string, extra: Json = {}) => ({
    op: 'create',
    address,
    type: 'topic',
    title: `Page ${address}`,
    summary: `About ${address}.`,
    body: `Text of ${address}.`,
    sources: [{ entryId: source }],
    reason: 'From the journal.',
    ...extra,
  })
  const byWeb = async (op: Json) => {
    const r = await w.callWeb(coraWeb, 'POST', '/v1/brains/ul/wiki/changes', op)
    assert.ok(r.status < 300, r.text)
    return r
  }
  const plant = (address: string, extra: Json = {}) =>
    byWeb({ op: 'create', address, type: 'topic', title: address, summary: address, body: address, ...extra })
  const undo = (id: string, body: Json = {}, key?: string) =>
    key
      ? w.call(key, 'POST', `/v1/wiki/changes/${id}/undo`, body)
      : w.callWeb(coraWeb, 'POST', `/v1/wiki/changes/${id}/undo`, body)
  const links = async (from: string) =>
    (
      await w.db.query<{ kind: string; to: string }>(
        `SELECT l.kind, t.address AS to FROM page_links l JOIN pages f ON f.id = l.from_page JOIN pages t ON t.id = l.to_page
          JOIN brains b ON b.id = f.brain_id WHERE b.slug = 'ul' AND f.address = $1 AND f.status <> 'retired' ORDER BY 1, 2`,
        [from],
      )
    ).map((l) => `${l.kind} ${l.to}`)
  const holder = async (address: string) =>
    (
      await w.db.one<{ title: string }>(
        `SELECT p.title FROM page_addresses a JOIN pages p ON p.id = a.page_id JOIN brains b ON b.id = a.brain_id
          WHERE b.slug = 'ul' AND a.address = $1`,
        [address],
      )
    )?.title

  before(async () => {
    w = await world()
    cora = await w.person('Cora')
    cole = await w.person('Cole')
    await w.call(cora.key, 'POST', '/v1/brains', { slug: 'ul', purpose: 'Undo later.' })
    await w.member('ul', cole.id, 'contributor')
    coraWeb = await w.web(cora.id)
    const coleWeb = await w.web(cole.id)
    const t = await w.callWeb(coleWeb, 'POST', '/v1/me/tokens', {
      name: 'Cole writer',
      perm: 'write',
      brains: ['ul'],
      days: 30,
    })
    const tok = t.body.token as { id: string; secret: string }
    writer = tok.secret
    assert.equal((await w.callWeb(coraWeb, 'PUT', `/v1/brains/ul/wiki/writers/${tok.id}`)).status, 200)
    const e = await w.call(cole.key, 'POST', '/v1/brains/ul/entries', {
      type: 'learning',
      title: 'S',
      content: 'S.',
    })
    source = (e.body.receipt as { entryId: string }).entryId
  })
  after(async () => w.close())

  it('U1: a link into the page that a later page made stays after the undo', async () => {
    await plant('pa')
    const c = await w.call(cole.key, 'POST', '/v1/brains/ul/proposals', {
      title: 'Edit pa',
      ops: [{ op: 'edit', address: 'pa', baseRevision: 1, body: 'Agent words.', reason: 'R.' }],
    })
    await plant('qa', { links: [{ kind: 'related', to: 'pa' }] })
    const r = await undo(String(c.body.undo))
    assert.equal(r.status, 200, r.text)
    assert.deepEqual(await links('qa'), ['related pa'])
  })

  it('U2: a part whose revision before was purged stops the whole undo (409 undo_purged); nothing changes', async () => {
    await plant('bx')
    await plant('by')
    const c = await w.call(cole.key, 'POST', '/v1/brains/ul/proposals', {
      title: 'Merge',
      ops: [
        {
          op: 'merge',
          address: 'bx',
          from: 'by',
          body: 'Both.',
          dropSources: [],
          dropLinks: [],
          reason: 'Same.',
        },
      ],
    })
    await w.db.query(
      `UPDATE page_revisions r SET purged_at = now(), body = '' FROM pages p JOIN brains b ON b.id = p.brain_id
        WHERE r.page_id = p.id AND b.slug = 'ul' AND p.address = 'by' AND r.revision = 1`,
    )
    const before = await w.db.query('SELECT address, status, revision, body FROM pages ORDER BY id')
    const r = await undo(String(c.body.undo))
    assert.equal(r.status, 409, r.text)
    assert.equal(r.body.error?.code, 'undo_purged')
    assert.match(String(r.body.error?.message), /by/)
    assert.deepEqual(
      await w.db.query('SELECT address, status, revision, body FROM pages ORDER BY id'),
      before,
    )
    assert.equal(await holder('by'), 'bx')
  })

  it('U3: a waiting part that needs an undone part is discarded with the undo; approving it later is refused', async () => {
    await plant('prot')
    await w.callWeb(coraWeb, 'PUT', '/v1/brains/ul/protection/prot', { protected: true })
    const c = await w.call(cole.key, 'POST', '/v1/brains/ul/proposals', {
      title: 'New page and a link',
      ops: [create('newp'), { op: 'link', address: 'prot', kind: 'related', to: 'newp', reason: 'See.' }],
    })
    const id = (c.body.proposal as { id: string }).id
    const r = await undo(String(c.body.undo))
    assert.equal(r.status, 200, r.text)
    assert.deepEqual(r.body.discarded, [1])
    const ops = (await w.call(cora.key, 'GET', `/v1/proposals/${id}`)).body.ops as Array<{ status: string }>
    assert.deepEqual(
      ops.map((o) => o.status),
      ['undone', 'undone'],
    )
    // A person makes another page at that address; the old link must not land on it.
    await plant('newp')
    const review = await w.callWeb(coraWeb, 'GET', `/v1/proposals/${id}/review`)
    const ok = await w.callWeb(coraWeb, 'POST', `/v1/proposals/${id}/approve`, {
      fingerprint: review.body.fingerprint,
      approve: [1],
    })
    assert.ok([400, 409].includes(ok.status), ok.text)
    assert.deepEqual(await links('prot'), [])
  })

  it('U4: an address another page took since is a conflict; overwrite does not take it from that page', async () => {
    const made = await w.call(writer, 'POST', '/v1/brains/ul/wiki/write', {
      title: 'Dd',
      ops: [create('dd')],
    })
    const un = await undo(String(made.body.undo), {}, writer)
    assert.equal(un.status, 200, un.text)
    await plant('dd', { title: 'Newcomer' })
    // The key's undo is a change of its own; undoing it would bring dd back over the newcomer.
    const back = (await w.call(cora.key, 'GET', '/v1/brains/ul/wiki/changes')).body.items as Array<{
      id: string
      title: string
    }>
    const undoChange = back.find((x) => /Undone: Written directly/.test(x.title))
    assert.ok(undoChange, JSON.stringify(back))
    for (const body of [{}, { overwrite: ['dd'] }]) {
      const r = await undo(undoChange.id, body)
      assert.equal(r.status, 409, r.text)
      assert.equal(r.body.error?.code, 'undo_conflict')
      assert.match(String(r.body.error?.message), /dd/)
      assert.equal(await holder('dd'), 'Newcomer')
    }
  })
})
