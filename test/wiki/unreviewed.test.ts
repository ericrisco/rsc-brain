// Spec learning-memory A1 (plan §2.4, §8.3 H1): every change to the wiki a person in the web did not make enters
// «Review later» and leaves its pages marked «unreviewed» — on the page, in search results, among neighbours and in the
// context given to agents — until a person edits the page (Keep comes with T007). A key with the wiki write permission
// too (CA-A17), and with «Ask first», its direct write and its decision (H1). A person in the web leaves no mark.
// CA-A9 (the mark), A17.
import assert from 'node:assert/strict'
import { after, before, describe, it } from 'node:test'
import { skipPg } from '../helpers/pg.ts'
import { type World, world } from '../helpers/world.ts'

type Json = Record<string, unknown>

describe('changes for review and the unreviewed mark (spec learning-memory A1)', { skip: skipPg }, () => {
  let w: World
  let cora: { id: string; key: string }
  let cole: { id: string; key: string }
  let coraWeb: string
  let writer: string
  const sources: Record<string, string> = {}

  const create = (slug: string, address: string, extra: Json = {}) => ({
    op: 'create',
    address,
    type: 'topic',
    title: `Page ${address}`,
    summary: `About ${address}.`,
    body: `The ${address} text about wombatoid.`,
    sources: [{ entryId: sources[slug] }],
    reason: 'From the journal.',
    ...extra,
  })
  const page = async (address: string, slug = 'ur') =>
    (await w.call(cora.key, 'GET', `/v1/brains/${slug}/pages/${address}`)).body.page as {
      revision: number
      unreviewed: boolean
    }
  const changes = async (slug = 'ur') =>
    w.db.query<{
      id: string
      state: string
      key_name: string | null
      proposal_id: string | null
      log_id: string
    }>(
      `SELECT c.* FROM wiki_changes c JOIN brains b ON b.id = c.brain_id WHERE b.slug = $1 ORDER BY c.created_at, c.id`,
      [slug],
    )
  const parts = async (changeId: string) =>
    w.db.query<{
      part: number
      page_id: string
      created: boolean
      revision_before: number | null
      revision_after: number
    }>('SELECT * FROM wiki_change_parts WHERE change_id = $1 ORDER BY part', [changeId])

  before(async () => {
    w = await world()
    cora = await w.person('Cora')
    cole = await w.person('Cole')
    coraWeb = await w.web(cora.id)
    const coleWeb = await w.web(cole.id)
    for (const [slug, mode] of [
      ['ur', 'auto'],
      ['ua', 'ask_first'],
    ] as const) {
      await w.call(cora.key, 'POST', '/v1/brains', { slug, purpose: slug })
      await w.member(slug, cole.id, 'contributor')
      if (mode === 'ask_first')
        assert.equal(
          (await w.callWeb(coraWeb, 'PUT', `/v1/brains/${slug}/wiki/settings`, { writeMode: 'ask_first' }))
            .status,
          200,
        )
      const e = await w.call(cole.key, 'POST', `/v1/brains/${slug}/entries`, {
        type: 'learning',
        title: 'Wombatoid',
        content: 'Wombatoid facts.',
      })
      sources[slug] = (e.body.receipt as { entryId: string }).entryId
    }
    const t = await w.callWeb(coleWeb, 'POST', '/v1/me/tokens', {
      name: 'Cole writer',
      perm: 'write',
      brains: ['ur', 'ua'],
      days: 30,
    })
    const tok = t.body.token as { id: string; secret: string }
    writer = tok.secret
    for (const slug of ['ur', 'ua'])
      assert.equal((await w.callWeb(coraWeb, 'PUT', `/v1/brains/${slug}/wiki/writers/${tok.id}`)).status, 200)
  })
  after(async () => w.close())

  it('an applied proposal enters «Review later»: the answer says how to undo it, with the change and its parts', async () => {
    const r = await w.call(cole.key, 'POST', '/v1/brains/ur/proposals', {
      title: 'Alpha',
      ops: [create('ur', 'alpha')],
    })
    assert.equal(r.status, 201, r.text)
    assert.equal(r.body.review, 'pending-review')
    assert.match(String(r.body.undo), /^chg_[0-9a-f]{12}$/)
    const [c] = await changes()
    assert.ok(c)
    assert.equal(c.id, r.body.undo)
    assert.equal(c.state, 'pending_review')
    assert.equal(c.key_name, 'test')
    assert.equal(c.proposal_id, (r.body.proposal as { id: string }).id)
    const ps = await parts(c.id)
    assert.deepEqual(
      ps.map((p) => [p.part, p.created, p.revision_before, p.revision_after]),
      [[0, true, null, 1]],
    )
    const log = await w.db.one<{ change_id: string }>('SELECT change_id FROM wiki_log WHERE id = $1', [
      c.log_id,
    ])
    assert.equal(log?.change_id, c.id)
  })

  it('CA-A9: the page is marked on reading, in search, among neighbours and in the context', async () => {
    assert.equal((await page('alpha')).unreviewed, true)
    const s = await w.call(cole.key, 'GET', '/v1/search?q=wombatoid&brains=ur&in=pages')
    assert.equal(s.status, 200, s.text)
    const hit = (s.body.items as Array<{ address: string; unreviewed?: boolean }>).find(
      (h) => h.address === 'alpha',
    )
    assert.equal(hit?.unreviewed, true)
    // A page by the curator in the web, linked to it: not marked; alpha is its neighbour, marked.
    const b = await w.callWeb(coraWeb, 'POST', '/v1/brains/ur/wiki/changes', {
      op: 'create',
      address: 'beta',
      type: 'topic',
      title: 'Beta',
      summary: 'Beta.',
      body: 'Beta wombatoid.',
      links: [{ kind: 'related', to: 'alpha' }],
    })
    assert.equal(b.status, 201, b.text)
    assert.equal((await page('beta')).unreviewed, false)
    const n = await w.call(cole.key, 'GET', '/v1/search?q=beta&brains=ur&in=pages&neighbours=1')
    const near = (n.body.neighbours as Array<{ address: string; unreviewed?: boolean }>).find(
      (h) => h.address === 'alpha',
    )
    assert.equal(near?.unreviewed, true)
    const prop = await w.call(cole.key, 'POST', '/v1/brains/ur/proposals', {
      title: 'Edit beta',
      ops: [
        { op: 'edit', address: 'beta', baseRevision: 1, body: 'Beta, again wombatoid.', reason: 'More.' },
      ],
    })
    const nb = (prop.body.neighbours as Array<{ address: string; unreviewed: boolean }>).find(
      (x) => x.address === 'alpha',
    )
    assert.equal(nb?.unreviewed, true)
    const ctx = await w.call(cole.key, 'GET', '/v1/brains/ur/context?task=wombatoid')
    assert.equal(ctx.status, 200, ctx.text)
    assert.match(String(ctx.body.text), /<<<page address=alpha [^>]*reviewed=no/)
    const item = (ctx.body.items as Array<{ address?: string; unreviewed?: boolean }>).find(
      (i) => i.address === 'alpha',
    )
    assert.equal(item?.unreviewed, true)
  })

  it('CA-A9: a curator’s edit by hand takes the mark off', async () => {
    const p = await page('alpha')
    const r = await w.callWeb(coraWeb, 'PATCH', '/v1/brains/ur/pages/alpha', {
      baseRevision: p.revision,
      body: 'Edited by Cora about wombatoid.',
    })
    assert.equal(r.status, 200, r.text)
    assert.equal((await page('alpha')).unreviewed, false)
    const ctx = await w.call(cole.key, 'GET', '/v1/brains/ur/context?task=wombatoid')
    assert.doesNotMatch(String(ctx.body.text), /<<<page address=alpha [^>]*reviewed=no/)
  })

  it('a person in the web proposing leaves no change for review and no mark', async () => {
    const before = (await changes()).length
    const r = await w.callWeb(coraWeb, 'POST', '/v1/brains/ur/proposals', {
      title: 'By Cora',
      ops: [create('ur', 'gamma')],
    })
    assert.equal(r.status, 201, r.text)
    assert.equal(r.body.status, 'applied')
    assert.deepEqual([r.body.review, r.body.undo], [null, null])
    assert.equal((await changes()).length, before)
    assert.equal((await page('gamma')).unreviewed, false)
  })

  it('CA-A17: a key with the permission writes a protected page directly: applied, for review, marked', async () => {
    await w.callWeb(coraWeb, 'PUT', '/v1/brains/ur/protection/beta', { protected: true })
    const r = await w.call(writer, 'POST', '/v1/brains/ur/wiki/write', {
      title: 'Beta by the writer',
      ops: [{ op: 'edit', address: 'beta', baseRevision: 2, body: 'Written wombatoid.', reason: 'Direct.' }],
    })
    assert.equal(r.status, 201, r.text)
    assert.match(String(r.body.undo), /^chg_/)
    assert.equal((await page('beta')).unreviewed, true)
    const c = (await changes()).find((x) => x.id === r.body.undo)
    assert.equal(c?.key_name, 'Cole writer')
    // A retry with the same request key: the same undo.
    const body = { title: 'Delta', ops: [create('ur', 'delta')], requestKey: 'u-1' }
    const one = await w.call(writer, 'POST', '/v1/brains/ur/wiki/write', body)
    const two = await w.call(writer, 'POST', '/v1/brains/ur/wiki/write', body)
    assert.equal(two.body.undo, one.body.undo)
  })

  describe('H1: «Ask first»', () => {
    it('a direct write by a key with the permission applies as in v0.7.15 and enters «Review later»', async () => {
      const r = await w.call(writer, 'POST', '/v1/brains/ua/wiki/write', {
        title: 'Ua',
        ops: [create('ua', 'ua-one')],
      })
      assert.equal(r.status, 201, r.text)
      assert.match(String(r.body.undo), /^chg_/)
      assert.equal((await page('ua-one', 'ua')).unreviewed, true)
      assert.equal((await changes('ua')).length, 1)
    })

    it('a decision by a key with the permission applies and enters «Review later»; one in the web does not', async () => {
      const p = await w.call(cole.key, 'POST', '/v1/brains/ua/proposals', {
        title: 'Two',
        ops: [create('ua', 'ua-two')],
      })
      const id = (p.body.proposal as { id: string }).id
      const review = await w.call(writer, 'GET', `/v1/proposals/${id}/review`)
      const ok = await w.call(writer, 'POST', `/v1/proposals/${id}/approve`, {
        fingerprint: review.body.fingerprint,
      })
      assert.equal(ok.status, 200, ok.text)
      assert.match(String(ok.body.undo), /^chg_/)
      assert.equal((await page('ua-two', 'ua')).unreviewed, true)
      assert.equal((await changes('ua')).length, 2)
      const q = await w.call(cole.key, 'POST', '/v1/brains/ua/proposals', {
        title: 'Three',
        ops: [create('ua', 'ua-three')],
      })
      const qid = (q.body.proposal as { id: string }).id
      const rv = await w.callWeb(coraWeb, 'GET', `/v1/proposals/${qid}/review`)
      const web = await w.callWeb(coraWeb, 'POST', `/v1/proposals/${qid}/approve`, {
        fingerprint: rv.body.fingerprint,
      })
      assert.equal(web.status, 200, web.text)
      assert.equal(web.body.undo, null)
      assert.equal((await page('ua-three', 'ua')).unreviewed, false)
      assert.equal((await changes('ua')).length, 2)
    })
  })
})
