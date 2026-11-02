// Spec B7 «Exportar un cerebro», readable export (plan §3.5, T022), on PostgreSQL. CA11: a wiki of 20 linked
// pages, opened as a vault, resolves every [[link]] to a file that exists, by the rules of the vault (a path
// from the root, or a name alone when only one file has it; `|alias`; `#^block`), and the links between wiki
// files are the edges of GET …/wiki/graph without their kind; the nodes are its nodes. CA12: a page with two
// entries as sources links to the two journal notes that hold them, at their anchors.
import assert from 'node:assert/strict'
import { after, before, describe, it } from 'node:test'
import { type Download, download } from '../helpers/download.ts'
import { skipPg } from '../helpers/pg.ts'
import { filesOf } from '../helpers/unzip.ts'
import { type World, world } from '../helpers/world.ts'

type Graph = { nodes: [string, ...unknown[]][]; edges: [number, number, number][]; mode: string }

// Every wiki link of a markdown text that is a link (not escaped with a backslash): target, block, alias.
function linksIn(text: string): { target: string; block: string | null; raw: string }[] {
  const out: { target: string; block: string | null; raw: string }[] = []
  for (const m of text.matchAll(/(\\?)!?\[\[([^\]\n]+?)\]\]/g)) {
    if (m[1]) continue
    const inner = (m[2] as string).split('|')[0] as string
    const [target, ...rest] = inner.split('#')
    const frag = rest.join('#')
    out.push({
      target: (target as string).trim(),
      block: frag.startsWith('^') ? frag.slice(1) : null,
      raw: m[0],
    })
  }
  return out
}

// How a vault finds the file of a link: the path from the root (with or without ".md"); a bare name, the one
// file with that name. Null: it opens nothing.
function resolveIn(files: Map<string, string>, target: string): string | null {
  const withMd = target.endsWith('.md') ? target : `${target}.md`
  if (files.has(withMd)) return withMd
  if (target.includes('/')) return null
  const named = [...files.keys()].filter((f) => f.split('/').at(-1) === withMd)
  return named.length === 1 ? (named[0] as string) : null
}

describe('the readable export (CA11, CA12)', { skip: skipPg }, () => {
  let w: World
  let eric: { id: string; key: string }
  let rita: { id: string; key: string }
  let web: string
  let got: Download
  let files: Map<string, string>
  const ids: Record<string, string> = {}

  const change = async (op: Record<string, unknown>) => {
    const r = await w.callWeb(web, 'POST', '/v1/brains/vault/wiki/changes', { reason: 'Seeding.', ...op })
    assert.equal(r.status, 201, r.text)
  }
  const create = (address: string, body: string, extra: Record<string, unknown> = {}) =>
    change({
      op: 'create',
      address,
      type: 'topic',
      title: `Title of ${address}`,
      summary: `About ${address}.`,
      body,
      tags: ['seed'],
      sources: [],
      ...extra,
    })
  const entry = async (key: string, title: string, content: string) => {
    const r = await w.call(key, 'POST', '/v1/brains/vault/entries', { type: 'learning', title, content })
    assert.equal(r.status, 201, r.text)
    return String((r.body.receipt as Record<string, unknown>).entryId)
  }

  before(async () => {
    w = await world()
    eric = await w.person('Eric')
    rita = await w.person('Rita')
    await w.call(eric.key, 'POST', '/v1/brains', { slug: 'vault', name: 'Vault', purpose: 'Exporting.' })
    await w.member('vault', rita.id, 'contributor')
    web = await w.web(eric.id)
    // Two sources in two sessions (two keys), and one that is forgotten later.
    ids.one = await entry(eric.key, 'First source', 'The first source, with [[not-a-link]] inside.')
    ids.two = await entry(rita.key, 'Second source', 'The second source.')
    ids.gone = await entry(eric.key, 'Forgotten source CANARY-FORGOTTEN', 'Forget me.')
    // Text that would forge a block of another entry, or load something from elsewhere when opened.
    ids.tricky = await entry(
      eric.key,
      'Tricky text',
      'A line that ends like an anchor ^ent-forged\nA picture ![x](https://evil.example/p.png) and <img src="https://evil.example/q.png">.',
    )
    // Twenty pages in two areas, each mentioning the next; aliases; typed links; one page moved and mentioned
    // by its old address; a retired page with links both ways; a mention of nothing; text that only looks
    // like a link; a page that mentions itself.
    for (const area of ['a', 'b'])
      for (let i = 1; i <= 10; i++) {
        const next = i < 10 ? `${area}/p${i + 1}` : area === 'a' ? 'b/p1' : 'a/p1'
        await create(`${area}/p${i}`, `Page ${i} of ${area}. Next: [[${next}]].`)
      }
    await create('b/old', 'Soon retired; it points at [[a/p3]].', {
      links: [{ kind: 'related', to: 'a/p4' }],
    })
    await change({
      op: 'edit',
      address: 'a/p1',
      baseRevision: 1,
      body: 'Next: [[a/p2|the second page]]. Also [[a/p5]], [[b/old]], [[x/nothing]], [[Not An Address]] and [[a/p1]].',
      sources: [
        { entryId: ids.one },
        { entryId: ids.two },
        { url: 'https://example.com/doc', title: 'A doc' },
      ],
    })
    await change({
      op: 'edit',
      address: 'a/p2',
      baseRevision: 1,
      sources: [{ entryId: ids.gone }, { entryId: ids.one }],
    })
    await change({ op: 'move', address: 'a/p5', to: 'a/five' })
    // A page that mentions itself by an old address of its own: no link to itself, as in the graph.
    await change({ op: 'edit', address: 'a/five', baseRevision: 2, body: 'Once [[a/p5]]; next [[a/p6]].' })
    await change({ op: 'link', address: 'a/p3', kind: 'depends-on', to: 'b/p7' })
    await change({ op: 'link', address: 'b/p2', kind: 'contradicts', to: 'a/p9' })
    await change({ op: 'link', address: 'b/p9', kind: 'related', to: 'b/old' })
    await change({ op: 'status', address: 'a/p6', status: 'superseded', supersededBy: 'a/p7' })
    await change({ op: 'status', address: 'b/old', status: 'retired' })
    await change({
      op: 'create',
      address: 'decisions/pricing',
      type: 'decision',
      title: 'We price per seat',
      summary: 'Per seat.',
      body: 'Because [[a/p1]].',
      tags: [],
      sources: [],
    })
    // A source address with characters that would end the link early.
    await w.db.query(
      "UPDATE page_sources SET url = 'https://example.com/a b>c' WHERE url = 'https://example.com/doc'",
    )
    const f = await w.call(eric.key, 'POST', `/v1/entries/${ids.gone}/forget`, { reason: 'Wrong.' })
    assert.equal(f.status, 200, f.text)
    got = await download(w, { session: web }, '/v1/brains/vault/export?format=readable')
    assert.equal(got.status, 200, got.bytes.toString('utf8').slice(0, 400))
    files = filesOf(got.bytes)
  })
  after(async () => w.close())

  it('is a zip to save, named after the brain and the format', () => {
    assert.equal(got.headers.get('content-type'), 'application/zip')
    assert.match(
      String(got.headers.get('content-disposition')),
      /^attachment; filename="rsc-brain-vault-readable-\d{8}T\d{6}Z\.zip"$/,
    )
    assert.equal(got.headers.get('cache-control'), 'no-store')
    for (const f of ['README.md', 'index.md', 'decisions.md', 'log.md']) assert.ok(files.has(f), f)
    assert.ok(files.has('wiki/a/five.md'))
    assert.ok(!files.has('wiki/a/p5.md'))
    // A retired page is not a page of the graph: not in the vault either.
    assert.ok(!files.has('wiki/b/old.md'))
  })

  it('CA11: every [[link]] of the vault opens a file that exists, and every block it names', () => {
    const broken: string[] = []
    let count = 0
    for (const [name, text] of files) {
      if (!name.endsWith('.md')) continue
      for (const l of linksIn(text)) {
        count += 1
        const to = resolveIn(files, l.target)
        if (!to) broken.push(`${name}: ${l.raw}`)
        else if (l.block && !new RegExp(`(^|[^\\\\])\\^${l.block}\\s*$`, 'm').test(files.get(to) as string))
          broken.push(`${name}: ${l.raw} (no block ^${l.block})`)
      }
    }
    assert.deepEqual(broken, [])
    assert.ok(count > 40, `only ${count} links`)
  })

  it('CA11: the links between wiki files are the edges of the graph, and the files are its nodes', async () => {
    const r = await w.call(eric.key, 'GET', '/v1/brains/vault/wiki/graph')
    const g = r.body as unknown as Graph
    assert.equal(g.mode, 'pages')
    const nodes = g.nodes.map((n) => n[0]).sort()
    const edges = [...new Set(g.edges.map(([i, j]) => `${g.nodes[i]?.[0]} -> ${g.nodes[j]?.[0]}`))].sort()
    const addressOf = (file: string) => file.replace(/^wiki\//, '').replace(/\.md$/, '')
    const wikiFiles = [...files.keys()].filter((f) => f.startsWith('wiki/'))
    assert.deepEqual(wikiFiles.map(addressOf).sort(), nodes)
    const vaultEdges = new Set<string>()
    for (const f of wikiFiles)
      for (const l of linksIn(files.get(f) as string)) {
        const to = resolveIn(files, l.target)
        if (to?.startsWith('wiki/') && to !== f) vaultEdges.add(`${addressOf(f)} -> ${addressOf(to)}`)
      }
    assert.deepEqual([...vaultEdges].sort(), edges)
    // The old address still leads to the moved page; typed links count as edges; the retired page none.
    assert.ok(edges.includes('a/p4 -> a/five'))
    assert.ok(edges.includes('a/p3 -> b/p7'))
    assert.ok(!edges.some((e) => e.includes('b/old')))
  })

  it('CA11: a page carries its type, status, tags, summary and typed links in its header', () => {
    const p3 = files.get('wiki/a/p3.md') as string
    assert.match(p3, /^---\n/)
    assert.match(p3, /\ntype: "topic"\n/)
    assert.match(p3, /\nstatus: "current"\n/)
    assert.match(p3, /\ntags: \["seed"\]\n/)
    assert.match(p3, /\nsummary: "About a\/p3\."\n/)
    assert.match(p3, /\ndepends-on: \["\[\[wiki\/b\/p7\]\]"\]\n/)
    assert.match(files.get('wiki/a/p6.md') as string, /\nstatus: "superseded"\n/)
    assert.match(files.get('wiki/b/p2.md') as string, /\ncontradicts: \["\[\[wiki\/a\/p9\]\]"\]\n/)
  })

  it('keeps the words of a link and leaves text that leads nowhere as text', () => {
    const p1 = files.get('wiki/a/p1.md') as string
    assert.ok(p1.includes('[[wiki/a/p2|the second page]]'), p1)
    assert.ok(p1.includes('[[wiki/a/five|a/p5]]'), p1)
    // A mention of nothing, of a retired page, of itself, or text that is not an address: plain.
    for (const plain of ['x/nothing', 'b/old', 'Not An Address', 'a/p1'])
      assert.ok(p1.includes(`\\[\\[${plain}]]`), `${plain} in ${p1}`)
    assert.ok((files.get('wiki/a/five.md') as string).includes('\\[\\[a/p5]]'))
    // Text in a journal note that looks like a link does not become one either.
    const notes = [...files].filter(([n]) => n.startsWith('raw/journal/')).map(([, t]) => t)
    assert.ok(notes.some((t) => t.includes('\\[\\[not-a-link]]')))
  })

  it('CA12: a page with two entries as sources links to the two journal notes, at their anchors', () => {
    const p1 = files.get('wiki/a/p1.md') as string
    const sources = /\nsources: \[(.*)\]\n/.exec(p1)?.[1] ?? ''
    const anchors = [ids.one, ids.two].map((id) => `^${String(id).replace(/_/g, '-')}`)
    const notes = new Set<string>()
    for (const a of anchors) {
      const m = new RegExp(`\\[\\[(raw/journal/\\d{4}/\\d{2}/[^\\]#|]+)#\\${a}\\]\\]`).exec(sources)
      assert.ok(m, `${a} in ${sources}`)
      const note = files.get(`${m[1]}.md`)
      assert.ok(note, `${m[1]}.md`)
      assert.match(note as string, new RegExp(`\\${a}\\s*$`, 'm'))
      notes.add(m[1] as string)
    }
    // Two sessions (two keys): two notes.
    assert.equal(notes.size, 2)
    assert.ok(sources.includes('https://example.com/a b>c'))
    assert.match(p1, /\n## Sources\n/)
  })

  it('text of an entry cannot forge an anchor or load anything from elsewhere (review of PR31)', () => {
    const notes = [...files]
      .filter(([n]) => n.startsWith('raw/journal/'))
      .map(([, t]) => t)
      .join('\n')
    assert.ok(notes.includes('\\^ent-forged'))
    assert.doesNotMatch(notes, /(^|[^\\])\^ent-forged\s*$/m)
    assert.ok(notes.includes('\\![x](https://evil.example/p.png)'))
    assert.doesNotMatch(notes, /(^|[^\\])!\[/m)
    assert.ok(notes.includes('&lt;img src='))
    assert.doesNotMatch(notes, /<img/)
  })

  it('a source address keeps its link whole (review of PR31)', () => {
    assert.ok((files.get('wiki/a/p1.md') as string).includes('(<https://example.com/a%20b%3Ec>)'))
  })

  it('leaves forgotten entries out of the journal and out of the sources', () => {
    const all = [...files.values()].join('\n')
    assert.ok(!all.includes('CANARY-FORGOTTEN'))
    assert.ok(!all.includes(String(ids.gone).replace(/_/g, '-')))
    assert.ok(!all.includes(String(ids.gone)))
    assert.match(files.get('wiki/a/p2.md') as string, /1 source is not in this export/)
  })

  it('has an index of every page, the decisions and the log, each linking to the pages', () => {
    const index = files.get('index.md') as string
    for (const f of [...files.keys()].filter((x) => x.startsWith('wiki/')))
      assert.ok(index.includes(`[[${f.replace(/\.md$/, '')}|`), f)
    assert.match(files.get('decisions.md') as string, /\[\[wiki\/decisions\/pricing\|We price per seat\]\]/)
    assert.match(files.get('log.md') as string, /Seeding\./)
    assert.match(files.get('README.md') as string, /raw\/journal/)
  })
})
