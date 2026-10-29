// Spec B2: sending proposals (checks, warnings, privacy, permissions), the inbox, withdrawing and
// replacing them, the compile pack and the guide; and reading pages, links, map, decisions and log.
import assert from 'node:assert/strict'
import { after, before, describe, it } from 'node:test'
import { SECRET_MARK } from '../../src/privacy/redact.ts'
import { skipPg } from '../helpers/pg.ts'
import { type World, world } from '../helpers/world.ts'

type Problem = { op: number | null; message: string }
type Warning = { op: number | null; code: string; message: string }
const GITHUB = 'ghp_AbCdEfGhIjKlMnOpQrStUvWxYz0123456789'

describe('wiki proposals and reading', { skip: skipPg }, () => {
  let w: World
  let eric: { id: string; key: string }
  let ana: { id: string; key: string }
  let reader: { id: string; key: string }
  let factory: { id: string; key: string }
  const entries: string[] = []

  const save = async (key: string, body: Record<string, unknown>, slug = 'yt') =>
    ((await w.call(key, 'POST', `/v1/brains/${slug}/entries`, body)).body.receipt as { entryId: string })
      .entryId
  const propose = (key: string, body: Record<string, unknown>, slug = 'yt') =>
    w.call(key, 'POST', `/v1/brains/${slug}/proposals`, body)
  const create = (address: string, extra: Record<string, unknown> = {}) => ({
    op: 'create',
    address,
    type: 'topic',
    title: `Page ${address}`,
    summary: `About ${address}.`,
    body: `Text of ${address}.`,
    sources: [{ entryId: entries[0] }],
    reason: 'It is what the journal says.',
    ...extra,
  })
  // Pages are written by the applier (next part); here they are planted to test reading.
  let n = 0
  const plant = async (
    address: string,
    o: { type?: string; status?: string; body?: string; old?: string[] } = {},
  ) => {
    n += 1
    const id = `pg_${String(n).padStart(12, '0')}`
    const b = await w.db.one<{ id: string }>("SELECT id FROM brains WHERE slug = 'yt'")
    await w.db.query(
      `INSERT INTO pages (id, brain_id, address, type, title, summary, body, status, created_at, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$9)`,
      [
        id,
        b?.id,
        address,
        o.type ?? 'topic',
        `Title ${address}`,
        `Sum ${address}`,
        o.body ?? '',
        o.status ?? 'current',
        w.now,
      ],
    )
    for (const a of [address, ...(o.old ?? [])]) {
      await w.db.query(
        'INSERT INTO page_addresses (brain_id, address, page_id, created_at) VALUES ($1,$2,$3,$4)',
        [b?.id, a, id, w.now],
      )
    }
    return { id, brainId: b?.id as string }
  }

  before(async () => {
    w = await world()
    eric = await w.person('Eric')
    ana = await w.person('Ana')
    reader = await w.person('Reader')
    factory = await w.service('RSC Factory')
    await w.call(eric.key, 'POST', '/v1/brains', { slug: 'yt', purpose: 'Our channel.' })
    await w.call(eric.key, 'POST', '/v1/brains', { slug: 'other' })
    await w.member('yt', ana.id, 'contributor')
    await w.member('yt', reader.id, 'reader')
    await w.member('yt', factory.id, 'contributor')
    for (const i of [1, 2, 3]) {
      entries.push(
        await save(ana.key, {
          type: 'learning',
          title: `Retention ${i}`,
          content: `Short hooks keep viewers ${i}.`,
        }),
      )
    }
  })
  after(async () => w.close())

  it('a contributor sends a proposal; it is pending in the inbox, with no blocking problem', async () => {
    const r = await propose(factory.key, {
      title: 'Retention page',
      reason: 'Run r_1 learned it.',
      ops: [create('audience/retention')],
    })
    assert.equal(r.status, 201)
    const p = r.body.proposal as { id: string; status: string; old: boolean }
    assert.match(p.id, /^prp_[0-9a-f]{12}$/)
    assert.deepEqual([p.status, p.old], ['pending', false])
    const inbox = (await w.call(eric.key, 'GET', '/v1/brains/yt/proposals')).body.items as {
      id: string
      opCount: number
    }[]
    assert.ok(inbox.some((x) => x.id === p.id && x.opCount === 1))
  })

  it('CA2: a new page without sources is refused, naming the operation', async () => {
    const r = await propose(factory.key, {
      title: 'Two pages',
      ops: [create('voices/ok'), create('voices/bare', { sources: [] })],
    })
    assert.equal(r.status, 400)
    assert.equal(r.body.error?.code, 'proposal_invalid')
    const problems = (r.body.error as unknown as { problems: Problem[] }).problems
    assert.deepEqual(
      problems.map((p) => p.op),
      [1],
    )
    assert.match(problems[0]?.message ?? '', /voices\/bare.*cites no sources/)
    assert.equal(await w.db.one("SELECT 1 FROM proposals WHERE title = 'Two pages'"), undefined)
  })

  it('CA3: a typed link to a page that neither exists nor is created is refused; a broken mention is a warning', async () => {
    const bad = await propose(factory.key, {
      title: 'Dep',
      ops: [create('voices/style', { links: [{ kind: 'depends-on', to: 'voices/narrator' }] })],
    })
    assert.equal(bad.status, 400)
    assert.match(
      JSON.stringify(bad.body),
      /depends-on link points at \\"voices\/narrator\\", which does not exist/,
    )
    const both = await propose(factory.key, {
      title: 'Dep with the page',
      ops: [
        create('voices/style2', { links: [{ kind: 'depends-on', to: 'voices/narrator' }] }),
        create('voices/narrator'),
      ],
    })
    assert.equal(both.status, 201)
    const mention = await propose(factory.key, {
      title: 'Mention',
      ops: [create('voices/intro', { body: 'Read [[voices/narrator-x]] first.' })],
    })
    assert.equal(mention.status, 201)
    const ws = mention.body.warnings as Warning[]
    assert.ok(ws.some((x) => x.code === 'broken_mention' && x.op === 0))
  })

  it('every problem at once: bad addresses, taken and reserved addresses, too many operations, unknown entries', async () => {
    await plant('style/intro-length', { old: ['style/intro'] })
    const r = await propose(factory.key, {
      title: 'Many problems',
      ops: [
        create('Style/Bad'),
        create('style/intro-length'),
        create('style/intro'),
        create('x/one', { sources: [{ entryId: 'ent_000000000000' }] }),
        { op: 'edit', address: 'style/intro-length', body: 'x', reason: 'r' },
        { op: 'edit', address: 'nowhere/at-all', body: 'x', reason: 'r' },
      ],
    })
    assert.equal(r.status, 400)
    const text = JSON.stringify((r.body.error as unknown as { problems: Problem[] }).problems)
    assert.match(text, /not a valid address/)
    assert.match(text, /already taken by the page/)
    assert.match(text, /reserved: it was an address of the page now at \\"style\/intro-length\\"/)
    assert.match(text, /no entry \\"ent_000000000000\\"/)
    assert.match(text, /baseRevision/)
    assert.match(text, /no page at \\"nowhere\/at-all\\"/)
    const many = await propose(factory.key, {
      title: 'Too many',
      ops: Array.from({ length: 51 }, (_, i) => create(`bulk/p${i}`)),
    })
    assert.equal(many.status, 400)
    assert.match(JSON.stringify(many.body), /at most 50 operations/)
  })

  it('warnings that do not block: no links, empty summary, near-duplicate title', async () => {
    await plant('audience/what-keeps-viewers')
    const r = await propose(factory.key, {
      title: 'Warnings',
      ops: [create('audience/keeps', { title: 'Title audience/what-keeps-viewers', summary: '' })],
    })
    assert.equal(r.status, 201)
    const codes = (r.body.warnings as Warning[]).map((x) => x.code).sort()
    assert.deepEqual(codes, ['empty_summary', 'no_links', 'similar_title'])
  })

  it('CA24: a source forgotten after sending shows as a warning when the proposal is read', async () => {
    const e7 = await save(ana.key, { type: 'fact', title: 'E7', content: 'Seven.' })
    const p = (
      await propose(factory.key, {
        title: 'Cites E7',
        ops: [create('facts/seven', { sources: [{ entryId: e7 }] })],
      })
    ).body.proposal as { id: string }
    await w.call(eric.key, 'POST', `/v1/entries/${e7}/forget`, { reason: 'wrong' })
    const read = (await w.call(eric.key, 'GET', `/v1/proposals/${p.id}`)).body.warnings as Warning[]
    assert.ok(read.some((x) => x.code === 'source_forgotten' && x.op === 0))
  })

  it('privacy: secrets in the title, reason and operations are never stored', async () => {
    const r = await propose(factory.key, {
      title: `Deploy ${GITHUB}`,
      reason: `with ${GITHUB}`,
      ops: [create('tools/deploy', { body: `use ${GITHUB}`, reason: `r ${GITHUB}` })],
    })
    assert.equal(r.status, 201)
    assert.ok(!r.text.includes(GITHUB) && r.text.includes(SECRET_MARK))
    for (const t of ['proposals', 'proposal_ops', 'events']) {
      assert.ok(!JSON.stringify(await w.db.query(`SELECT * FROM ${t}`)).includes(GITHUB), t)
    }
  })

  it('only contributors with a write key propose; readers and strangers cannot', async () => {
    assert.equal((await propose(reader.key, { title: 'x', ops: [create('a/b')] })).status, 403)
    const ro = await w.token(ana.id, { perm: 'read' })
    assert.equal((await propose(ro, { title: 'x', ops: [create('a/b')] })).status, 403)
    const stranger = await w.person('Stranger')
    assert.equal((await propose(stranger.key, { title: 'x', ops: [create('a/b')] })).status, 404)
    await w.call(eric.key, 'POST', '/v1/brains/other/archive')
    const archived = await propose(eric.key, { title: 'x', ops: [create('a/b')] }, 'other')
    assert.equal(archived.status, 403)
    assert.match(archived.body.error?.message ?? '', /archived/)
  })

  it('CA22: the author replaces a pending proposal; the old one is superseded and no longer pending', async () => {
    const p1 = (await propose(factory.key, { title: 'P1', ops: [create('replace/one')] })).body.proposal as {
      id: string
    }
    const p2r = await propose(factory.key, { title: 'P2', supersedes: p1.id, ops: [create('replace/one')] })
    assert.equal(p2r.status, 201)
    const p2 = p2r.body.proposal as { id: string; supersedes: string; status: string }
    assert.deepEqual([p2.supersedes, p2.status], [p1.id, 'pending'])
    const old = (await w.call(eric.key, 'GET', `/v1/proposals/${p1.id}`)).body.proposal as {
      status: string
      supersededBy: string
    }
    assert.deepEqual([old.status, old.supersededBy], ['superseded', p2.id])
    const again = await propose(factory.key, { title: 'P3', supersedes: p1.id, ops: [create('replace/one')] })
    assert.equal(again.status, 400)
    const byOther = await propose(ana.key, { title: 'P4', supersedes: p2.id, ops: [create('replace/one')] })
    assert.equal(byOther.status, 400)
    assert.match(JSON.stringify(byOther.body), /Only the author/)
  })

  it('the author withdraws a pending proposal; nobody else can', async () => {
    const p = (await propose(factory.key, { title: 'W', ops: [create('withdraw/one')] })).body.proposal as {
      id: string
    }
    assert.equal((await w.call(ana.key, 'POST', `/v1/proposals/${p.id}/withdraw`)).status, 403)
    const r = await w.call(factory.key, 'POST', `/v1/proposals/${p.id}/withdraw`)
    assert.equal((r.body.proposal as { status: string }).status, 'withdrawn')
    assert.equal((await w.call(factory.key, 'POST', `/v1/proposals/${p.id}/withdraw`)).status, 409)
  })

  it('CA20: a proposal pending for 31 days is marked old and is still pending', async () => {
    const p = (await propose(factory.key, { title: 'Old one', ops: [create('old/one')] })).body.proposal as {
      id: string
    }
    w.advance(31 * 24 * 60 * 60 * 1000)
    const inbox = (await w.call(eric.key, 'GET', '/v1/brains/yt/proposals')).body.items as {
      id: string
      old: boolean
      status: string
    }[]
    const mine = inbox.find((x) => x.id === p.id)
    assert.deepEqual([mine?.status, mine?.old], ['pending', true])
    w.advance(-31 * 24 * 60 * 60 * 1000)
  })

  it('proposals of a brain I cannot read answer like ones that do not exist', async () => {
    const p = (await propose(factory.key, { title: 'Hidden', ops: [create('hidden/one')] })).body
      .proposal as { id: string }
    const stranger = await w.person('Outsider')
    assert.equal((await w.call(stranger.key, 'GET', `/v1/proposals/${p.id}`)).status, 404)
    assert.equal((await w.call(stranger.key, 'GET', '/v1/proposals/prp_000000000000')).status, 404)
  })

  it('CA16: the compile pack has the uncompiled entries in order, the corrections, the map, related pages and the guide', async () => {
    await w.call(eric.key, 'POST', '/v1/brains', { slug: 'pack', purpose: 'Packing.' })
    await w.member('pack', factory.id, 'contributor')
    await w.member('pack', ana.id, 'contributor')
    const ids: string[] = []
    for (let i = 1; i <= 12; i += 1) {
      ids.push(
        await save(
          ana.key,
          {
            type: 'learning',
            title: `Hook ${i}`,
            content: `Hooks lesson number ${i} about audience/retention. ${'More detail. '.repeat(30)}`,
          },
          'pack',
        ),
      )
      w.advance(1000)
    }
    for (const i of [1, 2]) {
      await w.call(factory.key, 'POST', '/v1/brains/pack/corrections/relay', {
        onBehalf: (await w.db.one<{ email: string }>('SELECT email FROM accounts WHERE id = $1', [ana.id]))
          ?.email,
        title: `Correction ${i}`,
        content: `People say ${i}.`,
      })
    }
    const pk = (await w.call(factory.key, 'GET', '/v1/brains/pack/wiki/compile')).body as {
      entries: { id: string }[]
      corrections: { type: string }[]
      map: { groups: unknown[] }
      pages: unknown[]
      guide: string
      remaining: number
    }
    assert.deepEqual(
      pk.entries.map((e) => e.id),
      ids,
    )
    assert.equal(pk.corrections.length, 2)
    assert.ok(pk.corrections.every((c) => c.type === 'correction'))
    assert.ok(Array.isArray(pk.map.groups))
    assert.match(pk.guide, /cites the journal entries/)
    assert.equal(pk.remaining, 0)
    const small = (await w.call(factory.key, 'GET', '/v1/brains/pack/wiki/compile?maxChars=4000')).body as {
      entries: unknown[]
      remaining: number
    }
    assert.ok(small.entries.length < 12 && small.remaining === 12 - small.entries.length)
    assert.equal((await w.call(factory.key, 'GET', '/v1/brains/pack/wiki/compile?maxChars=10')).status, 400)
  })

  it('the compile pack brings the pages the entries name, share a topic with, or match by words', async () => {
    await plant('audience/retention-notes')
    await plant('quokka/topic')
    await plant('zebra/words', { body: 'zebrafish narration timing' })
    await save(ana.key, { type: 'note', title: 'Note', content: 'See [[audience/retention-notes]].' })
    await save(ana.key, { type: 'note', title: 'T', content: 'topic one', topic: 'quokka/topic' })
    await save(ana.key, { type: 'note', title: 'zebrafish timing', content: 'words' })
    const pk = (await w.call(factory.key, 'GET', '/v1/brains/yt/wiki/compile')).body as {
      pages: { address: string; why: string }[]
    }
    const why = Object.fromEntries(pk.pages.map((p) => [p.address, p.why]))
    assert.equal(why['audience/retention-notes'], 'mentioned')
    assert.equal(why['quokka/topic'], 'topic')
    assert.equal(why['zebra/words'], 'words')
    assert.equal((await w.call(reader.key, 'GET', '/v1/brains/yt/wiki/compile')).status, 403)
  })

  it('CA17 (reading): the guide is the default until a curator writes one', async () => {
    const g = (await w.call(reader.key, 'GET', '/v1/brains/yt/wiki/guide')).body as {
      guide: string
      custom: boolean
    }
    assert.equal(g.custom, false)
    assert.match(g.guide, /One page per topic/)
  })

  it('reading a page: old addresses redirect, links both ways, broken and retired mentions, sources', async () => {
    const a = await plant('read/target', { old: ['read/old-target'] })
    const b = await plant('read/source', {
      body: 'See [[read/old-target]], [[read/missing]] and [[read/gone]].',
    })
    await plant('read/gone', { status: 'retired' })
    for (const to of ['read/old-target', 'read/missing', 'read/gone']) {
      await w.db.query(
        "INSERT INTO page_links (brain_id, from_page, kind, to_address) VALUES ($1,$2,'mentions',$3)",
        [b.brainId, b.id, to],
      )
    }
    await w.db.query(
      "INSERT INTO page_links (brain_id, from_page, kind, to_page) VALUES ($1,$2,'related',$3)",
      [a.brainId, a.id, b.id],
    )
    await w.db.query('INSERT INTO page_sources (page_id, entry_id) VALUES ($1,$2)', [a.id, entries[1]])
    const viaOld = (await w.call(reader.key, 'GET', '/v1/brains/yt/pages/read/old-target')).body as {
      page: { address: string }
      redirectedFrom: string
      links: {
        out: { kind: string; address: string; state: string }[]
        in: { kind: string; address: string }[]
      }
      sources: { entryId: string; state: string }[]
    }
    assert.deepEqual([viaOld.page.address, viaOld.redirectedFrom], ['read/target', 'read/old-target'])
    assert.deepEqual(
      viaOld.links.out.map((l) => [l.kind, l.address]),
      [['related', 'read/source']],
    )
    assert.deepEqual(
      viaOld.links.in.map((l) => [l.kind, l.address]),
      [['mentions', 'read/source']],
    )
    assert.deepEqual(
      viaOld.sources.map((s) => [s.entryId, s.state]),
      [[entries[1], 'active']],
    )
    const src = (await w.call(reader.key, 'GET', '/v1/brains/yt/pages/read/source')).body as {
      links: { out: { address: string; state: string }[] }
    }
    const states = Object.fromEntries(src.links.out.map((l) => [l.address, l.state]))
    assert.deepEqual(states, { 'read/target': 'ok', 'read/missing': 'broken', 'read/gone': 'retired' })
    const gone = (await w.call(reader.key, 'GET', '/v1/brains/yt/pages/read/gone')).body as { notice: string }
    assert.match(gone.notice, /retired/)
    const missing = await w.call(reader.key, 'GET', '/v1/brains/yt/pages/read/nope')
    assert.deepEqual([missing.status, missing.body.error?.code], [404, 'page_not_found'])
    const stranger = await w.person('Nobody')
    assert.equal((await w.call(stranger.key, 'GET', '/v1/brains/yt/pages/read/target')).status, 404)
  })

  it('the map lists current pages grouped by type and area; decisions newest first', async () => {
    await plant('decisions/hooks', { type: 'decision' })
    w.advance(1000)
    await plant('decisions/voices', { type: 'decision' })
    await plant('decisions/old', { type: 'decision', status: 'retired' })
    const map = (await w.call(reader.key, 'GET', '/v1/brains/yt/wiki/map')).body as {
      groups: { type: string; area: string; pages: { address: string }[] }[]
    }
    const all = map.groups.flatMap((g) => g.pages.map((p) => p.address))
    assert.ok(all.includes('read/target') && !all.includes('read/gone'))
    const dec = map.groups.find((g) => g.type === 'decision' && g.area === 'decisions')
    assert.deepEqual(
      dec?.pages.map((p) => p.address),
      ['decisions/hooks', 'decisions/voices'],
    )
    const decisions = (await w.call(reader.key, 'GET', '/v1/brains/yt/wiki/decisions')).body.decisions as {
      address: string
    }[]
    assert.deepEqual(
      decisions.map((d) => d.address),
      ['decisions/voices', 'decisions/hooks'],
    )
    const log = (await w.call(reader.key, 'GET', '/v1/brains/yt/wiki/log')).body as {
      items: unknown[]
      total: number
    }
    assert.deepEqual([log.items, log.total], [[], 0])
  })

  it('review: the agent name is redacted like every stored text', async () => {
    const r = await propose(factory.key, { title: 'Agent', agent: GITHUB, ops: [create('agent/redacted')] })
    assert.equal(r.status, 201)
    assert.ok(!JSON.stringify(await w.db.query('SELECT agent FROM proposals')).includes(GITHUB))
  })

  it('review: broken text, odd values, deep nesting and odd cursors are 400, never 500', async () => {
    const raw = (body: string) => w.call(factory.key, 'POST', '/v1/brains/yt/proposals', body)
    const op = (extra: string) =>
      `{"title":"t","ops":[{"op":"create","address":"odd/x","type":"topic","title":"x","sources":[{"entryId":"${entries[0]}"}],"reason":"r"${extra}}]}`
    assert.equal((await raw(op(',"body":"\\ud800"'))).status, 400)
    assert.equal((await raw(op(',"tags":["\\udfff"]'))).status, 400)
    assert.equal((await raw('{"title":"t","ops":[{"op":{"toString":1}}]}')).status, 400)
    assert.equal((await raw(op(',"type":{"toString":1}').replace('"type":"topic",', ''))).status, 400)
    assert.equal((await raw(`{"title":"t","ops":${'['.repeat(5000)}${']'.repeat(5000)}}`)).status, 400)
    const cursor = Buffer.from(JSON.stringify({ at: '1', id: 'x' })).toString('base64url')
    for (const path of ['/v1/brains/yt/wiki/log', '/v1/brains/yt/proposals', '/v1/brains/yt/entries']) {
      assert.equal((await w.call(eric.key, 'GET', `${path}?cursor=${cursor}`)).status, 400, path)
    }
  })

  it('review: withdrawing needs what proposing needs: a write key and an active brain', async () => {
    const p = (await propose(ana.key, { title: 'Mine', ops: [create('withdraw/mine')] })).body.proposal as {
      id: string
    }
    const ro = await w.token(ana.id, { perm: 'read' })
    assert.equal((await w.call(ro, 'POST', `/v1/proposals/${p.id}/withdraw`)).status, 403)
    await w.call(eric.key, 'POST', '/v1/brains', { slug: 'arch' })
    await w.member('arch', ana.id, 'contributor')
    await save(ana.key, { type: 'note', title: 'n', content: 'archived soon' }, 'arch')
    const e = (
      await w.db.one<{ id: string }>(
        "SELECT e.id FROM entries e JOIN brains b ON b.id = e.brain_id WHERE b.slug = 'arch'",
      )
    )?.id
    const q = (
      await propose(ana.key, { title: 'A', ops: [create('arch/one', { sources: [{ entryId: e }] })] }, 'arch')
    ).body.proposal as { id: string }
    await w.call(eric.key, 'POST', '/v1/brains/arch/archive')
    assert.equal((await w.call(ana.key, 'POST', `/v1/proposals/${q.id}/withdraw`)).status, 403)
    assert.equal(
      ((await w.call(ana.key, 'GET', `/v1/proposals/${p.id}`)).body.proposal as { status: string }).status,
      'pending',
    )
  })

  it('review: a page cannot point at itself, not even through an old address', async () => {
    await plant('self/page', { old: ['self/old'] })
    const cases = [
      [create('self/new', { links: [{ kind: 'related', to: 'self/new' }] })],
      [{ op: 'link', address: 'self/page', kind: 'related', to: 'self/old', reason: 'r' }],
      [{ op: 'merge', address: 'self/page', from: 'self/old', body: 'b', reason: 'r' }],
      [{ op: 'status', address: 'self/page', status: 'superseded', supersededBy: 'self/old', reason: 'r' }],
      [{ op: 'status', address: 'self/page', status: 'superseded', supersededBy: 'self/page', reason: 'r' }],
    ]
    for (const ops of cases) {
      const r = await propose(factory.key, { title: 'Self', ops })
      assert.equal(r.status, 400, JSON.stringify(ops))
      assert.match(JSON.stringify(r.body), /itself/)
    }
  })

  it('review: operations after a move in the same proposal reach the existing page', async () => {
    await plant('moved/page')
    await w.db.query("UPDATE pages SET revision = 3 WHERE address = 'moved/page'")
    const noBase = await propose(factory.key, {
      title: 'Move and edit',
      ops: [
        { op: 'move', address: 'moved/page', to: 'moved/page-2', reason: 'r' },
        { op: 'edit', address: 'moved/page-2', body: 'x', reason: 'r' },
      ],
    })
    assert.equal(noBase.status, 400)
    assert.match(JSON.stringify(noBase.body), /baseRevision/)
    const revert = await propose(factory.key, {
      title: 'Move and revert',
      ops: [
        { op: 'move', address: 'moved/page', to: 'moved/page-3', reason: 'r' },
        { op: 'revert', address: 'moved/page-3', toRevision: 1, reason: 'r' },
      ],
    })
    assert.equal(revert.status, 201)
    const back = await propose(factory.key, {
      title: 'There and back',
      ops: [
        { op: 'move', address: 'moved/page', to: 'moved/page-4', reason: 'r' },
        { op: 'move', address: 'moved/page-4', to: 'moved/page', reason: 'r' },
      ],
    })
    assert.equal(back.status, 201)
  })

  it('review: the map keeps each area in one group; a page names another once', async () => {
    await plant('zz')
    await plant('zz-x/y')
    await plant('zz/a', { body: 'see [[zz]]' })
    const map = (await w.call(reader.key, 'GET', '/v1/brains/yt/wiki/map')).body as {
      groups: { type: string; area: string; pages: { address: string }[] }[]
    }
    const zz = map.groups.filter((g) => g.type === 'topic' && g.area === 'zz')
    assert.equal(zz.length, 1)
    assert.deepEqual(
      zz[0]?.pages.map((p) => p.address),
      ['zz', 'zz/a'],
    )
    const t = await plant('dup/target', { old: ['dup/target-old'] })
    const s2 = await plant('dup/source', { body: '[[dup/target]] [[dup/target-old]] [[dup/source]]' })
    for (const a of ['dup/target', 'dup/target-old', 'dup/source']) {
      await w.db.query(
        "INSERT INTO page_links (brain_id, from_page, kind, to_address) VALUES ($1,$2,'mentions',$3)",
        [s2.brainId, s2.id, a],
      )
    }
    const src = (await w.call(reader.key, 'GET', '/v1/brains/yt/pages/dup/source')).body as {
      links: { out: { address: string }[]; in: { address: string }[] }
    }
    assert.deepEqual(
      src.links.out.map((l) => l.address),
      ['dup/target'],
    )
    assert.deepEqual(src.links.in, [])
    void t
  })

  it('review: corrections count against the compile budget; tags and sources are counted once', async () => {
    await w.call(eric.key, 'POST', '/v1/brains', { slug: 'budget' })
    await w.member('budget', factory.id, 'contributor')
    await w.member('budget', ana.id, 'contributor')
    const anaEmail = (await w.db.one<{ email: string }>('SELECT email FROM accounts WHERE id = $1', [ana.id]))
      ?.email
    for (const i of [1, 2, 3, 4]) {
      await w.call(factory.key, 'POST', '/v1/brains/budget/corrections/relay', {
        onBehalf: anaEmail,
        title: `Big correction ${i}`,
        content: 'x'.repeat(1900),
      })
    }
    await save(ana.key, { type: 'note', title: 'small', content: 'small entry' }, 'budget')
    const pk = (await w.call(factory.key, 'GET', '/v1/brains/budget/wiki/compile?maxChars=4000')).body as {
      corrections: { content: string; title: string }[]
      entries: unknown[]
      remainingCorrections: number
    }
    const chars = pk.corrections.reduce((n, c) => n + c.content.length + c.title.length + 200, 0)
    assert.ok(chars <= 2000 + 2100, String(chars))
    assert.ok(pk.remainingCorrections > 0)
    assert.equal(pk.entries.length, 1)
    const many = await propose(factory.key, {
      title: 'Same source 60 times',
      ops: [create('dup/sources', { sources: Array.from({ length: 60 }, () => ({ entryId: entries[0] })) })],
    })
    assert.equal(many.status, 201)
    const tags = await propose(factory.key, {
      title: 'Tags',
      ops: [
        create('tags/same', {
          tags: Array.from({ length: 21 }, () => 'same'),
          sources: [{ entryId: entries[0] }, { entryId: entries[0] }],
        }),
      ],
    })
    assert.equal(tags.status, 201)
    const op = (tags.body.ops as { op: { tags: string[]; sources: unknown[] } }[])[0]?.op
    assert.deepEqual([op?.tags, op?.sources.length], [['same'], 1])
  })
})
