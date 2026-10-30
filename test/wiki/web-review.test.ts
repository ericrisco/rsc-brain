// Review of PR19 (spec B6 «Wiki», B2 «Historia» and «Registro»): what the web needs from v1 to tell a person
// what each change was and why, to show every page of the map whatever its status, and to read a page
// once per visit. Every revision says what kind of change made it (created, edited, linked, a status,
// moved, restored) and the curator's reason; the log says it too, with the new status of a direct
// status change. A page read with its history records one read, not two. The map can list every
// status (the web's map), while the default map stays as B2 says: current pages only. A link to a stale
// page says so. A page says who saved its last revision (the conflict of an edit names them).
import assert from 'node:assert/strict'
import { after, before, describe, it } from 'node:test'
import { skipPg } from '../helpers/pg.ts'
import { type World, world } from '../helpers/world.ts'

type Summary = {
  revision: number
  change: string
  status: string
  restoredFrom: number | null
  reason: string | null
}

describe('the wiki as the web shows it (PR19 review)', { skip: skipPg }, () => {
  let w: World
  let eric: { id: string; key: string }
  let factory: { id: string; key: string }
  let web: string

  const change = async (op: Record<string, unknown>) => {
    const r = await w.callWeb(web, 'POST', '/v1/brains/rv/wiki/changes', op)
    assert.equal(r.status, 201, r.text)
    return r.body
  }
  const create = (address: string, extra: Record<string, unknown> = {}) =>
    change({
      op: 'create',
      address,
      type: 'topic',
      title: `Page ${address}`,
      summary: `About ${address}.`,
      body: `Text of ${address}.`,
      tags: [],
      sources: [],
      reason: `Start ${address}.`,
      ...extra,
    })
  const history = async (address: string) => {
    const r = await w.call(eric.key, 'GET', `/v1/brains/rv/pages/${address}?history=1`)
    assert.equal(r.status, 200, r.text)
    return r.body.history as Summary[]
  }

  before(async () => {
    w = await world()
    eric = await w.person('Eric')
    factory = await w.person('Factory')
    await w.call(eric.key, 'POST', '/v1/brains', { slug: 'rv', purpose: 'Review.' })
    await w.member('rv', factory.id, 'contributor')
    web = await w.web(eric.id)
    await create('a/one')
    await create('a/two')
    await change({ op: 'edit', address: 'a/one', baseRevision: 1, body: 'Edited.', reason: 'Shorter.' })
    await change({ op: 'link', address: 'a/one', kind: 'related', to: 'a/two', reason: 'They go together.' })
    await change({ op: 'status', address: 'a/two', status: 'stale', reason: 'Numbers are old.' })
    await change({ op: 'move', address: 'a/one', to: 'a/first', reason: 'Better name.' })
    await change({ op: 'revert', address: 'a/first', toRevision: 2, reason: 'Back to the edit.' })
  })
  after(async () => w.close())

  it('each revision says what changed and why', async () => {
    const one = await history('a/first')
    assert.deepEqual(
      one.map((r) => [r.revision, r.change, r.reason, r.restoredFrom]),
      [
        [1, 'created', 'Start a/one.', null],
        [2, 'edited', 'Shorter.', null],
        [3, 'linked', 'They go together.', null],
        [4, 'moved', 'Better name.', null],
        [5, 'restored', 'Back to the edit.', 2],
      ],
    )
    const two = await history('a/two')
    assert.deepEqual(
      two.map((r) => [r.change, r.status, r.reason]),
      [
        ['created', 'current', 'Start a/two.'],
        ['status', 'stale', 'Numbers are old.'],
      ],
    )
  })

  it("a revision from a proposal gives the operation's reason", async () => {
    const p = await w.call(factory.key, 'POST', '/v1/brains/rv/proposals', {
      title: 'New page',
      reason: 'The whole proposal.',
      ops: [
        {
          op: 'create',
          address: 'a/proposed',
          type: 'topic',
          title: 'Proposed',
          summary: 'S.',
          body: 'B.',
          tags: [],
          sources: [{ url: 'https://example.test/x' }],
          links: [],
          reason: 'This one op.',
        },
      ],
    })
    assert.equal(p.status, 201, p.text)
    const id = (p.body.proposal as { id: string }).id
    const review = await w.callWeb(web, 'GET', `/v1/proposals/${id}/review`)
    const ok = await w.callWeb(web, 'POST', `/v1/proposals/${id}/approve`, {
      fingerprint: (review.body as { fingerprint: string }).fingerprint,
    })
    assert.equal(ok.status, 200, ok.text)
    const h = await history('a/proposed')
    assert.deepEqual(
      h.map((r) => [r.change, r.reason]),
      [['created', 'This one op.']],
    )
    const log = await w.call(eric.key, 'GET', '/v1/brains/rv/wiki/log?kind=proposal')
    const line = (log.body.items as { reason: string | null }[])[0]
    assert.equal(line?.reason, 'The whole proposal.')
  })

  it('the log gives the reason, and a direct status change its new status', async () => {
    const r = await w.call(eric.key, 'GET', '/v1/brains/rv/wiki/log?kind=direct&page=a/two')
    const items = r.body.items as { summary: string; reason: string | null }[]
    const status = items.find((l) => l.summary.includes('status'))
    assert.equal(status?.summary, 'Direct status → stale: a/two')
    assert.equal(status?.reason, 'Numbers are old.')
  })

  it('a page read with its history is one read', async () => {
    await w.db.query('DELETE FROM trail')
    const r = await w.call(eric.key, 'GET', '/v1/brains/rv/pages/a/first?include=history')
    assert.equal(r.status, 200, r.text)
    assert.equal((r.body.page as { address: string }).address, 'a/first')
    assert.deepEqual(
      (r.body.history as Summary[]).map((x) => x.revision),
      [1, 2, 3, 4, 5],
    )
    const t = await w.call(eric.key, 'GET', '/v1/brains/rv/trail?page=a/first')
    assert.equal((t.body.items as { kind: string }[]).filter((l) => l.kind === 'read').length, 1)
    const bad = await w.call(eric.key, 'GET', '/v1/brains/rv/pages/a/first?include=everything')
    assert.equal(bad.status, 400, bad.text)
  })

  it('a page says who saved its last revision', async () => {
    const r = await w.call(eric.key, 'GET', '/v1/brains/rv/pages/a/two')
    assert.deepEqual(r.body.lastChange, {
      revision: 2,
      authorId: eric.id,
      authorName: 'Eric',
      at: (r.body.page as { updatedAt: string }).updatedAt,
    })
  })

  it('the map lists every status when asked, each page with its status; by default current only', async () => {
    type Map = { groups: { pages: { address: string; status: string }[] }[]; count: number }
    const pages = (m: Map) => m.groups.flatMap((g) => g.pages.map((p) => [p.address, p.status]))
    const plain = (await w.call(eric.key, 'GET', '/v1/brains/rv/wiki/map')).body as unknown as Map
    assert.deepEqual(pages(plain), [
      ['a/first', 'current'],
      ['a/proposed', 'current'],
    ])
    const all = (await w.call(eric.key, 'GET', '/v1/brains/rv/wiki/map?status=all')).body as unknown as Map
    assert.deepEqual(pages(all), [
      ['a/first', 'current'],
      ['a/proposed', 'current'],
      ['a/two', 'stale'],
    ])
    assert.equal(all.count, 3)
    assert.equal((await w.call(eric.key, 'GET', '/v1/brains/rv/wiki/map?status=old')).status, 400)
  })

  it('a link to a stale page says it is stale', async () => {
    const r = await w.call(eric.key, 'GET', '/v1/brains/rv/pages/a/first')
    const out = r.body.links as { out: { kind: string; address: string; state: string }[] }
    // Revision 5 restored revision 2, which had no typed link; link again to see the state.
    await change({ op: 'link', address: 'a/first', kind: 'related', to: 'a/two', reason: 'Again.' })
    const again = await w.call(eric.key, 'GET', '/v1/brains/rv/pages/a/first')
    const links = (again.body.links as typeof out).out
    assert.equal(links.find((l) => l.address === 'a/two')?.state, 'stale')
  })

  it('a purged revision loses its reason too', async () => {
    const admin = await w.person('Admin', { isAdmin: true })
    const s = await w.web(admin.id)
    const r = await w.callWeb(s, 'POST', '/v1/brains/rv/wiki/purge', {
      address: 'a/two',
      revision: 2,
      text: ['Numbers are old'],
      reason: 'Personal data.',
    })
    assert.equal(r.status, 200, r.text)
    const h = await history('a/two')
    assert.equal(h.find((x) => x.revision === 2)?.reason, null)
    for (const t of ['page_revisions', 'wiki_log']) {
      const dump = JSON.stringify(await w.db.query(`SELECT * FROM ${t}`))
      assert.ok(!dump.includes('Numbers are old'), t)
    }
  })
})
