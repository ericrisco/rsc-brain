// What a change would leave incoherent in the wiki (spec v0.6 «Avisos de incoherencia», CA7–CA9), worked out on
// the wiki as it would be after it: inside the caller's transaction the change is applied by the one writer of
// pages, looked at, and — for a proposal or a check — undone (a savepoint), so nothing of it stays. Warnings never
// block: blocking stays with the checks of a proposal. With them come the pages linked to what the change touches,
// for the agent to look for contradictions in meaning itself; the server judges no meaning (P2).
import type { Db, Row } from '../../db/db.ts'
import type { Ctx } from '../context.ts'
import { type ApplyMeta, applyOps } from './apply.ts'
import { LIVE, ORPHAN, WRITTEN_ABOUT_SINCE } from './health.ts'
import { nearlySame, type Op } from './model.ts'
import { settingsOf } from './pages.ts'
import { addressesOf, knownAddresses } from './proposals.ts'

export const COHERENCE_CODES = [
  'duplicate_title',
  'broken_link',
  'orphan_created',
  'stale_page',
  'open_conflict',
] as const
export type Coherence = { code: (typeof COHERENCE_CODES)[number]; message: string; addresses: string[] }

export type Neighbour = {
  address: string
  title: string
  summary: string
  type: string
  status: string
  revision: number
  // How it is linked to a page the change touches: the link's kind, and whether it goes from that page or to it.
  link: { page: string; kind: string; direction: 'out' | 'in' }
}

export type Checked = { coherence: Coherence[]; neighbours: Neighbour[] }

export const NEIGHBOURS_MAX = 20
const SIMILAR_SCAN = 2000

const NONE: Checked = { coherence: [], neighbours: [] }

// The pages linked to these ones, either way, typed links and resolved mentions alike.
const LINKED = `SELECT l.from_page AS src, coalesce(l.to_page, a.page_id) AS dst, l.kind, 'out' AS direction
                  FROM page_links l
                  LEFT JOIN page_addresses a ON l.to_page IS NULL AND a.brain_id = l.brain_id AND a.address = l.to_address
                 WHERE l.from_page = ANY($1)
                UNION ALL
                SELECT coalesce(l.to_page, a.page_id), l.from_page, l.kind, 'in'
                  FROM page_links l
                  LEFT JOIN page_addresses a ON l.to_page IS NULL AND a.brain_id = l.brain_id AND a.address = l.to_address
                 WHERE coalesce(l.to_page, a.page_id) = ANY($1)`

async function linkedIds(db: Db, ids: string[]): Promise<string[]> {
  if (ids.length === 0) return []
  const rows = await db.query<{ id: string }>(
    `SELECT DISTINCT x.dst AS id FROM (${LINKED}) x WHERE x.dst IS NOT NULL AND x.dst <> ALL($1)`,
    [ids],
  )
  return rows.map((r) => r.id)
}

const orphansAmong = async (db: Db, ids: string[]): Promise<Set<string>> =>
  new Set(
    ids.length === 0
      ? []
      : (
          await db.query<{ id: string }>(
            `SELECT p.id FROM pages p WHERE p.id = ANY($1) AND ${LIVE} AND ${ORPHAN}`,
            [ids],
          )
        ).map((r) => r.id),
  )

type Before = { known: string[]; around: string[]; orphans: Set<string>; stale: Row[] }

// What is so before the change: the pages it names, those linked to them, which of those are orphans already,
// and which of the pages it changes are stale (marked so, or written about in the journal since they changed).
async function before(db: Db, brainId: string, ops: Op[], staleDays: number, now: Date): Promise<Before> {
  const named = await knownAddresses(db, brainId, ops)
  const known = [...new Set([...named.values()].map((k) => k.pageId))]
  const around = await linkedIds(db, known)
  const changed = new Set(ops.map((o) => o.address))
  const changedIds = [...named.entries()].filter(([a]) => changed.has(a)).map(([, k]) => k.pageId)
  const cutoff = new Date(now.getTime() - staleDays * 86_400_000)
  const stale = changedIds.length
    ? await db.query(
        `SELECT p.address FROM pages p WHERE p.id = ANY($1) AND ${LIVE}
            AND (p.status = 'stale' OR (p.updated_at < $2 AND EXISTS (SELECT 1 FROM entries e WHERE ${WRITTEN_ABOUT_SINCE})))
          ORDER BY p.address`,
        [changedIds, cutoff],
      )
    : []
  return { known, around, orphans: await orphansAmong(db, [...known, ...around]), stale }
}

// What is so after it, for the pages it touched.
async function after(db: Db, brainId: string, b: Before, touched: string[]): Promise<Checked> {
  const out: Coherence[] = []
  const ids = [...new Set([...touched, ...b.known])]
  const pages = await db.query(
    `SELECT p.id, p.address, p.title FROM pages p WHERE p.id = ANY($1) AND ${LIVE}`,
    [ids],
  )
  const live = new Set(pages.map((p) => String(p.id)))
  const touchedLive = pages.filter((p) => touched.includes(String(p.id)))
  // A title almost the same as another live page's.
  const titles = await db.query(
    `SELECT p.id, p.address, p.title FROM pages p WHERE p.brain_id = $1 AND ${LIVE} ORDER BY p.address LIMIT ${SIMILAR_SCAN}`,
    [brainId],
  )
  const pairs = new Set<string>()
  for (const p of touchedLive) {
    for (const t of titles) {
      if (t.id === p.id || !nearlySame(String(p.title), String(t.title))) continue
      const key = [String(p.address), String(t.address)].sort().join(' ')
      if (pairs.has(key)) continue
      pairs.add(key)
      out.push({
        code: 'duplicate_title',
        message: `The title "${p.title}" of "${p.address}" is almost the same as that of "${t.address}" ("${t.title}"): the same subject twice?`,
        addresses: [String(p.address), String(t.address)],
      })
    }
  }
  // A [[mention]] in a touched page of an address no page has.
  const broken = await db.query(
    `SELECT p.address AS from, l.to_address AS to FROM page_links l JOIN pages p ON p.id = l.from_page
      WHERE l.from_page = ANY($1) AND l.to_address IS NOT NULL AND ${LIVE}
        AND NOT EXISTS (SELECT 1 FROM page_addresses a WHERE a.brain_id = l.brain_id AND a.address = l.to_address)
      ORDER BY p.address, l.to_address`,
    [touched],
  )
  for (const r of broken)
    out.push({
      code: 'broken_link',
      message: `"${r.from}" links to [[${r.to}]], which is no page.`,
      addresses: [String(r.from), String(r.to)],
    })
  // A page left with no link either way that was not so before (or did not exist).
  const candidates = [...new Set([...ids, ...b.around, ...(await linkedIds(db, ids))])]
  const now = await orphansAmong(db, candidates)
  const lonely = candidates.filter((id) => now.has(id) && !b.orphans.has(id))
  if (lonely.length) {
    for (const r of await db.query('SELECT address FROM pages WHERE id = ANY($1) ORDER BY address', [lonely]))
      out.push({
        code: 'orphan_created',
        message: `"${r.address}" is left with no link to or from any other page: link it where it belongs.`,
        addresses: [String(r.address)],
      })
  }
  for (const r of b.stale)
    out.push({
      code: 'stale_page',
      message: `"${r.address}" is stale: the journal says newer things about it, or a curator marked it. Check them before relying on it.`,
      addresses: [String(r.address)],
    })
  // A touched page in an open contradiction with another live page.
  const conflicts = await db.query(
    `SELECT DISTINCT p.address AS a, q.address AS b FROM page_links l
       JOIN pages p ON p.id = l.from_page JOIN pages q ON q.id = l.to_page
      WHERE l.kind = 'contradicts' AND (l.from_page = ANY($1) OR l.to_page = ANY($1))
        AND p.status IN ('current', 'stale') AND q.status IN ('current', 'stale')
      ORDER BY 1, 2`,
    [touched.filter((id) => live.has(id))],
  )
  for (const r of conflicts)
    out.push({
      code: 'open_conflict',
      message: `"${r.a}" and "${r.b}" contradict each other and nobody has settled it: settle it, or say which holds.`,
      addresses: [String(r.a), String(r.b)],
    })
  // The pages linked to what was touched: what to read for contradictions in meaning.
  const near = touched.length
    ? await db.query(
        `SELECT DISTINCT ON (n.id) n.address, n.title, n.summary, n.type, n.status, n.revision,
                s.address AS page, x.kind, x.direction
           FROM (${LINKED}) x JOIN pages n ON n.id = x.dst JOIN pages s ON s.id = x.src
          WHERE x.dst <> ALL($1) AND n.status IN ('current', 'stale')
          ORDER BY n.id, x.direction DESC, x.kind
          LIMIT ${NEIGHBOURS_MAX}`,
        [touched],
      )
    : []
  const neighbours = near
    .map((r) => ({
      address: String(r.address),
      title: String(r.title),
      summary: String(r.summary),
      type: String(r.type),
      status: String(r.status),
      revision: Number(r.revision),
      link: { page: String(r.page), kind: String(r.kind), direction: r.direction as 'out' | 'in' },
    }))
    .sort((a, c) => a.address.localeCompare(c.address))
  return { coherence: out, neighbours }
}

// The warnings and neighbours of pages as the wiki stands now, for a change applied earlier: the receipt a retry
// returns keeps no page text (a purge since must not come back through it), so they are worked out again. Nothing
// is known of before: a page with no links counts as an orphan the change left.
export async function checksNow(db: Db, brainId: string, pageIds: string[], now: Date): Promise<Checked> {
  if (pageIds.length === 0) return NONE
  const s = await settingsOf(db, brainId)
  const cutoff = new Date(now.getTime() - s.staleDays * 86_400_000)
  const stale = await db.query(
    `SELECT p.address FROM pages p WHERE p.id = ANY($1) AND ${LIVE}
        AND (p.status = 'stale' OR (p.updated_at < $2 AND EXISTS (SELECT 1 FROM entries e WHERE ${WRITTEN_ABOUT_SINCE})))
      ORDER BY p.address`,
    [pageIds, cutoff],
  )
  return after(db, brainId, { known: [], around: [], orphans: new Set(), stale }, pageIds)
}

// Applies `ops` inside the caller's transaction and returns the warnings of the result. `keep`: a direct write,
// which stays; otherwise (a proposal, a check) everything it did is undone before returning. A change that cannot
// be applied as it stands (a proposal that waits on another) brings no warnings: they are advice, never a refusal.
export async function checkChange(
  ctx: Ctx,
  db: Db,
  brainId: string,
  ops: Op[],
  o: { keep: false } | { keep: true; meta: ApplyMeta },
): Promise<Checked & { applied?: Awaited<ReturnType<typeof applyOps>> }> {
  if (ops.length === 0 || addressesOf(ops).size === 0) return NONE
  const s = await settingsOf(db, brainId)
  const b = await before(db, brainId, ops, s.staleDays, ctx.clock())
  const items = ops.map((op, index) => ({ op, index, baseReviewed: !o.keep }))
  if (o.keep) {
    const applied = await applyOps(ctx, db, brainId, items, o.meta)
    return { ...(await after(db, brainId, b, [...new Set(applied.revised.map((r) => r.pageId))])), applied }
  }
  await db.query('SAVEPOINT brain_check')
  try {
    const applied = await applyOps(ctx, db, brainId, items, { kind: 'proposal', summary: 'check' })
    return await after(db, brainId, b, [...new Set(applied.revised.map((r) => r.pageId))])
  } catch {
    return NONE
  } finally {
    await db.query('ROLLBACK TO SAVEPOINT brain_check')
    await db.query('RELEASE SAVEPOINT brain_check')
  }
}
