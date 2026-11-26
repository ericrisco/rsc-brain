// The undo rule by property (replanteo of CA-A10 after the closing review, decisions.md 2026-11-26): an undo detects,
// never merges. A seeded generator draws, per seed, a wiki, a change of edit, link, unlink, merge, move and status
// operations, later writes (links, unlinks, retiring and moving pages outside the change, and sometimes an edit or a link
// from a page of the change), then an undo of all of it or of some parts. Whatever is drawn, one of two things holds:
//   - 409 undo_conflict, and the whole wiki (pages, links, addresses, revisions, the log, the changes) is byte-identical
//     to before the call; or
//   - 200, every page undone is as it was before the change (its text, type, tags, status, what supersedes it, its
//     address and addresses, its links out, the links into it from pages outside the change; a page the change created
//     is retired with no address or link), and no page outside the change was written. Its links out are as its revision
//     named them, so a link to a page whose own part stays applied (a merge that stays) goes to whoever holds that address.
// 60 seeds by default (a minute of test time); UNDO_PROPERTY_SEEDS=1000 for the long run the ledger records. Spec
// learning-memory A2, CA-A10.
import assert from 'node:assert/strict'
import { after, before, describe, it } from 'node:test'
import { skipPg } from '../helpers/pg.ts'
import { type World, world } from '../helpers/world.ts'

type Json = Record<string, unknown>
const SEEDS = Number(process.env.UNDO_PROPERTY_SEEDS ?? 60)
const KINDS = ['related', 'depends-on', 'example-of']

describe('undo by property: detect, never merge (replanteo of CA-A10)', { skip: skipPg }, () => {
  let w: World
  let cora: { id: string; key: string }
  let cole: { id: string; key: string }
  let coraWeb: string
  let source: string
  let brainId: string

  const byWeb = async (op: Json) => {
    const r = await w.callWeb(coraWeb, 'POST', '/v1/brains/up/wiki/changes', op)
    assert.ok(r.status < 300, `${JSON.stringify(op)} → ${r.text}`)
    return r
  }
  const idOf = async (address: string) =>
    String(
      (
        await w.db.one<{ id: string }>(
          'SELECT page_id AS id FROM page_addresses WHERE brain_id = $1 AND address = $2',
          [brainId, address],
        )
      )?.id,
    )
  // The whole wiki of the brain, as text: what a refused undo must leave byte-identical.
  const wholeWiki = async () =>
    JSON.stringify(
      await Promise.all(
        [
          'SELECT * FROM pages WHERE brain_id = $1 ORDER BY id',
          'SELECT from_page, kind, to_page, to_address FROM page_links WHERE brain_id = $1 ORDER BY 1, 2, 3, 4',
          'SELECT address, page_id FROM page_addresses WHERE brain_id = $1 ORDER BY 1',
          'SELECT r.page_id, r.revision FROM page_revisions r JOIN pages p ON p.id = r.page_id WHERE p.brain_id = $1 ORDER BY 1, 2',
          'SELECT id FROM wiki_log WHERE brain_id = $1 ORDER BY id',
          `SELECT c.id, c.state, x.part, x.state AS part_state FROM wiki_changes c JOIN wiki_change_parts x ON x.change_id = c.id
            WHERE c.brain_id = $1 ORDER BY 1, 3`,
        ].map((q) => w.db.query(q, [brainId])),
      ),
    )
  // A page's own state, and the links around it, by id.
  type Own = { row: string; addresses: string[]; out: string[] }
  const ownState = async (id: string): Promise<Own | null> => {
    const p = await w.db.one<Json>(
      'SELECT type, title, summary, body, tags, status, superseded_by, address FROM pages WHERE id = $1',
      [id],
    )
    if (!p) return null
    const addresses = (
      await w.db.query<{ address: string }>(
        'SELECT address FROM page_addresses WHERE page_id = $1 ORDER BY 1',
        [id],
      )
    ).map((a) => a.address)
    const out = (
      await w.db.query<{ k: string }>(
        `SELECT kind || ' ' || coalesce(to_page, '@' || to_address) AS k FROM page_links WHERE from_page = $1 ORDER BY 1`,
        [id],
      )
    ).map((l) => l.k)
    return { row: JSON.stringify(p), addresses, out }
  }
  const linksInto = async (id: string) =>
    (
      await w.db.query<{ k: string }>(
        "SELECT from_page || ' ' || kind AS k FROM page_links WHERE to_page = $1 ORDER BY 1",
        [id],
      )
    ).map((l) => l.k)
  const pagesOf = async () =>
    new Map(
      (
        await w.db.query<{ id: string; revision: number; status: string; address: string }>(
          'SELECT id, revision, status, address FROM pages WHERE brain_id = $1',
          [brainId],
        )
      ).map((p) => [p.id, `${p.revision} ${p.status} ${p.address}`]),
    )

  before(async () => {
    w = await world()
    cora = await w.person('Cora')
    cole = await w.person('Cole')
    await w.call(cora.key, 'POST', '/v1/brains', { slug: 'up', purpose: 'Undo by property.' })
    await w.member('up', cole.id, 'contributor')
    coraWeb = await w.web(cora.id)
    const e = await w.call(cole.key, 'POST', '/v1/brains/up/entries', {
      type: 'learning',
      title: 'S',
      content: 'S.',
    })
    source = (e.body.receipt as { entryId: string }).entryId
    brainId = String((await w.db.one<{ id: string }>("SELECT id FROM brains WHERE slug = 'up'"))?.id)
  })
  after(async () => w.close())

  it(`${SEEDS} seeds: either a refused undo that changed nothing, or every undone page as before the change`, async () => {
    let applied = 0
    let ok200 = 0
    let ok409 = 0
    for (let seed = 1; seed <= SEEDS; seed++) {
      // mulberry32: every draw uses all the bits.
      let state = seed * 7919
      const rnd = (n: number) => {
        state = (state + 0x6d2b79f5) | 0
        let t = Math.imul(state ^ (state >>> 15), 1 | state)
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
        return ((t ^ (t >>> 14)) >>> 0) % n
      }
      const pick = <T>(xs: T[]): T => xs[rnd(xs.length)] as T
      // A minute per seed on the test's clock: the requests stay under the per-minute limit of a key.
      w.advance(61_000)
      const at = `s${seed}`
      const P = [0, 1, 2, 3, 4].map((i) => `${at}/p${i}`)
      const R = [0, 1, 2].map((i) => `${at}/r${i}`)
      for (const a of [...P, ...R])
        await byWeb({
          op: 'create',
          address: a,
          type: 'topic',
          title: a,
          summary: a,
          body: a,
          reason: 'Plant.',
        })
      for (const a of [...P, ...R])
        for (const to of [...P, ...R].filter((t) => t !== a && rnd(4) === 0))
          await byWeb({ op: 'link', address: a, kind: pick(KINDS), to, reason: 'Plant.' })
      // The change: one to three operations, each on pages of its own.
      const free = [...P]
      const take = () => free.splice(rnd(free.length), 1)[0] as string
      const ops: Json[] = []
      const kept: string[] = []
      for (let i = 0, n = 1 + rnd(3); i < n && free.length > 0; i++) {
        const kind = pick(['edit', 'link', 'unlink', 'merge', 'move', 'status'])
        const a = take()
        const into = kept.filter((x) => x !== a)
        if (kind !== 'move') kept.push(a)
        const revision = Number(
          (await w.db.one<{ r: number }>('SELECT revision AS r FROM pages WHERE id = $1', [await idOf(a)]))
            ?.r,
        )
        const edit = {
          op: 'edit',
          address: a,
          baseRevision: revision,
          body: `Agent words on ${a}.`,
          reason: 'R.',
        }
        if (kind === 'edit') ops.push(edit)
        else if (kind === 'link')
          ops.push({
            op: 'link',
            address: a,
            kind: pick(KINDS),
            to: into.length && rnd(3) > 0 ? pick(into) : pick([...P, ...R].filter((x) => x !== a)),
            reason: 'R.',
          })
        else if (kind === 'unlink') {
          const out = await w.db.query<{ kind: string; to: string }>(
            `SELECT l.kind, t.address AS to FROM page_links l JOIN pages t ON t.id = l.to_page
              WHERE l.from_page = $1 AND l.kind <> 'mentions' ORDER BY t.address, l.kind`,
            [await idOf(a)],
          )
          ops.push(out.length ? { op: 'unlink', address: a, ...pick(out), reason: 'R.' } : edit)
        } else if (kind === 'merge' && free.length > 0) {
          const from = take()
          ops.push({
            op: 'merge',
            address: a,
            from,
            body: 'Both.',
            dropSources: [],
            dropLinks: [],
            reason: 'Same.',
          })
        } else if (kind === 'move') ops.push({ op: 'move', address: a, to: `${a}-moved`, reason: 'R.' })
        else ops.push({ op: 'status', address: a, status: 'stale', reason: 'R.' })
      }
      // Before the change, by page id.
      const ids = await Promise.all([...P, ...R].map(idOf))
      const before = new Map<string, { own: Own | null; into: string[] }>()
      for (const id of ids) before.set(id, { own: await ownState(id), into: await linksInto(id) })
      const c = await w.call(cole.key, 'POST', '/v1/brains/up/proposals', {
        title: `Seed ${seed}`,
        ops,
        sources: [{ entryId: source }],
      })
      // A drawn change that does not hold together is refused whole by the server: next seed.
      if (c.status !== 201 || c.body.status !== 'applied') continue
      applied += 1
      const change = String(c.body.undo)
      const parts = (
        (await w.callWeb(coraWeb, 'GET', `/v1/wiki/changes/${change}`)).body.parts as Array<{
          part: number
          address: string
        }>
      ).sort((a, b) => a.part - b.part)
      const partPage = new Map<number, string>()
      for (const p of parts)
        partPage.set(
          p.part,
          String(
            (
              await w.db.one<{ id: string }>(
                'SELECT page_id AS id FROM wiki_change_parts WHERE change_id = $1 AND part = $2',
                [change, p.part],
              )
            )?.id,
          ),
        )
      const changed = new Set(partPage.values())
      // Later writes: links and unlinks, retiring and moving pages outside the change; sometimes a write on one of its pages.
      for (let i = 0, n = rnd(4); i < n; i++) {
        const what = pick([
          'link',
          'link',
          'unlink',
          'retire',
          'move',
          'edit-changed',
          'link-changed',
          'none',
          'none',
        ])
        const live = await w.db.query<{ id: string; address: string; revision: number }>(
          `SELECT id, address, revision FROM pages WHERE brain_id = $1 AND address LIKE $2 AND status NOT IN ('retired', 'superseded')
            ORDER BY address`,
          [brainId, `${at}/%`],
        )
        const outside = live.filter((p) => !changed.has(p.id))
        const inside = live.filter((p) => changed.has(p.id))
        if (what === 'none') continue
        if (what === 'retire' && outside.length) {
          await byWeb({ op: 'status', address: pick(outside).address, status: 'retired', reason: 'Later.' })
        } else if (what === 'move' && outside.length) {
          const r = pick(outside)
          await byWeb({ op: 'move', address: r.address, to: `${r.address}-later${i}`, reason: 'Later.' })
        } else if (what === 'edit-changed' && inside.length) {
          const p = pick(inside)
          await byWeb({
            op: 'edit',
            address: p.address,
            baseRevision: Number(p.revision),
            body: 'A person.',
            reason: 'Later.',
          })
        } else if ((what === 'link' || what === 'link-changed' || what === 'unlink') && live.length > 1) {
          const from =
            what === 'link-changed' && inside.length
              ? pick(inside)
              : outside.length
                ? pick(outside)
                : pick(live)
          const out = await w.db.query<{ kind: string; to: string }>(
            `SELECT l.kind, t.address AS to FROM page_links l JOIN pages t ON t.id = l.to_page
              WHERE l.from_page = $1 AND l.kind <> 'mentions' AND t.status <> 'retired' ORDER BY t.address, l.kind`,
            [from.id],
          )
          if (what === 'unlink' && out.length)
            await byWeb({ op: 'unlink', address: from.address, ...pick(out), reason: 'Later.' })
          else {
            const to = pick(live.filter((p) => p.id !== from.id))
            const kind = pick(KINDS)
            if (!out.some((l) => l.to === to.address && l.kind === kind))
              await byWeb({ op: 'link', address: from.address, kind, to: to.address, reason: 'Later.' })
          }
        }
      }
      // Whole or by parts; parts another part needs come along.
      let chosen =
        rnd(2) === 0 ? parts.map((p) => p.part) : parts.filter(() => rnd(2) === 0).map((p) => p.part)
      if (chosen.length === 0) chosen = [(parts[0] as { part: number }).part]
      let wikiBefore = await wholeWiki()
      let pagesBefore = await pagesOf()
      let r = await w.callWeb(coraWeb, 'POST', `/v1/wiki/changes/${change}/undo`, { parts: chosen })
      while (r.status === 400 && r.body.error?.code === 'missing_dependencies') {
        const more = ((r.body.error as { problems?: Array<{ part: number }> }).problems ?? []).map(
          (m) => m.part,
        )
        chosen = [...new Set([...chosen, ...more])]
        wikiBefore = await wholeWiki()
        pagesBefore = await pagesOf()
        r = await w.callWeb(coraWeb, 'POST', `/v1/wiki/changes/${change}/undo`, { parts: chosen })
      }
      const where = `seed ${seed}, ops ${JSON.stringify(ops)}, parts ${chosen}`
      if (r.status === 409) {
        assert.equal(r.body.error?.code, 'undo_conflict', where)
        assert.equal(await wholeWiki(), wikiBefore, `${where}: a refused undo changed the wiki`)
        ok409 += 1
        continue
      }
      assert.equal(r.status, 200, `${where}: ${r.text}`)
      ok200 += 1
      const undone = new Set(chosen.map((n) => partPage.get(n) as string))
      for (const id of undone) {
        const was = before.get(id)
        const now = await ownState(id)
        if (!was?.own) {
          // A page the change created: retired, with no address and no link.
          assert.equal(JSON.parse(now?.row ?? '{}').status, 'retired', `${where}: created page ${id}`)
          assert.deepEqual([now?.addresses, now?.out], [[], []], `${where}: created page ${id}`)
          continue
        }
        assert.equal(now?.row, was.own.row, `${where}: page ${id} is not as before`)
        assert.deepEqual(now?.addresses, was.own.addresses, `${where}: addresses of ${id}`)
        // Links out go back as the revision named them: to whoever holds that address now. For a target whose part stays
        // applied (a merge that stays gave its address to another page) that is the page holding it; for any other, the same page.
        const resolved: string[] = []
        for (const k of was.own.out) {
          const [kind, target] = k.split(' ') as [string, string]
          const t = before.get(target)?.own
          if (!target.startsWith('@') && changed.has(target) && !undone.has(target) && t) {
            const holder = await w.db.one<{ id: string }>(
              'SELECT page_id AS id FROM page_addresses WHERE brain_id = $1 AND address = $2',
              [brainId, JSON.parse(t.row).address],
            )
            resolved.push(`${kind} ${holder?.id ?? target}`)
          } else resolved.push(k)
        }
        assert.deepEqual(now?.out, [...new Set(resolved)].sort(), `${where}: links out of ${id}`)
        const fromOutside = (xs: string[]) => xs.filter((k) => !changed.has(k.split(' ')[0] as string))
        assert.deepEqual(
          fromOutside(await linksInto(id)),
          fromOutside(was.into),
          `${where}: links into ${id}`,
        )
      }
      const pagesAfter = await pagesOf()
      for (const [id, v] of pagesBefore)
        if (!changed.has(id))
          assert.equal(pagesAfter.get(id), v, `${where}: page ${id} outside the change was written`)
    }
    assert.ok(applied >= SEEDS / 2, `only ${applied} of ${SEEDS} drawn changes applied`)
    assert.ok(ok200 > SEEDS / 10 && ok409 > SEEDS / 20, `200: ${ok200}, 409: ${ok409}`)
    process.stdout.write(
      `# undo property: ${SEEDS} seeds, ${applied} applied, ${ok200} undone, ${ok409} refused\n`,
    )
  })
})
