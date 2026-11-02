// Spec B7 «Exportar un cerebro» (plan §3.5, T023), on PostgreSQL: the faithful export (a manifest and one
// NDJSON file per kind of row, original ids, people by reference, no key, no trail, no vector) and the route
// GET /v1/brains/{slug}/export with its permissions (CA15): forgotten entries only when a curator asks for
// them, purged ones never; only curators export; someone outside the brain, the administration included until
// it joins, is told the brain does not exist; every export is audited and shown in the brain's activity.
import assert from 'node:assert/strict'
import { after, before, describe, it } from 'node:test'
import { VERSION } from '../../src/core/version.ts'
import { type Download, download } from '../helpers/download.ts'
import { skipPg } from '../helpers/pg.ts'
import { filesOf } from '../helpers/unzip.ts'
import { type World, world } from '../helpers/world.ts'

type Json = Record<string, unknown>
const TABLES = [
  'pages',
  'page_addresses',
  'page_revisions',
  'page_links',
  'page_sources',
  'entries',
  'entry_revisions',
  'sessions',
  'relations',
  'proposals',
  'proposal_ops',
  'wiki_settings',
  'wiki_log',
]
const errorOf = (d: Download) => (d.json?.error ?? {}) as Json
const ndjson = (text: string | undefined): Json[] =>
  (text ?? '')
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l) as Json)

describe('the faithful export and the export route (CA13 shape, CA15)', { skip: skipPg }, () => {
  let w: World
  let eric: { id: string; key: string }
  let rita: { id: string; key: string }
  let carl: { id: string; key: string }
  let stranger: { id: string; key: string }
  let boss: { id: string; key: string }
  let outsider: { id: string; key: string }
  let dora: { id: string; key: string }
  let web: string
  const ids: Record<string, string> = {}
  const url = (q: string) => `/v1/brains/faith/export?${q}`

  const entry = async (title: string, content: string, key = eric.key) => {
    const r = await w.call(key, 'POST', '/v1/brains/faith/entries', { type: 'learning', title, content })
    assert.equal(r.status, 201, r.text)
    return String((r.body.receipt as Json).entryId)
  }
  const zipOf = async (q: string, who: { key?: string; session?: string } = { session: web }) => {
    const d = await download(w, who, url(q))
    assert.equal(d.status, 200, d.bytes.toString('utf8').slice(0, 300))
    return filesOf(d.bytes)
  }
  const all = (files: Map<string, string>) => [...files.values()].join('\n')

  before(async () => {
    w = await world()
    eric = await w.person('Eric')
    rita = await w.person('Rita')
    carl = await w.person('Carl')
    stranger = await w.person('Stranger')
    boss = await w.person('Boss', { isAdmin: true })
    outsider = await w.person('Outsider', { isAdmin: true })
    await w.call(eric.key, 'POST', '/v1/brains', { slug: 'faith', name: 'Faith', purpose: 'Round trips.' })
    await w.member('faith', rita.id, 'reader')
    await w.member('faith', carl.id, 'contributor')
    dora = await w.person('Dora')
    await w.member('faith', dora.id, 'contributor')
    web = await w.web(eric.id)
    ids.keep = await entry('Kept entry', 'Kept text.')
    ids.forgotten = await entry('Forgotten CANARY-FORGOTTEN', 'Forgotten text CANARY-FORGOTTEN.')
    ids.purged = await entry('Purged CANARY-PURGED', 'Purged text CANARY-PURGED.')
    ids.carls = await entry('Carl wrote this', 'By Carl.', carl.key)
    ids.doras = await entry('Dora wrote this', 'By Dora, who leaves.', dora.key)
    const rel = await w.call(eric.key, 'POST', '/v1/brains/faith/relations', {
      from: ids.keep,
      to: ids.forgotten,
      kind: 'contradicts',
    })
    assert.equal(rel.status, 201, rel.text)
    const page = await w.callWeb(web, 'POST', '/v1/brains/faith/wiki/changes', {
      op: 'create',
      address: 'topic/one',
      type: 'topic',
      title: 'One',
      summary: 'The one page.',
      body: 'Body of one, see [[topic/two]].',
      tags: ['t'],
      sources: [{ entryId: ids.keep }, { entryId: ids.forgotten }, { entryId: ids.purged }],
      reason: 'Seeding.',
    })
    assert.equal(page.status, 201, page.text)
    const proposal = await w.call(eric.key, 'POST', '/v1/brains/faith/proposals', {
      title: 'Add two',
      ops: [
        {
          op: 'create',
          address: 'topic/two',
          type: 'topic',
          title: 'Two',
          summary: 'Second.',
          body: 'Two.',
          sources: [{ entryId: ids.keep }],
          reason: 'More.',
        },
      ],
    })
    assert.equal(proposal.status, 201, proposal.text)
    const settings = await w.callWeb(web, 'PUT', '/v1/brains/faith/wiki/settings', { mapIntro: 'The map.' })
    assert.equal(settings.status, 200, settings.text)
    // Carl's entry was superseded by the one that is forgotten next: the faithful export says by which only
    // when that one comes too.
    await w.db.query('UPDATE entries SET superseded_by = $2 WHERE id = $1', [ids.carls, ids.forgotten])
    // Dora leaves the brain: what she wrote stays, her email is no longer the brain's to give.
    const left = await w.callWeb(web, 'DELETE', `/v1/brains/faith/members/${dora.id}`)
    assert.equal(left.status, 200, left.text)
    const f = await w.call(eric.key, 'POST', `/v1/entries/${ids.forgotten}/forget`, { reason: 'Wrong.' })
    assert.equal(f.status, 200, f.text)
    const p = await w.callWeb(await w.web(boss.id), 'POST', `/v1/entries/${ids.purged}/purge`, {
      reason: 'Secret.',
    })
    assert.equal(p.status, 200, p.text)
  })
  after(async () => w.close())

  it('writes a manifest and one NDJSON file per kind of row, counted', async () => {
    const files = await zipOf('format=faithful')
    const m = JSON.parse(files.get('manifest.json') as string) as Json
    assert.equal(m.format, 'rsc-brain-faithful')
    assert.equal(m.version, 1)
    assert.equal(m.release, VERSION)
    assert.equal(m.includeForgotten, false)
    assert.deepEqual(m.brain, { slug: 'faith', name: 'Faith', description: '', purpose: 'Round trips.' })
    const counts = m.counts as Record<string, number>
    for (const t of TABLES) {
      assert.ok(files.has(`${t}.ndjson`), t)
      assert.equal(ndjson(files.get(`${t}.ndjson`)).length, counts[t], t)
    }
    assert.equal(counts.pages, 1)
    assert.equal(counts.proposals, 1)
    assert.equal(counts.wiki_settings, 1)
    // Original ids and words.
    const page = ndjson(files.get('pages.ndjson'))[0] as Json
    const row = await w.db.one('SELECT id, body FROM pages WHERE address = $1', ['topic/one'])
    assert.deepEqual([page.id, page.body], [row?.id, row?.body])
    assert.deepEqual(
      ndjson(files.get('entries.ndjson'))
        .map((e) => e.id)
        .sort(),
      [ids.keep, ids.carls, ids.doras].sort(),
    )
  })

  it('names people by reference: the manifest holds their names and emails, the rows only the reference', async () => {
    const files = await zipOf('format=faithful')
    const m = JSON.parse(files.get('manifest.json') as string) as Json
    const people = m.people as { ref: string; name: string; email: string | null; kind: string }[]
    const byName = Object.fromEntries(people.map((p) => [p.name, p]))
    assert.ok(byName.Eric && byName.Carl)
    assert.match(String(byName.Eric?.email), /^eric\d+@example\.com$/)
    // Someone who left the brain is there by reference and name, without the email (review of PR31).
    assert.deepEqual(byName.Dora, { ref: byName.Dora?.ref, kind: 'person', name: 'Dora', email: null })
    assert.ok(!all(files).includes('dora'))
    const carls = ndjson(files.get('entries.ndjson')).find((e) => e.id === ids.carls) as Json
    assert.equal(carls.author, byName.Carl?.ref)
    assert.ok(!('author_id' in carls))
    // No account id, key id or key anywhere.
    const text = all(files)
    assert.doesNotMatch(text, /\bacc_[0-9a-f]{12}\b/)
    assert.doesNotMatch(text, /\bcrd_[0-9a-f]{12}\b/)
    assert.doesNotMatch(text, /credential/)
  })

  it('never holds a secret: no key, no hash, no sealed value, no trail, no vector', async () => {
    const secrets = await w.db.query(
      `SELECT secret_hash AS v FROM credentials UNION ALL SELECT password_hash FROM accounts WHERE password_hash IS NOT NULL
        UNION ALL SELECT refresh_hash FROM oauth_grants`,
    )
    for (const q of ['format=faithful&includeForgotten=1', 'format=readable&includeForgotten=1']) {
      const files = await zipOf(q)
      const text = all(files)
      for (const s of secrets) assert.ok(!text.includes(String(s.v)), `a secret in ${q}`)
      for (const k of [eric.key, rita.key, carl.key]) assert.ok(!text.includes(k))
      assert.ok(![...files.keys()].some((f) => /trail|events|meaning|vector|audit/.test(f)), q)
    }
  })

  it('CA15: without "include forgotten", neither the forgotten nor the purged entry is in either format', async () => {
    for (const format of ['faithful', 'readable']) {
      const files = await zipOf(`format=${format}`)
      const text = all(files)
      assert.ok(!text.includes('CANARY-FORGOTTEN'), format)
      assert.ok(!text.includes('CANARY-PURGED'), format)
      for (const id of [ids.forgotten, ids.purged]) {
        assert.ok(!text.includes(String(id)), `${format}: ${id}`)
        assert.ok(!text.includes(String(id).replace(/_/g, '-')), `${format}: ${id}`)
      }
    }
    // What pointed at them goes with them: their relation, their place among the sources.
    const files = await zipOf('format=faithful')
    assert.equal(ndjson(files.get('relations.ndjson')).length, 0)
    assert.deepEqual(
      ndjson(files.get('page_sources.ndjson')).map((s) => s.entry_id),
      [ids.keep],
    )
    const carls = ndjson(files.get('entries.ndjson')).find((e) => e.id === ids.carls) as Json
    assert.equal(carls.superseded_by, null)
  })

  it('CA15: with it, the forgotten entry is there, marked, and the purged one still is not', async () => {
    const faithful = await zipOf('format=faithful&includeForgotten=1')
    const m = JSON.parse(faithful.get('manifest.json') as string) as Json
    assert.equal(m.includeForgotten, true)
    const forgotten = ndjson(faithful.get('entries.ndjson')).find((e) => e.id === ids.forgotten) as Json
    assert.equal(forgotten.state, 'forgotten')
    assert.equal(forgotten.forgotten_reason, 'Wrong.')
    assert.equal(ndjson(faithful.get('relations.ndjson')).length, 1)
    const carls = ndjson(faithful.get('entries.ndjson')).find((e) => e.id === ids.carls) as Json
    assert.equal(carls.superseded_by, ids.forgotten)
    const readable = await zipOf('format=readable&includeForgotten=1')
    const notes = [...readable].filter(([n]) => n.startsWith('raw/journal/')).map(([, t]) => t)
    const note = notes.find((t) => t.includes('CANARY-FORGOTTEN')) as string
    assert.ok(note)
    assert.match(note, /forgotten: true/)
    for (const files of [faithful, readable]) {
      const text = all(files)
      assert.ok(!text.includes('CANARY-PURGED'))
      assert.ok(!text.includes(String(ids.purged)))
      assert.ok(!text.includes(String(ids.purged).replace(/_/g, '-')))
    }
  })

  it('CA15: a reader or a contributor is refused; someone outside, the administration too, does not see the brain', async () => {
    for (const who of [rita, carl])
      for (const q of ['format=readable', 'format=faithful&includeForgotten=1']) {
        const d = await download(w, { session: await w.web(who.id) }, url(q))
        assert.equal(d.status, 403, q)
        assert.equal(errorOf(d).code, 'forbidden')
      }
    const none = await download(
      w,
      { session: await w.web(stranger.id) },
      '/v1/brains/nowhere/export?format=readable',
    )
    for (const who of [stranger, outsider]) {
      const d = await download(w, { session: await w.web(who.id) }, url('format=readable'))
      assert.deepEqual([d.status, errorOf(d).code], [404, errorOf(none).code])
    }
    // The administration joins (as a reader): still not a curator.
    const ow = await w.web(outsider.id)
    assert.equal((await w.callWeb(ow, 'POST', '/v1/admin/brains/faith/join')).status, 200)
    assert.equal((await download(w, { session: ow }, url('format=readable'))).status, 403)
    // As a curator of the brain it exports, and its curators see that it did.
    assert.equal(
      (await w.callWeb(ow, 'POST', '/v1/admin/brains/faith/curator', { account: outsider.id })).status,
      200,
    )
    assert.equal((await download(w, { session: ow }, url('format=faithful&includeForgotten=1'))).status, 200)
  })

  it("is done in the web only: no key exports, a curator's own included (review of PR31)", async () => {
    for (const key of [eric.key, await w.token(eric.id, { perm: 'read' }), await w.app(eric.id, [])]) {
      const d = await download(w, { key }, url('format=readable'))
      assert.equal(d.status, 403)
      assert.equal(errorOf(d).code, 'web_only')
    }
    // The same person in the web does.
    assert.equal((await download(w, { session: web }, url('format=readable'))).status, 200)
  })

  it('refuses a format or a flag it does not know, before anything is written', async () => {
    for (const q of ['format=pdf', '', 'format=readable&includeForgotten=yes']) {
      const d = await download(w, { session: web }, url(q))
      assert.equal(d.status, 400, q)
      assert.equal(errorOf(d).code, 'invalid_request')
    }
  })

  it('every export is audited with its format, and the brain activity says so', async () => {
    const since = Number((await w.db.one('SELECT coalesce(max(id), 0) AS n FROM audit'))?.n)
    await zipOf('format=faithful&includeForgotten=1')
    await download(w, { session: await w.web(rita.id) }, url('format=readable'))
    const rows = await w.db.query(
      "SELECT outcome, detail, actor_id FROM audit WHERE action = 'brain.export' AND id > $1 ORDER BY id",
      [since],
    )
    assert.deepEqual(
      rows.map((r) => [r.outcome, r.actor_id]),
      [
        ['ok', eric.id],
        ['denied', rita.id],
      ],
    )
    assert.deepEqual(JSON.parse(String(rows[0]?.detail)), { format: 'faithful', includeForgotten: true })
    const ev = await w.db.one(
      "SELECT label, account_id FROM events WHERE kind = 'brain.exported' ORDER BY id DESC LIMIT 1",
    )
    assert.deepEqual([ev?.label, ev?.account_id], ['faithful, forgotten included', eric.id])
  })
})
