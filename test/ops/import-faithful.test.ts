// Spec B7 «Importar» (plan §3.6, T029, CA13, C17), on PostgreSQL: a faithful export of a brain in one installation
// (A), imported into an empty brain of another (B, its own database and key), is the same brain: pages, revisions,
// links, entries, relations and proposals equal in number and in content. People are found by their email only
// when they are members of the brain imported into; everyone else comes in as an author (a name, never an account
// that signs in). The ids are kept, or all made new when this installation already has one of them (the same
// export twice). A file that points at anything outside itself, or carries columns it should not, is refused whole.
import assert from 'node:assert/strict'
import { after, before, describe, it } from 'node:test'
import { zipWriter } from '../../src/core/zip.ts'
import { importTree } from '../../src/ops/import/import.ts'
import { treeFromZip } from '../../src/ops/import/tree.ts'
import { download } from '../helpers/download.ts'
import { skipPg } from '../helpers/pg.ts'
import { principalOfSession } from '../helpers/principal.ts'
import { readZip } from '../helpers/unzip.ts'
import { type World, world } from '../helpers/world.ts'

type Json = Record<string, unknown>
// CA13's tables, and the rest of what a faithful export carries.
const COMPARED = [
  'pages',
  'page_addresses',
  'page_revisions',
  'page_links',
  'page_sources',
  'entries',
  'entry_revisions',
  'relations',
  'proposals',
  'proposal_ops',
  'wiki_settings',
] as const
// What is this installation's own, not the brain's: never compared.
const LOCAL = new Set(['brain_id', 'credential_id', 'search'])
const PEOPLE = new Set([
  'account_id',
  'author_id',
  'on_behalf_id',
  'forgotten_by',
  'created_by',
  'decided_by',
  'purged_by',
  'corrected_by',
  'base_reviewed_by',
  'actor_id',
])
const SCOPE: Record<string, string> = {
  pages: 'brain_id = $1',
  page_addresses: 'brain_id = $1',
  page_links: 'brain_id = $1',
  entries: 'brain_id = $1',
  relations: 'brain_id = $1',
  proposals: 'brain_id = $1',
  wiki_settings: 'brain_id = $1',
  wiki_log: 'brain_id = $1',
  page_revisions: 'page_id IN (SELECT id FROM pages WHERE brain_id = $1)',
  page_sources: 'page_id IN (SELECT id FROM pages WHERE brain_id = $1)',
  entry_revisions: 'entry_id IN (SELECT id FROM entries WHERE brain_id = $1)',
  proposal_ops: 'proposal_id IN (SELECT id FROM proposals WHERE brain_id = $1)',
}

// A table of a brain as text that can be compared between installations: every column but those of the
// installation, people by name, rows sorted.
async function fingerprint(w: World, slug: string, table: string): Promise<string[]> {
  const brain = (await w.db.one('SELECT id FROM brains WHERE slug = $1', [slug]))?.id
  const names = new Map(
    (await w.db.query('SELECT id, name FROM accounts')).map((a) => [String(a.id), String(a.name)]),
  )
  const rows = await w.db.query(`SELECT to_jsonb(t) AS r FROM ${table} t WHERE ${SCOPE[table]}`, [brain])
  return rows
    .map((row) => {
      const r = row.r as Json
      const out: Json = {}
      for (const k of Object.keys(r).sort()) {
        if (LOCAL.has(k)) continue
        out[k] = PEOPLE.has(k) && r[k] != null ? `person:${names.get(String(r[k]))}` : r[k]
      }
      return JSON.stringify(out)
    })
    .sort()
}

async function zipOf(files: Map<string, Buffer | string>): Promise<Buffer> {
  const chunks: Buffer[] = []
  const z = zipWriter(async (b) => {
    chunks.push(Buffer.from(b))
  })
  for (const [n, d] of files) await z.file(n, d)
  await z.end()
  return Buffer.concat(chunks)
}

describe('a faithful export imported into another installation (CA13)', { skip: skipPg }, () => {
  let a: World
  let b: World
  let exported: Buffer
  const ids: Record<string, string> = {}
  const people: Record<string, { id: string; key: string; email: string }> = {}
  const P = (k: string) => people[k] as { id: string; key: string; email: string }
  let bWeb: string

  before(async () => {
    a = await world()
    b = await world({ secret: 'another-installation-secret-of-32-characters-at-least' })
    const person = async (w: World, name: string, email: string, o: Json = {}) => {
      const p = await w.person(name, { email, ...o })
      return { ...p, email }
    }
    people.eric = await person(a, 'Eric', 'eric@example.com')
    people.carl = await person(a, 'Carl', 'carl@example.com')
    people.dora = await person(a, 'Dora', 'dora@example.com')
    const svc = await a.service('Factory')
    const aWeb = await a.web(P('eric').id)
    await a.call(P('eric').key, 'POST', '/v1/brains', {
      slug: 'faith',
      name: 'Faith',
      purpose: 'Round trips.',
    })
    await a.member('faith', P('carl').id, 'contributor')
    await a.member('faith', P('dora').id, 'contributor')
    await a.member('faith', svc.id, 'contributor')
    const entry = async (key: string, title: string, content: string) => {
      const r = await a.call(key, 'POST', '/v1/brains/faith/entries', { type: 'learning', title, content })
      assert.equal(r.status, 201, r.text)
      return String((r.body.receipt as Json).entryId)
    }
    ids.e1 = await entry(P('eric').key, 'Retention', 'People come back after a first win.')
    ids.e2 = await entry(
      P('carl').key,
      'Retention again',
      'A first win in five minutes. password: hunter2hunter2',
    )
    ids.e3 = await entry(P('dora').key, 'Audience', 'Teams of five.')
    ids.e4 = await entry(svc.key, 'From the factory', 'A step the factory saved.')
    ids.e5 = await entry(P('eric').key, 'Forgotten', 'Not true after all.')
    // An entry revised, one forgotten, one superseding another, a relation between two.
    const revised = await a.call(P('eric').key, 'PATCH', `/v1/entries/${ids.e1}`, {
      baseRevision: 1,
      content: 'People come back after a first win, revised.',
    })
    assert.equal(revised.status, 200, revised.text)
    const forgot = await a.call(P('eric').key, 'POST', `/v1/entries/${ids.e5}/forget`, { reason: 'Wrong.' })
    assert.equal(forgot.status, 200, forgot.text)
    const rel = await a.call(P('eric').key, 'POST', '/v1/brains/faith/relations', {
      from: ids.e1,
      to: ids.e2,
      kind: 'contradicts',
    })
    assert.equal(rel.status, 201, rel.text)
    await a.db.query('UPDATE entries SET superseded_by = $2 WHERE id = $1', [ids.e3, ids.e2])
    // Pages: one by hand, edited; one by an approved proposal, with a typed link; one pending proposal.
    const change = (body: Json) => a.callWeb(aWeb, 'POST', '/v1/brains/faith/wiki/changes', body)
    assert.equal(
      (
        await change({
          op: 'create',
          address: 'topics/retention',
          type: 'topic',
          title: 'Retention',
          summary: 'Why people return.',
          body: 'See [[topics/audience]].',
          tags: ['growth'],
          sources: [{ entryId: ids.e1 }, { url: 'https://example.com/r', title: 'A paper' }],
          reason: 'Seeding.',
        })
      ).status,
      201,
    )
    const p1 = await a.call(P('carl').key, 'POST', '/v1/brains/faith/proposals', {
      title: 'Audience',
      ops: [
        {
          op: 'create',
          address: 'topics/audience',
          type: 'topic',
          title: 'Audience',
          summary: 'Who reads.',
          body: 'Back to [[topics/retention]].',
          sources: [{ entryId: ids.e3 }],
          links: [{ kind: 'related', to: 'topics/retention' }],
          reason: 'Carl saw it.',
        },
      ],
    })
    assert.equal(p1.status, 201, p1.text)
    const pid = (p1.body.proposal as { id: string }).id
    const fp = ((await a.callWeb(aWeb, 'GET', `/v1/proposals/${pid}/review`)).body as { fingerprint: string })
      .fingerprint
    const approved = await a.callWeb(aWeb, 'POST', `/v1/proposals/${pid}/approve`, { fingerprint: fp })
    assert.equal(approved.status, 200, approved.text)
    const edit = await a.callWeb(aWeb, 'PATCH', '/v1/brains/faith/pages/topics/retention', {
      baseRevision: 1,
      body: 'See [[topics/audience]], twice.',
      reason: 'Clearer.',
    })
    assert.equal(edit.status, 200, edit.text)
    const p2 = await a.call(P('dora').key, 'POST', '/v1/brains/faith/proposals', {
      title: 'Pending',
      ops: [
        {
          op: 'edit',
          address: 'topics/audience',
          baseRevision: 1,
          summary: 'Who reads us.',
          sources: [{ entryId: ids.e2 }],
          reason: 'Better.',
        },
      ],
    })
    assert.equal(p2.status, 201, p2.text)
    assert.equal(
      (
        await a.callWeb(aWeb, 'PUT', '/v1/brains/faith/wiki/settings', {
          mapIntro: 'The map of faith.',
          staleDays: 30,
        })
      ).status,
      200,
    )
    // Dora leaves: what she wrote stays, by her name.
    assert.equal((await a.callWeb(aWeb, 'DELETE', `/v1/brains/faith/members/${P('dora').id}`)).status, 200)
    const d = await download(
      a,
      { session: aWeb },
      '/v1/brains/faith/export?format=faithful&includeForgotten=1',
    )
    assert.equal(d.status, 200)
    exported = d.bytes
    // B: Eric and Carl have accounts with the same emails; only Eric is a member of the brain imported into.
    people.beric = await person(b, 'Eric B', 'eric@example.com')
    people.bcarl = await person(b, 'Carl B', 'carl@example.com')
    bWeb = await b.web(P('beric').id)
    await b.call(P('beric').key, 'POST', '/v1/brains', { slug: 'copy', name: 'Copy' })
  })
  after(async () => {
    await a.close()
    await b.close()
  })

  const imp = async (w: World, session: string, slug: string, zip: Buffer) =>
    importTree(
      { db: w.db, clock: w.clock, who: await principalOfSession(w, session) },
      slug,
      treeFromZip(zip),
      {
        from: 'faith.zip',
      },
    )

  it('CA13: the same pages, revisions, links, entries, relations and proposals, in number and content', async () => {
    const report = await imp(b, bWeb, 'copy', exported)
    assert.equal(report.kind, 'faithful')
    assert.equal(report.pages, 2)
    assert.equal(report.entries, 5)
    for (const t of COMPARED) {
      const [x, y] = await Promise.all([fingerprint(a, 'faith', t), fingerprint(b, 'copy', t)])
      // People by name: in B, Carl and Dora are authors with the names they had in A, and Eric is Eric B.
      const rename = (rows: string[]) => rows.map((r) => r.replaceAll('person:Eric B', 'person:Eric'))
      assert.equal(y.length, x.length, `${t}: ${y.length} rows, ${x.length} in A`)
      assert.deepEqual(rename(y), x, t)
    }
    // The ids are the original ones (no clash in B).
    assert.ok(await b.db.one('SELECT 1 FROM entries WHERE id = $1', [ids.e1]))
  })

  it("finds people by email only among the brain's members; everyone else is an author who never signs in", async () => {
    const authorOf = async (entryId: string) =>
      (await b.db.one(
        'SELECT a.id, a.kind, a.name, a.email FROM entries e JOIN accounts a ON a.id = e.author_id WHERE e.id = $1',
        [entryId],
      )) as Json
    assert.equal((await authorOf(ids.e1 as string)).id, P('beric').id)
    // Carl has an account in B with that email, but is not a member of this brain: his work is not given to it.
    const carl = await authorOf(ids.e2 as string)
    assert.deepEqual([carl.kind, carl.name, carl.email], ['author', 'Carl', null])
    assert.notEqual(carl.id, P('bcarl').id)
    const dora = await authorOf(ids.e3 as string)
    assert.deepEqual([dora.kind, dora.name, dora.email], ['author', 'Dora', null])
    const svc = await authorOf(ids.e4 as string)
    assert.deepEqual([svc.kind, svc.name], ['author', 'Factory'])
    // Authors: no key, no membership, no password.
    const n = await b.db.one(
      `SELECT (SELECT count(*)::int FROM credentials c JOIN accounts a ON a.id = c.account_id WHERE a.kind = 'author') AS keys,
              (SELECT count(*)::int FROM memberships m JOIN accounts a ON a.id = m.account_id WHERE a.kind = 'author') AS members,
              (SELECT count(*)::int FROM accounts WHERE kind = 'author' AND password_hash IS NOT NULL) AS passwords`,
    )
    assert.deepEqual(n, { keys: 0, members: 0, passwords: 0 })
  })

  it('leaves the history whole: the wiki log of A, then one line for the import; sessions closed', async () => {
    const [x, y] = await Promise.all([
      fingerprint(a, 'faith', 'wiki_log'),
      fingerprint(b, 'copy', 'wiki_log'),
    ])
    const imported = y.filter((r) => r.includes('"kind":"import"'))
    assert.equal(imported.length, 1)
    assert.match(imported[0] as string, /Imported by Eric B from faith\.zip/)
    assert.deepEqual(
      y
        .filter((r) => !r.includes('"kind":"import"'))
        .map((r) => r.replaceAll('person:Eric B', 'person:Eric')),
      x,
    )
    const open = await b.db.one("SELECT count(*)::int AS n FROM sessions WHERE status = 'open'")
    assert.equal(open?.n, 0)
  })

  it('the same export again, into another brain of B: every id made new, the same content', async () => {
    await b.call(P('beric').key, 'POST', '/v1/brains', { slug: 'copy-two', name: 'Copy two' })
    // Carl has an account here and is a member of this brain, but his account was removed: not him any more.
    await b.member('copy-two', P('bcarl').id, 'contributor')
    await b.db.query("UPDATE accounts SET status = 'removed', removed_at = now() WHERE id = $1", [
      P('bcarl').id,
    ])
    const report = await imp(b, bWeb, 'copy-two', exported)
    const carls = await b.db.one(
      `SELECT a.id, a.kind FROM entries e JOIN brains x ON x.id = e.brain_id JOIN accounts a ON a.id = e.author_id
        WHERE x.slug = 'copy-two' AND e.title = 'Retention again'`,
    )
    assert.equal(carls?.kind, 'author')
    assert.notEqual(carls?.id, P('bcarl').id)
    assert.deepEqual([report.pages, report.entries], [2, 5])
    const two = (await b.db.one("SELECT id FROM brains WHERE slug = 'copy-two'"))?.id
    assert.equal((await b.db.one('SELECT count(*)::int AS n FROM entries WHERE id = $1', [ids.e1]))?.n, 1)
    const e = await b.db.query('SELECT id, title FROM entries WHERE brain_id = $1 ORDER BY title', [two])
    assert.equal(e.length, 5)
    for (const r of e) assert.ok(!Object.values(ids).includes(String(r.id)))
    // References follow the new ids: the relation, the superseding entry, the sources of the pages.
    const rel = await b.db.one(
      `SELECT f.title AS f, t.title AS t FROM relations r JOIN entries f ON f.id = r.from_id JOIN entries t ON t.id = r.to_id
        WHERE r.brain_id = $1`,
      [two],
    )
    assert.deepEqual(rel, { f: 'Retention', t: 'Retention again' })
    const src = await b.db.query(
      `SELECT e.brain_id FROM page_sources s JOIN pages p ON p.id = s.page_id JOIN entries e ON e.id = s.entry_id
        WHERE p.brain_id = $1`,
      [two],
    )
    assert.ok(src.length > 0)
    for (const s of src) assert.equal(s.brain_id, two)
    for (const t of ['pages', 'entries', 'relations', 'proposals', 'page_revisions', 'page_links'] as const) {
      const strip = (rows: string[]) =>
        rows
          .map((r) => JSON.parse(r) as Json)
          .map((r) => {
            for (const k of [
              'id',
              'page_id',
              'entry_id',
              'from_id',
              'to_id',
              'from_page',
              'to_page',
              'session_id',
              'superseded_by',
              'proposal_id',
              'sources',
            ])
              delete r[k]
            return JSON.stringify(r)
          })
          .sort()
      assert.deepEqual(strip(await fingerprint(b, 'copy-two', t)), strip(await fingerprint(b, 'copy', t)), t)
    }
  })

  it('refuses, and writes nothing, a file pointing outside itself, with columns of its own, or from a newer release', async () => {
    const files = new Map(readZip(exported).map((e) => [e.name, e.data]))
    const other = await b.db.one(
      "SELECT p.id FROM pages p JOIN brains x ON x.id = p.brain_id WHERE x.slug = 'copy-two' LIMIT 1",
    )
    const tamper = (name: string, f: (rows: Json[]) => Json[]) => {
      const m = new Map<string, Buffer | string>(files)
      const rows = String(m.get(name))
        .split('\n')
        .filter(Boolean)
        .map((l) => JSON.parse(l) as Json)
      m.set(
        name,
        `${f(rows)
          .map((r) => JSON.stringify(r))
          .join('\n')}\n`,
      )
      return m
    }
    const cases: Array<[string, Map<string, Buffer | string>]> = [
      // A link to a page of another brain of this installation.
      [
        'link out',
        tamper('page_links.ndjson', (r) =>
          r.map((x, i) => (i === 0 ? { ...x, to_page: other?.id, to_address: null, kind: 'related' } : x)),
        ),
      ],
      // A source that is an entry of another brain.
      [
        'source out',
        tamper('page_sources.ndjson', (r) => [
          ...r,
          { page_id: r[0]?.page_id, entry_id: 'ent_000000000000', url: null, title: null },
        ]),
      ],
      // A column the export never writes (the brain, a key).
      ['brain_id', tamper('pages.ndjson', (r) => r.map((x) => ({ ...x, brain_id: 'brn_000000000000' })))],
      ['credential_id', tamper('entries.ndjson', (r) => r.map((x) => ({ ...x, credential_id: 'crd_x' })))],
      // Someone the manifest does not name.
      ['unknown person', tamper('entries.ndjson', (r) => r.map((x) => ({ ...x, author: 'p999' })))],
      [
        'unknown person, where one may be left out',
        tamper('entries.ndjson', (r) => r.map((x) => ({ ...x, on_behalf: 'p999' }))),
      ],
      // A value the schema refuses.
      ['bad value', tamper('pages.ndjson', (r) => r.map((x) => ({ ...x, type: 'weapon' })))],
      ['purged', tamper('entries.ndjson', (r) => r.map((x) => ({ ...x, state: 'purged' })))],
      [
        'newer',
        new Map<string, Buffer | string>([
          ...files,
          [
            'manifest.json',
            JSON.stringify({ ...JSON.parse(String(files.get('manifest.json'))), version: 2 }),
          ],
        ]),
      ],
    ]
    for (const [i, [label, m]] of cases.entries()) {
      const slug = `bad-${i}`
      await b.call(P('beric').key, 'POST', '/v1/brains', { slug, name: `Bad ${i}` })
      await assert.rejects(
        imp(b, bWeb, slug, await zipOf(m)),
        (e: { status?: number; code?: string }) => {
          assert.deepEqual([e.status, e.code], [422, 'invalid_archive'], label)
          return true
        },
        label,
      )
      const left = await b.db.one(
        `SELECT (SELECT count(*)::int FROM pages p JOIN brains x ON x.id = p.brain_id WHERE x.slug = $1) +
                (SELECT count(*)::int FROM entries e JOIN brains x ON x.id = e.brain_id WHERE x.slug = $1) AS n,
                (SELECT imported_at FROM brains WHERE slug = $1) AS at`,
        [slug],
      )
      assert.deepEqual(left, { n: 0, at: null }, label)
    }
    // Nothing of a refused import made an author either.
    const authors = await b.db.one("SELECT count(*)::int AS n FROM accounts WHERE kind = 'author'")
    assert.equal(authors?.n, 6)
    // Nothing of any of them in the log either.
    assert.equal(
      (
        await b.db.one(
          "SELECT count(*)::int AS n FROM wiki_log l JOIN brains x ON x.id = l.brain_id WHERE x.slug LIKE 'bad-%'",
        )
      )?.n,
      0,
    )
  })
})
