// Spec learning-memory A2 (plan §2.5, §4.1, §8.3 H2, M2): the «Review later» tray of a brain, oldest first, with who,
// which key, from which session or run, how many parts and the difference of each; Keep, by a person curator in the web,
// takes the mark off up to the revision that change left; parts that wait are decided as before, only those, and a key
// with the wiki write permission that applies them puts them in the tray. Who may do what, by the API. CA-A9 (Keep), A18.
import assert from 'node:assert/strict'
import { after, before, describe, it } from 'node:test'
import { MODERN } from '../../src/mcp/server.ts'
import { skipPg } from '../helpers/pg.ts'
import { type World, world } from '../helpers/world.ts'

type Json = Record<string, unknown>
type Item = {
  id: string
  at: string
  actor: { id: string; name: string }
  keyName: string | null
  ref: string | null
  proposalId: string | null
  title: string
  parts: number
  state: string
}
type Part = {
  part: number
  op: string | null
  address: string
  revisionBefore: number | null
  revisionAfter: number
  created: boolean
  dependsOn: number[]
  diff: string
  state: string
}

describe('the «Review later» tray, Keep and parts that wait (spec learning-memory A2)', {
  skip: skipPg,
}, () => {
  let w: World
  let cora: { id: string; key: string }
  let cole: { id: string; key: string }
  let rita: { id: string; key: string }
  let otto: { id: string; key: string }
  let coraWeb: string
  let writer: string
  let writerId: string
  let source: string
  let n = 0

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
    reason: 'Better.',
  })
  const tray = async (key: string | null, query = '', web?: string) => {
    const path = `/v1/brains/rl/wiki/changes${query}`
    return web ? w.callWeb(web, 'GET', path) : w.call(key, 'GET', path)
  }
  const page = async (address: string) =>
    (await w.call(cora.key, 'GET', `/v1/brains/rl/pages/${address}`)).body.page as {
      revision: number
      unreviewed: boolean
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
  let first: string
  let second: string

  before(async () => {
    w = await world()
    cora = await w.person('Cora')
    cole = await w.person('Cole')
    rita = await w.person('Rita')
    otto = await w.person('Otto')
    await w.call(cora.key, 'POST', '/v1/brains', { slug: 'rl', purpose: 'Review later.' })
    await w.member('rl', cole.id, 'contributor')
    await w.member('rl', rita.id, 'reader')
    coraWeb = await w.web(cora.id)
    const coleWeb = await w.web(cole.id)
    const t = await w.callWeb(coleWeb, 'POST', '/v1/me/tokens', {
      name: 'Cole writer',
      perm: 'write',
      brains: ['rl'],
      days: 30,
    })
    const tok = t.body.token as { id: string; secret: string }
    writer = tok.secret
    writerId = tok.id
    assert.equal((await w.callWeb(coraWeb, 'PUT', `/v1/brains/rl/wiki/writers/${tok.id}`)).status, 200)
    const e = await w.call(cole.key, 'POST', '/v1/brains/rl/entries', {
      type: 'learning',
      title: 'Hooks',
      content: 'Hooks matter.',
    })
    source = (e.body.receipt as { entryId: string }).entryId
    const a = await w.call(cole.key, 'POST', '/v1/brains/rl/proposals', {
      title: 'Alpha',
      ops: [create('alpha')],
    })
    first = String(a.body.undo)
    w.advance(60_000)
    const b = await w.call(writer, 'POST', '/v1/brains/rl/wiki/write', {
      title: 'Alpha better',
      ops: [edit('alpha', 1, 'Alpha, better.')],
    })
    second = String(b.body.undo)
  })
  after(async () => w.close())

  it('lists what waits for review, oldest first: who, which key, which proposal, how many parts', async () => {
    const r = await tray(null, '', coraWeb)
    assert.equal(r.status, 200, r.text)
    const items = r.body.items as Item[]
    assert.deepEqual(
      items.map((i) => i.id),
      [first, second],
    )
    assert.equal(r.body.total, 2)
    const [a, b] = items as [Item, Item]
    assert.deepEqual(
      [a.actor.name, a.keyName, a.ref, a.parts, a.state, a.title],
      ['Cole', 'test', null, 1, 'pending_review', 'Alpha'],
    )
    assert.match(String(a.proposalId), /^prp_/)
    assert.deepEqual([b.keyName, b.proposalId, b.parts], ['Cole writer', null, 1])
    assert.match(b.title, /Alpha better/)
    // A curator's key and a key with the permission read it too.
    assert.equal((await tray(cora.key)).status, 200)
    assert.equal((await tray(writer)).status, 200)
  })

  it('the detail: each part with its page, its revisions and the difference', async () => {
    const r = await w.callWeb(coraWeb, 'GET', `/v1/wiki/changes/${second}`)
    assert.equal(r.status, 200, r.text)
    assert.equal((r.body.change as Item).id, second)
    const parts = r.body.parts as Part[]
    assert.equal(parts.length, 1)
    const [p] = parts as [Part]
    assert.deepEqual(
      [p.part, p.address, p.revisionBefore, p.revisionAfter, p.created, p.state],
      [0, 'alpha', 1, 2, false, 'applied'],
    )
    assert.match(p.diff, /-Text of alpha\./)
    assert.match(p.diff, /\+Alpha, better\./)
    const c = await w.call(writer, 'GET', `/v1/wiki/changes/${first}`)
    assert.equal(c.status, 200, c.text)
    const [q] = c.body.parts as [Part]
    assert.deepEqual([q.op, q.created, q.revisionBefore, q.revisionAfter], ['create', true, null, 1])
  })

  it('CA-A9: Keep, by a curator in the web, takes the mark off only up to the revision that change left', async () => {
    assert.equal((await page('alpha')).unreviewed, true)
    const k = await w.callWeb(coraWeb, 'POST', `/v1/wiki/changes/${first}/keep`)
    assert.equal(k.status, 200, k.text)
    assert.equal((k.body.change as Item).state, 'kept')
    assert.equal((await page('alpha')).unreviewed, true, 'the later change is not reviewed yet')
    assert.equal((await w.callWeb(coraWeb, 'POST', `/v1/wiki/changes/${second}/keep`)).status, 200)
    assert.equal((await page('alpha')).unreviewed, false)
    assert.deepEqual((await tray(null, '', coraWeb)).body.items, [])
    const kept = await tray(null, '?state=kept', coraWeb)
    assert.deepEqual(
      (kept.body.items as Item[]).map((i) => i.id),
      [first, second],
    )
    // Keeping again changes nothing.
    assert.equal((await w.callWeb(coraWeb, 'POST', `/v1/wiki/changes/${first}/keep`)).status, 200)
  })

  it('H2: who may read and keep; the same 404 for a brain one is not in and an id that does not exist', async () => {
    // Keep is a person's, in the web: a curator's key and a key with the permission are refused.
    for (const key of [cora.key, writer]) {
      const r = await w.call(key, 'POST', `/v1/wiki/changes/${first}/keep`)
      assert.equal(r.status, 403, r.text)
    }
    // A reader and a contributor without the permission: 403 on reading and keeping.
    const coleWeb = await w.web(cole.id)
    for (const [label, call] of [
      ['reader list', () => tray(rita.key)],
      ['reader detail', () => w.call(rita.key, 'GET', `/v1/wiki/changes/${first}`)],
      ['reader keep', () => w.call(rita.key, 'POST', `/v1/wiki/changes/${first}/keep`)],
      ['contributor list', () => tray(cole.key)],
      ['contributor detail', () => w.call(cole.key, 'GET', `/v1/wiki/changes/${first}`)],
      ['contributor keep (web)', () => w.callWeb(coleWeb, 'POST', `/v1/wiki/changes/${first}/keep`)],
    ] as const) {
      const r = await call()
      assert.equal(r.status, 403, `${label}: ${r.text}`)
    }
    const outsider = await w.call(otto.key, 'GET', `/v1/wiki/changes/${first}`)
    const invented = await w.call(cora.key, 'GET', '/v1/wiki/changes/chg_000000000000')
    assert.deepEqual([outsider.status, outsider.body.error], [invented.status, invented.body.error])
    assert.equal(outsider.status, 404)
    const outsiderKeep = await w.call(otto.key, 'POST', `/v1/wiki/changes/${first}/keep`)
    assert.equal(outsiderKeep.status, 404)
    assert.equal((await tray(otto.key)).status, 404)
  })

  describe('parts that wait (CA-A18)', () => {
    let held: string
    before(async () => {
      await w.callWeb(coraWeb, 'POST', '/v1/brains/rl/wiki/changes', {
        op: 'create',
        address: 'runbook',
        type: 'guide',
        title: 'Runbook',
        summary: 'Steps.',
        body: 'Steps.',
      })
      await w.callWeb(coraWeb, 'PUT', '/v1/brains/rl/protection/runbook', { protected: true })
      const r = await w.call(cole.key, 'POST', '/v1/brains/rl/proposals', {
        title: 'Runbook and tips',
        ops: [edit('runbook', 1, 'By an agent.'), create('tips')],
      })
      held = (r.body.proposal as { id: string }).id
      assert.equal((r.body.proposal as { status: string }).status, 'partially_applied')
    })

    it('a key without the permission cannot decide: 403, by the API and by MCP', async () => {
      const review = await w.call(writer, 'GET', `/v1/proposals/${held}/review`)
      const r = await w.call(cole.key, 'POST', `/v1/proposals/${held}/approve`, {
        fingerprint: review.body.fingerprint,
      })
      assert.equal(r.status, 403)
      assert.equal(r.body.error?.code, 'web_only')
      const m = await mcp(cole.key, 'brain_decide', {
        id: held,
        decision: 'approve',
        fingerprint: review.body.fingerprint,
      })
      assert.match(String(m.error), /web_only|Approval happens in the web/)
      assert.equal((await page('runbook')).revision, 1)
    })

    it('a part that is not waiting cannot be approved: not_held', async () => {
      const review = await w.call(writer, 'GET', `/v1/proposals/${held}/review`)
      const r = await w.call(writer, 'POST', `/v1/proposals/${held}/approve`, {
        fingerprint: review.body.fingerprint,
        approve: [1],
      })
      assert.equal(r.status, 400, r.text)
      assert.equal(r.body.error?.code, 'not_held')
    })

    it('a key with the permission approves what waits: it applies, enters the tray, and the page is marked', async () => {
      const review = await w.call(writer, 'GET', `/v1/proposals/${held}/review`)
      const r = await w.call(writer, 'POST', `/v1/proposals/${held}/approve`, {
        fingerprint: review.body.fingerprint,
      })
      assert.equal(r.status, 200, r.text)
      assert.equal((r.body.proposal as { status: string }).status, 'approved')
      assert.deepEqual(
        (r.body.ops as Array<{ status: string }>).map((o) => o.status),
        ['approved', 'applied'],
      )
      assert.match(String(r.body.undo), /^chg_/)
      assert.equal((await page('runbook')).revision, 2)
      assert.equal((await page('runbook')).unreviewed, true)
      const items = (await tray(null, '', coraWeb)).body.items as Item[]
      assert.ok(items.some((i) => i.id === r.body.undo))
    })

    it('returning what waits leaves what applied as it is; a curator in the web approving leaves no mark', async () => {
      const p = await w.call(cole.key, 'POST', '/v1/brains/rl/proposals', {
        title: 'Runbook again and more',
        ops: [edit('runbook', 2, 'Again.'), create('more')],
      })
      const id = (p.body.proposal as { id: string }).id
      const review = await w.callWeb(coraWeb, 'GET', `/v1/proposals/${id}/review`)
      const back = await w.callWeb(coraWeb, 'POST', `/v1/proposals/${id}/return`, {
        fingerprint: review.body.fingerprint,
        comment: 'Not on the runbook.',
      })
      assert.equal(back.status, 200, back.text)
      assert.deepEqual(
        (back.body.ops as Array<{ status: string }>).map((o) => o.status),
        ['returned', 'applied'],
      )
      assert.equal((await page('more')).revision, 1)
      const q = await w.call(cole.key, 'POST', '/v1/brains/rl/proposals', {
        title: 'Runbook by web approval',
        ops: [edit('runbook', 2, 'Approved in the web.')],
      })
      const qid = (q.body.proposal as { id: string }).id
      const rv = await w.callWeb(coraWeb, 'GET', `/v1/proposals/${qid}/review`)
      const ok = await w.callWeb(coraWeb, 'POST', `/v1/proposals/${qid}/approve`, {
        fingerprint: rv.body.fingerprint,
      })
      assert.equal(ok.status, 200, ok.text)
      assert.equal(ok.body.undo, null)
      assert.equal((await page('runbook')).unreviewed, false)
    })

    it('H2: a revoked key is refused on its next request', async () => {
      const coleWeb = await w.web(cole.id)
      assert.equal((await w.callWeb(coleWeb, 'DELETE', `/v1/me/tokens/${writerId}`)).status < 300, true)
      assert.equal((await tray(writer)).status, 401)
      assert.equal((await w.call(writer, 'GET', `/v1/wiki/changes/${first}`)).status, 401)
    })
  })
})
