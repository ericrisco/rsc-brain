// Spec B3 «Buscar» and «Vecinos en el grafo»: entries and pages found together, by words, forms and
// phrases, with filters and states, across brains, in order, and with the pages linked to them.
import assert from 'node:assert/strict'
import { after, before, describe, it } from 'node:test'
import { skipPg } from '../helpers/pg.ts'
import { type World, world } from '../helpers/world.ts'

type Hit = {
  kind: 'entry' | 'page'
  id: string
  address?: string
  brain: string
  type: string
  state: string
  title: string
  snippet: string
  why: string
  reason: string
  linkedFrom?: { address: string; title: string; kind: string; direction: string }
  at: string
}
type Found = { items: Hit[]; neighbours?: Hit[]; next: number | null; note?: string }

describe('search: entries and pages', { skip: skipPg }, () => {
  let w: World
  let eric: { id: string; key: string }
  let ana: { id: string; key: string }
  let ericWeb: string

  const find = async (key: string, query: string) => {
    const r = await w.call(key, 'GET', `/v1/search?${query}`)
    assert.equal(r.status, 200, r.text)
    return r.body as unknown as Found
  }
  const q = (text: string) => `q=${encodeURIComponent(text)}`
  const page = async (slug: string, address: string, fields: Record<string, unknown> = {}) => {
    const r = await w.callWeb(ericWeb, 'POST', `/v1/brains/${slug}/wiki/changes`, {
      op: 'create',
      address,
      type: 'topic',
      title: `Page ${address}`,
      summary: '',
      body: `About ${address}.`,
      ...fields,
    })
    assert.equal(r.status, 201, r.text)
    const p = (await w.call(eric.key, 'GET', `/v1/brains/${slug}/pages/${address}`)).body.page as {
      id: string
    }
    return p.id
  }
  const change = async (slug: string, op: Record<string, unknown>) => {
    const r = await w.callWeb(ericWeb, 'POST', `/v1/brains/${slug}/wiki/changes`, op)
    assert.equal(r.status < 300, true, r.text)
  }
  const save = async (key: string, slug: string, body: Record<string, unknown>) => {
    const r = await w.call(key, 'POST', `/v1/brains/${slug}/entries`, body)
    assert.equal(r.status, 201, r.text)
    return (r.body.receipt as { entryId: string }).entryId
  }

  before(async () => {
    w = await world()
    eric = await w.person('Eric')
    ana = await w.person('Ana')
    for (const slug of ['yt', 'alpha', 'beta', 'gamma']) {
      await w.call(eric.key, 'POST', '/v1/brains', { slug, purpose: `Brain ${slug}.` })
    }
    await w.member('yt', ana.id, 'contributor')
    await w.member('alpha', ana.id, 'reader')
    await w.member('beta', ana.id, 'reader')
    ericWeb = await w.web(eric.id)
  })
  after(async () => w.close())

  it('CA1: a fact only in the body of one page among 500 is in the first three, marked, "by words"', async () => {
    const b = await w.db.one<{ id: string }>("SELECT id FROM brains WHERE slug = 'yt'")
    // 499 pages that talk about voices and narrators in general, written straight to the table.
    await w.db.query(
      `WITH n AS (SELECT g, 'filler-' || g AS address FROM generate_series(1, 499) g)
       INSERT INTO pages (id, brain_id, address, type, title, summary, body, created_at, updated_at)
       SELECT 'pg_fill_' || g, $1, address, 'topic', 'Filler ' || g, '',
              'This page is about the channel. ' || CASE WHEN g % 3 = 0 THEN 'A voice can be warm. ' ELSE '' END ||
              CASE WHEN g % 7 = 0 THEN 'Our narrator speaks slowly. ' ELSE '' END || repeat('More words here. ', 20),
              $2, $2
         FROM n`,
      [b?.id, w.now],
    )
    await w.db.query(
      `INSERT INTO page_addresses (brain_id, address, page_id, created_at)
       SELECT $1, 'filler-' || g, 'pg_fill_' || g, $2 FROM generate_series(1, 499) g`,
      [b?.id, w.now],
    )
    const voices = await page('yt', 'voices', {
      title: 'Voices',
      body: 'We tried many options. In the end the narrator voice is Bella, for every video.',
    })
    const found = await find(eric.key, `${q('which voice narrates')}&in=pages`)
    const at = found.items.findIndex((h) => h.id === voices)
    assert.ok(at >= 0 && at < 3, `Voices at ${at}`)
    const hit = found.items[at] as Hit
    assert.match(hit.snippet, /«narrator»|«voice»/)
    assert.deepEqual(
      [hit.kind, hit.why, hit.reason, hit.address],
      ['page', 'words', 'matched by words', 'voices'],
    )
  })

  it('CA2: forms and accents, in pages too', async () => {
    const id = await page('yt', 'ca2', { title: 'Claridad', body: 'retenemos al público con voces claras' })
    assert.ok((await find(eric.key, `${q('retener publico')}&in=pages`)).items.some((h) => h.id === id))
    const claro = (await find(eric.key, `${q('claro')}&in=pages&prefix=ca2`)).items.find((h) => h.id === id)
    // The form found is the one marked.
    assert.match(claro?.snippet ?? '', /«claras»/)
    // "voice" for "voces" is a translation, not a form of the word: meaning search finds it (CA4).
  })

  it('CA3: an exact phrase, and an excluded word, in pages too', async () => {
    const one = await page('yt', 'ca3/one', { body: 'Una intro larga aburre.' })
    const two = await page('yt', 'ca3/two', { body: 'Una larga intro aburre.' })
    const ids = (f: Found) => f.items.map((h) => h.id)
    const phrase = ids(await find(eric.key, `${q('"intro larga"')}&prefix=ca3`))
    assert.ok(phrase.includes(one) && !phrase.includes(two))
    const minus = ids(await find(eric.key, `${q('intro -larga')}&prefix=ca3`))
    assert.ok(!minus.includes(one) && !minus.includes(two))
  })

  it('entries and pages come together; "in" narrows to one kind', async () => {
    const e = await save(eric.key, 'yt', { type: 'fact', title: 'Kumquat entry', content: 'kumquat jam' })
    const p = await page('yt', 'kumquat', { title: 'Kumquat', body: 'kumquat jam recipe' })
    const both = await find(eric.key, q('kumquat'))
    assert.deepEqual(
      new Set(both.items.map((h) => `${h.kind}:${h.id}`)),
      new Set([`entry:${e}`, `page:${p}`]),
    )
    assert.deepEqual(
      (await find(eric.key, `${q('kumquat')}&in=entries`)).items.map((h) => h.id),
      [e],
    )
    assert.deepEqual(
      (await find(eric.key, `${q('kumquat')}&in=pages`)).items.map((h) => h.id),
      [p],
    )
  })

  it('order: a current page goes before an entry and a stale page of similar relevance', async () => {
    const e = await save(eric.key, 'yt', { type: 'fact', title: 'Rambutan', content: 'rambutan season' })
    w.advance(1000)
    const stale = await page('yt', 'rambutan/old', { title: 'Rambutan', body: 'rambutan season' })
    await change('yt', { op: 'status', address: 'rambutan/old', status: 'stale', reason: 'old' })
    w.advance(1000)
    const current = await page('yt', 'rambutan/now', { title: 'Rambutan', body: 'rambutan season' })
    w.advance(1000)
    // The entry is the most recent, still it goes after the current page.
    // Another author, so it is not the same entry said again.
    const newer = await save(ana.key, 'yt', { type: 'fact', title: 'Rambutan', content: 'rambutan season' })
    const order = (await find(eric.key, `${q('rambutan season')}&include=stale`)).items.map((h) => h.id)
    assert.equal(order[0], current)
    assert.ok(order.indexOf(newer) < order.indexOf(e), 'the more recent entry first among similar entries')
    assert.ok(order.includes(stale))
    // Without asking for stale pages, the stale one is not there.
    assert.ok(!(await find(eric.key, q('rambutan season'))).items.some((h) => h.id === stale))
  })

  it('CA17b: a superseded page never goes before the page that replaced it', async () => {
    const old = await page('yt', 'durian/v1', { title: 'Durian', body: 'durian smell' })
    w.advance(1000)
    const now = await page('yt', 'durian/v2', { title: 'Durian', body: 'durian smell' })
    // The old one is edited later, so by date alone it would go first.
    await change('yt', { op: 'link', address: 'durian/v2', kind: 'supersedes', to: 'durian/v1' })
    w.advance(1000)
    const r = await w.call(eric.key, 'GET', '/v1/brains/yt/pages/durian/v1')
    const rev = (r.body.page as { revision: number }).revision
    await change('yt', { op: 'edit', address: 'durian/v1', baseRevision: rev, body: 'durian smell, kept' })
    const found = (await find(eric.key, `${q('durian smell')}&include=superseded`)).items
    const ids = found.map((h) => h.id)
    assert.ok(ids.indexOf(now) >= 0 && ids.indexOf(now) < ids.indexOf(old), ids.join(','))
    assert.equal(found.find((h) => h.id === old)?.state, 'superseded')
    assert.ok(!(await find(eric.key, q('durian smell'))).items.some((h) => h.id === old))
  })

  it('filters: types, tags, prefix, dates, author, session and reference', async () => {
    const t0 = w.now.toISOString()
    w.advance(86_400_000)
    ericWeb = await w.web(eric.id) // a web session lasts 12 hours
    const a = await save(ana.key, 'yt', {
      type: 'decision',
      topic: 'style/longan',
      title: 'Longan decision',
      content: 'longan picked',
      tags: ['fruit', 'asia'],
    })
    const b = await save(eric.key, 'yt', {
      type: 'note',
      title: 'Longan note',
      content: 'longan noted',
      tags: ['fruit'],
    })
    const p = await page('yt', 'style/longan', {
      type: 'guide',
      title: 'Longan guide',
      body: 'longan guide',
      tags: ['fruit'],
    })
    const ids = async (extra: string) =>
      (await find(eric.key, `${q('longan')}&${extra}`)).items.map((h) => h.id).sort()
    assert.deepEqual(await ids('types=decision'), [a])
    assert.deepEqual(await ids('types=decision,guide'), [a, p].sort())
    assert.deepEqual(await ids('tags=fruit,asia'), [a])
    assert.deepEqual(await ids('tags=fruit'), [a, b, p].sort())
    assert.deepEqual(await ids('prefix=style'), [a, p].sort())
    assert.deepEqual(await ids('prefix=style/'), [a, p].sort())
    assert.deepEqual(await ids(`author=${ana.id}`), [a])
    assert.deepEqual(await ids(`author=${eric.id}`), [b, p].sort())
    assert.deepEqual(await ids(`to=${t0.slice(0, 10)}`), [])
    assert.deepEqual(await ids(`from=${w.now.toISOString().slice(0, 10)}`), [a, b, p].sort())
    const e = (await w.call(eric.key, 'GET', `/v1/entries/${b}`)).body.entry as { sessionId: string }
    // A session or a reference belongs to the journal: pages are left out.
    assert.deepEqual(await ids(`session=${e.sessionId}`), [b])
    for (const bad of [
      'types=nope',
      'prefix=Style',
      'from=yesterday',
      'from=1',
      'in=all',
      'include=retired',
    ]) {
      const r = await w.call(eric.key, 'GET', `/v1/search?${q('longan')}&${bad}`)
      assert.equal(r.status, 400, bad)
    }
  })

  it('CA13 + CA14: all my brains are the ones I can read; one taken away right now is left out', async () => {
    for (const slug of ['alpha', 'beta', 'gamma'])
      await save(eric.key, slug, { type: 'fact', title: 'Pitaya', content: `pitaya in ${slug}` })
    await page('gamma', 'pitaya', { body: 'pitaya page in gamma' })
    const all = await find(ana.key, q('pitaya'))
    assert.deepEqual([...new Set(all.items.map((h) => h.brain))].sort(), ['alpha', 'beta'])
    const named = await find(ana.key, `${q('pitaya')}&brains=alpha,beta,gamma`)
    assert.deepEqual([...new Set(named.items.map((h) => h.brain))].sort(), ['alpha', 'beta'])
    await w.db.query(
      "DELETE FROM memberships WHERE account_id = $1 AND brain_id = (SELECT id FROM brains WHERE slug = 'beta')",
      [ana.id],
    )
    const now = await find(ana.key, `${q('pitaya')}&brains=alpha,beta`)
    assert.deepEqual([...new Set(now.items.map((h) => h.brain))], ['alpha'])
    // Alone, a brain I lost answers like one that does not exist.
    const alone = await w.call(ana.key, 'GET', `/v1/search?${q('pitaya')}&brains=beta`)
    const missing = await w.call(ana.key, 'GET', `/v1/search?${q('pitaya')}&brains=zzz`)
    assert.deepEqual([alone.status, alone.body.error?.code], [missing.status, missing.body.error?.code])
  })

  it('CA17: a purged entry never comes back, with every state asked', async () => {
    const id = await save(eric.key, 'yt', { type: 'fact', title: 'Salak', content: 'salak secret' })
    const admin = await w.person('Admin', { isAdmin: true })
    assert.equal((await w.call(admin.key, 'POST', `/v1/entries/${id}/purge`, { reason: 'leak' })).status, 200)
    const found = await find(eric.key, `${q('salak')}&include=forgotten,superseded,expired,stale`)
    assert.ok(!found.items.some((h) => h.id === id))
  })

  it('an empty search gives the most recent; none found says so and suggests dropping filters', async () => {
    w.advance(1000)
    const last = await save(eric.key, 'yt', { type: 'note', title: 'Latest', content: 'the very last one' })
    const recent = await find(eric.key, 'q=&brains=yt')
    assert.deepEqual([recent.items[0]?.id, recent.items[0]?.why], [last, 'recent'])
    assert.match((await find(eric.key, `${q('zzyzxnothing')}&types=fact`)).note ?? '', /without filters/)
    assert.match((await find(eric.key, q('zzyzxnothing'))).note ?? '', /other words/)
  })

  it('pages: 10 by default, up to 50, and it says when there are more', async () => {
    const first = await find(eric.key, `${q('channel')}&in=pages`)
    assert.equal(first.items.length, 10)
    assert.equal(first.next, 10)
    const second = await find(eric.key, `${q('channel')}&in=pages&offset=10`)
    assert.equal(new Set([...first.items, ...second.items].map((h) => h.id)).size, 20)
    assert.equal((await find(eric.key, `${q('channel')}&in=pages&limit=50`)).items.length, 50)
    assert.equal((await w.call(eric.key, 'GET', `/v1/search?${q('channel')}&limit=51`)).status, 400)
  })

  it('CA9: with neighbours, a page linked from a result is marked with the link it came by', async () => {
    await page('yt', 'hooks', { title: 'Hooks', body: 'Open with a question.' })
    await page('yt', 'retention', {
      title: 'Retention',
      body: 'How viewers stay. See [[intro-tips]].',
      links: [{ kind: 'depends-on', to: 'hooks' }],
    })
    await page('yt', 'intro-tips', { title: 'Intro tips', body: 'Short intros.' })
    const found = await find(eric.key, `${q('retention')}&in=pages&neighbours=1`)
    assert.equal(found.items[0]?.address, 'retention')
    const hooks = found.neighbours?.find((h) => h.address === 'hooks')
    assert.equal(hooks?.reason, 'linked from Retention via depends-on')
    assert.deepEqual(
      [hooks?.why, hooks?.linkedFrom?.kind, hooks?.linkedFrom?.direction],
      ['link', 'depends-on', 'out'],
    )
    assert.equal(found.neighbours?.find((h) => h.address === 'intro-tips')?.linkedFrom?.kind, 'mentions')
  })

  it('neighbours of a page: one or two hops, by kind, by direction', async () => {
    await page('yt', 'n/c', { title: 'NC' })
    await page('yt', 'n/b', { title: 'NB', links: [{ kind: 'related', to: 'n/c' }] })
    await page('yt', 'n/a', { title: 'NA', links: [{ kind: 'depends-on', to: 'n/b' }] })
    const at = async (query: string) => {
      const r = await w.call(eric.key, 'GET', `/v1/brains/yt/neighbours?${query}`)
      assert.equal(r.status, 200, r.text)
      return (r.body.items as Hit[])
        .map((h) => `${h.address}:${h.linkedFrom?.kind}:${h.linkedFrom?.direction}`)
        .sort()
    }
    assert.deepEqual(await at('address=n/a'), ['n/b:depends-on:out'])
    assert.deepEqual(await at('address=n/a&hops=2'), ['n/b:depends-on:out', 'n/c:related:out'])
    assert.deepEqual(await at('address=n/b&direction=in'), ['n/a:depends-on:in'])
    assert.deepEqual(await at('address=n/b&direction=out'), ['n/c:related:out'])
    assert.deepEqual(await at('address=n/b&kinds=related'), ['n/c:related:out'])
    assert.equal((await w.call(eric.key, 'GET', '/v1/brains/yt/neighbours?address=n/zz')).status, 404)
    assert.equal((await w.call(eric.key, 'GET', '/v1/brains/yt/neighbours?address=n/a&hops=3')).status, 400)
    assert.equal(
      (await w.call(eric.key, 'GET', '/v1/brains/yt/neighbours?address=n/a&kinds=likes')).status,
      400,
    )
    // Not a member: the brain does not exist for you.
    const stranger = await w.person('Stranger')
    assert.equal((await w.call(stranger.key, 'GET', '/v1/brains/yt/neighbours?address=n/a')).status, 404)
  })

  it('a search leaves a trail with the pages it found', async () => {
    const id = await page('yt', 'feijoa', { title: 'Feijoa', body: 'feijoa' })
    await find(eric.key, `${q('feijoa')}&brains=yt`)
    const t = await w.db.one<{ result_ids: string[] }>(
      "SELECT result_ids FROM trail WHERE kind = 'search' AND query = 'feijoa' ORDER BY id DESC LIMIT 1",
    )
    assert.deepEqual(t?.result_ids, [id])
  })

  const supersede = (address: string, by: string) =>
    change('yt', { op: 'status', address, status: 'superseded', supersededBy: by, reason: 'replaced' })

  it('review: a stale successor still goes before the superseded page edited later (CA17b)', async () => {
    const fresh = await page('yt', 'r3/new', { title: 'Mangosteen', body: 'mangosteen rind' })
    await change('yt', { op: 'status', address: 'r3/new', status: 'stale', reason: 'old' })
    w.advance(1000)
    const old = await page('yt', 'r3/old', { title: 'Mangosteen', body: 'mangosteen rind' })
    w.advance(1000)
    await supersede('r3/old', 'r3/new') // the old one is now the most recently changed
    const ids = (await find(eric.key, `${q('mangosteen rind')}&include=stale,superseded`)).items.map(
      (h) => h.id,
    )
    assert.deepEqual(ids, [fresh, old])
  })

  it('review: a chain of four replacements keeps its order', async () => {
    const ids: Record<string, string> = {}
    for (const x of ['d', 'c', 'b', 'a']) {
      ids[x] = await page('yt', `r2/${x}`)
      w.advance(1000)
    }
    for (const [x, by] of [
      ['c', 'd'],
      ['b', 'c'],
      ['a', 'b'],
    ] as const) {
      await supersede(`r2/${x}`, `r2/${by}`)
      w.advance(1000)
    }
    const order = (await find(eric.key, 'q=&in=pages&prefix=r2&include=superseded')).items.map((h) => h.id)
    assert.deepEqual(order, [ids.d, ids.c, ids.b, ids.a])
  })

  it('review: with superseded results, pages of results neither repeat nor skip', async () => {
    await page('yt', 'r1/b')
    for (let i = 0; i < 10; i++) {
      w.advance(1000)
      await page('yt', `r1/f${i}`)
    }
    w.advance(1000)
    await page('yt', 'r1/a')
    await supersede('r1/a', 'r1/b')
    const base = 'q=&in=pages&prefix=r1&include=superseded'
    const one = (await find(eric.key, `${base}&limit=10`)).items.map((h) => h.id)
    const two = (await find(eric.key, `${base}&limit=10&offset=10`)).items.map((h) => h.id)
    const all = (await find(eric.key, `${base}&limit=50`)).items.map((h) => h.id)
    assert.equal(all.length, 12)
    assert.deepEqual([...one, ...two], all)
  })

  it('review: NUL in the query string, impossible days and phrases without words', async () => {
    for (const bad of [
      'q=a%00b',
      'q=x&tags=a%00',
      'q=x&author=%00',
      'q=x&from=2026-02-31',
      'q=x&to=2026-13-01',
    ]) {
      const r = await w.call(eric.key, 'GET', `/v1/search?${bad}`)
      assert.equal(r.status, 400, bad)
    }
    assert.equal((await w.call(eric.key, 'GET', '/v1/brains/yt/neighbours?address=%00')).status, 400)
    const last = await page('yt', 'punct')
    assert.equal((await find(eric.key, `${q('"!!!"')}&in=pages&prefix=punct`)).items[0]?.id, last)
  })

  it('review: "to" a day includes the whole of that day', async () => {
    const id = await page('yt', 'whole-day')
    const b = await w.db.one<{ id: string }>("SELECT id FROM brains WHERE slug = 'yt'")
    await w.db.query(
      "UPDATE pages SET updated_at = '2026-01-15T23:59:59.9995Z' WHERE id = $1 AND brain_id = $2",
      [id, b?.id],
    )
    const r = await find(eric.key, 'q=&in=pages&prefix=whole-day&from=2026-01-15&to=2026-01-15')
    assert.deepEqual(
      r.items.map((h) => h.id),
      [id],
    )
    assert.deepEqual((await find(eric.key, 'q=&in=pages&prefix=whole-day&to=2026-01-14')).items, [])
  })

  it('review: snippets of long pages are bounded in cost', async () => {
    const b = await w.db.one<{ id: string }>("SELECT id FROM brains WHERE slug = 'yt'")
    const body = `zebra ${'lorem ipsum dolor sit amet consectetur '.repeat(2900)}`.slice(0, 119_000)
    await w.db.query(
      `INSERT INTO pages (id, brain_id, address, type, title, summary, body, created_at, updated_at)
       SELECT 'pg_long_' || g, $1, 'long-' || g, 'topic', 'Long ' || g, '', $3, $2, $2 FROM generate_series(1, 50) g`,
      [b?.id, w.now, body],
    )
    const t = Date.now()
    const all = await find(
      eric.key,
      `${q('zebra lorem ipsum dolor sit amet')}&in=pages&limit=50&prefix=long-1`,
    )
    const many = await find(eric.key, `${q('zebra lorem ipsum dolor sit amet')}&in=pages&limit=50`)
    assert.ok(Date.now() - t < 5000, `took ${Date.now() - t} ms`)
    assert.ok(all.items.length === 1 && many.items.length === 50)
  })

  it('review: neighbours follow a mention through an old address, and inbound mentions', async () => {
    await page('yt', 'm/target', { title: 'Target' })
    await page('yt', 'm/source', { title: 'Source', body: 'See [[m/target]].' })
    const t = (await w.call(eric.key, 'GET', '/v1/brains/yt/pages/m/target')).body.page as {
      revision: number
    }
    await change('yt', { op: 'move', address: 'm/target', to: 'm/moved', reason: 'rename' })
    const at = async (query: string) =>
      ((await w.call(eric.key, 'GET', `/v1/brains/yt/neighbours?${query}`)).body.items as Hit[]).map(
        (h) => `${h.address}:${h.linkedFrom?.kind}:${h.linkedFrom?.direction}`,
      )
    assert.deepEqual(await at('address=m/source'), ['m/moved:mentions:out'])
    assert.deepEqual(await at('address=m/moved'), ['m/source:mentions:in'])
    assert.ok(t.revision >= 1)
    // A page already among the results is not repeated as a neighbour.
    const found = await find(eric.key, `${q('target source')}&in=pages&prefix=m&neighbours=1`)
    assert.equal(found.items.length, 2)
    assert.deepEqual(found.neighbours, [])
  })
})
