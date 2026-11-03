// Spec B7 «Importar» (plan §3.6, T028, CA14 in CI): a documentation folder as a brain. Without a database, what the
// reader makes of test/fixtures/docs-sample/ (a synthetic 02-DOCS with headers, wikilinks, relative links, a
// binary, a name that is not an address, a key file, a hidden folder and things outside wiki/ and raw/), as a folder
// and as a zip of it; with PostgreSQL, what the import writes: the pages with their links, the notes, the map, one
// line of the wiki's log, nothing private and no secret, and the report.
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, describe, it } from 'node:test'
import { planDocs } from '../../src/ops/import/docs.ts'
import { type FileTree, treeFromFolder, treeFromZip } from '../../src/ops/import/tree.ts'
import { skipPg } from '../helpers/pg.ts'
import { type World, world } from '../helpers/world.ts'
import { zipOfFolder } from '../helpers/zipfolder.ts'

const SAMPLE = new URL('../fixtures/docs-sample/', import.meta.url).pathname
const MB = 1024 * 1024

const memTree = (files: Record<string, string | Buffer>, big: string[] = []): FileTree => ({
  skipped: [],
  files: [
    ...Object.entries(files).map(([path, data]) => {
      const buf = Buffer.isBuffer(data) ? data : Buffer.from(data, 'utf8')
      return { path, size: buf.length, tooLarge: false, read: async () => buf }
    }),
    ...big.map((path) => ({
      path,
      size: 2 * MB,
      tooLarge: true,
      read: async (): Promise<Buffer> => {
        throw new Error('a file over 1 MB is never read')
      },
    })),
  ],
})

describe('reading a documentation folder (CA14, CI)', () => {
  it('makes pages, notes and the map of the sample, and says what it left out and why', async () => {
    const plan = await planDocs(await treeFromFolder(SAMPLE))
    assert.deepEqual(
      plan.pages.map((p) => [p.address, p.type, p.title]),
      [
        ['decisions/use-postgres', 'decision', 'Use PostgreSQL'],
        ['guides/getting-started', 'guide', 'Getting started'],
        ['people/ada', 'entity', 'Ada Lovelace'],
        ['topics/audience-notes', 'topic', 'Audience notes'],
        ['topics/retention', 'topic', 'Retention'],
      ],
    )
    assert.deepEqual(plan.renamed, [
      { path: 'wiki/topics/Audience Notes.md', address: 'topics/audience-notes' },
    ])
    assert.deepEqual(plan.ignored, [
      { path: '.obsidian/', why: 'hidden' },
      { path: 'README.md', why: 'outside' },
      { path: 'archive/', why: 'outside' },
      { path: 'raw/images/photo.jpg', why: 'binary' },
      { path: 'raw/keys/admin.totp', why: 'secret' },
      { path: 'wiki/data.json', why: 'not_markdown' },
      { path: 'wiki/diagram.png', why: 'binary' },
    ])
    assert.deepEqual(plan.unresolved, [
      { from: 'decisions/use-postgres', target: 'wiki/nowhere' },
      { from: 'topics/retention', target: 'missing-page' },
    ])
    assert.deepEqual(
      plan.notes.map((n) => [n.ref, n.type, n.title]),
      [
        ['import:raw/notes/call.md', 'note', 'Call with the team'],
        ['import:raw/notes/transcript.txt', 'note', 'transcript.txt'],
        ['import:log.md#1', 'note', '2026-10-01 · First pages'],
        ['import:log.md#2', 'note', '2026-10-02 · People'],
      ],
    )
    assert.equal(
      plan.mapIntro,
      'A synthetic 02-DOCS folder for the import tests: a few pages that link to each other, notes, and the files an import leaves out. Start at [[guides/getting-started|getting started]].',
    )
  })

  it('takes the header first, then the folder, the name and the first paragraph', async () => {
    const plan = await planDocs(await treeFromFolder(SAMPLE))
    const page = (a: string) => plan.pages.find((p) => p.address === a)
    const guide = page('guides/getting-started')
    assert.deepEqual(guide?.tags, ['onboarding', 'first steps'])
    assert.equal(guide?.summary, 'How to begin with the sample.')
    const retention = page('topics/retention')
    assert.equal(
      retention?.summary,
      'People come back when the first session ends with something done. This line is the summary.',
    )
    // The title the file opens with is the title, not part of the body again.
    assert.ok(!guide?.body.includes('# Getting started'))
    const pg = page('decisions/use-postgres')
    assert.deepEqual(pg?.links, [{ kind: 'depends-on', to: 'topics/retention' }])
    assert.deepEqual(pg?.sources, [
      { url: 'https://www.postgresql.org/docs/' },
      { file: 'raw/notes/call.md' },
    ])
  })

  it("writes every link to a page as the wiki's own, and leaves the rest as text", async () => {
    const plan = await planDocs(await treeFromFolder(SAMPLE))
    const body = (a: string) => plan.pages.find((p) => p.address === a)?.body ?? ''
    const guide = body('guides/getting-started')
    assert.match(
      guide,
      /Read \[\[topics\/retention\]\] first, then \[\[topics\/audience-notes\|the audience notes\]\]\./,
    )
    // An alias of a page's header, with the words it was written with.
    assert.match(guide, /\[\[people\/ada\|Ada Lovelace\]\]/)
    // A note of raw/ is a source, not a link to a page that does not exist.
    assert.match(guide, /\\\[\\\[raw\/notes\/call\]\]/)
    assert.deepEqual(plan.pages.find((p) => p.address === 'guides/getting-started')?.sources, [
      { file: 'raw/notes/call.md' },
    ])
    // Code stays as it was written.
    assert.match(guide, /A link in code stays as it is: \[\[topics\/retention\]\]/)
    assert.match(guide, /Inline `\[\[not-a-link\]\]` too\./)
    // By its name, when only one file has it.
    assert.match(body('topics/audience-notes'), /Back to \[\[topics\/retention\]\]\./)
    // A link to nothing never becomes a link; the web stays a link to the web.
    const retention = body('topics/retention')
    assert.match(retention, /\\\[\\\[missing-page\]\]/)
    assert.match(retention, /\[the paper\]\(https:\/\/example\.com\/retention\)/)
  })

  it('keeps nothing private and no secret: a private part, a password, a key, a key file', async () => {
    const plan = await planDocs(await treeFromFolder(SAMPLE))
    const all = JSON.stringify(plan)
    for (const s of ['Our churn by customer', 'hunter2hunter2', 'abcdefgh12345678', 'JBSWY3DPEHPK3PXP'])
      assert.ok(!all.includes(s), s)
    assert.match(all, /\[private removed\]/)
    assert.match(all, /\[redacted secret\]/)
  })

  it('reads the same from a zip of the folder, also one made of the folder itself (02-DOCS/…)', async () => {
    const folder = await planDocs(await treeFromFolder(SAMPLE))
    for (const prefix of ['', '02-DOCS/']) {
      const zipped = await planDocs(treeFromZip(await zipOfFolder(SAMPLE, prefix)))
      assert.deepEqual(zipped, folder, prefix)
    }
  })

  it('leaves out a file over 1 MB unread, a page too long for the wiki, and cuts a long note in pieces', async () => {
    const plan = await planDocs(
      memTree(
        {
          'wiki/long.md': `# Long\n\n${'word '.repeat(21_000)}`,
          'wiki/ok.md': '# Ok\n\nShort.',
          'raw/long-note.md': `# Long note\n\n${'## Part\n\n'.concat('line of text\n'.repeat(2000)).repeat(3)}`,
        },
        ['wiki/huge.md', 'raw/huge.txt'],
      ),
    )
    assert.deepEqual(
      plan.pages.map((p) => p.address),
      ['ok'],
    )
    assert.deepEqual(plan.ignored, [
      { path: 'raw/huge.txt', why: 'too_large' },
      { path: 'wiki/huge.md', why: 'too_large' },
      { path: 'wiki/long.md', why: 'too_large' },
    ])
    const parts = plan.notes.filter((n) => n.path === 'raw/long-note.md')
    assert.equal(parts.length, 3)
    assert.deepEqual(
      parts.map((n) => [n.ref, n.title]),
      [
        ['import:raw/long-note.md.1', 'Long note (part 1 of 3)'],
        ['import:raw/long-note.md.2', 'Long note (part 2 of 3)'],
        ['import:raw/long-note.md.3', 'Long note (part 3 of 3)'],
      ],
    )
    for (const n of parts) assert.ok(n.content.length <= 32_000)
    assert.equal(
      parts.map((n) => n.content).join(''),
      `# Long note\n\n${'## Part\n\n'.concat('line of text\n'.repeat(2000)).repeat(3)}`,
    )
  })

  it('reads an Obsidian vault (no wiki/): its notes are the pages; two names that meet get their own address', async () => {
    const plan = await planDocs(
      memTree({
        'Home.md': '# Home\n\nSee [[Ideas/Big Idea]] and [[Ideas/big-idea]].',
        'Ideas/Big Idea.md': 'One.',
        'Ideas/big-idea.md': 'Two.',
        'attachments/pic.png': Buffer.from([0x89, 0x50]),
      }),
    )
    assert.deepEqual(
      plan.pages.map((p) => [p.path, p.address]),
      [
        ['Home.md', 'home'],
        ['Ideas/Big Idea.md', 'ideas/big-idea'],
        ['Ideas/big-idea.md', 'ideas/big-idea-2'],
      ],
    )
    assert.match(plan.pages[0]?.body ?? '', /See \[\[ideas\/big-idea\]\] and \[\[ideas\/big-idea-2\]\]\./)
    assert.deepEqual(plan.ignored, [{ path: 'attachments/pic.png', why: 'binary' }])
  })

  it('walks a folder without following links, and only wiki/, raw/ and the root of a 02-DOCS folder', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'rsc-brain-import-walk-'))
    try {
      for (const f of ['wiki/a.md', 'raw/n.md', 'archive/x/deep.md']) {
        await mkdir(join(dir, f, '..'), { recursive: true })
        await writeFile(join(dir, f), 'x')
      }
      await symlink('/etc/hosts', join(dir, 'wiki', 'hosts.md'))
      await symlink('/etc', join(dir, 'raw', 'etc'))
      const t = await treeFromFolder(dir)
      assert.deepEqual(
        t.files.map((f) => f.path),
        ['raw/n.md', 'wiki/a.md'],
      )
      assert.deepEqual(t.skipped, [
        { path: 'archive/', why: 'outside' },
        { path: 'raw/etc', why: 'link' },
        { path: 'wiki/hosts.md', why: 'link' },
      ])
      assert.ok((await stat(join(dir, 'archive/x/deep.md'))).isFile())
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})

describe('review of PR32: limits and the fine print of a folder (CI)', () => {
  const never = (path: string, size = 10) => ({
    path,
    size,
    tooLarge: false,
    read: async (): Promise<Buffer> => {
      throw new Error(`${path} is never read`)
    },
  })

  it('a manifest.json that is not a faithful export keeps the 1 MB limit of a folder', async () => {
    const big = Buffer.alloc(MB + 500_000, 0x61)
    for (const manifest of ['{"name":"my app"}', '{}', 'not json']) {
      const { rawZip } = await import('../helpers/rawzip.ts')
      const z = rawZip([
        { name: 'manifest.json', data: manifest },
        { name: 'wiki/big.md', data: big },
        { name: 'wiki/a.md', data: '# A' },
      ])
      const t = treeFromZip(z)
      assert.equal(t.files.find((f) => f.path === 'wiki/big.md')?.tooLarge, true, manifest)
      const dir = await mkdtemp(join(tmpdir(), 'rsc-brain-import-manifest-'))
      try {
        await mkdir(join(dir, 'wiki'))
        await writeFile(join(dir, 'manifest.json'), manifest)
        await writeFile(join(dir, 'wiki', 'big.md'), big)
        const f = await treeFromFolder(dir)
        assert.equal(f.files.find((x) => x.path === 'wiki/big.md')?.tooLarge, true, manifest)
      } finally {
        await rm(dir, { recursive: true, force: true })
      }
    }
    // A faithful one takes the limit of the whole import for each file.
    const { rawZip } = await import('../helpers/rawzip.ts')
    const faithful = treeFromZip(
      rawZip([
        { name: 'manifest.json', data: '{"format":"rsc-brain-faithful","version":1}' },
        { name: 'entries.ndjson', data: big },
      ]),
    )
    assert.equal(faithful.files.find((f) => f.path === 'entries.ndjson')?.tooLarge, false)
  })

  it('says why a file that is not markdown is left out by its name alone, never reading it', async () => {
    const plan = await planDocs({
      skipped: [],
      files: [
        never('wiki/data.json'),
        never('wiki/photo.png'),
        never('wiki/thing.xyz'),
        { ...never('wiki/a.md'), read: async () => Buffer.from('# A') },
      ],
    })
    assert.deepEqual(plan.ignored, [
      { path: 'wiki/data.json', why: 'not_markdown' },
      { path: 'wiki/photo.png', why: 'binary' },
      { path: 'wiki/thing.xyz', why: 'not_markdown' },
    ])
  })

  it('a link to the same page, to a file left out; empty headers; CRLF; Windows-1252 text', async () => {
    const plan = await planDocs(
      memTree(
        {
          'wiki/a.md': '---\n---\n# Alpha\r\n\r\nSee [[#Usage]], ![[pic.png]] and [[huge]].\r\nLine two.',
          'wiki/pic.png': Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 0]),
          'wiki/latin.md': Buffer.from('# Caf\xe9\n\nAu lait, \x93quoted\x94.', 'latin1'),
          'raw/n.md': 'note',
        },
        ['wiki/huge.md'],
      ),
    )
    const a = plan.pages.find((p) => p.address === 'a')
    assert.equal(a?.title, 'Alpha')
    assert.ok(!a?.body.includes('\r'))
    assert.ok(!a?.body.includes('---'))
    assert.match(a?.body ?? '', /See \[\[#Usage\]\],/)
    assert.deepEqual(plan.unresolved, [
      { from: 'a', target: 'pic.png', why: 'left_out' },
      { from: 'a', target: 'huge', why: 'left_out' },
    ])
    const latin = plan.pages.find((p) => p.address === 'latin')
    assert.equal(latin?.title, 'Café')
    assert.match(latin?.body ?? '', /Au lait, “quoted”\./)
    assert.deepEqual(plan.recoded, ['wiki/latin.md'])
  })

  it('an Obsidian vault with a raw/ folder but no wiki/ is a vault: every note is a page', async () => {
    const plan = await planDocs(memTree({ 'Note.md': '# Note', 'raw/x.md': '# X' }))
    assert.deepEqual(
      plan.pages.map((p) => p.address),
      ['note', 'raw/x'],
    )
    assert.equal(plan.notes.length, 0)
  })
})

describe('importing a documentation folder (CA14, PostgreSQL)', { skip: skipPg }, () => {
  let w: World
  let eric: { id: string; key: string }
  let web: string
  before(async () => {
    w = await world()
    eric = await w.person('Eric')
    web = await w.web(eric.id)
    await w.call(eric.key, 'POST', '/v1/brains', { slug: 'docs', name: 'Docs' })
  })
  after(async () => w.close())

  it('writes the pages with their links, the notes, the map and one line of the log, and reports it', async () => {
    const { importTree } = await import('../../src/ops/import/import.ts')
    const { principalOfSession } = await import('../helpers/principal.ts')
    const who = await principalOfSession(w, web)
    const report = await importTree({ db: w.db, clock: w.clock, who }, 'docs', await treeFromFolder(SAMPLE), {
      from: 'docs-sample',
    })
    assert.equal(report.kind, 'docs')
    assert.equal(report.pages, 5)
    assert.equal(report.entries, 4)
    assert.equal(report.ignored.length, 7)
    assert.equal(report.unresolved.length, 2)
    assert.deepEqual(report.renamed, [
      { path: 'wiki/topics/Audience Notes.md', address: 'topics/audience-notes' },
    ])
    const brain = (await w.db.one(
      "SELECT id, imported_at, imported_from FROM brains WHERE slug = 'docs'",
    )) as {
      id: string
      imported_at: Date
      imported_from: string
    }
    assert.equal(brain.imported_from, 'docs-sample')
    assert.ok(brain.imported_at)
    // Links: the mentions of the bodies (each to a page that is there) and the typed one.
    const links = await w.db.query(
      `SELECT f.address AS "from", l.kind, coalesce(t.address, l.to_address) AS "to" FROM page_links l
         JOIN pages f ON f.id = l.from_page LEFT JOIN pages t ON t.id = l.to_page
        WHERE l.brain_id = $1 ORDER BY 1, 2, 3`,
      [brain.id],
    )
    assert.deepEqual(
      links.map((l) => `${l.from} ${l.kind} ${l.to}`),
      [
        'decisions/use-postgres depends-on topics/retention',
        'guides/getting-started mentions people/ada',
        'guides/getting-started mentions topics/audience-notes',
        'guides/getting-started mentions topics/retention',
        'topics/audience-notes mentions topics/retention',
      ],
    )
    assert.equal(report.links, links.length)
    // The graph of the brain shows them connected.
    const graph = await w.callWeb(web, 'GET', '/v1/brains/docs/wiki/graph')
    assert.equal(graph.status, 200, graph.text)
    const g = graph.body as { nodes: { address: string }[]; edges: unknown[] }
    assert.equal(g.nodes.length, 5)
    assert.equal(g.edges.length, 5)
    // Every page has its first revision, written by the import.
    const revs = await w.db.query(
      `SELECT r.kind, r.revision, r.author_id FROM page_revisions r JOIN pages p ON p.id = r.page_id WHERE p.brain_id = $1`,
      [brain.id],
    )
    assert.equal(revs.length, 5)
    for (const r of revs) assert.deepEqual([r.kind, r.revision, r.author_id], ['import', 1, eric.id])
    // A page's sources: the web, and the note of raw/ it links to.
    const src = await w.db.query(
      `SELECT s.url, e.refs FROM page_sources s JOIN pages p ON p.id = s.page_id LEFT JOIN entries e ON e.id = s.entry_id
        WHERE p.address = 'decisions/use-postgres' ORDER BY s.url NULLS LAST`,
    )
    assert.deepEqual(
      src.map((s) => s.url ?? s.refs),
      ['https://www.postgresql.org/docs/', ['import:raw/notes/call.md']],
    )
    // The notes, in one closed session of the import, by the person who imported.
    const notes = await w.db.query(
      `SELECT e.type, e.title, e.refs, e.author_id, s.status FROM entries e JOIN sessions s ON s.id = e.session_id
        WHERE e.brain_id = $1 ORDER BY e.refs`,
      [brain.id],
    )
    assert.equal(notes.length, 4)
    for (const n of notes) assert.deepEqual([n.type, n.author_id, n.status], ['note', eric.id, 'closed'])
    const map = await w.db.one('SELECT map_intro FROM wiki_settings WHERE brain_id = $1', [brain.id])
    assert.match(String(map?.map_intro), /^A synthetic 02-DOCS folder/)
    // One line in the log of the wiki.
    const log = await w.db.query('SELECT kind, summary, actor_id FROM wiki_log WHERE brain_id = $1', [
      brain.id,
    ])
    assert.deepEqual(log, [
      { kind: 'import', summary: 'Imported by Eric from docs-sample', actor_id: eric.id },
    ])
    // Nothing private, no secret, anywhere it wrote.
    const dump = JSON.stringify(
      await w.db.query(
        `SELECT p.title, p.summary, p.body, p.tags FROM pages p WHERE p.brain_id = $1
         UNION ALL SELECT e.title, e.type, e.content, e.tags FROM entries e WHERE e.brain_id = $1`,
        [brain.id],
      ),
    )
    for (const s of ['Our churn by customer', 'hunter2hunter2', 'abcdefgh12345678', 'JBSWY3DPEHPK3PXP'])
      assert.ok(!dump.includes(s), s)
    // The brain's first step is done, and its activity says so.
    const ov = await w.callWeb(web, 'GET', '/v1/brains/docs/overview')
    const steps = ov.body.firstSteps as { imported: boolean; firstEntry: boolean; agentConnected: boolean }
    assert.equal(steps.imported, true)
    // The notes it brought are not an agent's first entry, nor an agent connected.
    assert.deepEqual([steps.firstEntry, steps.agentConnected], [false, false])
    w.advance(1000)
    await w.call(eric.key, 'POST', '/v1/brains/docs/entries', {
      type: 'fact',
      title: 'New',
      content: 'After.',
    })
    const after = (await w.callWeb(web, 'GET', '/v1/brains/docs/overview')).body.firstSteps as {
      firstEntry: boolean
    }
    assert.equal(after.firstEntry, true)
    const ev = await w.db.one("SELECT label, account_id FROM events WHERE kind = 'brain.imported'")
    assert.deepEqual(ev, { label: 'docs', account_id: eric.id })
  })

  it('asks again in its own transaction: a role taken away, or an entry saved, while the folder is read', async () => {
    const { importTree } = await import('../../src/ops/import/import.ts')
    const { principalOfSession } = await import('../helpers/principal.ts')
    const ada = await w.person('Ada')
    const adaWeb = await w.web(ada.id)
    const who = await principalOfSession(w, adaWeb)
    for (const [slug, meanwhile, status, code] of [
      [
        'race-role',
        (id: string) =>
          w.db.query("UPDATE memberships SET role = 'reader' WHERE brain_id = $1 AND account_id = $2", [
            id,
            ada.id,
          ]),
        403,
        'forbidden',
      ],
      [
        'race-entry',
        async () => {
          await w.call(ada.key, 'POST', '/v1/brains/race-entry/entries', {
            type: 'fact',
            title: 'Meanwhile',
            content: 'Saved.',
          })
        },
        409,
        'brain_not_empty',
      ],
    ] as const) {
      assert.equal((await w.call(ada.key, 'POST', '/v1/brains', { slug, name: slug })).status, 201)
      const id = String((await w.db.one('SELECT id FROM brains WHERE slug = $1', [slug]))?.id)
      let done = false
      const tree = {
        skipped: [],
        files: [
          {
            path: 'wiki/a.md',
            size: 3,
            tooLarge: false,
            read: async () => {
              if (!done) {
                done = true
                await meanwhile(id)
              }
              return Buffer.from('# A')
            },
          },
        ],
      }
      await assert.rejects(
        importTree({ db: w.db, clock: w.clock, who }, slug, tree, { from: 'race' }),
        (e: { status?: number; code?: string }) => {
          assert.deepEqual([e.status, e.code], [status, code], slug)
          return true
        },
      )
      const n = await w.db.one('SELECT count(*)::int AS n FROM pages WHERE brain_id = $1', [id])
      assert.equal(n?.n, 0, slug)
    }
  })
})
