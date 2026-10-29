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
    assert.ok(h.conflicts.some((c) => c.a === 'h/y' && c.b === 'h/x'))
    assert.ok(h.long.some((l) => l.address === 'h/long'))
    assert.ok(h.similarTitles.some((s) => s.a === 'h/t1' && s.b === 'h/t2'))
    assert.deepEqual(
      h.stale.filter((s) => s.address === 'h/old').map((s) => s.newEntries),
      [1],
    )
    await change({ op: 'link', address: 'h/x', kind: 'supersedes', to: 'h/y' })
    const after = (await w.call(ana.key, 'GET', '/v1/brains/yt/wiki/health')).body as {
      conflicts: { a: string }[]
    }
    assert.ok(!after.conflicts.some((c) => c.a === 'h/y'))
  })

  it('every so many approvals, the web suggests a maintenance proposal; asking for one starts the count again', async () => {
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
    const h = (await w.call(ana.key, 'GET', '/v1/brains/yt/wiki/health')).body as {
      maintenance: { suggested: boolean }
    }
    assert.equal(h.maintenance.suggested, true)
    await w.callWeb(ericWeb, 'POST', '/v1/brains/yt/wiki/maintenance-asked')
    const again = (await w.call(ana.key, 'GET', '/v1/brains/yt/wiki/health')).body as {
      maintenance: { suggested: boolean }
    }
    assert.equal(again.maintenance.suggested, false)
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
      reason: 'personal data',
    })
    assert.equal(r.status, 200, r.text)
    assert.deepEqual([r.body.restoredTo, r.body.joined], [3, true])
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
})
