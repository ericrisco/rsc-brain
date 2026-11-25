// Spec learning-memory A1 and R1 (plan §2.3, §4.1, §8.3 M1, M2): a proposal from anyone who may propose applies at
// once, part by part. Parts on protected pages, against a person's correction or in a brain that asks first wait for
// a person; an edit written on an old revision comes back with the current page; what depends on a part that does not
// apply shares its fate. The answer says it part by part, with a request key a retry gets the same receipt, and with
// «Ask first» the proposal is the one of v0.7.15 plus the new fields. By the API and by MCP.
// CA-A1, A4, A5, A6, A7, A8, A11, A20, A24, U2.
import assert from 'node:assert/strict'
import { after, before, describe, it } from 'node:test'
import { MODERN } from '../../src/mcp/server.ts'
import { skipPg } from '../helpers/pg.ts'
import { type World, world } from '../helpers/world.ts'

type Json = Record<string, unknown>
type R1 = {
  status: 'applied' | 'held' | 'returned'
  proposal: { id: string; status: string }
  ops: Array<{ index: number; status: string; holdReason: string | null; staleCurrent: number | null }>
  pages: Array<{ page: string; revision: number; change: 'created' | 'updated' }>
  held: Array<{ op: number; address: string; reason: string; detail: string }>
  returned: Array<{
    op: number
    address: string
    reason: string
    currentRevision: number | null
    current: { revision: number; body: string } | null
  }>
  warnings: unknown[]
  coherence: unknown[]
  neighbours: unknown[]
}

describe('proposals that apply at once (spec learning-memory A1)', { skip: skipPg }, () => {
  let w: World
  let cora: { id: string; key: string }
  let cole: { id: string; key: string }
  let rita: { id: string; key: string }
  let coraWeb: string
  let writer: string
  let source: string
  let n = 0

  const propose = (key: string, body: Json, slug = 'aa') =>
    w.call(key, 'POST', `/v1/brains/${slug}/proposals`, body)
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
  const edit = (address: string, baseRevision: number, body: string) => ({
    op: 'edit',
    address,
    baseRevision,
    body,
    reason: 'Better words.',
  })
  const page = async (address: string, slug = 'aa') => {
    const r = await w.call(cora.key, 'GET', `/v1/brains/${slug}/pages/${address}`)
    return r.status === 200 ? (r.body.page as { revision: number; body: string; status: string }) : null
  }
  // A page written by the curator in the web: it is not an agent's change.
  const plant = async (address: string, slug = 'aa') => {
    const r = await w.callWeb(coraWeb, 'POST', `/v1/brains/${slug}/wiki/changes`, {
      op: 'create',
      address,
      type: 'topic',
      title: `Page ${address}`,
      summary: `About ${address}.`,
      body: `Text of ${address}.`,
    })
    assert.equal(r.status, 201, r.text)
  }
  const mcp = async (key: string, name: string, args: Json): Promise<{ error?: string; result?: Json }> => {
    n += 1
    const res = await fetch(`${w.base}/mcp`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${key}`,
        'content-type': 'application/json',
        'mcp-protocol-version': MODERN,
        'mcp-method': 'tools/call',
        'mcp-name': name,
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: n,
        method: 'tools/call',
        params: { name, arguments: args, _meta: { 'io.modelcontextprotocol/protocolVersion': MODERN } },
      }),
    })
    const body = (await res.json()) as { result: { isError: boolean; content: Array<{ text: string }> } }
    const text = body.result.content[0]?.text ?? ''
    return body.result.isError ? { error: text } : { result: JSON.parse(text) as Json }
  }
  const logLines = async (slug = 'aa') =>
    (
      await w.db.query<{ kind: string; summary: string }>(
        `SELECT l.kind, l.summary FROM wiki_log l JOIN brains b ON b.id = l.brain_id WHERE b.slug = $1
          ORDER BY l.at, l.id`,
        [slug],
      )
    ).map((l) => `${l.kind}: ${l.summary}`)

  before(async () => {
    w = await world()
    cora = await w.person('Cora')
    cole = await w.person('Cole')
    rita = await w.person('Rita')
    await w.call(cora.key, 'POST', '/v1/brains', { slug: 'aa', purpose: 'Auto apply.' })
    await w.member('aa', cole.id, 'contributor')
    await w.member('aa', rita.id, 'reader')
    coraWeb = await w.web(cora.id)
    const coleWeb = await w.web(cole.id)
    const t = await w.callWeb(coleWeb, 'POST', '/v1/me/tokens', {
      name: 'Cole writer',
      perm: 'write',
      brains: ['aa'],
      days: 30,
    })
    const tok = t.body.token as { id: string; secret: string }
    writer = tok.secret
    assert.equal((await w.callWeb(coraWeb, 'PUT', `/v1/brains/aa/wiki/writers/${tok.id}`)).status, 200)
    const e = await w.call(cole.key, 'POST', '/v1/brains/aa/entries', {
      type: 'learning',
      title: 'Hooks',
      content: 'The first 30 seconds decide.',
    })
    source = (e.body.receipt as { entryId: string }).entryId
  })
  after(async () => w.close())

  it('CA-A1: a contributor’s proposal applies at once: a revision, a log line, and the answer says so', async () => {
    const r = await propose(cole.key, { title: 'Hooks page', reason: 'Compiled.', ops: [create('hooks')] })
    assert.equal(r.status, 201, r.text)
    const b = r.body as unknown as R1
    assert.equal(b.status, 'applied')
    assert.deepEqual(b.pages, [{ page: 'hooks', revision: 1, change: 'created' }])
    assert.deepEqual([b.held, b.returned], [[], []])
    assert.equal(b.proposal.status, 'applied')
    assert.deepEqual(
      b.ops.map((o) => [o.index, o.status, o.holdReason]),
      [[0, 'applied', null]],
    )
    // What a proposal answered before is still there (additive).
    for (const k of ['warnings', 'coherence', 'neighbours']) assert.ok(Array.isArray(b[k as keyof R1]), k)
    assert.equal((await page('hooks'))?.revision, 1)
    assert.ok((await logLines()).includes('proposal: Applied at once: Hooks page'))
    // Its source is compiled, as when a curator approves.
    const e = await w.db.one<{ compiled: boolean }>('SELECT compiled FROM entries WHERE id = $1', [source])
    assert.equal(e?.compiled, true)
    // An edit of it: updated, at revision 2.
    const u = await propose(cole.key, { title: 'Hooks better', ops: [edit('hooks', 1, 'Hooks in 30 s.')] })
    assert.equal(u.status, 201, u.text)
    assert.deepEqual((u.body as unknown as R1).pages, [{ page: 'hooks', revision: 2, change: 'updated' }])
    assert.equal((await page('hooks'))?.body, 'Hooks in 30 s.')
  })

  it('CA-A4, A5: a part on a protected page waits, the other applies; the answer says it part by part', async () => {
    await plant('runbook')
    assert.equal(
      (await w.callWeb(coraWeb, 'PUT', '/v1/brains/aa/protection/runbook', { protected: true })).status,
      200,
    )
    const r = await propose(cole.key, {
      title: 'Runbook and tips',
      ops: [edit('runbook', 1, 'Changed by an agent.'), create('tips')],
    })
    assert.equal(r.status, 201, r.text)
    const b = r.body as unknown as R1
    assert.equal(b.status, 'applied')
    assert.equal(b.proposal.status, 'partially_applied')
    assert.deepEqual(b.pages, [{ page: 'tips', revision: 1, change: 'created' }])
    assert.deepEqual(
      b.held.map((h) => [h.op, h.address, h.reason]),
      [[0, 'runbook', 'protected']],
    )
    assert.match(b.held[0]?.detail ?? '', /protected/)
    assert.deepEqual(
      b.ops.map((o) => [o.status, o.holdReason]),
      [
        ['pending', 'protected'],
        ['applied', null],
      ],
    )
    const p = await page('runbook')
    assert.deepEqual([p?.revision, p?.body], [1, 'Text of runbook.'])
  })

  it('CA-A4: all of it on a protected page: nothing applies and the proposal waits for a person', async () => {
    const r = await propose(cole.key, { title: 'Only the runbook', ops: [edit('runbook', 1, 'Again.')] })
    const b = r.body as unknown as R1
    assert.equal(b.status, 'held')
    assert.equal(b.proposal.status, 'pending')
    assert.deepEqual(b.pages, [])
    assert.equal((await page('runbook'))?.revision, 1)
  })

  it('CA-A17 (facts): a key with the wiki write permission writes a protected page by proposing', async () => {
    const r = await propose(writer, {
      title: 'Runbook by a writer',
      ops: [edit('runbook', 1, 'By the writer.')],
    })
    const b = r.body as unknown as R1
    assert.equal(b.status, 'applied', r.text)
    assert.equal((await page('runbook'))?.body, 'By the writer.')
  })

  it('CA-A6: a part against a person’s correction waits, with the permission too: by a page: ref and by a source', async () => {
    await plant('style')
    const c = await w.callWeb(coraWeb, 'POST', '/v1/brains/aa/corrections', {
      title: 'Keep the intro short',
      content: 'Three seconds, no more.',
      page: 'style',
    })
    assert.equal(c.status, 201, c.text)
    const r = await propose(writer, { title: 'Style', ops: [edit('style', 1, 'Long intros.')] })
    const b = r.body as unknown as R1
    assert.deepEqual(
      b.held.map((h) => [h.address, h.reason]),
      [['style', 'correction']],
    )
    assert.equal((await page('style'))?.revision, 1)
    // A page that cites the correction as its source is a corrected page too.
    const correction = (c.body.receipt as { entryId: string }).entryId
    const s = await w.callWeb(coraWeb, 'POST', '/v1/brains/aa/wiki/changes', {
      op: 'create',
      address: 'intro-rules',
      type: 'topic',
      title: 'Intro rules',
      summary: 'Rules.',
      body: 'Short.',
      sources: [{ entryId: correction }],
    })
    assert.equal(s.status, 201, s.text)
    const t = await propose(cole.key, { title: 'Intro rules', ops: [edit('intro-rules', 1, 'Long.')] })
    assert.deepEqual(
      (t.body as unknown as R1).held.map((h) => [h.address, h.reason]),
      [['intro-rules', 'correction']],
    )
    // A «contradicts» link towards it waits; a «related» one applies.
    const l = await propose(cole.key, {
      title: 'Links to style',
      ops: [
        { op: 'link', address: 'tips', kind: 'contradicts', to: 'style', reason: 'It says otherwise.' },
        { op: 'link', address: 'hooks', kind: 'related', to: 'style', reason: 'Same topic.' },
      ],
    })
    const lb = l.body as unknown as R1
    assert.deepEqual(
      lb.held.map((h) => [h.op, h.reason]),
      [[0, 'correction']],
    )
    assert.deepEqual(
      lb.pages.map((p) => p.page),
      ['hooks'],
    )
  })

  it('CA-A24: create P and link to it from a protected page: P is created, the link waits, no link points nowhere', async () => {
    const r = await propose(cole.key, {
      title: 'New page and a link from the runbook',
      ops: [
        create('checklist'),
        { op: 'link', address: 'runbook', kind: 'related', to: 'checklist', reason: 'See.' },
      ],
    })
    const b = r.body as unknown as R1
    assert.deepEqual(b.pages, [{ page: 'checklist', revision: 1, change: 'created' }])
    assert.deepEqual(
      b.held.map((h) => [h.op, h.reason]),
      [[1, 'protected']],
    )
    const broken = await w.db.one<{ n: number }>(
      `SELECT count(*)::int AS n FROM page_links l LEFT JOIN pages t ON t.id = l.to_page
        WHERE l.to_page IS NOT NULL AND t.id IS NULL`,
    )
    assert.equal(broken?.n, 0)
    // What depends on a part that waits waits too: moving the protected page, and a link to its new address.
    const m = await propose(cole.key, {
      title: 'Move the runbook and link to it',
      ops: [
        { op: 'move', address: 'runbook', to: 'ops/runbook', reason: 'Tidy.' },
        { op: 'link', address: 'tips', kind: 'related', to: 'ops/runbook', reason: 'See.' },
      ],
    })
    const mb = m.body as unknown as R1
    assert.deepEqual(
      mb.held.map((h) => [h.op, h.reason]),
      [
        [0, 'protected'],
        [1, 'depends'],
      ],
    )
    assert.equal(mb.status, 'held')
  })

  it('an edit written on an old revision comes back with the current page; sent again on it, it applies', async () => {
    const now = (await page('hooks'))?.revision as number
    const r = await propose(cole.key, { title: 'Old base', ops: [edit('hooks', now - 1, 'From before.')] })
    assert.equal(r.status, 201, r.text)
    const b = r.body as unknown as R1
    assert.equal(b.status, 'returned')
    assert.equal(b.proposal.status, 'stale')
    assert.deepEqual(
      b.returned.map((x) => [x.op, x.address, x.reason, x.currentRevision]),
      [[0, 'hooks', 'stale', now]],
    )
    assert.equal(b.returned[0]?.current?.revision, now)
    assert.equal(b.returned[0]?.current?.body, 'Hooks in 30 s.')
    assert.deepEqual(
      b.ops.map((o) => [o.status, o.staleCurrent]),
      [['stale', now]],
    )
    const again = await propose(cole.key, { title: 'Current base', ops: [edit('hooks', now, 'From now.')] })
    assert.equal((again.body as unknown as R1).status, 'applied')
    assert.equal((await page('hooks'))?.revision, now + 1)
  })

  it('CA-A20: two proposals at once on the same revision: one applies, the other comes back, then applies', async () => {
    await plant('race')
    const [a, b] = await Promise.all([
      propose(cole.key, { title: 'Race A', ops: [edit('race', 1, 'A wins.')] }),
      propose(writer, { title: 'Race B', ops: [edit('race', 1, 'B wins.')] }),
    ])
    const outs = [a.body as unknown as R1, b.body as unknown as R1].map((x) => x.status).sort()
    assert.deepEqual(outs, ['applied', 'returned'])
    const lost = [a, b].find((x) => (x.body as unknown as R1).status === 'returned') as typeof a
    const back = (lost.body as unknown as R1).returned[0]
    assert.equal(back?.currentRevision, 2)
    assert.equal((await page('race'))?.revision, 2)
    const redo = await propose(cole.key, { title: 'Race again', ops: [edit('race', 2, 'Both, in turn.')] })
    assert.equal((redo.body as unknown as R1).status, 'applied')
    assert.equal((await page('race'))?.revision, 3)
  })

  it('CA-A11: the same request key twice: one revision, the same receipt; another request with it: 409', async () => {
    const body = { title: 'Keyed', ops: [create('keyed')], requestKey: 'rk-1' }
    const one = await propose(cole.key, body)
    const two = await propose(cole.key, body)
    assert.equal(one.status, 201, one.text)
    assert.equal(two.status, 201, two.text)
    const [x, y] = [one.body as unknown as R1, two.body as unknown as R1]
    assert.equal(y.proposal.id, x.proposal.id)
    assert.deepEqual([y.status, y.pages], [x.status, x.pages])
    const revs = await w.db.one<{ n: number }>(
      `SELECT count(*)::int AS n FROM page_revisions r JOIN pages p ON p.id = r.page_id WHERE p.address = 'keyed'`,
    )
    assert.equal(revs?.n, 1)
    const proposals = await w.db.one<{ n: number }>(
      "SELECT count(*)::int AS n FROM proposals WHERE title = 'Keyed'",
    )
    assert.equal(proposals?.n, 1)
    // The stored receipt keeps ids, revisions and reason codes: never a title or a page's text.
    const stored = await w.db.one<{ receipt: unknown }>(
      `SELECT receipt FROM request_keys WHERE receipt::text LIKE '%' || $1 || '%'`,
      [x.proposal.id],
    )
    assert.ok(stored)
    assert.doesNotMatch(JSON.stringify(stored.receipt), /Keyed|Text of keyed|About keyed/)
    const other = await propose(cole.key, { ...body, title: 'Keyed, another' })
    assert.equal(other.status, 409)
    assert.equal(other.body.error?.code, 'request_key_reused')
  })

  it('CA-A8: a reader cannot propose, as before', async () => {
    const r = await propose(rita.key, { title: 'Reader', ops: [create('by-reader')] })
    assert.equal(r.status, 403)
    assert.equal(await page('by-reader'), null)
  })

  it('by MCP: brain_propose answers the same, and takes a request key', async () => {
    const r = await mcp(cole.key, 'brain_propose', {
      brain: 'aa',
      title: 'By MCP',
      ops: [create('by-mcp')],
      requestKey: 'mcp-1',
    })
    assert.equal(r.error, undefined, r.error)
    const b = r.result as unknown as R1
    assert.equal(b.status, 'applied')
    assert.deepEqual(b.pages, [{ page: 'by-mcp', revision: 1, change: 'created' }])
    const again = await mcp(cole.key, 'brain_propose', {
      brain: 'aa',
      title: 'By MCP',
      ops: [create('by-mcp')],
      requestKey: 'mcp-1',
    })
    assert.equal((again.result as unknown as R1).proposal.id, b.proposal.id)
  })

  describe('a brain that asks first (CA-A7, U2)', () => {
    before(async () => {
      await w.call(cora.key, 'POST', '/v1/brains', { slug: 'af', purpose: 'Ask first.' })
      await w.member('af', cole.id, 'contributor')
      await plant('guide', 'af')
      const e = await w.call(cole.key, 'POST', '/v1/brains/af/entries', {
        type: 'learning',
        title: 'Guides',
        content: 'Guides help.',
      })
      source = (e.body.receipt as { entryId: string }).entryId
    })

    it('CA-U2: a proposal still waiting is left as it was when the mode changes', async () => {
      await w.callWeb(coraWeb, 'PUT', '/v1/brains/af/protection/guide', { protected: true })
      const r = await propose(cole.key, { title: 'Held before', ops: [edit('guide', 1, 'X.')] }, 'af')
      const id = (r.body as unknown as R1).proposal.id
      await w.callWeb(coraWeb, 'PUT', '/v1/brains/af/protection/guide', { protected: false })
      await w.callWeb(coraWeb, 'PUT', '/v1/brains/af/wiki/settings', { writeMode: 'ask_first' })
      await w.callWeb(coraWeb, 'PUT', '/v1/brains/af/wiki/settings', {
        base: { writeMode: 'ask_first' },
        writeMode: 'auto',
      })
      const g = await w.call(cora.key, 'GET', `/v1/proposals/${id}`)
      assert.equal((g.body.proposal as { status: string }).status, 'pending')
      assert.equal((await page('guide', 'af'))?.revision, 1)
    })

    it('nothing applies: the proposal, its parts and its decision are those of v0.7.15, plus the new fields', async () => {
      const m = await w.callWeb(coraWeb, 'PUT', '/v1/brains/af/wiki/settings', {
        base: { writeMode: 'auto' },
        writeMode: 'ask_first',
      })
      assert.equal(m.status, 200, m.text)
      const r = await propose(
        cole.key,
        { title: 'Asked first', ops: [create('asked'), edit('guide', 1, 'Y.')] },
        'af',
      )
      assert.equal(r.status, 201, r.text)
      const b = r.body as unknown as R1
      assert.equal(b.status, 'held')
      assert.equal(b.proposal.status, 'pending')
      assert.deepEqual(
        b.ops.map((o) => [o.status, o.holdReason]),
        [
          ['pending', 'ask_first'],
          ['pending', 'ask_first'],
        ],
      )
      assert.deepEqual(
        b.held.map((h) => h.reason),
        ['ask_first', 'ask_first'],
      )
      assert.deepEqual(b.pages, [])
      assert.equal(await page('asked', 'af'), null)
      // A curator approves it in the web, as before.
      const review = await w.callWeb(coraWeb, 'GET', `/v1/proposals/${b.proposal.id}/review`)
      const ok = await w.callWeb(coraWeb, 'POST', `/v1/proposals/${b.proposal.id}/approve`, {
        fingerprint: review.body.fingerprint,
      })
      assert.equal(ok.status, 200, ok.text)
      assert.equal((ok.body.proposal as { status: string }).status, 'approved')
      assert.equal((await page('asked', 'af'))?.revision, 1)
    })

    it('H1: a key with the permission still writes directly, as in v0.7.15', async () => {
      const coleWeb = await w.web(cole.id)
      const t = await w.callWeb(coleWeb, 'POST', '/v1/me/tokens', {
        name: 'Cole af writer',
        perm: 'write',
        brains: ['af'],
        days: 30,
      })
      const tok = t.body.token as { id: string; secret: string }
      assert.equal((await w.callWeb(coraWeb, 'PUT', `/v1/brains/af/wiki/writers/${tok.id}`)).status, 200)
      const r = await w.call(tok.secret, 'POST', '/v1/brains/af/wiki/write', {
        title: 'Direct',
        ops: [create('direct')],
      })
      assert.equal(r.status, 201, r.text)
      assert.equal(r.body.applied, true)
      assert.equal((await page('direct', 'af'))?.revision, 1)
    })
  })
})
