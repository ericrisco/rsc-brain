// Spec B5 CA10: every MCP tool has the same operation in the API, and with the same key both give the
// same result and the same permission outcome. The API request of each tool is written here by hand,
// from the API's side, so a tool that drifts from its route fails; and the test walks the whole
// catalogue, so a new tool without its line here fails too.
import assert from 'node:assert/strict'
import { after, before, describe, it } from 'node:test'
import { MODERN } from '../../src/mcp/server.ts'
import { TOOLS } from '../../src/mcp/tools.ts'
import { skipPg } from '../helpers/pg.ts'
import { type World, world } from '../helpers/world.ts'

type Json = Record<string, unknown>
type Side = 'mcp' | 'api'
type Outcome = { ok: true; result: unknown } | { ok: false; code: string }
// One operation: the tool's arguments and the API request that does the same, for one side. Writes
// act on a twin of the same thing per side (the same change to two entries, say); a twin differs only
// by the side's name, which the comparison folds.
type Case = {
  args: (side: Side) => Promise<Json> | Json
  api: (side: Side) => Promise<[string, string, Json?]> | [string, string, Json?]
  // A field the first side's write changes for the second (the twin made first is "similar" to the
  // one made second), left out of the comparison.
  drop?: (result: Json) => void
}

// The tools a key cannot use are refused before the call, naming the permission that is missing
// (spec B5 «Bordes»); the API refuses those requests in its own words ("forbidden").
const GATE = new Set(['read_only_key', 'cannot_create_brains'])

const SIDE = /mcpside|apiside/g
// Identifiers made per side (a new session, entry, proposal) differ by nature; the rest must not.
const IDS = /\b(acc|brn|crd|ses|ent|rel|pg|prp|wlg|inv|app)_[0-9a-f]{12}\b/g
const fold = (v: unknown) => JSON.parse(JSON.stringify(v).replace(SIDE, 'side').replace(IDS, '$1_*'))

describe('CA10: parity between the MCP tools and the API', { skip: skipPg }, () => {
  let w: World
  let eric: { id: string; key: string }
  let readOnly: string
  let stranger: { id: string; key: string }
  let web = ''
  let n = 0
  const twin: Record<string, Record<Side, string>> = {}

  async function viaMcp(key: string, name: string, args: Json): Promise<Outcome> {
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
    if (body.result.isError) return { ok: false, code: text.slice(0, text.indexOf(':')) }
    return { ok: true, result: JSON.parse(text) }
  }

  async function viaApi(key: string, [method, path, body]: [string, string, Json?]): Promise<Outcome> {
    const r = await w.call(key, method, path, body)
    if (r.body.error) return { ok: false, code: r.body.error.code }
    assert.ok(r.status < 300, `${method} ${path}: ${r.status}`)
    return { ok: true, result: r.body }
  }

  const entry = async (title: string, o: Json = {}) => {
    const r = await w.call(eric.key, 'POST', '/v1/brains/par/entries', {
      type: 'learning',
      title,
      content: `About ${title}: retention starts in the first minute.`,
      ...o,
    })
    assert.equal(r.status, 201, r.text)
    return (r.body.receipt as { entryId: string }).entryId
  }
  const session = async () => {
    const r = await w.call(eric.key, 'POST', '/v1/brains/par/sessions', { purpose: 'twin' })
    return (r.body.session as { id: string }).id
  }
  const proposal = async (side: Side, what = 'Withdraw', where = 'drafts') => {
    const r = await w.call(eric.key, 'POST', '/v1/brains/par/proposals', {
      title: `${what} ${side}side`,
      ops: [opOn(`${where}/${side}side`)],
    })
    assert.equal(r.status, 201, r.text)
    return (r.body.proposal as { id: string }).id
  }
  const twins = async (name: string, make: (side: Side) => Promise<string>) => {
    twin[name] = { mcp: await make('mcp'), api: await make('api') }
  }
  let sourceId = ''
  const opOn = (address: string) => ({
    op: 'create',
    address,
    type: 'topic',
    title: 'Hooks',
    summary: 'Hooks.',
    body: 'Hooks matter.',
    sources: [{ entryId: sourceId }],
    reason: 'From the journal.',
  })
  const t = (name: string, side: Side) => twin[name]?.[side] as string
  // The fingerprint a curator reads in the web, which a key with the permission reads the same (spec v0.7).
  const seen = async (id: string) =>
    String((await w.callWeb(web, 'GET', `/v1/proposals/${id}/review`)).body.fingerprint)

  const CASES: Record<string, Case> = {
    brain_list: { args: () => ({}), api: () => ['GET', '/v1/brains'] },
    brain_resolve: {
      args: () => ({ repos: ['https://github.com/risco/parity'] }),
      api: () => ['POST', '/v1/resolve', { repos: ['https://github.com/risco/parity'] }],
    },
    mem_context: {
      args: () => ({ brain: 'par', task: 'retention', max: 8000 }),
      api: () => ['GET', '/v1/brains/par/context?task=retention&max=8000'],
    },
    mem_session_start: {
      args: () => ({ brain: 'par', purpose: 'Parity', ref: 'ticket 7' }),
      api: () => ['POST', '/v1/brains/par/sessions', { purpose: 'Parity', ref: 'ticket 7' }],
    },
    mem_save: {
      // The same request key: the API answers with the receipt the tool got.
      args: () => ({
        brain: 'par',
        type: 'decision',
        title: 'Saved',
        content: 'Both ways.',
        requestKey: 'k-1',
      }),
      api: () => [
        'POST',
        '/v1/brains/par/entries',
        { type: 'decision', title: 'Saved', content: 'Both ways.', requestKey: 'k-1' },
      ],
    },
    mem_update: {
      args: (s) => ({ id: t('update', s), baseRevision: 1, content: 'Corrected.' }),
      api: (s) => ['PATCH', `/v1/entries/${t('update', s)}`, { baseRevision: 1, content: 'Corrected.' }],
    },
    mem_suggest_topic: {
      args: () => ({ brain: 'par', title: 'Retention of new viewers' }),
      api: () => ['POST', '/v1/brains/par/topics/suggest', { title: 'Retention of new viewers' }],
    },
    mem_relate: {
      args: (s) => ({ brain: 'par', from: t('relateFrom', s), to: t('relateTo', s), kind: 'contradicts' }),
      api: (s) => [
        'POST',
        '/v1/brains/par/relations',
        { from: t('relateFrom', s), to: t('relateTo', s), kind: 'contradicts' },
      ],
    },
    mem_forget: {
      args: (s) => ({ id: t('forget', s), reason: 'Wrong.' }),
      api: (s) => ['POST', `/v1/entries/${t('forget', s)}/forget`, { reason: 'Wrong.' }],
    },
    mem_session_summary: {
      args: (s) => ({ session: t('summary', s), content: 'Goal, done, pending.' }),
      api: (s) => ['POST', `/v1/sessions/${t('summary', s)}/summary`, { content: 'Goal, done, pending.' }],
      drop: (r) => {
        delete (r.receipt as Json).similar
      },
    },
    mem_session_end: {
      args: (s) => ({ session: t('end', s) }),
      api: (s) => ['POST', `/v1/sessions/${t('end', s)}/end`],
    },
    mem_search: {
      args: () => ({ q: 'retention', brains: ['par'], in: 'both', limit: 5, neighbours: true }),
      api: () => ['GET', '/v1/search?q=retention&brains=par&in=both&limit=5&neighbours=true'],
    },
    mem_get: {
      args: () => ({ id: sourceId, history: true }),
      api: () => ['GET', `/v1/entries/${sourceId}?history=1`],
    },
    mem_timeline: {
      args: () => ({ id: sourceId, n: 3 }),
      api: () => ['GET', `/v1/entries/${sourceId}/around?n=3`],
    },
    brain_page: {
      args: () => ({ brain: 'par', address: 'audience/retention' }),
      api: () => ['GET', '/v1/brains/par/pages/audience/retention'],
    },
    brain_neighbors: {
      args: () => ({ brain: 'par', address: 'audience/retention', hops: 2, direction: 'both' }),
      api: () => ['GET', '/v1/brains/par/neighbours?address=audience%2Fretention&hops=2&direction=both'],
    },
    brain_map: { args: () => ({ brain: 'par' }), api: () => ['GET', '/v1/brains/par/wiki/map'] },
    brain_health: { args: () => ({ brain: 'par' }), api: () => ['GET', '/v1/brains/par/wiki/health'] },
    brain_compile_pack: {
      args: () => ({ brain: 'par', maxChars: 8000 }),
      api: () => ['GET', '/v1/brains/par/wiki/compile?maxChars=8000'],
    },
    brain_propose: {
      args: (s) => ({ brain: 'par', title: `Hooks ${s}side`, ops: [opOn(`audience/${s}side`)] }),
      api: (s) => [
        'POST',
        '/v1/brains/par/proposals',
        { title: `Hooks ${s}side`, ops: [opOn(`audience/${s}side`)] },
      ],
    },
    brain_check: {
      args: () => ({ brain: 'par', title: 'Check', ops: [opOn('checked/page')] }),
      api: () => ['POST', '/v1/brains/par/wiki/check', { title: 'Check', ops: [opOn('checked/page')] }],
    },
    // Spec v0.6: Eric's key may write to the wiki of "par" (given in before()).
    brain_write: {
      args: (s) => ({ brain: 'par', title: `Write ${s}side`, ops: [opOn(`written/${s}side`)] }),
      api: (s) => [
        'POST',
        '/v1/brains/par/wiki/write',
        { title: `Write ${s}side`, ops: [opOn(`written/${s}side`)] },
      ],
      // The second twin's title is the first's: a duplicate_title the first one did not have.
      drop: (r) => {
        delete r.coherence
      },
    },
    brain_proposals: {
      args: () => ({ brain: 'par', status: 'pending' }),
      api: () => ['GET', '/v1/brains/par/proposals?mine=1&status=pending'],
    },
    // Spec v0.7: Eric's key may write to the wiki of "par", so it reads and decides its proposals.
    brain_review: {
      args: (s) => ({ id: t('review', s) }),
      api: (s) => ['GET', `/v1/proposals/${t('review', s)}/review`],
      // A hash of the proposal, whose title names its side.
      drop: (r) => {
        delete r.fingerprint
      },
    },
    brain_decide: {
      args: async (s) => ({
        id: t('decide', s),
        decision: 'approve',
        fingerprint: await seen(t('decide', s)),
      }),
      api: async (s) => [
        'POST',
        `/v1/proposals/${t('decide', s)}/approve`,
        { fingerprint: await seen(t('decide', s)) },
      ],
    },
    brain_withdraw: {
      args: (s) => ({ id: t('withdraw', s) }),
      api: (s) => ['POST', `/v1/proposals/${t('withdraw', s)}/withdraw`],
    },
    brain_create: {
      args: (s) => ({ slug: `new-${s}side`, purpose: 'Made twice.' }),
      api: (s) => ['POST', '/v1/brains', { slug: `new-${s}side`, purpose: 'Made twice.' }],
    },
  }

  before(async () => {
    w = await world()
    eric = await w.person('Eric')
    stranger = await w.person('Stranger')
    readOnly = await w.token(eric.id, { perm: 'read' })
    await w.call(eric.key, 'POST', '/v1/brains', { slug: 'par', purpose: 'Parity.' })
    web = await w.web(eric.id)
    await w.callWeb(web, 'POST', '/v1/brains/par/repos', { repo: 'github.com/risco/parity' })
    const page = await w.callWeb(web, 'POST', '/v1/brains/par/wiki/changes', {
      op: 'create',
      address: 'audience/retention',
      type: 'topic',
      title: 'Retention',
      summary: 'How viewers stay.',
      body: 'Viewers stay when the first minute holds. See [[audience/hooks]].',
    })
    assert.equal(page.status, 201, page.text)
    const writer = await w.db.one<{ id: string }>(
      "SELECT id FROM credentials WHERE account_id = $1 AND kind = 'token' AND perm = 'write'",
      [eric.id],
    )
    assert.equal((await w.callWeb(web, 'PUT', `/v1/brains/par/wiki/writers/${writer?.id}`)).status, 200)
    sourceId = await entry('Source')
    await entry('Context')
    await twins('update', (s) => entry(`Update ${s}side`))
    await twins('relateFrom', (s) => entry(`From ${s}side`))
    await twins('relateTo', (s) => entry(`To ${s}side`))
    await twins('forget', (s) => entry(`Forget ${s}side`))
    await twins('summary', () => session())
    await twins('end', () => session())
    await twins('withdraw', (s) => proposal(s))
    await twins('review', (s) => proposal(s, 'Review', 'reviewed'))
    await twins('decide', (s) => proposal(s, 'Decide', 'decided'))
  })
  after(async () => w.close())

  it('every tool of the catalogue has its operation in the API here', () => {
    assert.deepEqual(Object.keys(CASES).sort(), TOOLS.map((x) => x.name).sort())
  })

  for (const tool of TOOLS) {
    it(`${tool.name}: the same result through MCP and through the API, with the same key`, async () => {
      const c = CASES[tool.name]
      assert.ok(c, `no API operation for ${tool.name}`)
      const m = await viaMcp(eric.key, tool.name, await c.args('mcp'))
      const a = await viaApi(eric.key, await c.api('api'))
      assert.ok(m.ok, `${tool.name} through MCP: ${JSON.stringify(m)}`)
      assert.ok(a.ok, `${tool.name} through the API: ${JSON.stringify(a)}`)
      for (const r of [m.result, a.result]) c.drop?.(r as Json)
      assert.deepEqual(fold(m.result), fold(a.result))
    })
  }

  // A read-only key and a key of someone outside the brain: each tool is refused or allowed alike, with
  // the same code. Whatever a refused write would have changed is left as it was.
  for (const tool of TOOLS) {
    it(`${tool.name}: the same permission outcome through MCP and through the API`, async () => {
      const c = CASES[tool.name] as Case
      for (const [who, key] of [
        ['read-only key', () => readOnly],
        ['stranger', () => stranger.key],
      ] as const) {
        const m = await viaMcp(key(), tool.name, await c.args('mcp'))
        const a = await viaApi(key(), await c.api('mcp'))
        assert.equal(m.ok, a.ok, `${tool.name}, ${who}: MCP ${JSON.stringify(m)} / API ${JSON.stringify(a)}`)
        // Refused at the gate, the API refuses too (it may find another reason first, such as an entry
        // this key cannot see); refused anywhere else, for the same reason.
        if (!m.ok && !a.ok && !GATE.has(m.code)) assert.equal(m.code, a.code, `${tool.name}, ${who}`)
      }
    })
  }
})
