// Review round 3 of T005–T008 (W3): an undo, whole or by parts, is the exact inverse of what its undone parts did, and
// never touches what a later write did. A seeded generator draws, for each seed, a change of edit, link, unlink, merge,
// move and status operations; later writes from pages outside it (link, unlink, retire, move); then a whole or partial
// undo. The invariant, link by link (from page, kind, to page, by id):
//   - a link a later write made or took away is as the later write left it; a page a later write retired gets no link
//     back (a link the change gave it may still go);
//   - a link out of a page whose part is undone is as before the change;
//   - a link into a page whose part is undone, from a page outside the change, is as before the change;
//   - every other link is as it was right before the undo.
// Spec learning-memory A2, CA-A10.
import assert from 'node:assert/strict'
import { after, before, describe, it } from 'node:test'
import { skipPg } from '../helpers/pg.ts'
import { type World, world } from '../helpers/world.ts'

type Json = Record<string, unknown>
const SEEDS = 60
const KINDS = ['related', 'depends-on', 'example-of']

describe('undo by property (review round 3, W3)', { skip: skipPg }, () => {
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
  const snapshot = async () =>
    new Set(
      (
        await w.db.query<{ f: string; k: string; t: string }>(
          'SELECT from_page AS f, kind AS k, to_page AS t FROM page_links WHERE brain_id = $1 AND to_page IS NOT NULL',
          [brainId],
        )
      ).map((l) => `${l.f}|${l.k}|${l.t}`),
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

  it(`${SEEDS} seeds: every later write survives; what only undone parts touched is as before`, async () => {
    let applied = 0
    for (let seed = 1; seed <= SEEDS; seed++) {
      // mulberry32: every draw uses all the bits (a plain LCG's low bits repeat, and some operations never came up).
      let state = seed * 7919
      const rnd = (n: number) => {
        state = (state + 0x6d2b79f5) | 0
        let t = Math.imul(state ^ (state >>> 15), 1 | state)
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
        return ((t ^ (t >>> 14)) >>> 0) % n
      }
      const pick = <T>(xs: T[]): T => xs[rnd(xs.length)] as T
      // A minute per seed, on the test's clock: the requests stay under the per-minute limit of a key.
      w.advance(61_000)
      const at = `s${seed}`
      const P = [0, 1, 2, 3, 4].map((i) => `${at}/p${i}`)
      const R = [0, 1, 2].map((i) => `${at}/r${i}`)
      // The wiki before: pages with links among them, drawn at random.
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
      for (const a of [...P, ...R].filter((x) => R.includes(x) || rnd(2) === 0))
        for (const to of [...P, ...R].filter((t) => t !== a && rnd(3) === 0))
          await byWeb({ op: 'link', address: a, kind: pick(KINDS), to, reason: 'Plant.' })
      // The change: one to three operations, each on pages of its own.
      const free = [...P]
      const take = () => free.splice(rnd(free.length), 1)[0] as string
      const ops: Json[] = []
      const n = 1 + rnd(3)
      // Pages an earlier operation of the change kept (not merged away): a link of the change points at them most often,
      // so a partial undo meets a part that stays linking into a part that goes (W1).
      const kept: string[] = []
      for (let i = 0; i < n && free.length > 0; i++) {
        const kind = pick(['edit', 'link', 'unlink', 'merge', 'move', 'status'])
        const a = take()
        const into = kept.filter((x) => x !== a)
        if (kind !== 'move') kept.push(a)
        const revision = Number(
          (await w.db.one<{ r: number }>('SELECT revision AS r FROM pages WHERE id = $1', [await idOf(a)]))
            ?.r,
        )
        if (kind === 'edit')
          ops.push({
            op: 'edit',
            address: a,
            baseRevision: revision,
            body: `Agent words on ${a}.`,
            reason: 'R.',
          })
        // A link to another page of the change or outside it.
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
            `SELECT l.kind, a.address AS to FROM page_links l JOIN pages a ON a.id = l.to_page
              WHERE l.from_page = $1 AND l.kind <> 'mentions' ORDER BY a.address, l.kind`,
            [await idOf(a)],
          )
          if (out.length) ops.push({ op: 'unlink', address: a, ...pick(out), reason: 'R.' })
          else
            ops.push({
              op: 'edit',
              address: a,
              baseRevision: revision,
              body: `Agent words on ${a}.`,
              reason: 'R.',
            })
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
      const s0 = await snapshot()
      const c = await w.call(cole.key, 'POST', '/v1/brains/up/proposals', {
        title: `Seed ${seed}`,
        ops,
        sources: [{ entryId: source }],
      })
      // A drawn change that does not hold together (a link to a page merged away in it) is refused whole: next seed.
      if (c.status !== 201 || c.body.status !== 'applied') continue
      applied += 1
      const change = String(c.body.undo)
      const s1 = await snapshot()
      const changed = new Set(
        (
          await w.db.query<{ id: string }>(
            'SELECT page_id AS id FROM wiki_change_parts WHERE change_id = $1',
            [change],
          )
        ).map((x) => x.id),
      )
      // Later writes, only from pages outside the change, each on a link of its own.
      const touched = new Set<string>()
      const retired = new Set<string>()
      const live = [...R]
      for (let i = 0; i < 2 + rnd(3) && live.length > 0; i++) {
        const r = pick(live)
        const rid = await idOf(r)
        const what = pick(['link', 'link', 'unlink', 'unlink', 'retire', 'move'])
        if (what === 'retire') {
          await byWeb({ op: 'status', address: r, status: 'retired', reason: 'Later.' })
          retired.add(rid)
          live.splice(live.indexOf(r), 1)
        } else if (what === 'move') {
          const to = `${r}-later`
          await byWeb({ op: 'move', address: r, to, reason: 'Later.' })
          live[live.indexOf(r)] = to
        } else {
          const targets = await w.db.query<{ id: string; address: string }>(
            `SELECT id, address FROM pages WHERE brain_id = $1 AND address LIKE $2 AND status <> 'retired' AND id <> $3 ORDER BY address`,
            [brainId, `${at}/%`, rid],
          )
          const now = await snapshot()
          const options = targets.flatMap((t) =>
            KINDS.map((k) => ({ t, k, key: `${rid}|${k}|${t.id}` })).filter(
              (o) => !touched.has(o.key) && now.has(o.key) === (what === 'unlink'),
            ),
          )
          if (!options.length) continue
          // Mostly on links into the pages of the change, where an undo could reach.
          const near = options.filter((o) => changed.has(o.t.id))
          const o = near.length && rnd(3) > 0 ? pick(near) : pick(options)
          await byWeb({ op: what, address: r, kind: o.k, to: o.t.address, reason: 'Later.' })
          touched.add(o.key)
        }
      }
      const s2 = await snapshot()
      // Whole or by parts; parts another part needs come along.
      const parts = (
        (await w.callWeb(coraWeb, 'GET', `/v1/wiki/changes/${change}`)).body.parts as Array<{
          part: number
          address: string
        }>
      ).sort((a, b) => a.part - b.part)
      let chosen =
        rnd(2) === 0 ? parts.map((p) => p.part) : parts.filter(() => rnd(2) === 0).map((p) => p.part)
      if (chosen.length === 0) chosen = [(parts[0] as { part: number }).part]
      let r = await w.callWeb(coraWeb, 'POST', `/v1/wiki/changes/${change}/undo`, { parts: chosen })
      while (r.status === 400 && r.body.error?.code === 'missing_dependencies') {
        const more = ((r.body.error as { problems?: Array<{ part: number }> }).problems ?? []).map(
          (m) => m.part,
        )
        chosen = [...new Set([...chosen, ...more])]
        r = await w.callWeb(coraWeb, 'POST', `/v1/wiki/changes/${change}/undo`, { parts: chosen })
      }
      assert.equal(r.status, 200, `seed ${seed}: ${r.text}`)
      const detail = (await w.callWeb(coraWeb, 'GET', `/v1/wiki/changes/${change}`)).body.parts as Array<{
        part: number
        state: string
      }>
      const pageOf = async (part: number) =>
        String(
          (
            await w.db.one<{ id: string }>(
              'SELECT page_id AS id FROM wiki_change_parts WHERE change_id = $1 AND part = $2',
              [change, part],
            )
          )?.id,
        )
      const undone = new Set<string>()
      const staying = new Set<string>()
      for (const p of detail) (p.state === 'undone' ? undone : staying).add(await pageOf(p.part))
      const s3 = await snapshot()
      const wrong: string[] = []
      const names = new Map<string, string>()
      const named = (k: string) =>
        k
          .split('|')
          .map((x) => names.get(x) ?? x)
          .join(' ')
      for (const key of new Set([...s0, ...s1, ...s2, ...s3])) {
        const [f, , t] = key.split('|') as [string, string, string]
        // A link out of an undone page into a page whose part stays (a merge there may hold the address it named) goes
        // where that address points now: not checked here.
        if (undone.has(f) && staying.has(t) && !touched.has(key)) continue
        const want =
          touched.has(key) || (retired.has(f) && !s2.has(key))
            ? s2.has(key)
            : undone.has(f)
              ? s0.has(key)
              : staying.has(f)
                ? s2.has(key)
                : undone.has(t)
                  ? s0.has(key)
                  : s2.has(key)
        if (s3.has(key) !== want && names.size === 0)
          for (const r of await w.db.query<{ id: string; address: string }>(
            "SELECT p.id, string_agg(a.address, ',') AS address FROM pages p JOIN page_addresses a ON a.page_id = p.id WHERE p.brain_id = $1 GROUP BY p.id",
            [brainId],
          ))
            names.set(r.id, r.address)
        if (s3.has(key) !== want)
          wrong.push(
            `${named(key)} [${[s0, s1, s2, s3].map((x) => (x.has(key) ? 1 : 0)).join('')}${touched.has(key) ? ' touched' : ''}]: ${s3.has(key) ? 'there' : 'missing'}, want ${want ? 'there' : 'missing'}`,
          )
      }
      assert.deepEqual(wrong, [], `seed ${seed}, ops ${JSON.stringify(ops)}, undone ${chosen}`)
    }
    assert.ok(applied >= SEEDS / 2, `only ${applied} of ${SEEDS} drawn changes applied`)
  })
})
