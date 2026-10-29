// Searching the journal by its words (spec B3 minimum for B1): any of the words, quoted phrases,
// excluded words, no accents, Spanish and English word forms. Forgotten entries only for curators who
// ask, purged ones never; superseded and expired only when asked. Each search leaves a trail.
import { AppError, invalid } from '../core/errors.ts'
import type { Row } from '../db/db.ts'
import { listBrains } from './brains.ts'
import { type Ctx, inBrain } from './context.ts'
import { words } from './entries.ts'
import { track } from './trail.ts'

export const MAX_QUERY = 1000

export type Include = 'forgotten' | 'superseded' | 'expired'

export type SearchRequest = {
  q: string
  brains?: string[] // slugs; absent: every brain the key can read
  include?: Include[]
  type?: string
  limit?: number
  offset?: number
}

export type Hit = {
  entryId: string
  brain: string
  type: string
  title: string
  snippet: string
  state: string
  superseded: boolean
  why: 'words'
  createdAt: string
}

export type ParsedQuery = {
  anyWords: string[]
  phrases: string[]
  excluded: string[]
  excludedPhrases: string[]
}

export function parseQuery(q: string): ParsedQuery {
  const phrases: string[] = []
  const excludedPhrases: string[] = []
  const rest = q.replace(/(^|\s)(-?)"([^"]+)"/g, (_, lead: string, minus: string, p: string) => {
    if (p.trim()) (minus ? excludedPhrases : phrases).push(p.trim())
    return lead || ' '
  })
  const excluded: string[] = []
  const free: string[] = []
  for (const token of rest.split(/\s+/)) {
    if (!token) continue
    if (token.startsWith('-') && token.length > 1) excluded.push(token.slice(1))
    else free.push(token)
  }
  return {
    anyWords: words(free.join(' ')),
    phrases,
    excluded: excluded.flatMap((x) => words(x)),
    excludedPhrases,
  }
}

export async function search(
  ctx: Ctx,
  r: SearchRequest,
): Promise<{ items: Hit[]; next: number | null; note?: string }> {
  if (r.q.length > MAX_QUERY) {
    throw invalid(`A search has at most ${MAX_QUERY} characters.`, 'Search with the key words only.')
  }
  const include = new Set(r.include ?? [])
  const limit = r.limit ?? 10
  const offset = r.offset ?? 0
  const targets: { id: string; slug: string; curator: boolean }[] = []
  if (r.brains && r.brains.length > 0) {
    for (const slug of r.brains) {
      try {
        const { brain, role } = await inBrain(ctx, { slug })
        targets.push({ id: brain.id, slug: brain.slug, curator: role === 'curator' })
      } catch (err) {
        // A brain you cannot read is left out without saying so; alone, it answers like a missing one.
        // Any other failure is a real error.
        if (r.brains.length === 1 || !(err instanceof AppError) || err.status !== 404) throw err
      }
    }
  } else {
    for (const b of await listBrains(ctx))
      targets.push({ id: b.id, slug: b.slug, curator: b.role === 'curator' })
  }
  if (targets.length === 0) return { items: [], next: null }
  const { anyWords, phrases, excluded, excludedPhrases } = parseQuery(r.q)
  const empty = anyWords.length === 0 && phrases.length === 0
  const ids = targets.map((t) => t.id)
  const curatorOf = targets.filter((t) => t.curator).map((t) => t.id)
  // Each value becomes a parameter only where the SQL uses it: PostgreSQL cannot type an unused one.
  const params: unknown[] = []
  const p = (v: unknown) => {
    params.push(v)
    return `$${params.length}`
  }
  const conditions = [`e.brain_id = ANY(${p(ids)})`, "e.state <> 'purged'"]
  conditions.push(
    include.has('forgotten')
      ? `(e.state = 'active' OR e.brain_id = ANY(${p(curatorOf)}::text[]))`
      : "e.state = 'active'",
  )
  if (!include.has('superseded')) conditions.push('e.superseded_by IS NULL')
  if (!include.has('expired')) conditions.push(`(e.expires_at IS NULL OR e.expires_at > ${p(ctx.clock())})`)
  if (r.type) conditions.push(`e.type = ${p(r.type)}`)
  // Exclusions apply on their own, also with nothing else asked: an entry with any excluded word, in
  // any of the three word forms, or with an excluded phrase, is left out.
  if (excluded.length > 0) {
    conditions.push(
      `NOT coalesce(e.search @@ brain_query(${p(excluded)}::text[], '{}'::text[], '{}'::text[]), false)`,
    )
  }
  for (const phrase of excludedPhrases) {
    conditions.push(
      `NOT coalesce(e.search @@ brain_query('{}'::text[], ${p([phrase])}::text[], '{}'::text[]), false)`,
    )
  }
  let rank = '0'
  let snippet = 'left(e.content, 200)'
  if (!empty) {
    const q = `brain_query(${p(anyWords)}::text[], ${p(phrases)}::text[], '{}'::text[])`
    conditions.push(`e.search @@ ${q}`)
    rank = `ts_rank_cd(e.search, ${q})`
    snippet = `ts_headline('simple', e.title || ' — ' || e.content, ${q}, 'StartSel=«,StopSel=»,MaxWords=30,MinWords=8,MaxFragments=2,FragmentDelimiter= … ')`
  }
  const lim = p(limit + 1)
  const off = p(offset)
  const rows = await ctx.db.query<Row>(
    `SELECT e.id, e.type, e.title, e.state, e.superseded_by, e.created_at, b.slug, ${snippet} AS snippet, ${rank} AS rank
       FROM entries e JOIN brains b ON b.id = e.brain_id
      WHERE ${conditions.join(' AND ')}
      ORDER BY rank DESC, e.created_at DESC, e.id
      LIMIT ${lim} OFFSET ${off}`,
    params,
  )
  const page = rows.slice(0, limit)
  for (const t of targets) {
    await track(ctx.root ?? ctx.db, ctx, {
      brainId: t.id,
      kind: 'search',
      query: r.q,
      resultIds: page.filter((h) => h.slug === t.slug).map((h) => String(h.id)),
    })
  }
  const items = page.map((h) => ({
    entryId: String(h.id),
    brain: String(h.slug),
    type: String(h.type),
    title: String(h.title),
    snippet: String(h.snippet),
    state: String(h.state),
    superseded: h.superseded_by != null,
    why: 'words' as const,
    createdAt: (h.created_at as Date).toISOString(),
  }))
  const out: { items: Hit[]; next: number | null; note?: string } = {
    items,
    next: rows.length > limit ? offset + limit : null,
  }
  if (items.length === 0) {
    out.note =
      r.brains?.length || r.type || include.size
        ? 'No results. Try without filters, or in all your brains.'
        : 'No results. Try other words.'
  }
  return out
}
