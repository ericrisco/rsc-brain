// Spec B2: editing by hand with a trace, going back to a revision, comparing revisions, the curator's
// guide and settings, the health report and the maintenance nudge, and purging wiki text.
import assert from 'node:assert/strict'
import { after, before, describe, it } from 'node:test'
import { skipPg } from '../helpers/pg.ts'
import { type World, world } from '../helpers/world.ts'

describe('wiki by hand, health and purge', { skip: skipPg }, () => {
  let w: World
  let eric: { id: string; key: string }
  let ana: { id: string; key: string }
  let admin: { id: string; key: string }
  let factory: { id: string; key: string }
  let ericWeb: string
  let anaWeb: string
  let adminWeb: string
  const e: string[] = []

  const save = async (body: Record<string, unknown>) =>
    ((await w.call(ana.key, 'POST', '/v1/brains/yt/entries', body)).body.receipt as { entryId: string })
      .entryId
  const change = (op: Record<string, unknown>, session = ericWeb) =>
    w.callWeb(session, 'POST', '/v1/brains/yt/wiki/changes', op)
  const create = (address: string, extra: Record<string, unknown> = {}) =>
    change({
      op: 'create',
      address,
      type: 'topic',
      title: `Page ${address}`,
      summary: 's',
      body: `Body of ${address}.`,
      ...extra,
    })
  const page = async (address: string) =>
    (await w.call(eric.key, 'GET', `/v1/brains/yt/pages/${address}`)).body as {
      page: { revision: number; body: string; title: string; status: string }
    }
  const edit = (address: string, baseRevision: number, fields: Record<string, unknown>, session = ericWeb) =>
    w.callWeb(session, 'PATCH', `/v1/brains/yt/pages/${address}`, { baseRevision, ...fields })

  before(async () => {
    w = await world()
    eric = await w.person('Eric')
    ana = await w.person('Ana')
    admin = await w.person('Admin', { isAdmin: true })
    factory = await w.service('RSC Factory')
    await w.call(eric.key, 'POST', '/v1/brains', { slug: 'yt', purpose: 'Our channel.' })
    await w.member('yt', ana.id, 'contributor')
    await w.member('yt', factory.id, 'contributor')
    ericWeb = await w.web(eric.id)
    anaWeb = await w.web(ana.id)
    adminWeb = await w.web(admin.id)
    for (const i of [1, 2, 3]) e.push(await save({ type: 'fact', title: `F${i}`, content: `Fact ${i}.` }))
  })
  after(async () => w.close())

  it('CA10: a curator edits a page in the web; a new revision with their authorship and a "direct edit" log line', async () => {
    assert.equal((await create('ca10/page')).status, 201)
    w.advance(1000)
    const r = await edit('ca10/page', 1, { body: 'Edited by hand.' })
    assert.equal(r.status, 200, r.text)
    const h = (await w.call(eric.key, 'GET', '/v1/brains/yt/pages/ca10/page?history=1')).body.history as {
      revision: number
      kind: string
      authorId: string
    }[]
    assert.deepEqual(h.at(-1), { ...h.at(-1), revision: 2, kind: 'direct', authorId: eric.id })
    const log = (await w.call(eric.key, 'GET', '/v1/brains/yt/wiki/log')).body.items as {
      kind: string
      summary: string
    }[]
    assert.deepEqual([log[0]?.kind, log[0]?.summary], ['direct', 'Direct edit: ca10/page'])
  })

  it('an edit by hand against an old revision saves nothing and shows the current version', async () => {
    await create('stale/page')
    await edit('stale/page', 1, { body: 'two' })
    const r = await edit('stale/page', 1, { body: 'three' })
    assert.deepEqual([r.status, r.body.error?.code], [409, 'page_changed'])
    const current = (r.body.error as unknown as { current: { page: { body: string; revision: number } } })
      .current
    assert.deepEqual([current.page.body, current.page.revision], ['two', 2])
    assert.equal((await page('stale/page')).page.body, 'two')
  })

  it('only curators in the web change the wiki by hand; contributors and keys cannot', async () => {
    assert.equal((await create('who/page', {})).status, 201)
    assert.equal((await edit('who/page', 1, { body: 'x' }, anaWeb)).status, 403)
    const byKey = await w.call(eric.key, 'PATCH', '/v1/brains/yt/pages/who/page', {
      baseRevision: 1,
      body: 'x',
    })
    assert.equal(byKey.body.error?.code, 'web_only')
    assert.equal((await page('who/page')).page.revision, 1)
  })

  it('CA18: going back to revision 3 of a page at 5 creates revision 6 with the content of 3; 4 and 5 stay', async () => {
    await create('ca18/page', { body: 'v1' })
    for (const [i, body] of [
      [1, 'v2'],
      [2, 'v3'],
      [3, 'v4'],
      [4, 'v5'],
    ] as const) {
      assert.equal((await edit('ca18/page', i, { body })).status, 200)
    }
    const r = await change({ op: 'revert', address: 'ca18/page', toRevision: 3 })
    assert.equal(r.status, 201, r.text)
    const p = await page('ca18/page')
    assert.deepEqual([p.page.revision, p.page.body], [6, 'v3'])
    const h = (await w.call(eric.key, 'GET', '/v1/brains/yt/pages/ca18/page?history=1')).body.history as {
      revision: number
      kind: string
    }[]
    assert.deepEqual(
      h.map((x) => x.revision),
      [1, 2, 3, 4, 5, 6],
    )
    assert.equal(h.at(-1)?.kind, 'revert')
    const cmp = (await w.call(eric.key, 'GET', '/v1/brains/yt/pages/ca18/page?compare=4,6')).body as {
      a: { body: string }
      b: { body: string }
    }
    assert.deepEqual([cmp.a.body, cmp.b.body], ['v4', 'v3'])
  })

  it('CA17: a curator changes the compile guide; the pack brings the new one; null goes back to the default', async () => {
    const set = await w.callWeb(ericWeb, 'PUT', '/v1/brains/yt/wiki/settings', {
      guide: 'Our own guide: one page per video.',
    })
    assert.equal(set.status, 200, set.text)
    const pk = (await w.call(factory.key, 'GET', '/v1/brains/yt/wiki/compile')).body as { guide: string }
    assert.equal(pk.guide, 'Our own guide: one page per video.')
    assert.equal(
      (await w.call(eric.key, 'PUT', '/v1/brains/yt/wiki/settings', { guide: 'x' })).body.error?.code,
      'web_only',
    )
    await w.callWeb(ericWeb, 'PUT', '/v1/brains/yt/wiki/settings', { guide: null })
    const back = (await w.call(factory.key, 'GET', '/v1/brains/yt/wiki/guide')).body as { custom: boolean }
    assert.equal(back.custom, false)
  })

  it('CA15: the health report shows an orphan, a broken link and a page citing a purged entry, each with its page', async () => {
    const purged = await save({ type: 'fact', title: 'Address', content: 'Lucía lives at Calle Falsa 1.' })
    await create('ca15/orphan')
    await create('ca15/linker', { body: 'See [[ca15/nowhere]].' })
    await create('ca15/cites', { sources: [{ entryId: purged }], body: 'Cites a fact; see [[ca15/linker]].' })
    await w.call(admin.key, 'POST', `/v1/entries/${purged}/purge`, { reason: 'personal data' })
    const h = (await w.call(ana.key, 'GET', '/v1/brains/yt/wiki/health')).body as {
      orphans: { address: string }[]
      broken: { from: string; to: string }[]
      unavailableSources: { address: string; entryId: string; state: string }[]
    }
    assert.ok(h.orphans.some((o) => o.address === 'ca15/orphan'))
    assert.ok(!h.orphans.some((o) => o.address === 'ca15/linker' || o.address === 'ca15/cites'))
    assert.ok(h.broken.some((b) => b.from === 'ca15/linker' && b.to === 'ca15/nowhere'))
    // Review of PR23: each page comes with its title, for the web to show it first.
    assert.equal(
      (h.broken as Array<{ from: string; fromTitle?: string }>).find((b) => b.from === 'ca15/linker')
        ?.fromTitle,
      'Page ca15/linker',
    )
    assert.equal(
      (h.unavailableSources as Array<{ address: string; title?: string }>).find(
        (u) => u.address === 'ca15/cites',
      )?.title,
      'Page ca15/cites',
    )
    assert.ok(
      h.unavailableSources.some(
        (u) => u.address === 'ca15/cites' && u.entryId === purged && u.state === 'purged',
      ),
    )
  })

  it('health: open contradictions, long pages, near-duplicate titles and stale pages the journal still mentions', async () => {
    await create('h/x')
    await create('h/y', { links: [{ kind: 'contradicts', to: 'h/x' }] })
    await w.callWeb(ericWeb, 'PUT', '/v1/brains/yt/wiki/settings', { longChars: 1000, staleDays: 10 })
    await create('h/long', { body: 'x'.repeat(1500) })
    await create('h/t1', { title: 'What keeps our viewers watching' })
    await create('h/t2', { title: 'What keeps our viewers watching?' })
    // Written before the page changed: about it, but not newer than it.
    await save({ type: 'note', title: 'before', content: 'Earlier about h/old.' })
    w.advance(1000)
    await create('h/old')
    w.advance(11 * 86_400_000)
    // Web sessions last hours, not days: sign in again after the clock jumps.
    ericWeb = await w.web(eric.id)
    anaWeb = await w.web(ana.id)
    adminWeb = await w.web(admin.id)
    await save({ type: 'note', title: 'again', content: 'More about h/old today.' })
    const h = (await w.call(ana.key, 'GET', '/v1/brains/yt/wiki/health')).body as {
      conflicts: { a: string; b: string }[]
      long: { address: string }[]
      similarTitles: { a: string; b: string }[]
      stale: { address: string; newEntries: number }[]
    }
    assert.ok(h.conflicts.some((c) => c.a === 'h/x' && c.b === 'h/y'))
    assert.ok(h.long.some((l) => l.address === 'h/long'))
    assert.ok(h.similarTitles.some((s) => s.a === 'h/t1' && s.b === 'h/t2'))
    const pair = (h.similarTitles as Array<{ a: string; aTitle?: string; bTitle?: string }>).find(
      (s) => s.a === 'h/t1',
    )
    assert.deepEqual(
      [pair?.aTitle, pair?.bTitle],
      ['What keeps our viewers watching', 'What keeps our viewers watching?'],
    )
    const contra = (h.conflicts as Array<{ a: string; aTitle?: string; bTitle?: string }>).find(
      (c) => c.a === 'h/x',
    )
    assert.deepEqual([contra?.aTitle, contra?.bTitle], ['Page h/x', 'Page h/y'])
    // Review of PR23: «N newer entries about it» opens the journal at those entries, by the same rule.
    const old = h.stale.find((s) => s.address === 'h/old') as { address: string; updatedAt?: string }
    const about = await w.call(
      ana.key,
      'GET',
      `/v1/brains/yt/entries?about=h%2Fold&since=${encodeURIComponent(String(old.updatedAt))}`,
    )
    assert.equal(about.status, 200, about.text)
    assert.deepEqual(
      (about.body.items as { title: string }[]).map((x) => x.title),
      ['again'],
    )
    assert.equal((await w.call(ana.key, 'GET', '/v1/brains/yt/entries?about=Not%20an%20address')).status, 400)
    assert.deepEqual(
      h.stale.filter((s) => s.address === 'h/old').map((s) => s.newEntries),
      [1],
    )
    await change({ op: 'link', address: 'h/x', kind: 'supersedes', to: 'h/y' })
    const after = (await w.call(ana.key, 'GET', '/v1/brains/yt/wiki/health')).body as {
      conflicts: { a: string; b: string }[]
    }
    assert.ok(!after.conflicts.some((c) => c.b === 'h/y'))
  })

  // Since v0.6 the suggestion is the daily cleanup (test/wiki/cleanup.test.ts): the count of approvals is still
  // kept for API v1, and decides nothing.
  it('the count of approvals is kept for API v1; the suggestion follows the daily cleanup, not the count', async () => {
    await w.callWeb(ericWeb, 'PUT', '/v1/brains/yt/wiki/settings', { maintenanceEvery: 2 })
    for (const i of [1, 2]) {
      const id = (
        (
          await w.call(factory.key, 'POST', '/v1/brains/yt/proposals', {
            title: `M${i}`,
            ops: [
              {
                op: 'create',
                address: `maint/p${i}`,
                type: 'topic',
                title: `M${i}`,
                sources: [{ entryId: e[0] }],
                reason: 'r',
              },
            ],
          })
        ).body.proposal as { id: string }
      ).id
      const fp = (
        (await w.callWeb(ericWeb, 'GET', `/v1/proposals/${id}/review`)).body as { fingerprint: string }
      ).fingerprint
      assert.equal(
        (await w.callWeb(ericWeb, 'POST', `/v1/proposals/${id}/approve`, { fingerprint: fp })).status,
        200,
      )
    }
    type M = {
      maintenance: { suggested: boolean; approvalsSince: number; every: number; lastAt: string | null }
    }
    const h = (await w.call(ana.key, 'GET', '/v1/brains/yt/wiki/health')).body as M
    assert.deepEqual(
      [h.maintenance.approvalsSince >= 2, h.maintenance.every, h.maintenance.lastAt],
      [true, 2, null],
    )
    const problems = [
      'orphans',
      'broken',
      'conflicts',
      'stale',
      'unavailableSources',
      'long',
      'similarTitles',
    ].some((k) => ((h as unknown as Record<string, unknown[]>)[k] ?? []).length > 0)
    assert.equal(h.maintenance.suggested, problems)
    await w.callWeb(ericWeb, 'POST', '/v1/brains/yt/wiki/maintenance-asked')
    const again = (await w.call(ana.key, 'GET', '/v1/brains/yt/wiki/health')).body as M
    assert.deepEqual([again.maintenance.approvalsSince, again.maintenance.suggested], [0, problems])
  })

  it('CA25: purging a page revision: the text is nowhere, the page goes back to the revision before, the mark stays', async () => {
    const secret = 'Paco Pérez, DNI 12345678Z'
    await create('ca25/page', { body: 'r1' })
    await edit('ca25/page', 1, { body: 'r2' })
    await edit('ca25/page', 2, { body: 'r3' })
    // Revision 4 copies a personal datum, through a proposal (so the operation holds it too).
    const id = (
      (
        await w.call(factory.key, 'POST', '/v1/brains/yt/proposals', {
          title: 'Add the contact',
          ops: [
            {
              op: 'edit',
              address: 'ca25/page',
              baseRevision: 3,
              body: `Contact: ${secret}.`,
              reason: 'copied',
            },
          ],
        })
      ).body.proposal as { id: string }
    ).id
    const fp = (
      (await w.callWeb(ericWeb, 'GET', `/v1/proposals/${id}/review`)).body as { fingerprint: string }
    ).fingerprint
    await w.callWeb(ericWeb, 'POST', `/v1/proposals/${id}/approve`, { fingerprint: fp })
    assert.equal(
      (
        await w.callWeb(ericWeb, 'POST', '/v1/brains/yt/wiki/purge', {
          address: 'ca25/page',
          revision: 4,
          reason: 'personal data',
        })
      ).status,
      403,
    )
    const byKey = await w.call(admin.key, 'POST', '/v1/brains/yt/wiki/purge', {
      address: 'ca25/page',
      revision: 4,
      reason: 'x',
    })
    assert.equal(byKey.body.error?.code, 'web_only')
    // An administrator who is not a member of the brain joins to purge, visibly.
    const outsider = await w.person('Admin2', { isAdmin: true })
    const r = await w.callWeb(await w.web(outsider.id), 'POST', '/v1/brains/yt/wiki/purge', {
      address: 'ca25/page',
      revision: 4,
      text: ['Paco Pérez', '12345678Z'],
      reason: 'personal data',
    })
    assert.equal(r.status, 200, r.text)
    assert.equal(r.body.joined, true)
    assert.equal((await page('ca25/page')).page.body, 'r3')
    const tables = await w.db.query<{ table_name: string }>(
      "SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' AND table_type = 'BASE TABLE'",
    )
    for (const { table_name } of tables) {
      const dump = JSON.stringify(await w.db.query(`SELECT * FROM ${table_name}`))
      assert.ok(!dump.includes('12345678Z') && !dump.includes('Paco'), table_name)
    }
    const found = (await w.call(eric.key, 'GET', '/v1/search?q=Paco')).body.items as unknown[]
    assert.deepEqual(found, [])
    const h = (await w.call(eric.key, 'GET', '/v1/brains/yt/pages/ca25/page?history=1')).body.history as {
      revision: number
      purged: { by: string; reason: string } | null
    }[]
    assert.deepEqual(h.find((x) => x.revision === 4)?.purged, {
      ...h.find((x) => x.revision === 4)?.purged,
      by: outsider.id,
      reason: 'personal data',
    })
    assert.ok(
      await w.db.one("SELECT 1 FROM audit WHERE action = 'admin.join' AND actor_id = $1", [outsider.id]),
    )
  })

  it('purging a proposal removes its text and keeps the mark', async () => {
    const id = (
      (
        await w.call(factory.key, 'POST', '/v1/brains/yt/proposals', {
          title: 'Leaky title Juana',
          reason: 'Juana told us',
          ops: [
            {
              op: 'create',
              address: 'leak/page',
              type: 'topic',
              title: 'Juana',
              body: 'Juana again',
              sources: [{ entryId: e[0] }],
              reason: 'Juana',
            },
          ],
        })
      ).body.proposal as { id: string }
    ).id
    const r = await w.callWeb(adminWeb, 'POST', `/v1/proposals/${id}/purge`, { reason: 'personal data' })
    assert.equal(r.status, 200, r.text)
    for (const t of ['proposals', 'proposal_ops', 'events', 'wiki_log']) {
      assert.ok(!JSON.stringify(await w.db.query(`SELECT * FROM ${t}`)).includes('Juana'), t)
    }
    const p = (await w.call(eric.key, 'GET', `/v1/proposals/${id}`)).body.proposal as {
      purged: boolean
      status: string
    }
    assert.deepEqual([p.purged, p.status], [true, 'withdrawn'])
  })

  it('B1 CA13: purging an entry takes it out of the pending proposals that cite or collect it', async () => {
    const x = await save({ type: 'fact', title: 'X', content: 'personal x' })
    const y = await save({ type: 'fact', title: 'Y', content: 'kept y' })
    const id = (
      (
        await w.call(factory.key, 'POST', '/v1/brains/yt/proposals', {
          title: 'Cites x',
          collected: [x],
          ops: [
            {
              op: 'create',
              address: 'b1/ca13',
              type: 'topic',
              title: 'T',
              sources: [{ entryId: x }, { entryId: y }],
              reason: 'r',
            },
          ],
        })
      ).body.proposal as { id: string }
    ).id
    await w.call(admin.key, 'POST', `/v1/entries/${x}/purge`, { reason: 'personal data' })
    const p = (await w.call(eric.key, 'GET', `/v1/proposals/${id}`)).body as {
      proposal: { collected: string[] }
      ops: { op: { sources: { entryId: string }[] } }[]
    }
    assert.deepEqual(p.proposal.collected, [])
    assert.deepEqual(p.ops[0]?.op.sources, [{ entryId: y }])
  })

  const nowhere = async (needle: string) => {
    const tables = await w.db.query<{ table_name: string }>(
      "SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' AND table_type = 'BASE TABLE'",
    )
    for (const { table_name } of tables) {
      const dump = JSON.stringify(await w.db.query(`SELECT * FROM ${table_name}`)).toLowerCase()
      assert.ok(!dump.includes(needle.toLowerCase()), `${needle} in ${table_name}`)
    }
  }
  const purgeRev = (
    address: string,
    revisions: number[],
    text: string[],
    extra: Record<string, unknown> = {},
  ) =>
    w.callWeb(adminWeb, 'POST', '/v1/brains/yt/wiki/purge', {
      address,
      revisions,
      text,
      reason: 'personal data',
      ...extra,
    })

  it('review: the named text goes from every revision and field, whatever later edits did to it', async () => {
    // Small later edits, a case change, a move to another field, a url source, a tag.
    await create('pa/page', { body: 'one', summary: 'sum', tags: ['a'] })
    await edit('pa/page', 1, {
      body: 'one pw=hunter2X end',
      summary: 'sum Code ZEBRA42Q',
      tags: ['a', 'hunter2X'],
      sources: [{ url: 'https://x.test/hunter2X' }],
    })
    await edit('pa/page', 2, { body: 'one pw=hunter2X', title: 'Note zebra42q' })
    await edit('pa/page', 3, { sources: [{ url: 'https://x.test/hunter2X', title: 'ok' }] })
    const r = await purgeRev('pa/page', [2], ['hunter2X', 'zebra42q'])
    assert.equal(r.status, 200, r.text)
    await nowhere('hunter2X')
    await nowhere('zebra42q')
    const p = await page('pa/page')
    assert.deepEqual([p.page.title, p.page.body], ['Note [purged]', 'one pw=[purged]'])
  })

  it('review: the purged revision loses its reason too, even one that does not hold the named text', async () => {
    await create('pr/why', { body: 'one' })
    await edit('pr/why', 1, { body: 'one SECRETR', reason: 'Lucía asked for it' })
    const r = await purgeRev('pr/why', [2], ['SECRETR'])
    assert.equal(r.status, 200, r.text)
    const row = await w.db.one(
      `SELECT r.reason FROM page_revisions r JOIN page_addresses a ON a.page_id = r.page_id
        WHERE a.address = 'pr/why' AND r.revision = 2`,
    )
    assert.deepEqual(row, { reason: null })
  })

  it('review: purging the current revision brings the page back to the last revision left, with its mentions', async () => {
    await create('pm/b')
    await create('pm/a', { body: 'See [[pm/b]].' })
    await edit('pm/a', 1, {
      body: 'See [[pm/b]]. SECRETM',
      sources: [{ url: 'https://x.test/a', title: 'Juanita SECRETS' }],
    })
    assert.equal((await purgeRev('pm/a', [2], ['SECRETM', 'Juanita SECRETS'])).status, 200)
    const a = (await w.call(eric.key, 'GET', '/v1/brains/yt/pages/pm/a')).body as {
      page: { body: string }
      links: { out: { address: string }[] }
      sources: unknown[]
    }
    assert.equal(a.page.body, 'See [[pm/b]].')
    assert.deepEqual(
      a.links.out.map((l) => l.address),
      ['pm/b'],
    )
    assert.deepEqual(a.sources, [])
    await nowhere('SECRETM')
    await nowhere('Juanita SECRETS')
  })

  it('review: a merged page is purged by its own address; what the merge copied into the other page goes too', async () => {
    await create('pz/x', { body: 'x one' })
    await create('pz/y', { body: 'y one' })
    await edit('pz/y', 1, { body: 'SECRETZ here' })
    await change({ op: 'merge', address: 'pz/x', from: 'pz/y', body: 'x and SECRETZ here' })
    const r = await purgeRev('pz/y', [2], ['SECRETZ'])
    assert.equal(r.status, 200, r.text)
    assert.equal(r.body.address, 'pz/y')
    assert.equal(((await page('pz/x')) as { page: { body: string } }).page.body, 'x and [purged] here')
    const xh = (await w.call(eric.key, 'GET', '/v1/brains/yt/pages/pz/x?history=1')).body.history as {
      purged: unknown
    }[]
    assert.ok(xh.every((h) => h.purged === null))
    await nowhere('SECRETZ')
  })

  it('review: text inside an address is refused until the page moves; the text must be named', async () => {
    await create('dni-99887766x/page', { body: 'b' })
    const r = await purgeRev('dni-99887766x/page', [1], ['99887766x'])
    assert.deepEqual([r.status, r.body.error?.code], [409, 'text_in_address'])
    assert.equal((await purgeRev('dni-99887766x/page', [1], [])).status, 400)
    assert.equal((await purgeRev('dni-99887766x/page', [1], ['ab'])).status, 400)
  })

  it('review: purging a returned proposal also purges the correction its return left; the revisions it wrote are listed', async () => {
    const id = (
      (
        await w.call(factory.key, 'POST', '/v1/brains/yt/proposals', {
          title: 'Leaky Rosalía',
          ops: [
            {
              op: 'create',
              address: 'leak2/page',
              type: 'topic',
              title: 'T',
              sources: [{ entryId: e[0] }],
              reason: 'r',
            },
          ],
        })
      ).body.proposal as { id: string }
    ).id
    const fp = (
      (await w.callWeb(ericWeb, 'GET', `/v1/proposals/${id}/review`)).body as { fingerprint: string }
    ).fingerprint
    await w.callWeb(ericWeb, 'POST', `/v1/proposals/${id}/return`, { fingerprint: fp, comment: 'no' })
    const r = await w.callWeb(adminWeb, 'POST', `/v1/proposals/${id}/purge`, { reason: 'personal data' })
    assert.equal(r.status, 200, r.text)
    assert.deepEqual(r.body.revisions, [])
    await nowhere('Rosalía')
  })

  it('review: stale matches whole addresses only; compare takes exactly two revisions', async () => {
    await w.callWeb(ericWeb, 'PUT', '/v1/brains/yt/wiki/settings', { staleDays: 1 })
    await create('sales')
    w.advance(2 * 86_400_000)
    ericWeb = await w.web(eric.id)
    anaWeb = await w.web(ana.id)
    adminWeb = await w.web(admin.id)
    await save({ type: 'note', title: 'n', content: 'Presales and h/older stuff' })
    const h = (await w.call(ana.key, 'GET', '/v1/brains/yt/wiki/health')).body as {
      stale: { address: string }[]
    }
    assert.ok(!h.stale.some((x) => x.address === 'sales'))
    await save({ type: 'note', title: 'n2', content: 'About sales, today.' })
    const h2 = (await w.call(ana.key, 'GET', '/v1/brains/yt/wiki/health')).body as {
      stale: { address: string }[]
    }
    assert.ok(h2.stale.some((x) => x.address === 'sales'))
    assert.equal((await w.call(eric.key, 'GET', '/v1/brains/yt/pages/sales?compare=1,1,1')).status, 400)
  })

  it('review: the reason cannot carry the text; overlapping texts go whole; decomposed accents match', async () => {
    await create('pr/page', { body: 'one' })
    await edit('pr/page', 1, { body: 'client Lucia Mendozaq and José Pérezq here' })
    await edit('pr/page', 2, { body: 'kept: Lucia Mendozaq' })
    const r = await w.callWeb(adminWeb, 'POST', '/v1/brains/yt/wiki/purge', {
      address: 'pr/page',
      revisions: [2],
      text: ['Lucia', 'Lucia Mendozaq', 'José Pérezq'],
      reason: 'removes Lucia Mendozaq of the client',
    })
    assert.equal(r.status, 200, r.text)
    await nowhere('Mendozaq')
    await nowhere('rezq')
    const h = (await w.call(eric.key, 'GET', '/v1/brains/yt/pages/pr/page?history=1')).body.history as {
      purged: { reason: string } | null
    }[]
    assert.ok(h.some((x) => x.purged?.reason === 'removes [purged] of the client'))
  })

  it('review: a text found nowhere is refused, not reported as purged; a text inside the mark is refused', async () => {
    await create('pn/page', { body: 'STRASSEQ here' })
    const r = await purgeRev('pn/page', [1], ['straßeq'])
    assert.deepEqual([r.status, r.body.error?.code], [409, 'text_not_found'])
    assert.equal((await page('pn/page')).page.body, 'STRASSEQ here')
    assert.equal((await purgeRev('pn/page', [1], ['urged'])).status, 400)
  })

  it('review: the scrub never touches structure; long fields and colliding sources are handled', async () => {
    const id = (
      (
        await w.call(factory.key, 'POST', '/v1/brains/yt/proposals', {
          title: 'Unrelated',
          ops: [
            {
              op: 'create',
              address: 'p9/other',
              type: 'topic',
              title: 'Other',
              sources: [{ entryId: e[0] }],
              reason: 'r',
            },
          ],
        })
      ).body.proposal as { id: string }
    ).id
    await create('pq/page', {
      body: 'eat qzv',
      sources: [
        { url: 'https://x.test/?u=alicexx', title: `${'x'.repeat(297)}qzv` },
        { url: 'https://x.test/?u=bobyyyy' },
      ],
    })
    const r = await purgeRev('pq/page', [1], ['eat', 'qzv', 'alicexx', 'bobyyyy'])
    assert.equal(r.status, 200, r.text)
    const op = await w.db.one<{ op: { op: string; type: string } }>(
      'SELECT op FROM proposal_ops WHERE proposal_id = $1',
      [id],
    )
    assert.deepEqual([op?.op.op, op?.op.type], ['create', 'topic'])
    const fp = (
      (await w.callWeb(ericWeb, 'GET', `/v1/proposals/${id}/review`)).body as { fingerprint: string }
    ).fingerprint
    assert.equal(
      (await w.callWeb(ericWeb, 'POST', `/v1/proposals/${id}/approve`, { fingerprint: fp })).status,
      200,
    )
    assert.equal((await w.call(eric.key, 'GET', '/v1/brains/yt/pages/p9/other')).status, 200)
    await nowhere('alicexx')
    await nowhere('bobyyyy')
  })

  it('review: text in a pending proposal address is refused; a restored title that grew still fits', async () => {
    await w.call(factory.key, 'POST', '/v1/brains/yt/proposals', {
      title: 'People',
      ops: [
        {
          op: 'create',
          address: 'people/garciaq',
          type: 'entity',
          title: 'G',
          sources: [{ entryId: e[0] }],
          reason: 'r',
        },
      ],
    })
    await create('pg1/page', { body: 'Mr garciaq was here' })
    const r = await purgeRev('pg1/page', [1], ['garciaq'])
    assert.deepEqual([r.status, r.body.error?.code], [409, 'text_in_address'])
    await create('pg2/page', { title: 'zqw '.repeat(50).trim(), body: 'b' })
    await edit('pg2/page', 1, { title: 'Clean' })
    const ok = await purgeRev('pg2/page', [2], ['zqw'])
    assert.equal(ok.status, 200, ok.text)
    assert.ok((await page('pg2/page')).page.title.length <= 260)
    await nowhere('zqw')
  })
})
