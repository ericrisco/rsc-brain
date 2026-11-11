// Spec v0.7, CA1–CA9 (constitution P4, P5 v2.2.0): a key a curator let write to the wiki also decides the
// proposals of that brain, by MCP and by the API, with the four actions of the web — approve all, approve part and
// return the rest, correct an operation then approve, return all — after reading the same review the web shows and
// its fingerprint. Without the permission, or once a curator took it back, it is refused and nothing changes. A
// retry with the same request key gets the same result and decides once. The log and the activity name the key and
// its owner.
import assert from 'node:assert/strict'
import { after, before, describe, it } from 'node:test'
import { MODERN } from '../../src/mcp/server.ts'
import { skipPg } from '../helpers/pg.ts'
import { type World, world } from '../helpers/world.ts'

type Json = Record<string, unknown>
type Review = { fingerprint: string; purges: number; canDecide: boolean; ops: Json[] }

describe('deciding proposals with a key (v0.7)', { skip: skipPg }, () => {
  let w: World
  let eric: { id: string; key: string }
  let ana: { id: string; key: string }
  let factory: { id: string; key: string }
  let ericWeb: string
  let anaWeb: string
  let writer: { id: string; secret: string }
  let plain: string
  let source: string
  let n = 0

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
  const create = (address: string, extra: Json = {}) => ({
    op: 'create',
    address,
    type: 'topic',
    title: `Page ${address}`,
    summary: 'A page.',
    body: `About ${address}.`,
    sources: [{ entryId: source }],
    reason: 'From the journal.',
    ...extra,
  })
  const propose = async (ops: Json[], key = factory.key) => {
    const r = await w.call(key, 'POST', '/v1/brains/yt/proposals', { title: 'Hooks', ops })
    assert.equal(r.status, 201, r.text)
    return (r.body.proposal as { id: string }).id
  }
  const webReview = async (id: string) =>
    (await w.callWeb(ericWeb, 'GET', `/v1/proposals/${id}/review`)).body as unknown as Review
  const review = async (id: string, key = writer.secret) => {
    const r = await mcp(key, 'brain_review', { id })
    assert.equal(r.error, undefined, r.error)
    return r.result as unknown as Review
  }
  const status = async (id: string) =>
    String((await w.db.one('SELECT status FROM proposals WHERE id = $1', [id]))?.status)
  const page = async (address: string) =>
    (await w.call(eric.key, 'GET', `/v1/brains/yt/pages/${address}`)).body.page as
      | { revision: number; body: string }
      | undefined
  const corrections = async (id: string) =>
    w.db.query(
      "SELECT content, applies_to, author_id FROM entries WHERE type = 'correction' AND $1 = ANY(refs)",
      [id],
    )

  before(async () => {
    w = await world()
    eric = await w.person('Eric')
    ana = await w.person('Ana')
    factory = await w.service('RSC Factory')
    await w.call(eric.key, 'POST', '/v1/brains', { slug: 'yt', purpose: 'Our channel.' })
    await w.member('yt', ana.id, 'contributor')
    await w.member('yt', factory.id, 'contributor')
    ericWeb = await w.web(eric.id)
    anaWeb = await w.web(ana.id)
    const t = await w.callWeb(anaWeb, 'POST', '/v1/me/tokens', {
      name: 'Ana agent',
      perm: 'write',
      brains: ['yt'],
      days: 30,
    })
    writer = t.body.token as { id: string; secret: string }
    const p = await w.callWeb(anaWeb, 'POST', '/v1/me/tokens', {
      name: 'Ana other',
      perm: 'write',
      brains: ['yt'],
      days: 30,
    })
    plain = (p.body.token as { secret: string }).secret
    assert.equal((await w.callWeb(ericWeb, 'PUT', `/v1/brains/yt/wiki/writers/${writer.id}`)).status, 200)
    const e = await w.call(ana.key, 'POST', '/v1/brains/yt/entries', {
      type: 'fact',
      title: 'Hooks',
      content: 'The first 30 seconds decide.',
    })
    source = (e.body.receipt as { entryId: string }).entryId
  })
  after(async () => w.close())

  it('CA9: the key reads the review the web shows, with its fingerprint, by MCP and by the API', async () => {
    const id = await propose([
      create('ca9/one'),
      create('ca9/two', { links: [{ kind: 'related', to: 'ca9/one' }] }),
    ])
    const web = await webReview(id)
    const byMcp = await review(id)
    assert.deepEqual(byMcp, web)
    assert.equal(byMcp.canDecide, true)
    assert.match(byMcp.fingerprint, /^[0-9a-f]{64}$/)
    const byApi = await w.call(writer.secret, 'GET', `/v1/proposals/${id}/review`)
    assert.equal(byApi.status, 200, byApi.text)
    assert.deepEqual(byApi.body, web)
    // The pending queue to decide, by MCP: everyone's, not only the key's own.
    const queue = await mcp(writer.secret, 'brain_proposals', { brain: 'yt', status: 'pending', mine: false })
    assert.ok(((queue.result as Json).items as { id: string }[]).some((p) => p.id === id))
    const own = await mcp(writer.secret, 'brain_proposals', { brain: 'yt', status: 'pending' })
    assert.ok(!((own.result as Json).items as { id: string }[]).some((p) => p.id === id))
  })

  it('CA1: approved by MCP with the fingerprint seen; applied; the log names the key and its owner', async () => {
    const id = await propose([create('ca1/page')])
    const fp = (await review(id)).fingerprint
    const r = await mcp(writer.secret, 'brain_decide', { id, decision: 'approve', fingerprint: fp })
    assert.equal(r.error, undefined, r.error)
    assert.equal(((r.result as Json).proposal as Json).status, 'approved')
    assert.deepEqual(
      ((r.result as Json).applied as { address: string; revision: number }[]).map((x) => [
        x.address,
        x.revision,
      ]),
      [['ca1/page', 1]],
    )
    assert.equal((await page('ca1/page'))?.revision, 1)
    const log = (await w.call(eric.key, 'GET', '/v1/brains/yt/wiki/log')).body.items as Json[]
    assert.equal(log[0]?.kind, 'proposal')
    assert.equal(log[0]?.proposalId, id)
    assert.equal(log[0]?.actorName, 'Ana')
    assert.equal(log[0]?.keyName, 'Ana agent')
    assert.match(String(log[0]?.summary), /^Approved by Ana with the key Ana agent: Hooks/)
    const row = await w.db.one('SELECT decided_by FROM proposals WHERE id = $1', [id])
    assert.equal(row?.decided_by, ana.id)
    // The activity says it too: the decision, with the key; the change, with the log's words.
    const events = await w.db.query(
      "SELECT kind, label, account_id, credential_id FROM events WHERE target_id = $1 AND kind IN ('proposal.decided', 'wiki.changed') ORDER BY id",
      [id],
    )
    assert.deepEqual(
      events.map((e) => [e.kind, e.label, e.account_id, e.credential_id]),
      [
        ['wiki.changed', 'Approved by Ana with the key Ana agent: Hooks', ana.id, writer.id],
        ['proposal.decided', 'approved with the key Ana agent', ana.id, writer.id],
      ],
    )
  })

  it('CA1: a proposal the key itself sent can be decided by it', async () => {
    const id = await propose([create('ca1/own')], writer.secret)
    const fp = (await review(id)).fingerprint
    const r = await w.call(writer.secret, 'POST', `/v1/proposals/${id}/approve`, { fingerprint: fp })
    assert.equal(r.status, 200, r.text)
    assert.equal(await status(id), 'approved')
  })

  it('CA2: approved in part by the API; the rest goes back to its author as a correction', async () => {
    const id = await propose([create('ca2/kept'), create('ca2/back')])
    const fp = (await review(id)).fingerprint
    const r = await w.call(writer.secret, 'POST', `/v1/proposals/${id}/approve`, {
      fingerprint: fp,
      approve: [0],
      comment: 'The second page repeats the first.',
    })
    assert.equal(r.status, 200, r.text)
    assert.equal((r.body.proposal as Json).status, 'partially_approved')
    assert.deepEqual(
      (r.body.ops as { index: number; status: string }[]).map((o) => [o.index, o.status]),
      [
        [0, 'approved'],
        [1, 'returned'],
      ],
    )
    assert.ok(await page('ca2/kept'))
    assert.equal(await page('ca2/back'), undefined)
    const c = await corrections(id)
    assert.equal(c.length, 1)
    assert.match(String(c[0]?.content), /The second page repeats the first\./)
    assert.equal(c[0]?.applies_to, 'RSC Factory')
    assert.equal(c[0]?.author_id, ana.id)
    // By MCP as well.
    const id2 = await propose([create('ca2/mcp-kept'), create('ca2/mcp-back')])
    const m = await mcp(writer.secret, 'brain_decide', {
      id: id2,
      decision: 'approve',
      fingerprint: (await review(id2)).fingerprint,
      approve: [0],
      comment: 'Not this one.',
    })
    assert.equal(m.error, undefined, m.error)
    assert.equal(((m.result as Json).proposal as Json).status, 'partially_approved')
    assert.equal((await corrections(id2)).length, 1)
  })

  it('CA3: an operation corrected, then approved: the corrected version applies', async () => {
    const id = await propose([create('ca3/page')])
    const seen = await review(id)
    const r = await mcp(writer.secret, 'brain_decide', {
      id,
      decision: 'approve',
      fingerprint: seen.fingerprint,
      corrections: { 0: { body: 'The corrected words.', purges: seen.purges } },
    })
    assert.equal(r.error, undefined, r.error)
    assert.equal((await page('ca3/page'))?.body, 'The corrected words.')
    const op = await w.db.one('SELECT corrected_by FROM proposal_ops WHERE proposal_id = $1', [id])
    assert.equal(op?.corrected_by, ana.id)
  })

  it('CA4: all returned with a comment: nothing applies, the author gets the correction', async () => {
    const id = await propose([create('ca4/page')])
    const r = await mcp(writer.secret, 'brain_decide', {
      id,
      decision: 'return',
      fingerprint: (await review(id)).fingerprint,
      comment: 'Cite a second source.',
    })
    assert.equal(r.error, undefined, r.error)
    assert.equal(((r.result as Json).proposal as Json).status, 'returned')
    assert.deepEqual(r.result?.applied, [])
    assert.equal(await page('ca4/page'), undefined)
    const c = await corrections(id)
    assert.equal(c.length, 1)
    assert.match(String(c[0]?.content), /Cite a second source\./)
    const ev = await w.db.one("SELECT label FROM events WHERE kind = 'proposal.decided' AND target_id = $1", [
      id,
    ])
    assert.equal(ev?.label, 'returned with the key Ana agent')
    // By the API as well.
    const id2 = await propose([create('ca4/api')])
    const a = await w.call(writer.secret, 'POST', `/v1/proposals/${id2}/return`, {
      fingerprint: (await review(id2)).fingerprint,
      comment: 'No.',
    })
    assert.equal(a.status, 200, a.text)
    assert.equal(await status(id2), 'returned')
  })

  it('CA5: a key without the permission is refused with how to proceed, by MCP and API; nothing changes', async () => {
    const id = await propose([create('ca5/page')])
    const fp = (await webReview(id)).fingerprint
    for (const key of [plain, eric.key]) {
      const r = await w.call(key, 'POST', `/v1/proposals/${id}/approve`, { fingerprint: fp })
      assert.deepEqual([r.status, r.body.error?.code], [403, 'web_only'], r.text)
      assert.match(r.body.error?.howToProceed ?? '', /permission to write to the wiki/)
      const back = await w.call(key, 'POST', `/v1/proposals/${id}/return`, {
        fingerprint: fp,
        comment: 'No.',
      })
      assert.equal(back.status, 403, back.text)
      assert.equal((await w.call(key, 'GET', `/v1/proposals/${id}/review`)).status, 403)
      const m = await mcp(key, 'brain_decide', { id, decision: 'approve', fingerprint: fp })
      assert.match(m.error ?? '', /^web_only/)
      assert.match((await mcp(key, 'brain_review', { id })).error ?? '', /^web_only/)
    }
    assert.equal(await status(id), 'pending')
    assert.equal(await page('ca5/page'), undefined)
    // A curator in the web decides as before.
    const r = await w.callWeb(ericWeb, 'POST', `/v1/proposals/${id}/approve`, { fingerprint: fp })
    assert.equal(r.status, 200, r.text)
  })

  it('CA6: a fingerprint that no longer matches: the conflict, the current review, nothing applied', async () => {
    const id = await propose([create('ca6/page')])
    const now = await review(id)
    const r = await w.call(writer.secret, 'POST', `/v1/proposals/${id}/approve`, {
      fingerprint: 'f'.repeat(64),
    })
    assert.deepEqual([r.status, r.body.error?.code], [409, 'proposal_changed'], r.text)
    const current = (r.body.error as unknown as { current: Review }).current
    assert.equal(current.fingerprint, now.fingerprint)
    assert.equal(current.ops.length, 1)
    assert.equal(await page('ca6/page'), undefined)
    const m = await mcp(writer.secret, 'brain_decide', {
      id,
      decision: 'return',
      fingerprint: 'f'.repeat(64),
      comment: 'x',
    })
    assert.match(m.error ?? '', /^proposal_changed/)
    assert.equal(await status(id), 'pending')
    // Decided already: as in the web, the current state comes back.
    await mcp(writer.secret, 'brain_decide', { id, decision: 'approve', fingerprint: now.fingerprint })
    const again = await w.call(writer.secret, 'POST', `/v1/proposals/${id}/approve`, {
      fingerprint: now.fingerprint,
    })
    assert.deepEqual([again.status, again.body.error?.code], [409, 'already_decided'], again.text)
    assert.equal((again.body.error as unknown as { current: { status: string } }).current.status, 'approved')
    // Dependencies hold as in the web: a link to a page not approved with it.
    const dep = await propose([
      create('ca6/base'),
      create('ca6/linked', { links: [{ kind: 'related', to: 'ca6/base' }] }),
    ])
    const d = await w.call(writer.secret, 'POST', `/v1/proposals/${dep}/approve`, {
      fingerprint: (await review(dep)).fingerprint,
      approve: [1],
      comment: 'Only the second.',
    })
    assert.deepEqual([d.status, d.body.error?.code], [400, 'missing_dependencies'], d.text)
    assert.equal(await status(dep), 'pending')
  })

  it('CA8: a retry with the same request key gets the same result and decides once; no page text kept', async () => {
    const id = await propose([create('ca8/page', { body: 'Words only the page holds.' })])
    const body = { fingerprint: (await review(id)).fingerprint, requestKey: 'decide-ca8-1' }
    const a = await w.call(writer.secret, 'POST', `/v1/proposals/${id}/approve`, body)
    assert.equal(a.status, 200, a.text)
    const b = await w.call(writer.secret, 'POST', `/v1/proposals/${id}/approve`, body)
    assert.equal(b.status, 200, b.text)
    assert.deepEqual(b.body, a.body)
    const lines = await w.db.query('SELECT id FROM wiki_log WHERE proposal_id = $1', [id])
    assert.equal(lines.length, 1)
    const decided = await w.db.query(
      "SELECT id FROM events WHERE kind = 'proposal.decided' AND target_id = $1",
      [id],
    )
    assert.equal(decided.length, 1)
    const kept = await w.db.one<{ receipt: unknown }>(
      'SELECT receipt FROM request_keys WHERE receipt::text LIKE $1',
      [`%${id}%`],
    )
    assert.ok(kept)
    assert.ok(!JSON.stringify(kept.receipt).includes('Words only the page holds'))
    // The same key for a different request is refused.
    const other = await w.call(writer.secret, 'POST', `/v1/proposals/${id}/return`, {
      ...body,
      comment: 'No.',
    })
    assert.deepEqual([other.status, other.body.error?.code], [409, 'request_key_reused'], other.text)
    // By MCP: the retry returns the same result.
    const id2 = await propose([create('ca8/mcp')])
    const args = {
      id: id2,
      decision: 'return',
      fingerprint: (await review(id2)).fingerprint,
      comment: 'Later.',
      requestKey: 'decide-ca8-2',
    }
    const m1 = await mcp(writer.secret, 'brain_decide', args)
    const m2 = await mcp(writer.secret, 'brain_decide', args)
    assert.equal(m2.error, undefined, m2.error)
    assert.deepEqual(m2.result, m1.result)
    assert.equal((await corrections(id2)).length, 1)
  })

  it('CA7: the permission taken back after reading: deciding is refused, by MCP and API', async () => {
    const id = await propose([create('ca7/page')])
    const fp = (await review(id)).fingerprint
    assert.equal((await w.callWeb(ericWeb, 'DELETE', `/v1/brains/yt/wiki/writers/${writer.id}`)).status, 200)
    const r = await w.call(writer.secret, 'POST', `/v1/proposals/${id}/approve`, { fingerprint: fp })
    assert.equal(r.status, 403, r.text)
    const m = await mcp(writer.secret, 'brain_decide', { id, decision: 'approve', fingerprint: fp })
    assert.match(m.error ?? '', /^web_only/)
    assert.equal(await status(id), 'pending')
    assert.equal(await page('ca7/page'), undefined)
  })
})
