// The wiki checks itself, without AI (spec B2 «Salud de la wiki»): orphan pages, broken links, open
// contradictions, stale pages the journal keeps mentioning, sources no longer available, pages that grew
// too long and titles that are almost the same. Retired and superseded pages are history, not health.
// And the daily cleanup (spec v0.6 «Limpieza diaria», replacing the nudge every so many approvals): when no
// maintenance pass was approved or written in the last 24 hours, none waits for approval and the health has
// problems, a cleanup is suggested — to an agent at the start of its session, and on the health screen.
import { can, type Role } from '../../auth/can.ts'
import { actorOf } from '../../auth/principal.ts'
import type { Db } from '../../db/db.ts'
import { type Brain, type Ctx, inBrain } from '../context.ts'
import { nearlySame } from './model.ts'
import { settingsOf } from './pages.ts'

type Ref = { address: string; title: string }

export type Health = {
  orphans: Ref[]
  broken: { from: string; fromTitle: string; to: string }[]
  conflicts: { a: string; aTitle: string; b: string; bTitle: string }[]
  stale: (Ref & { updatedAt: string; newEntries: number })[]
  unavailableSources: { address: string; title: string; entryId: string; state: 'forgotten' | 'purged' }[]
  long: (Ref & { chars: number })[]
  similarTitles: { a: string; aTitle: string; b: string; bTitle: string }[]
  // `suggested`: a cleanup is due (v0.6). `lastAt`: the last one approved or written; `pending`: one waits for
  // approval. `approvalsSince` and `every` are kept for API v1 and no longer decide anything.
  maintenance: {
    suggested: boolean
    lastAt: string | null
    pending: boolean
    approvalsSince: number
    every: number
  }
}

export const CLEANUP_AFTER_MS = 24 * 3_600_000
const LISTS = [
  'orphans',
  'broken',
  'conflicts',
  'stale',
  'unavailableSources',
  'long',
  'similarTitles',
] as const
type ListName = (typeof LISTS)[number]

export const problemCounts = (h: Health): Record<ListName, number> =>
  Object.fromEntries(LISTS.map((k) => [k, h[k].length])) as Record<ListName, number>

// The last cleanup of a brain (an approved maintenance proposal or a maintenance write), and whether one waits.
async function cleanups(db: Db, brainId: string): Promise<{ lastAt: Date | null; pending: boolean }> {
  const r = await db.one<{ at: Date | null; pending: boolean }>(
    `SELECT (SELECT max(at) FROM wiki_log WHERE brain_id = $1 AND maintenance) AS at,
            EXISTS (SELECT 1 FROM proposals WHERE brain_id = $1 AND maintenance AND status = 'pending') AS pending`,
    [brainId],
  )
  return { lastAt: r?.at ?? null, pending: Boolean(r?.pending) }
}

const dueAt = (c: { lastAt: Date | null; pending: boolean }, now: Date) =>
  !c.pending && (c.lastAt === null || now.getTime() - c.lastAt.getTime() > CLEANUP_AFTER_MS)

export const LIVE = "p.status IN ('current', 'stale')"

// A page `p` no link reaches and whose links reach no other page. A link counts if it reaches a page: typed links
// always do; mentions when their address resolves. Shared with the warnings of a change (coherence.ts).
export const ORPHAN = `NOT EXISTS (SELECT 1 FROM page_links l WHERE l.from_page = p.id
              AND (l.to_page IS NOT NULL OR EXISTS (SELECT 1 FROM page_addresses a
                   WHERE a.brain_id = l.brain_id AND a.address = l.to_address AND a.page_id <> p.id)))
        AND NOT EXISTS (SELECT 1 FROM page_links l WHERE l.to_page = p.id AND l.from_page <> p.id)
        AND NOT EXISTS (SELECT 1 FROM page_links l JOIN page_addresses a
                         ON a.brain_id = l.brain_id AND a.address = l.to_address
                        WHERE a.page_id = p.id AND l.from_page <> p.id)`

// An active entry `e` of the page's brain written after the page last changed and about it: by its topic, by
// [[address]] or by naming its address — the whole address as a word: "sales" is not in "presales", nor "h/old"
// in "h/older".
export const WRITTEN_ABOUT_SINCE = `e.brain_id = p.brain_id AND e.state = 'active' AND e.created_at > p.updated_at
        AND (e.topic = p.address OR e.content ~ ('(^|[^a-z0-9/-])' || p.address || '($|[^a-z0-9/-])'))`

export async function wikiHealth(ctx: Ctx, slug: string): Promise<Health> {
  const { brain } = await inBrain(ctx, { slug })
  return healthOf(ctx, brain.id)
}

async function healthOf(ctx: Ctx, brainId: string): Promise<Health> {
  const brain = { id: brainId }
  const db = ctx.db
  const s = await settingsOf(db, brain.id)
  const ref = (r: Record<string, unknown>): Ref => ({ address: String(r.address), title: String(r.title) })

  const orphans = await db.query(
    `SELECT p.address, p.title FROM pages p
      WHERE p.brain_id = $1 AND ${LIVE} AND ${ORPHAN}
      ORDER BY p.address`,
    [brain.id],
  )
  const broken = await db.query(
    `SELECT p.address AS from, p.title AS from_title, l.to_address AS to FROM page_links l JOIN pages p ON p.id = l.from_page
      WHERE l.brain_id = $1 AND ${LIVE} AND l.to_address IS NOT NULL
        AND NOT EXISTS (SELECT 1 FROM page_addresses a WHERE a.brain_id = l.brain_id AND a.address = l.to_address)
      ORDER BY p.address, l.to_address`,
    [brain.id],
  )
  const conflicts = await db.query(
    // One conflict per pair of pages, whichever way the links go.
    `SELECT DISTINCT CASE WHEN p.address < q.address THEN p.address ELSE q.address END AS a,
                     CASE WHEN p.address < q.address THEN p.title ELSE q.title END AS a_title,
                     CASE WHEN p.address < q.address THEN q.address ELSE p.address END AS b,
                     CASE WHEN p.address < q.address THEN q.title ELSE p.title END AS b_title FROM page_links l
       JOIN pages p ON p.id = l.from_page JOIN pages q ON q.id = l.to_page
      WHERE l.brain_id = $1 AND l.kind = 'contradicts'
        AND p.status IN ('current', 'stale') AND q.status IN ('current', 'stale')
      ORDER BY a, b`,
    [brain.id],
  )
  // Stale: untouched for `staleDays`, and the journal has written about it since (by its topic, by
  // [[address]] or by naming its address).
  const cutoff = new Date(ctx.clock().getTime() - s.staleDays * 86_400_000)
  const stale = await db.query(
    `SELECT p.address, p.title, p.updated_at, count(e.id)::int AS n
       FROM pages p JOIN entries e ON ${WRITTEN_ABOUT_SINCE}
      WHERE p.brain_id = $1 AND ${LIVE} AND p.updated_at < $2
      GROUP BY p.id ORDER BY p.address`,
    [brain.id, cutoff],
  )
  const unavailable = await db.query(
    `SELECT p.address, p.title, e.id, e.state FROM page_sources s
       JOIN pages p ON p.id = s.page_id JOIN entries e ON e.id = s.entry_id
      WHERE p.brain_id = $1 AND ${LIVE} AND e.state <> 'active' ORDER BY p.address, e.id`,
    [brain.id],
  )
  const long = await db.query(
    `SELECT p.address, p.title, length(p.body) AS chars FROM pages p
      WHERE p.brain_id = $1 AND ${LIVE} AND length(p.body) > $2 ORDER BY chars DESC, p.address`,
    [brain.id, s.longChars],
  )
  const titles = await db.query(
    `SELECT p.address, p.title FROM pages p WHERE p.brain_id = $1 AND ${LIVE} ORDER BY p.address LIMIT 2000`,
    [brain.id],
  )
  const similar: Health['similarTitles'] = []
  for (let i = 0; i < titles.length && similar.length < 200; i += 1) {
    for (let j = i + 1; j < titles.length; j += 1) {
      const x = titles[i] as Record<string, unknown>
      const y = titles[j] as Record<string, unknown>
      if (nearlySame(String(x.title), String(y.title)))
        similar.push({
          a: String(x.address),
          aTitle: String(x.title),
          b: String(y.address),
          bTitle: String(y.title),
        })
    }
  }
  const cleanup = await cleanups(db, brain.id)
  const h: Health = {
    orphans: orphans.map(ref),
    broken: broken.map((r) => ({ from: String(r.from), fromTitle: String(r.from_title), to: String(r.to) })),
    conflicts: conflicts.map((r) => ({
      a: String(r.a),
      aTitle: String(r.a_title),
      b: String(r.b),
      bTitle: String(r.b_title),
    })),
    stale: stale.map((r) => ({
      ...ref(r),
      updatedAt: (r.updated_at as Date).toISOString(),
      newEntries: Number(r.n),
    })),
    unavailableSources: unavailable.map((r) => ({
      address: String(r.address),
      title: String(r.title),
      entryId: String(r.id),
      state: r.state as 'forgotten' | 'purged',
    })),
    long: long.map((r) => ({ ...ref(r), chars: Number(r.chars) })),
    similarTitles: similar,
    maintenance: {
      suggested: false,
      lastAt: cleanup.lastAt?.toISOString() ?? null,
      pending: cleanup.pending,
      approvalsSince: s.approvalsSince,
      every: s.maintenanceEvery,
    },
  }
  const problems = Object.values(problemCounts(h)).reduce((a, b) => a + b, 0)
  h.maintenance.suggested = problems > 0 && dueAt(cleanup, ctx.clock())
  return h
}

export const CLEANUP_LIST_MAX = 20

export type Cleanup = {
  lastAt: string | null
  problems: number
  counts: Record<ListName, number>
  // The health report, each list cut to its first CLEANUP_LIST_MAX (the counts say how many there are).
  health: Omit<Health, 'maintenance'>
  suggestion: string
}

// For the start of a session (CA10, CA11): the suggestion and the report when a cleanup is due, for a caller
// who may change the wiki; otherwise null. The health is worked out only when the rest says it could be due.
export async function cleanupDue(ctx: Ctx, brain: Brain, role: Role): Promise<Cleanup | null> {
  if (!can(actorOf(ctx.who), 'wiki.propose', { role, brainStatus: brain.status }).ok) return null
  if (!dueAt(await cleanups(ctx.db, brain.id), ctx.clock())) return null
  const h = await healthOf(ctx, brain.id)
  if (!h.maintenance.suggested) return null
  const counts = problemCounts(h)
  const problems = Object.values(counts).reduce((a, b) => a + b, 0)
  const { maintenance, ...lists } = h
  const health = Object.fromEntries(
    Object.entries(lists).map(([k, v]) => [k, (v as unknown[]).slice(0, CLEANUP_LIST_MAX)]),
  ) as Omit<Health, 'maintenance'>
  const listed = LISTS.filter((k) => counts[k] > 0)
    .map((k) => `${counts[k]} ${LABEL[k]}`)
    .join(', ')
  return {
    lastAt: maintenance.lastAt,
    problems,
    counts,
    health,
    suggestion: `The wiki of "${brain.slug}" has ${problems} problem${problems === 1 ? '' : 's'} (${listed}) and ${
      maintenance.lastAt ? 'no cleanup in the last 24 hours' : 'has never been cleaned'
    }. Before your task, or after it, clean what you can: link orphan pages where they belong, fix or remove broken links, settle contradictions, update stale pages from the journal, split long pages, merge pages about the same thing. Send it as one change marked as maintenance: brain_propose (or brain_write, if your key may write) with "maintenance": true.`,
  }
}

const LABEL: Record<ListName, string> = {
  orphans: 'orphan pages',
  broken: 'broken links',
  conflicts: 'open contradictions',
  stale: 'stale pages',
  unavailableSources: 'sources no longer available',
  long: 'long pages',
  similarTitles: 'pairs of titles almost the same',
}
