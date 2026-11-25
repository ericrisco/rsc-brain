// Spec learning-memory A2 and R7 (plan §2.5, §8.3 H2, H4, M7): undo puts every page a change touched back as it was —
// content, sources, links out and in, status, address and every address row — for a create (the page is retired, out of
// search and context, its address free again), an edit, a merge and a move. A later change on a page is a conflict a
// person decides (overwrite); undoing twice changes nothing; by parts it keeps dependencies; a comment teaches whoever
// proposed, redacted, and a purge takes it away. CA-A2, A3, A10, A21, A25, A26.
import assert from 'node:assert/strict'
import { after, before, describe, it } from 'node:test'
import { SECRET_MARK } from '../../src/privacy/redact.ts'
import { skipPg } from '../helpers/pg.ts'
import { type World, world } from '../helpers/world.ts'

type Json = Record<string, unknown>
// A made-up GitHub token, built here so no scanner takes the test for a leak.
const GITHUB = ['ghp', 'AbCdEfGhIjKlMnOpQrStUvWxYz0123456789'].join('_')

describe('undo, exact, whole or in parts (spec learning-memory A2)', { skip: skipPg }, () => {
  let w: World
  let cora: { id: string; key: string }
  let cole: { id: string; key: string }
  let rita: { id: string; key: string }
  let otto: { id: string; key: string }
  let coraWeb: string
  let adminWeb: string
  let writer: string
  let source: string
  let other: string

  const create = (address: string, extra: Json = {}) => ({
    op: 'create',
    address,
    type: 'topic',
    title: `Page ${address}`,
    summary: `About ${address}.`,
    body: `Text of ${address} about quaggalith.`,
    sources: [{ entryId: source }],
    reason: 'From the journal.',
    ...extra,
  })
  const propose = async (ops: Json[], title = 'A change', key = cole.key) => {
    const r = await w.call(key, 'POST', '/v1/brains/un/proposals', { title, ops })
    assert.equal(r.status, 201, r.text)
    return r.body as { undo: string; proposal: { id: string }; status: string }
  }
  const plant = async (address: string, extra: Json = {}) => {
    const r = await w.callWeb(coraWeb, 'POST', '/v1/brains/un/wiki/changes', {
      op: 'create',
      address,
      type: 'topic',
      title: `Page ${address}`,
      summary: `About ${address}.`,
      body: `Text of ${address}.`,
      sources: [{ entryId: other }],
      ...extra,
    })
    assert.equal(r.status, 201, r.text)
  }
  const undo = (id: string, body: Json = {}, key?: string) =>
    key
      ? w.call(key, 'POST', `/v1/wiki/changes/${id}/undo`, body)
      : w.callWeb(coraWeb, 'POST', `/v1/wiki/changes/${id}/undo`, body)
  const pageId = async (address: string) =>
    (
      await w.db.one<{ page_id: string }>(
        "SELECT page_id FROM page_addresses a JOIN brains b ON b.id = a.brain_id WHERE b.slug = 'un' AND a.address = $1",
        [address],
      )
    )?.page_id as string
  // Everything a page is, but its revision count and times: content, status, its addresses, sources, links out and in.
  const print = async (ids: string[]) => {
    const out: Json[] = []
    for (const id of ids) {
      const p = await w.db.one(
        'SELECT address, type, title, summary, body, tags, status, superseded_by FROM pages WHERE id = $1',
        [id],
      )
      const q = async (sql: string) => (await w.db.query(sql, [id])).map((r) => Object.values(r).join(' '))
      out.push({
        id,
        ...p,
        addresses: await q('SELECT address FROM page_addresses WHERE page_id = $1 ORDER BY address'),
        sources: await q(
          'SELECT coalesce(entry_id, url) FROM page_sources WHERE page_id = $1 ORDER BY coalesce(entry_id, url)',
        ),
        out: await q(
          'SELECT kind, coalesce(to_page, to_address) FROM page_links WHERE from_page = $1 ORDER BY 1, 2',
        ),
        in: await q('SELECT from_page, kind FROM page_links WHERE to_page = $1 ORDER BY 1, 2'),
      })
    }
    return out
  }
  const revisionOf = async (address: string) =>
    (
      (await w.call(cora.key, 'GET', `/v1/brains/un/pages/${address}`)).body.page as
        | { revision: number }
        | undefined
    )?.revision

  before(async () => {
    w = await world()
    cora = await w.person('Cora')
    cole = await w.person('Cole')
    rita = await w.person('Rita')
    otto = await w.person('Otto')
    const admin = await w.person('Admin', { isAdmin: true })
    await w.call(cora.key, 'POST', '/v1/brains', { slug: 'un', purpose: 'Undo.' })
    await w.member('un', cole.id, 'contributor')
    await w.member('un', rita.id, 'reader')
    coraWeb = await w.web(cora.id)
    adminWeb = await w.web(admin.id)
    const coleWeb = await w.web(cole.id)
    const t = await w.callWeb(coleWeb, 'POST', '/v1/me/tokens', {
      name: 'Cole writer',
      perm: 'write',
      brains: ['un'],
      days: 30,
    })
    const tok = t.body.token as { id: string; secret: string }
    writer = tok.secret
    assert.equal((await w.callWeb(coraWeb, 'PUT', `/v1/brains/un/wiki/writers/${tok.id}`)).status, 200)
    for (const [title, set] of [
      ['Quaggalith', (id: string) => (source = id)],
      ['Older', (id: string) => (other = id)],
    ] as const) {
      const e = await w.call(cole.key, 'POST', '/v1/brains/un/entries', {
        type: 'learning',
        title,
        content: `${title} facts.`,
      })
      set((e.body.receipt as { entryId: string }).entryId)
    }
  })
  after(async () => w.close())

  it('CA-A2, A3: undoing a create retires the page: out of search and context, its address free; the log has both lines', async () => {
    const c = await propose([create('fresh')], 'Fresh page')
    // The test clock stands still: a minute apart, the two log lines have an order.
    w.advance(60_000)
    const r = await undo(c.undo)
    assert.equal(r.status, 200, r.text)
    assert.deepEqual(
      (r.body.undone as Array<{ address: string }>).map((x) => x.address),
      ['fresh'],
    )
    assert.equal((r.body.change as { state: string }).state, 'undone')
    const st = await w.db.one<{ status: string }>(
      "SELECT p.status FROM pages p JOIN brains b ON b.id = p.brain_id WHERE b.slug = 'un' AND p.address = 'fresh'",
    )
    assert.equal(st?.status, 'retired')
    const s = await w.call(cole.key, 'GET', '/v1/search?q=quaggalith&brains=un&in=pages')
    assert.equal(
      (s.body.items as Array<{ address: string }>).find((x) => x.address === 'fresh'),
      undefined,
    )
    const ctx = await w.call(cole.key, 'GET', '/v1/brains/un/context?task=quaggalith')
    assert.doesNotMatch(String(ctx.body.text), /<<<page address=fresh /)
    const log = await w.db.query<{ kind: string; summary: string }>(
      "SELECT l.kind, l.summary FROM wiki_log l JOIN brains b ON b.id = l.brain_id WHERE b.slug = 'un' AND 'fresh' = ANY(l.pages) ORDER BY l.at, l.id",
    )
    assert.deepEqual(
      log.map((l) => `${l.kind}: ${l.summary}`),
      ['proposal: Applied at once: Fresh page', 'undo: Undone: Fresh page'],
    )
    // M7: its address is free for a new page.
    const again = await propose([create('fresh')], 'Fresh again')
    assert.equal(again.status, 'applied')
  })

  it('CA-A2: undoing an edit leaves the page exactly as it was', async () => {
    await plant('ed')
    const id = await pageId('ed')
    const before = await print([id])
    const c = await propose([
      {
        op: 'edit',
        address: 'ed',
        baseRevision: 1,
        title: 'New title',
        summary: 'New summary.',
        body: 'New body with [[fresh]].',
        tags: ['x'],
        sources: [{ entryId: source }],
        reason: 'Better.',
      },
    ])
    assert.notDeepEqual(await print([id]), before)
    const r = await undo(c.undo)
    assert.equal(r.status, 200, r.text)
    assert.deepEqual(await print([id]), before)
    assert.equal(await revisionOf('ed'), 3, 'the undo is a revision of its own')
  })

  it('CA-A26: undoing a merge puts both pages, their addresses and the links in and out back', async () => {
    await plant('mx')
    await plant('my', { links: [{ kind: 'related', to: 'mx' }] })
    await plant('mp', { links: [{ kind: 'depends-on', to: 'my' }] })
    await plant('mq')
    await w.callWeb(coraWeb, 'POST', '/v1/brains/un/wiki/changes', {
      op: 'link',
      address: 'my',
      kind: 'related',
      to: 'mq',
      reason: 'See.',
    })
    const ids = await Promise.all(['mx', 'my', 'mp', 'mq'].map(pageId))
    const before = await print(ids)
    const c = await propose([
      {
        op: 'merge',
        address: 'mx',
        from: 'my',
        body: 'Both.',
        dropSources: [],
        dropLinks: [],
        reason: 'Same.',
      },
    ])
    assert.equal(c.status, 'applied')
    assert.notDeepEqual(await print(ids), before)
    const r = await undo(c.undo)
    assert.equal(r.status, 200, r.text)
    assert.deepEqual(await print(ids), before)
  })

  it('CA-A26: undoing a move puts the address back and frees the new one', async () => {
    await plant('mv')
    const id = await pageId('mv')
    const before = await print([id])
    const c = await propose([{ op: 'move', address: 'mv', to: 'moved/mv', reason: 'Tidy.' }])
    const r = await undo(c.undo)
    assert.equal(r.status, 200, r.text)
    assert.deepEqual(await print([id]), before)
    assert.equal(await pageId('moved/mv'), undefined)
  })

  it('CA-A10: a later change on the page is a conflict; nothing changes until a person overwrites it', async () => {
    await plant('cf')
    const a = await propose([{ op: 'edit', address: 'cf', baseRevision: 1, body: 'A.', reason: 'A.' }])
    await propose([{ op: 'edit', address: 'cf', baseRevision: 2, body: 'B.', reason: 'B.' }])
    const r = await undo(a.undo)
    assert.equal(r.status, 409, r.text)
    assert.equal(r.body.error?.code, 'undo_conflict')
    assert.deepEqual((r.body.error as unknown as { pages: unknown }).pages, [
      { address: 'cf', changeRevision: 2, currentRevision: 3 },
    ])
    assert.equal(await revisionOf('cf'), 3)
    const ok = await undo(a.undo, { overwrite: ['cf'] })
    assert.equal(ok.status, 200, ok.text)
    const p = (await w.call(cora.key, 'GET', '/v1/brains/un/pages/cf')).body.page as {
      body: string
      revision: number
    }
    assert.deepEqual([p.body, p.revision], ['Text of cf.', 4])
    // What came after stays in the history.
    const h = await w.call(cora.key, 'GET', '/v1/brains/un/pages/cf?include=history')
    assert.ok((h.body.history as Array<{ revision: number }>).some((x) => x.revision === 3))
  })

  it('CA-A21: undoing twice answers it is undone already and changes nothing', async () => {
    const c = await propose([create('twice')])
    assert.equal((await undo(c.undo)).status, 200)
    const at = await w.db.one<{ n: number }>('SELECT count(*)::int AS n FROM page_revisions')
    const again = await undo(c.undo)
    assert.equal(again.status, 200, again.text)
    assert.equal(again.body.alreadyUndone, true)
    assert.deepEqual(await w.db.one('SELECT count(*)::int AS n FROM page_revisions'), at)
  })

  it('by parts: a part another part that stays needs is not undone alone; the one that needs it is', async () => {
    await plant('hub')
    const c = await propose([
      create('spoke'),
      { op: 'link', address: 'hub', kind: 'related', to: 'spoke', reason: 'See.' },
    ])
    const d = await w.callWeb(coraWeb, 'GET', `/v1/wiki/changes/${c.undo}`)
    const parts = d.body.parts as Array<{ part: number; address: string; dependsOn: number[] }>
    const spoke = parts.find((p) => p.address === 'spoke')?.part as number
    const hub = parts.find((p) => p.address === 'hub')?.part as number
    assert.deepEqual(parts.find((p) => p.address === 'hub')?.dependsOn, [spoke])
    const bad = await undo(c.undo, { parts: [spoke] })
    assert.equal(bad.status, 400, bad.text)
    assert.equal(bad.body.error?.code, 'missing_dependencies')
    const one = await undo(c.undo, { parts: [hub] })
    assert.equal(one.status, 200, one.text)
    assert.equal((one.body.change as { state: string }).state, 'partly_undone')
    const two = await undo(c.undo, { parts: [spoke] })
    assert.equal(two.status, 200, two.text)
    assert.equal((two.body.change as { state: string }).state, 'undone')
  })

  it('CA-A25, H4: a comment becomes a correction for whoever proposed, redacted; a purge takes the comment away', async () => {
    const c = await propose([create('taught')], 'Taught page')
    const r = await undo(c.undo, { comment: `Zanzibarite is wrong here; token ${GITHUB}.` })
    assert.equal(r.status, 200, r.text)
    const id = String(r.body.correction)
    const e = (await w.call(cora.key, 'GET', `/v1/entries/${id}`)).body.entry as {
      type: string
      appliesTo: string
      content: string
    }
    assert.equal(e.type, 'correction')
    assert.equal(e.appliesTo, 'Cole')
    assert.match(e.content, /Zanzibarite is wrong here/)
    assert.doesNotMatch(e.content, /ghp_/)
    const stored = await w.db.one<{ comment: string }>('SELECT comment FROM wiki_changes WHERE id = $1', [
      c.undo,
    ])
    assert.ok(stored?.comment.includes(SECRET_MARK) || !stored?.comment.includes('ghp_'))
    assert.doesNotMatch(String(stored?.comment), /ghp_/)
    const purge = await w.callWeb(adminWeb, 'POST', `/v1/proposals/${c.proposal.id}/purge`, {
      reason: 'wrong',
    })
    assert.equal(purge.status, 200, purge.text)
    const after = await w.db.one<{ comment: string | null }>(
      'SELECT comment FROM wiki_changes WHERE id = $1',
      [c.undo],
    )
    assert.equal(after?.comment, null)
  })

  it('M7: a comment on a direct write teaches the key’s owner, titled from its log line', async () => {
    const wr = await w.call(writer, 'POST', '/v1/brains/un/wiki/write', {
      title: 'Direct one',
      ops: [create('direct')],
    })
    assert.equal(wr.status, 201, wr.text)
    const r = await undo(String(wr.body.undo), { comment: 'Not this one.' })
    assert.equal(r.status, 200, r.text)
    const e = (await w.call(cora.key, 'GET', `/v1/entries/${r.body.correction}`)).body.entry as {
      appliesTo: string
      title: string
    }
    assert.equal(e.appliesTo, 'Cole')
    assert.match(e.title, /Direct one/)
  })

  it('a revision before that was purged is not put back: the part is skipped, with the reason', async () => {
    await plant('gone')
    const c = await propose([
      { op: 'edit', address: 'gone', baseRevision: 1, body: 'Later.', reason: 'Later.' },
    ])
    await w.db.query(
      "UPDATE page_revisions SET purged_at = now(), body = '' WHERE page_id = $1 AND revision = 1",
      [await pageId('gone')],
    )
    const r = await undo(c.undo)
    assert.equal(r.status, 200, r.text)
    assert.deepEqual(r.body.undone, [])
    assert.deepEqual(r.body.skipped, [{ address: 'gone', reason: 'purged' }])
    assert.equal(await revisionOf('gone'), 2)
  })

  it('H2: a key with the permission undoes; a reader, a contributor without it, are refused; outside, the same 404', async () => {
    const c = await propose([create('by-key')])
    const coleWeb = await w.web(cole.id)
    for (const [label, call] of [
      ['reader', () => undo(c.undo, {}, rita.key)],
      ['contributor key', () => undo(c.undo, {}, cole.key)],
      ['contributor web', () => w.callWeb(coleWeb, 'POST', `/v1/wiki/changes/${c.undo}/undo`, {})],
    ] as const) {
      const r = await call()
      assert.equal(r.status, 403, `${label}: ${r.text}`)
    }
    const outsider = await undo(c.undo, {}, otto.key)
    const invented = await undo('chg_000000000000', {}, cora.key)
    assert.deepEqual([outsider.status, outsider.body.error], [invented.status, invented.body.error])
    assert.equal(outsider.status, 404)
    const body = { requestKey: 'u-1' }
    const one = await undo(c.undo, body, writer)
    assert.equal(one.status, 200, one.text)
    const two = await undo(c.undo, body, writer)
    assert.deepEqual(two.body, one.body)
  })
})
