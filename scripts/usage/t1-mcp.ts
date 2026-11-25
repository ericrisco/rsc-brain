// Usage of T009 (spec learning-memory A1, A2 over MCP: CA-A1, A18, A21): an MCP client of the older protocol era, as
// most clients still are (initialize, notifications/initialized, tools/list, tools/call), on a clean installation.
//   - which tools each key sees: brain_changes for curators' keys and keys with the wiki write permission, brain_undo for
//     the latter, no keep;
//   - brain_propose applies at once, a part on a protected page waits;
//   - brain_changes lists and opens the change; brain_decide applies the part that waits; brain_undo undoes it with a
//     comment, and twice says it is undone; a key without the permission is refused.
//
//   RSC_BRAIN_PG_URL=… node scripts/usage/t1-mcp.ts [--no-build]
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { api, cleanInstall, ROOT, say } from './clean-install.ts'

const run = promisify(execFile)
let failed = 0
const check = (what: string, ok: boolean) => {
  say(`${ok ? 'ok  ' : 'FAIL'} ${what}`)
  if (!ok) failed += 1
}
type Json = Record<string, unknown>

// An MCP client: one handshake per key, then requests over the same endpoint.
class Client {
  n = 0
  version = '2025-06-18'
  base: string
  token: string
  name: string
  constructor(base: string, token: string, name: string) {
    this.base = base
    this.token = token
    this.name = name
  }
  async send(method: string, params: Json = {}, notify = false): Promise<Json> {
    const res = await fetch(`${this.base}/mcp`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${this.token}`,
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        'mcp-protocol-version': this.version,
      },
      body: JSON.stringify(
        notify ? { jsonrpc: '2.0', method, params } : { jsonrpc: '2.0', id: ++this.n, method, params },
      ),
    })
    const text = await res.text()
    return text ? (JSON.parse(text) as Json) : {}
  }
  async connect(): Promise<void> {
    const r = await this.send('initialize', {
      protocolVersion: this.version,
      capabilities: {},
      clientInfo: { name: 'usage-client', version: '1.0.0' },
    })
    const info = (r.result as { serverInfo: { name: string }; protocolVersion: string }) ?? {}
    await this.send('notifications/initialized', {}, true)
    say(`> mcp initialize as ${this.name} -> ${info.serverInfo?.name} ${info.protocolVersion}`)
  }
  async tools(): Promise<string[]> {
    const r = await this.send('tools/list')
    return ((r.result as { tools: Array<{ name: string }> }).tools ?? []).map((t) => t.name)
  }
  async call(name: string, args: Json, show: (b: Json) => unknown = () => undefined) {
    const r = await this.send('tools/call', { name, arguments: args })
    const result = r.result as { isError: boolean; content: Array<{ text: string }> } | undefined
    const text = result?.content[0]?.text ?? JSON.stringify(r.error ?? r)
    const out = !result || result.isError ? { error: text } : { result: JSON.parse(text) as Json }
    let shown: unknown
    try {
      shown = out.result ? show(out.result) : String(out.error).slice(0, 160)
    } catch {
      shown = Object.keys(out.result ?? {})
    }
    say(
      `> mcp ${name} as ${this.name} -> ${out.error ? 'error' : 'ok'}${shown === undefined ? '' : ` ${JSON.stringify(shown)}`}`,
    )
    return out
  }
}

const commit = (await run('git', ['-C', ROOT, 'rev-parse', '--short', 'HEAD'])).stdout.trim()
say(`# t1-mcp ${new Date().toISOString()} · commit ${commit}`)
const inst = await cleanInstall({ build: !process.argv.includes('--no-build') })
const call = api(inst.base)
try {
  const web = { cookie: inst.curator.cookie, name: 'Cora' }
  const coleWeb = { cookie: inst.contributor.cookie, name: 'Cole' }
  const t = await call(coleWeb, 'POST', '/v1/me/tokens', {
    name: 'Cole writer',
    perm: 'write',
    brains: ['demo'],
    days: 30,
  })
  const tok = t.body.token as { id: string; secret: string }
  await call(web, 'PUT', `/v1/brains/demo/wiki/writers/${tok.id}`)
  await call(web, 'POST', '/v1/brains/demo/wiki/changes', {
    op: 'create',
    address: 'runbook',
    type: 'guide',
    title: 'Runbook',
    summary: 'Steps.',
    body: 'Steps.',
  })
  await call(web, 'PUT', '/v1/brains/demo/protection/runbook', { protected: true })
  const cole = new Client(inst.base, inst.contributor.token, 'Cole')
  const writer = new Client(inst.base, tok.secret, 'Cole writer')
  const cora = new Client(inst.base, inst.curator.token, 'Cora (key)')
  for (const c of [cole, writer, cora]) await c.connect()
  const [plain, w, cur] = [await cole.tools(), await writer.tools(), await cora.tools()]
  say(
    `  Cole sees changes/undo: ${plain.includes('brain_changes')}/${plain.includes('brain_undo')}; writer: ${w.includes('brain_changes')}/${w.includes('brain_undo')}; Cora's key: ${cur.includes('brain_changes')}/${cur.includes('brain_undo')}`,
  )
  check(
    'tools by permission: brain_changes for the writer and the curator’s key, brain_undo for the writer only, no keep',
    !plain.includes('brain_changes') &&
      w.includes('brain_changes') &&
      w.includes('brain_undo') &&
      cur.includes('brain_changes') &&
      !cur.includes('brain_undo') &&
      ![...plain, ...w, ...cur].some((x) => /keep/.test(x)),
  )
  const e = await cole.call('mem_save', {
    brain: 'demo',
    type: 'learning',
    title: 'Tips',
    content: 'Short tips.',
  })
  const source = (e.result?.receipt as { entryId: string } | undefined)?.entryId
  const p = await cole.call(
    'brain_propose',
    {
      brain: 'demo',
      title: 'Tips and the runbook',
      ops: [
        {
          op: 'create',
          address: 'tips',
          type: 'topic',
          title: 'Tips',
          summary: 'Tips.',
          body: 'Short tips.',
          sources: [{ entryId: source }],
          reason: 'From the journal.',
        },
        { op: 'edit', address: 'runbook', baseRevision: 1, body: 'By an agent.', reason: 'Better.' },
      ],
      requestKey: 'mcp-usage-1',
    },
    (b) => ({ status: b.status, pages: b.pages, held: b.held, undo: b.undo }),
  )
  const r1 = p.result as {
    status: string
    undo: string
    held: Array<{ reason: string }>
    proposal: { id: string }
  }
  check(
    'CA-A1: brain_propose applied the new page at once; the part on the protected page waits',
    r1.status === 'applied' && /^chg_/.test(r1.undo) && r1.held[0]?.reason === 'protected',
  )
  const list = await writer.call('brain_changes', { brain: 'demo' }, (b) =>
    (b.items as Array<{ id: string; title: string; keyName: string }>).map(
      (i) => `${i.id} ${i.title} (${i.keyName})`,
    ),
  )
  const detail = await writer.call('brain_changes', { id: r1.undo }, (b) =>
    (b.parts as Array<{ address: string; created: boolean; diff: string }>).map(
      (x) => `${x.address} created=${x.created}`,
    ),
  )
  check(
    'brain_changes lists the change and opens it, part by part',
    ((list.result?.items ?? []) as Array<{ id: string }>).some((i) => i.id === r1.undo) &&
      ((detail.result?.parts ?? []) as unknown[]).length === 1,
  )
  const review = await writer.call('brain_review', { id: r1.proposal.id }, (b) => ({
    fingerprint: String(b.fingerprint).slice(0, 8),
  }))
  const no = await cole.call('brain_decide', {
    id: r1.proposal.id,
    decision: 'approve',
    fingerprint: review.result?.fingerprint,
  })
  check(
    'CA-A18: a key without the permission cannot decide',
    /web_only|Approval happens in the web/.test(String(no.error)),
  )
  const d = await writer.call(
    'brain_decide',
    { id: r1.proposal.id, decision: 'approve', fingerprint: review.result?.fingerprint },
    (b) => ({ status: (b.proposal as { status: string }).status, undo: b.undo }),
  )
  check(
    'CA-A18: the key with the permission applies the part that waits, into «Review later»',
    /^chg_/.test(String(d.result?.undo)),
  )
  const nope = await cole.call('brain_undo', { id: r1.undo })
  check('a key without the permission cannot undo', /web_only/.test(String(nope.error)))
  const u = await writer.call(
    'brain_undo',
    { id: String(d.result?.undo), comment: 'Leave the runbook to people.' },
    (b) => ({ state: (b.change as { state: string }).state, undone: b.undone, correction: b.correction }),
  )
  check(
    'brain_undo undoes it and leaves a correction for Cole',
    (u.result?.change as { state: string })?.state === 'undone' && /^ent_/.test(String(u.result?.correction)),
  )
  const again = await writer.call('brain_undo', { id: String(d.result?.undo) }, (b) => b)
  check('CA-A21: twice: alreadyUndone', again.result?.alreadyUndone === true)
  const page = await call(
    { token: inst.reader.token, name: 'Rita' },
    'GET',
    '/v1/brains/demo/pages/runbook',
    undefined,
    (b) => ({
      revision: (b.page as { revision: number }).revision,
      body: (b.page as { body: string }).body,
    }),
  )
  check(
    'the runbook reads as before the agent’s part',
    (page.body.page as { body: string }).body === 'Steps.',
  )
} finally {
  await inst.stop()
  await inst.drop()
}
say(failed === 0 ? 'PASS' : `FAIL (${failed})`)
process.exit(failed === 0 ? 0 : 1)
