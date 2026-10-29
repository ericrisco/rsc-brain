// What a compiling agent receives (spec B2 «Lo que el agente compilador recibe»): the uncompiled
// entries oldest first up to a size budget, the people's corrections not yet collected, the map, the
// pages those entries touch, and the brain's compile guide. The server compiles nothing (P2).
import { invalid } from '../../core/errors.ts'
import type { Row } from '../../db/db.ts'
import { allow, type Ctx, inBrain } from '../context.ts'
import { type Entry, entryOf, words } from '../entries.ts'
import { mentionsOf } from './model.ts'
import { settingsOf, wikiMap } from './pages.ts'

export const PACK = { default: 60_000, min: 4_000, max: 400_000 }

export type RelatedPage = {
  address: string
  title: string
  summary: string
  type: string
  status: string
  revision: number
  why: 'mentioned' | 'topic' | 'words'
}

export type CompilePack = {
  brain: { slug: string; purpose: string }
  guide: string
  entries: Entry[]
  remaining: number
  remainingCorrections: number
  corrections: Entry[]
  map: Awaited<ReturnType<typeof wikiMap>>
  pages: RelatedPage[]
  maxChars: number
}

const size = (e: Entry) => e.title.length + e.content.length + 200

export async function compilePack(
  ctx: Ctx,
  slug: string,
  o: { maxChars?: number } = {},
): Promise<CompilePack> {
  const { brain, role } = await inBrain(ctx, { slug })
  // Compiling ends in a proposal, so the pack is for those who may propose.
  await allow(ctx, 'wiki.propose', { role, brainStatus: brain.status }, brain.id)
  const maxChars = o.maxChars ?? PACK.default
  if (!Number.isSafeInteger(maxChars) || maxChars < PACK.min || maxChars > PACK.max) {
    throw invalid(`"maxChars" goes from ${PACK.min} to ${PACK.max}.`, `Ask for ${PACK.default}, the default.`)
  }
  const rows = await ctx.db.query(
    `SELECT * FROM entries WHERE brain_id = $1 AND state = 'active' AND NOT compiled AND type NOT IN ('summary', 'correction')
      ORDER BY created_at, id`,
    [brain.id],
  )
  const allCorrections = (
    await ctx.db.query(
      `SELECT * FROM entries WHERE brain_id = $1 AND state = 'active' AND NOT compiled AND type = 'correction'
        ORDER BY created_at, id`,
      [brain.id],
    )
  ).map(entryOf)
  // People's corrections first, up to half the budget, then entries, oldest first, with what is left:
  // corrections never collected cannot starve the entries. One item of each always goes, even over
  // its share, so an item larger than the budget can still be compiled.
  let used = 0
  const take = <T extends Entry>(list: T[], limit: number): T[] => {
    const out: T[] = []
    for (const e of list) {
      if (out.length > 0 && used + size(e) > limit) break
      out.push(e)
      used += size(e)
    }
    return out
  }
  const corrections = take(allCorrections, Math.floor(maxChars / 2))
  const entries = take(
    rows.map((r) => entryOf(r as Row)),
    maxChars,
  )
  const all = [...corrections, ...entries]
  const related = new Map<string, RelatedPage>()
  const add = (r: Row, why: RelatedPage['why']) => {
    const a = String(r.address)
    if (related.has(a) || related.size >= 40) return
    related.set(a, {
      address: a,
      title: String(r.title),
      summary: String(r.summary),
      type: String(r.type),
      status: String(r.status),
      revision: Number(r.revision),
      why,
    })
  }
  // 1. Pages the entries name: [[address]] or a bare address in the text.
  const named = new Set<string>()
  for (const e of all) {
    for (const m of mentionsOf(e.content)) named.add(m)
    for (const m of `${e.title} ${e.content}`.matchAll(
      /\b[a-z0-9]+(?:-[a-z0-9]+)*\/[a-z0-9]+(?:-[a-z0-9]+)*(?:\/[a-z0-9]+(?:-[a-z0-9]+)*)*\b/g,
    )) {
      named.add(m[0])
    }
  }
  if (named.size > 0) {
    for (const r of await ctx.db.query(
      `SELECT DISTINCT p.* FROM page_addresses a JOIN pages p ON p.id = a.page_id
        WHERE a.brain_id = $1 AND a.address = ANY($2) AND p.status <> 'retired'`,
      [brain.id, [...named].slice(0, 200)],
    )) {
      add(r, 'mentioned')
    }
  }
  // 2. Pages whose address is an entry's topic.
  const topics = [...new Set(all.map((e) => e.topic).filter((t): t is string => t !== null))]
  if (topics.length > 0) {
    for (const r of await ctx.db.query(
      `SELECT DISTINCT p.* FROM page_addresses a JOIN pages p ON p.id = a.page_id
        WHERE a.brain_id = $1 AND a.address = ANY($2) AND p.status <> 'retired'`,
      [brain.id, topics],
    )) {
      add(r, 'topic')
    }
  }
  // 3. Pages found by the words of the entries' titles (meaning search comes with B3).
  const ws = words(all.map((e) => e.title).join(' ')).slice(0, 30)
  if (ws.length > 0) {
    for (const r of await ctx.db.query(
      `SELECT p.*, ts_rank_cd(p.search, q) AS rank
         FROM pages p, brain_query($2::text[], '{}'::text[], '{}'::text[]) q
        WHERE p.brain_id = $1 AND p.status <> 'retired' AND p.search @@ q
        ORDER BY rank DESC, p.address LIMIT 15`,
      [brain.id, ws],
    )) {
      add(r, 'words')
    }
  }
  const settings = await settingsOf(ctx.db, brain.id)
  return {
    brain: { slug: brain.slug, purpose: brain.purpose },
    guide: settings.guide,
    entries,
    remaining: rows.length - entries.length,
    remainingCorrections: allCorrections.length - corrections.length,
    corrections,
    map: await wikiMap(ctx, slug),
    pages: [...related.values()],
    maxChars,
  }
}

export async function getGuide(ctx: Ctx, slug: string): Promise<{ guide: string; custom: boolean }> {
  const { brain } = await inBrain(ctx, { slug })
  const s = await settingsOf(ctx.db, brain.id)
  return { guide: s.guide, custom: s.customGuide }
}
