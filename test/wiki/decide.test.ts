// Spec B2: a person in the web reviews and decides; what is approved applies all at once; returned
// parts teach the agent; the map, the decisions and the log follow by themselves.
import assert from 'node:assert/strict'
import { after, before, describe, it } from 'node:test'
import { skipPg } from '../helpers/pg.ts'
import { type World, world } from '../helpers/world.ts'

type Review = {
  fingerprint: string
  ops: { index: number; dependsOn: number[]; stale: unknown; before: unknown; after: unknown }[]
}
type Decision = { proposal: { status: string }; ops: { index: number; status: string }[] }

describe('wiki decisions in the web', { skip: skipPg }, () => {
  let w: World
  let eric: { id: string; key: string }
  let eva: { id: string; key: string }
  let ana: { id: string; key: string }
  let factory: { id: string; key: string }
  let ericWeb: string
  let evaWeb: string
  let anaWeb: string
  const e: string[] = []

  const save = async (key: string, body: Record<string, unknown>) =>
    ((await w.call(key, 'POST', '/v1/brains/yt/entries', body)).body.receipt as { entryId: string }).entryId
  const create = (address: string, extra: Record<string, unknown> = {}) => ({
    op: 'create',
    address,
    type: 'topic',
    title: `Page ${address}`,
    summary: `About ${address}.`,
    body: `Text of ${address}.`,
    sources: [{ entryId: e[0] }],
    reason: 'The journal says so.',
    ...extra,
  })
  const propose = async (ops: unknown[], extra: Record<string, unknown> = {}) => {
    const r = await w.call(factory.key, 'POST', '/v1/brains/yt/proposals', { title: 'P', ops, ...extra })
    assert.equal(r.status, 201, r.text)
    return (r.body.proposal as { id: string }).id
  }
  const review = async (id: string, session = ericWeb) =>
    (await w.callWeb(session, 'GET', `/v1/proposals/${id}/review`)).body as unknown as Review
  const approve = async (id: string, body: Record<string, unknown> = {}, session = ericWeb) => {
    const fp = body.fingerprint ?? (await review(id, session)).fingerprint
    return w.callWeb(session, 'POST', `/v1/proposals/${id}/approve`, { fingerprint: fp, ...body })
  }
  const page = async (address: string) =>
    (await w.call(eric.key, 'GET', `/v1/brains/yt/pages/${address}`)).body
  const uncompiled = async () =>
    (
      (await w.call(eric.key, 'GET', '/v1/brains/yt/uncompiled?limit=200')).body.items as { id: string }[]
    ).map((x) => x.id)

  before(async () => {
    w = await world()
    eric = await w.person('Eric')
    eva = await w.person('Eva')
    ana = await w.person('Ana')
    factory = await w.service('RSC Factory')
    await w.call(eric.key, 'POST', '/v1/brains', { slug: 'yt', purpose: 'Our channel.' })
    await w.member('yt', eva.id, 'curator')
    await w.member('yt', ana.id, 'contributor')
    await w.member('yt', factory.id, 'contributor')
    ericWeb = await w.web(eric.id)
    evaWeb = await w.web(eva.id)
    anaWeb = await w.web(ana.id)
    for (const i of [1, 2, 3, 4, 5, 6, 7]) {
      e.push(await save(ana.key, { type: 'learning', title: `E${i}`, content: `Entry number ${i}.` }))
    }
  })
  after(async () => w.close())

  it('CA9: a key, even a curator token, cannot approve or edit pages; the wiki does not change', async () => {
    const id = await propose([create('ca9/page')])
    const fp = (await review(id)).fingerprint
    const byToken = await w.call(eric.key, 'POST', `/v1/proposals/${id}/approve`, { fingerprint: fp })
    assert.deepEqual([byToken.status, byToken.body.error?.code], [403, 'web_only'])
    assert.equal(byToken.body.error?.message, 'Approval happens in the web.')
    assert.equal((await w.call(eric.key, 'GET', `/v1/proposals/${id}/review`)).status, 403)
    assert.equal(
      (await w.call(eric.key, 'PATCH', '/v1/brains/yt/pages/ca9/page', { body: 'x' })).body.error?.code,
      'web_only',
    )
    assert.equal((await w.call(eric.key, 'GET', '/v1/brains/yt/pages/ca9/page')).status, 404)
    assert.equal(
      ((await w.call(eric.key, 'GET', `/v1/proposals/${id}`)).body.proposal as { status: string }).status,
      'pending',
    )
  })

  it('the web session works only as a cookie, and its writes need the web header', async () => {
    const asBearer = await w.call(ericWeb, 'GET', '/v1/brains')
    assert.deepEqual([asBearer.status, asBearer.body.error?.code], [401, 'wrong_channel'])
    const keyAsCookie = await w.callWeb(eric.key, 'GET', '/v1/brains')
    assert.deepEqual([keyAsCookie.status, keyAsCookie.body.error?.code], [401, 'wrong_channel'])
    const id = await propose([create('csrf/page')])
    const fp = (await review(id)).fingerprint
    const noHeader = await w.callWeb(
      ericWeb,
      'POST',
      `/v1/proposals/${id}/approve`,
      { fingerprint: fp },
      { csrf: false },
    )
    assert.deepEqual([noHeader.status, noHeader.body.error?.code], [403, 'csrf'])
    assert.equal((await w.callWeb(ericWeb, 'GET', '/v1/brains/yt')).status, 200)
  })

  it('only curators decide; a contributor in the web is refused; a stranger sees nothing', async () => {
    const id = await propose([create('who/decides')])
    const fp = (await review(id)).fingerprint
    assert.equal(
      (await w.callWeb(anaWeb, 'POST', `/v1/proposals/${id}/approve`, { fingerprint: fp })).status,
      403,
    )
    const stranger = await w.person('Stranger')
    const sWeb = await w.web(stranger.id)
    assert.equal((await w.callWeb(sWeb, 'GET', `/v1/proposals/${id}/review`)).status, 404)
  })

  it('CA1 + CA11: creating by proposal; the page cites its sources, is on the map, the entries leave "uncompiled", the log has it', async () => {
    const id = await propose([
      create('audience/retention', {
        sources: [{ entryId: e[0] }, { entryId: e[1] }],
        summary: 'What keeps viewers.',
      }),
      create('decisions/hooks-5s', {
        type: 'decision',
        title: 'Hooks under 5 seconds',
        sources: [{ entryId: e[0] }],
      }),
    ])
    const r = await approve(id)
    assert.equal(r.status, 200, r.text)
    assert.equal((r.body as unknown as Decision).proposal.status, 'approved')
    const p = (await page('audience/retention')) as {
      page: { revision: number }
      sources: { entryId: string }[]
    }
    assert.equal(p.page.revision, 1)
    assert.deepEqual(p.sources.map((s) => s.entryId).sort(), [e[0], e[1]].sort())
    const map = (await w.call(eric.key, 'GET', '/v1/brains/yt/wiki/map')).body as {
      groups: { pages: { address: string; summary: string }[] }[]
    }
    assert.ok(
      map.groups.some((g) =>
        g.pages.some((x) => x.address === 'audience/retention' && x.summary === 'What keeps viewers.'),
      ),
    )
    const left = await uncompiled()
    assert.ok(!left.includes(e[0] as string) && !left.includes(e[1] as string))
    const decisions = (await w.call(eric.key, 'GET', '/v1/brains/yt/wiki/decisions')).body.decisions as {
      address: string
    }[]
    assert.equal(decisions[0]?.address, 'decisions/hooks-5s')
    const log = (await w.call(eric.key, 'GET', '/v1/brains/yt/wiki/log')).body.items as {
      proposalId: string
      kind: string
    }[]
    assert.deepEqual([log[0]?.proposalId, log[0]?.kind], [id, 'proposal'])
  })

  it('CA4 + B1 CA23: approving part needs its dependencies; the rest is returned with a correction; only cited entries compile', async () => {
    const id = await propose([
      create('ca4/x', { sources: [{ entryId: e[2] }] }),
      { op: 'link', address: 'audience/retention', kind: 'related', to: 'ca4/x', reason: 'close' },
      create('ca4/other', { sources: [{ entryId: e[3] }] }),
    ])
    const rv = await review(id)
    assert.deepEqual(
      rv.ops.map((o) => o.dependsOn),
      [[], [0], []],
    )
    const noDep = await approve(id, { approve: [1], comment: 'not yet' })
    assert.deepEqual([noDep.status, noDep.body.error?.code], [400, 'missing_dependencies'])
    const noComment = await approve(id, { approve: [0] })
    assert.equal(noComment.status, 400)
    const ok = await approve(id, { approve: [0], comment: 'not yet' })
    assert.equal(ok.status, 200, ok.text)
    const d = ok.body as unknown as Decision
    assert.equal(d.proposal.status, 'partially_approved')
    assert.deepEqual(
      d.ops.map((o) => o.status),
      ['approved', 'returned', 'returned'],
    )
    assert.equal((await w.call(eric.key, 'GET', '/v1/brains/yt/pages/ca4/x')).status, 200)
    assert.equal((await w.call(eric.key, 'GET', '/v1/brains/yt/pages/ca4/other')).status, 404)
    const left = await uncompiled()
    assert.ok(!left.includes(e[2] as string) && left.includes(e[3] as string))
    const corr = await w.db.one<{ content: string; applies_to: string; author_id: string; refs: string[] }>(
      "SELECT content, applies_to, author_id, refs FROM entries WHERE type = 'correction' AND $1 = ANY(refs)",
      [id],
    )
    assert.match(corr?.content ?? '', /^not yet/)
    assert.deepEqual([corr?.applies_to, corr?.author_id], ['RSC Factory', eric.id])
  })

  it('CA4b: an edit of a moved address needs the move; an edit of a merged page needs the merge', async () => {
    const setup = await propose([create('a4b/a'), create('a4b/x'), create('a4b/y')])
    assert.equal((await approve(setup)).status, 200)
    const id = await propose([
      { op: 'move', address: 'a4b/a', to: 'a4b/b', reason: 'rename' },
      { op: 'edit', address: 'a4b/b', body: 'new body', reason: 'r', baseRevision: 1 },
      { op: 'merge', address: 'a4b/x', from: 'a4b/y', body: 'merged', reason: 'r' },
      { op: 'edit', address: 'a4b/y', summary: 'z', reason: 'r', baseRevision: 1 },
    ])
    const rv = await review(id)
    assert.deepEqual(
      rv.ops.map((o) => o.dependsOn),
      [[], [0], [], [2]],
    )
    for (const approveOnly of [[1], [3]]) {
      const r = await approve(id, { approve: approveOnly, comment: 'partial' })
      assert.equal(r.body.error?.code, 'missing_dependencies', JSON.stringify(approveOnly))
    }
  })

  it('CA5: a failure in the middle applies nothing; the proposal stays pending with the error', async () => {
    await w.db.query(`CREATE FUNCTION fail_page() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN IF NEW.address = 'ca5/p7' THEN RAISE EXCEPTION 'injected failure'; END IF; RETURN NEW; END $$`)
    await w.db.query(
      'CREATE TRIGGER fail_page BEFORE INSERT ON pages FOR EACH ROW EXECUTE FUNCTION fail_page()',
    )
    const id = await propose(Array.from({ length: 10 }, (_, i) => create(`ca5/p${i + 1}`)))
    const r = await approve(id)
    assert.equal(r.status, 409)
    assert.equal(r.body.error?.code, 'apply_failed')
    const n = await w.db.one<{ n: number }>("SELECT count(*)::int AS n FROM pages WHERE address LIKE 'ca5/%'")
    assert.equal(n?.n, 0)
    const p = (await w.call(eric.key, 'GET', `/v1/proposals/${id}`)).body.proposal as {
      status: string
      lastError: string
    }
    assert.equal(p.status, 'pending')
    assert.match(p.lastError, /could not be applied|injected/)
    await w.db.query('DROP TRIGGER fail_page ON pages')
  })

  it('CA6 + CA22: approving with an old fingerprint, or a replaced proposal, applies nothing and shows the new version', async () => {
    const id = await propose([create('ca6/one')])
    const seen = (await review(id)).fingerprint
    const id2 = await propose([create('ca6/one'), create('ca6/two')], { supersedes: id })
    const r = await approve(id, { fingerprint: seen })
    assert.deepEqual([r.status, r.body.error?.code], [409, 'proposal_changed'])
    assert.deepEqual((r.body.error as unknown as { current: { supersededBy: string } }).current, {
      supersededBy: id2,
    })
    assert.equal((await w.call(eric.key, 'GET', '/v1/brains/yt/pages/ca6/one')).status, 404)
    const stale = await approve(id2, { fingerprint: 'f'.repeat(64) })
    assert.deepEqual([stale.status, stale.body.error?.code], [409, 'proposal_changed'])
    assert.ok((stale.body.error as unknown as { current: Review }).current.fingerprint)
  })

  it('CA7: an edit on an old base shows base, current and proposed; it needs a correction or "base reviewed", which history keeps', async () => {
    const setup = await propose([create('ca7/x', { body: 'one' })])
    await approve(setup)
    const a = await propose([{ op: 'edit', address: 'ca7/x', baseRevision: 1, body: 'two', reason: 'r' }])
    const b = await propose([{ op: 'edit', address: 'ca7/x', baseRevision: 1, body: 'three', reason: 'r' }])
    await approve(a)
    const rv = await review(b)
    const st = rv.ops[0]?.stale as {
      base: { body: string }
      current: { body: string }
      proposed: { body: string }
    }
    assert.deepEqual([st.base.body, st.current.body, st.proposed.body], ['one', 'two', 'three'])
    const refused = await approve(b)
    assert.deepEqual([refused.status, refused.body.error?.code], [409, 'stale_base'])
    const ok = await approve(b, { baseReviewed: [0] })
    assert.equal(ok.status, 200, ok.text)
    const h = (await w.call(eric.key, 'GET', '/v1/brains/yt/pages/ca7/x?history=1')).body.history as {
      revision: number
      baseReviewed: boolean
    }[]
    assert.deepEqual(
      h.map((x) => [x.revision, x.baseReviewed]),
      [
        [1, false],
        [2, false],
        [3, true],
      ],
    )
  })

  it('a curator corrects an operation before approving; history says a person corrected it', async () => {
    const id = await propose([create('corr/page', { body: 'agent text' })])
    const r = await approve(id, { corrections: { 0: create('corr/page', { body: 'person text' }) } })
    assert.equal(r.status, 200, r.text)
    const p = (await page('corr/page')) as { page: { body: string } }
    assert.equal(p.page.body, 'person text')
    const h = (await w.call(eric.key, 'GET', '/v1/brains/yt/pages/corr/page?history=1')).body.history as {
      corrected: boolean
    }[]
    assert.equal(h[0]?.corrected, true)
    const other = await propose([create('corr/two')])
    const wrong = await approve(other, { corrections: { 0: create('corr/elsewhere') } })
    assert.equal(wrong.status, 400)
  })

  it('CA8: returning a proposal leaves a correction with the comment, pointing at the proposal and its author', async () => {
    const id = await propose([create('ca8/long')], { agent: 'compiler' })
    const fp = (await review(id)).fingerprint
    const r = await w.callWeb(ericWeb, 'POST', `/v1/proposals/${id}/return`, {
      fingerprint: fp,
      comment: 'too long, keep pages short',
    })
    assert.equal(r.status, 200, r.text)
    assert.equal((r.body as unknown as Decision).proposal.status, 'returned')
    const c = await w.db.one<{ content: string; applies_to: string }>(
      "SELECT content, applies_to FROM entries WHERE type = 'correction' AND $1 = ANY(refs)",
      [id],
    )
    assert.match(c?.content ?? '', /^too long, keep pages short/)
    assert.equal(c?.applies_to, 'compiler')
  })

  it('CA12: moving a page keeps links working, adds no revisions to the pages that link, and reserves the old address', async () => {
    const setup = await propose([
      create('ca12/a'),
      create('ca12/l1', { body: 'see [[ca12/a]]' }),
      create('ca12/l2', { links: [{ kind: 'related', to: 'ca12/a' }] }),
    ])
    assert.equal((await approve(setup)).status, 200)
    const mv = await propose([{ op: 'move', address: 'ca12/a', to: 'ca12/b', reason: 'rename' }])
    assert.equal((await approve(mv)).status, 200)
    const viaOld = (await page('ca12/a')) as { page: { address: string }; redirectedFrom: string }
    assert.deepEqual([viaOld.page.address, viaOld.redirectedFrom], ['ca12/b', 'ca12/a'])
    for (const a of ['ca12/l1', 'ca12/l2']) {
      const p = (await page(a)) as {
        page: { revision: number }
        links: { out: { address: string; state: string }[] }
      }
      assert.equal(p.page.revision, 1)
      assert.deepEqual(
        p.links.out.map((l) => [l.address, l.state]),
        [['ca12/b', 'ok']],
      )
    }
    const taken = await w.call(factory.key, 'POST', '/v1/brains/yt/proposals', {
      title: 'x',
      ops: [create('ca12/a')],
    })
    assert.equal(taken.status, 400)
    assert.match(taken.text, /reserved/)
  })

  it('CA13: merging y into x: x has the body, the sources and the links of y; y is superseded; links to y lead to x', async () => {
    const setup = await propose([
      create('ca13/x'),
      create('ca13/z'),
      create('ca13/y', { sources: [{ entryId: e[4] }], links: [{ kind: 'depends-on', to: 'ca13/z' }] }),
      create('ca13/in1', { links: [{ kind: 'related', to: 'ca13/y' }] }),
      create('ca13/in2', { body: 'see [[ca13/y]]' }),
    ])
    assert.equal((await approve(setup)).status, 200)
    const m = await propose([
      { op: 'merge', address: 'ca13/x', from: 'ca13/y', body: 'final body', reason: 'same thing' },
    ])
    assert.equal((await approve(m)).status, 200)
    const x = (await page('ca13/x')) as {
      page: { body: string }
      sources: { entryId: string }[]
      links: { out: { kind: string; address: string }[]; in: { kind: string; address: string }[] }
    }
    assert.equal(x.page.body, 'final body')
    assert.ok(x.sources.some((s) => s.entryId === e[4]))
    assert.ok(x.links.out.some((l) => l.kind === 'depends-on' && l.address === 'ca13/z'))
    const inbound = x.links.in.map((l) => `${l.kind}<${l.address}`).sort()
    assert.deepEqual(inbound, ['mentions<ca13/in2', 'related<ca13/in1'])
    const y = await w.db.one<{ status: string; superseded_by: string }>(
      "SELECT status, superseded_by FROM pages WHERE address = 'ca13/y'",
    )
    const xid = await w.db.one<{ id: string }>("SELECT p.id FROM pages p WHERE address = 'ca13/x'")
    assert.deepEqual([y?.status, y?.superseded_by], ['superseded', xid?.id])
    const viaY = (await page('ca13/y')) as { page: { address: string } }
    assert.equal(viaY.page.address, 'ca13/x')
  })

  it('CA14: a contradiction is an open conflict until "x supersedes y" settles it', async () => {
    const setup = await propose([
      create('ca14/x'),
      create('ca14/y', { links: [{ kind: 'contradicts', to: 'ca14/x' }] }),
    ])
    assert.equal((await approve(setup)).status, 200)
    const s = await propose([
      { op: 'link', address: 'ca14/x', kind: 'supersedes', to: 'ca14/y', reason: 'x wins' },
    ])
    assert.equal((await approve(s)).status, 200)
    const y = (await page('ca14/y')) as { page: { status: string } }
    assert.equal(y.page.status, 'superseded')
  })

  it('CA19: two curators approve at once: it applies once; the second hears who did', async () => {
    const id = await propose([create('ca19/page')])
    const fp = (await review(id)).fingerprint
    const rs = await Promise.all([
      w.callWeb(ericWeb, 'POST', `/v1/proposals/${id}/approve`, { fingerprint: fp }),
      w.callWeb(evaWeb, 'POST', `/v1/proposals/${id}/approve`, { fingerprint: fp }),
    ])
    assert.deepEqual(rs.map((r) => r.status).sort(), [200, 409])
    const second = rs.find((r) => r.status === 409)
    assert.equal(second?.body.error?.code, 'already_decided')
    assert.match(second?.body.error?.message ?? '', /Already approved by (Eric|Eva)/)
    const n = await w.db.one<{ n: number }>(
      "SELECT count(*)::int AS n FROM page_revisions r JOIN pages p ON p.id = r.page_id WHERE p.address = 'ca19/page'",
    )
    assert.equal(n?.n, 1)
  })

  it('CA21: a retired page leaves the map and the context of the wiki; its address still reads, with the notice', async () => {
    const setup = await propose([create('ca21/old')])
    await approve(setup)
    const r = await propose([{ op: 'status', address: 'ca21/old', status: 'retired', reason: 'obsolete' }])
    assert.equal((await approve(r)).status, 200)
    const map = (await w.call(eric.key, 'GET', '/v1/brains/yt/wiki/map')).body as {
      groups: { pages: { address: string }[] }[]
    }
    assert.ok(!map.groups.some((g) => g.pages.some((p) => p.address === 'ca21/old')))
    const p = (await page('ca21/old')) as { notice: string }
    assert.match(p.notice, /retired/)
  })

  it('CA23: entries collected without changes, and those an approved operation cites, leave "uncompiled"', async () => {
    const id = await propose([create('ca23/page', { sources: [{ entryId: e[5] }] })], { collected: [e[6]] })
    assert.equal((await approve(id)).status, 200)
    const left = await uncompiled()
    assert.ok(!left.includes(e[5] as string) && !left.includes(e[6] as string))
  })
})
