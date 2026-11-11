// Spec v0.6 «Escritura directa», CA1–CA3, CA5, CA6 (constitution P4, P5 v2.1.0): a key a curator let write to
// the wiki sends the operations of a proposal and they apply at once, all or nothing, with a revision per page,
// a log line that says it was written directly and by which key, and a receipt a retry gets again. Without the
// permission, or the request after a curator took it back, it is refused and nothing changes — by the API and
// by MCP alike. A page that moved since the revision sent is not written, and the current one comes back.
import assert from 'node:assert/strict'
import { after, before, describe, it } from 'node:test'
import { MODERN } from '../../src/mcp/server.ts'
import { skipPg } from '../helpers/pg.ts'
import { type World, world } from '../helpers/world.ts'

type Json = Record<string, unknown>

describe('writing to the wiki directly (v0.6)', { skip: skipPg }, () => {
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
  const write = (key: string, body: Json) => w.call(key, 'POST', '/v1/brains/yt/wiki/write', body)
  const page = async (address: string) =>
    (await w.call(eric.key, 'GET', `/v1/brains/yt/pages/${address}`)).body.page as
      | { revision: number; body: string; title: string }
      | undefined
  const revisions = async (address: string) =>
    Number(
      (
        await w.db.one(
          `SELECT count(*)::int AS n FROM page_revisions r JOIN page_addresses a ON a.page_id = r.page_id
            WHERE a.address = $1`,
          [address],
        )
      )?.n,
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

  it('CA1: applied at once, a revision per page, a log line "written directly" by the key', async () => {
    const r = await write(writer.secret, {
      title: 'Hooks and retention',
      reason: 'Compiled the hooks entry.',
      ops: [create('hooks'), create('retention', { links: [{ kind: 'related', to: 'hooks' }] })],
    })
    assert.equal(r.status, 201, r.text)
    assert.equal(r.body.applied, true)
    const revised = r.body.revised as { address: string; revision: number }[]
    assert.deepEqual(
      revised.map((x) => [x.address, x.revision]),
      [
        ['hooks', 1],
        ['retention', 1],
      ],
    )
    assert.equal((await page('hooks'))?.revision, 1)
    const log = (await w.call(eric.key, 'GET', '/v1/brains/yt/wiki/log')).body.items as Json[]
    assert.equal(log[0]?.kind, 'write')
    assert.equal(log[0]?.keyName, 'Ana agent')
    assert.equal(log[0]?.actorName, 'Ana')
    assert.match(String(log[0]?.summary), /^Written directly by Ana agent: Hooks and retention/)
    assert.equal(log[0]?.id, r.body.logId)
    // The cited entry is compiled, as with an approved proposal.
    const e = await w.db.one('SELECT compiled FROM entries WHERE id = $1', [source])
    assert.equal(e?.compiled, true)
    // The revision says how it came and is undone like any other: back to a revision.
    const rev = await w.db.one(
      "SELECT kind FROM page_revisions r JOIN pages p ON p.id = r.page_id WHERE p.address = 'hooks'",
    )
    assert.equal(rev?.kind, 'write')
  })

  it('CA1 by MCP: brain_write applies the same way', async () => {
    const r = await mcp(writer.secret, 'brain_write', {
      brain: 'yt',
      title: 'Edit hooks',
      ops: [
        {
          op: 'edit',
          address: 'hooks',
          baseRevision: 1,
          body: 'The first 15 seconds decide.',
          reason: 'Newer.',
        },
      ],
    })
    assert.equal(r.error, undefined, r.error)
    assert.equal(r.result?.applied, true)
    assert.equal((await page('hooks'))?.body, 'The first 15 seconds decide.')
  })

  it('CA2: a key without the permission is refused with how to proceed, and nothing changes', async () => {
    const before = await w.db.one('SELECT count(*)::int AS n FROM wiki_log')
    const r = await write(plain, { title: 'Try', ops: [create('tried')] })
    assert.equal(r.status, 403, r.text)
    assert.equal(r.body.error?.code, 'wiki_write_not_allowed')
    assert.match(r.body.error?.howToProceed ?? '', /brain_propose/)
    assert.match(r.body.error?.howToProceed ?? '', /permission to write to the wiki/)
    assert.equal(await page('tried'), undefined)
    const m = await mcp(plain, 'brain_write', { brain: 'yt', title: 'Try', ops: [create('tried')] })
    assert.match(m.error ?? '', /^wiki_write_not_allowed/)
    // The curator's own token neither, until a curator gives it the permission.
    assert.equal((await write(eric.key, { title: 'Try', ops: [create('tried')] })).status, 403)
    // A person in the web edits by hand instead.
    assert.equal(
      (await w.callWeb(ericWeb, 'POST', '/v1/brains/yt/wiki/write', { title: 'T', ops: [create('tried')] }))
        .status,
      403,
    )
    assert.deepEqual(await w.db.one('SELECT count(*)::int AS n FROM wiki_log'), before)
  })

  it('CA5: a retry with the same request key gets the same receipt and writes once', async () => {
    const body = { title: 'Once', requestKey: 'req-once-1', ops: [create('once')] }
    const a = await write(writer.secret, body)
    assert.equal(a.status, 201, a.text)
    const b = await write(writer.secret, body)
    assert.equal(b.status, 201, b.text)
    assert.deepEqual(b.body, a.body)
    assert.equal(await revisions('once'), 1)
    const other = await write(writer.secret, { ...body, title: 'Not once' })
    assert.equal(other.status, 409, other.text)
    assert.equal(other.body.error?.code, 'request_key_reused')
  })

  it('CA6: a page changed since the revision sent is not written; the current one comes back', async () => {
    const now = (await page('hooks'))?.revision as number
    const r = await write(writer.secret, {
      title: 'Stale edit',
      ops: [
        create('also-new'),
        { op: 'edit', address: 'hooks', baseRevision: now - 1, body: 'Old view.', reason: 'Mine.' },
      ],
    })
    assert.equal(r.status, 409, r.text)
    assert.equal(r.body.error?.code, 'page_changed')
    assert.equal(
      (r.body.error as unknown as { current: { page: { revision: number } } }).current.page.revision,
      now,
    )
    assert.equal((await page('hooks'))?.revision, now)
    assert.equal(await page('also-new'), undefined)
  })

  it('the checks of a proposal block a write, all listed', async () => {
    const r = await write(writer.secret, {
      title: 'Bad',
      ops: [
        create('no-source', { sources: [] }),
        { op: 'link', address: 'hooks', kind: 'related', to: 'nowhere', reason: 'x' },
      ],
    })
    assert.equal(r.status, 400, r.text)
    assert.equal((r.body.error as unknown as { problems: unknown[] }).problems.length, 2)
    assert.equal(await page('no-source'), undefined)
  })

  it('CA3: a curator takes the permission back; the very next request is refused, by API and MCP', async () => {
    assert.equal((await w.call(eric.key, 'DELETE', `/v1/brains/yt/wiki/writers/${writer.id}`)).status, 200)
    const r = await write(writer.secret, { title: 'After', ops: [create('after')] })
    assert.equal(r.status, 403, r.text)
    const m = await mcp(writer.secret, 'brain_write', { brain: 'yt', title: 'After', ops: [create('after')] })
    assert.match(m.error ?? '', /^wiki_write_not_allowed/)
    // What it wrote stays.
    assert.ok(await page('hooks'))
    // It can still propose.
    assert.equal(
      (await w.call(writer.secret, 'POST', '/v1/brains/yt/proposals', { title: 'P', ops: [create('after')] }))
        .status,
      201,
    )
  })

  it('a short key writes with the permission of the main key that made it', async () => {
    const main = await w.db.one<{ id: string }>(
      "SELECT id FROM credentials WHERE account_id = $1 AND kind = 'main'",
      [factory.id],
    )
    const k = await w.call(factory.key, 'POST', '/v1/keys/short', {
      writeBrain: 'yt',
      ref: 'run r_1',
      ttlMinutes: 30,
    })
    const short = (k.body.key as { secret: string }).secret
    assert.equal((await write(short, { title: 'S', ops: [create('short-1')] })).status, 403)
    assert.equal((await w.callWeb(ericWeb, 'PUT', `/v1/brains/yt/wiki/writers/${main?.id}`)).status, 200)
    const r = await write(short, { title: 'S', ops: [create('short-1')] })
    assert.equal(r.status, 201, r.text)
  })
})
