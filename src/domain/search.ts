// Searching a brain (spec B3 «Buscar»): journal entries and wiki pages together, by any of the words,
// quoted phrases and excluded words, without accents and in Spanish and English word forms; with
// filters, states to include, several brains, neighbours in the page graph, and a reason per result.
// Forgotten entries only for curators who ask, purged ones never, retired pages never.
import { AppError, invalid } from '../core/errors.ts'
import type { Db, Row } from '../db/db.ts'
import {
  BM25_FIELDS,
  type Bm25Table,
  bm25Expr,
  forgetSearchFeatures,
  type SearchFeatures,
  searchFeatures,
} from '../db/extensions.ts'
import { listBrains } from './brains.ts'
import { type Ctx, inBrain } from './context.ts'
import { ENTRY_TYPES, words } from './entries.ts'
import { meaningMatches } from './meaning.ts'
import { track } from './trail.ts'
import { ADDRESS, LINK_KINDS, PAGE_TYPES, type PageStatus } from './wiki/model.ts'
import { pageNotFound } from './wiki/pages.ts'

export const MAX_QUERY = 1000
export const MAX_OFFSET = 10_000
export const SEARCH_TYPES: readonly string[] = [...new Set<string>([...ENTRY_TYPES, ...PAGE_TYPES])]

export const INCLUDES = ['forgotten', 'superseded', 'expired', 'stale'] as const
export type Include = (typeof INCLUDES)[number]

export type SearchRequest = {
  q: string
  in?: 'entries' | 'pages' | 'both'
  brains?: string[] // slugs; absent: every brain the key can read
  include?: Include[]
  types?: string[]
  tags?: string[]
  prefix?: string // a topic or address and everything under it
  from?: Date
  to?: Date // up to and including
  before?: Date // up to, not including
  author?: string // account id
  client?: string // credential id
  session?: string // entries only
  ref?: string // entries only
  limit?: number
  offset?: number
  neighbours?: boolean
}

export type LinkedFrom = {
  pageId: string
  address: string
  title: string
  kind: string
  direction: 'out' | 'in'
}

export type Hit = {
  kind: 'entry' | 'page'
  id: string
  address?: string
  brain: string
  type: string
  state: string
  title: string
  snippet: string
  why: 'words' | 'meaning' | 'recent' | 'link'
  reason: string
  linkedFrom?: LinkedFrom
  at: string
}

export type SearchResult = {
  items: Hit[]
  neighbours?: Hit[]
  next: number | null
  note?: string
  meaning?: 'on' | 'unavailable'
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
  // Any quoted text is a phrase; a minus right before the quote, at the start or after a space, excludes it.
  const rest = q.replace(/((?<=^|\s)-)?"([^"]+)"/g, (_, minus: string | undefined, p: string) => {
    if (p.trim()) (minus ? excludedPhrases : phrases).push(p.trim())
    return ' '
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

// Two results are "about as relevant" when their scores are within this ratio: they share a band,
// and inside a band a current page goes first, then the most recent (spec B3 «El orden»).
const BAND = Math.log(1.15)
// How much a current page is lifted over entries and stale pages of similar relevance.
const CURRENT_LIFT = 1.25
// With BM25 (spec v0.6), how much more a word in the title counts than the same word in the rest.
export const TITLE_BOOST = 2

type Candidate = {
  kind: 'entry' | 'page'
  id: string
  brainSlug: string
  band: number
  first: number // 1 for a current page, which goes first inside its band
  at: Date
  depth: number // how many replacements away from something not superseded (0: not superseded)
  byWords: boolean // false: found by meaning only
  // Before `band`: 1 for results found by words, 0 for those found only by meaning; all 1 when the two are
  // mixed by RRF (spec v0.6), where neither list goes first by itself.
  tier: number
  word: number | null // the score by words, when found by them
  sim: number | null // how close in meaning, when found by meaning
}

// Reciprocal rank fusion (spec v0.6 «Búsqueda», CA14): a result's score is the sum, over the lists it is in, of
// 1 / (k + its position there), with k = 60.
export const RRF_K = 60
export const rrf = (positions: number[]): number => positions.reduce((s, n) => s + 1 / (RRF_K + n), 0)

// With meaning search on, the results found by words and those close in meaning, mixed by RRF: positions by
// words (a current page lifted as before) and by closeness, each over entries and pages together. The bands
// come from the fused score, so the rules of the order (current first, then newest) still apply after.
function fuse(all: Candidate[]): void {
  const position = (list: Candidate[], key: (c: Candidate) => number) => {
    const out = new Map<Candidate, number>()
    for (const [i, c] of list.sort((a, b) => key(b) - key(a)).entries()) out.set(c, i + 1)
    return out
  }
  const byWords = position(
    all.filter((c) => c.word !== null),
    (c) => (c.word ?? 0) * (c.first ? CURRENT_LIFT : 1),
  )
  const byMeaning = position(
    all.filter((c) => c.sim !== null),
    (c) => c.sim ?? 0,
  )
  for (const c of all) {
    const at = [byWords.get(c), byMeaning.get(c)].filter((n): n is number => n !== undefined)
    c.band = Math.floor(Math.log(Math.max(rrf(at), 1e-9)) / BAND)
    c.tier = 1
  }
}

type Target = { id: string; slug: string; curator: boolean }

async function targetsOf(ctx: Ctx, slugs: string[] | undefined): Promise<Target[]> {
  const targets: Target[] = []
  if (slugs && slugs.length > 0) {
    for (const slug of slugs) {
      try {
        const { brain, role } = await inBrain(ctx, { slug })
        if (!targets.some((t) => t.id === brain.id))
          targets.push({ id: brain.id, slug: brain.slug, curator: role === 'curator' })
      } catch (err) {
        // A brain you cannot read is left out without saying so; alone, it answers like a missing one.
        // Any other failure is a real error.
        if (slugs.length === 1 || !(err instanceof AppError) || err.status !== 404) throw err
      }
    }
  } else {
    for (const b of await listBrains(ctx))
      targets.push({ id: b.id, slug: b.slug, curator: b.role === 'curator' })
  }
  return targets
}

export async function search(ctx: Ctx, r: SearchRequest): Promise<SearchResult> {
  if (r.q.length > MAX_QUERY) {
    throw invalid(`A search has at most ${MAX_QUERY} characters.`, 'Search with the key words only.')
  }
  // Prefixes are topics or addresses; "style" and "style/" both mean "style" and everything under it.
  const prefix = r.prefix?.replace(/\/+$/, '')
  if (prefix !== undefined && !ADDRESS.test(prefix)) {
    throw invalid(
      '"prefix" must be a topic or an address, like "style/intros".',
      'Use lowercase words joined by "/".',
    )
  }
  const bad = r.types?.find((t) => !SEARCH_TYPES.includes(t))
  if (bad) throw invalid(`Unknown type "${bad}".`, `Use any of: ${SEARCH_TYPES.join(', ')}.`)
  const include = new Set(r.include ?? [])
  const limit = r.limit ?? 10
  const offset = r.offset ?? 0
  const scope = r.in ?? 'both'
  const targets = await targetsOf(ctx, r.brains)
  if (targets.length === 0) return { items: [], next: null, note: noteFor(r, include) }

  const query = parseQuery(r.q)
  // A phrase with nothing to search for ("!!!") is no phrase.
  query.phrases = query.phrases.filter((x) => /[\p{L}\p{N}]/u.test(x))
  query.excludedPhrases = query.excludedPhrases.filter((x) => /[\p{L}\p{N}]/u.test(x))
  const empty = query.anyWords.length === 0 && query.phrases.length === 0
  const want = offset + limit + 1
  // A session or a reference belongs to the journal: with either, pages are left out.
  const entriesToo = scope !== 'pages'
  const pagesToo = scope !== 'entries' && r.session === undefined && r.ref === undefined
  // Close in meaning, when meaning search is on: never for an empty search, nor with an exact phrase
  // (it asks for those words, not for their meaning). Only the words searched for are sent, not the
  // excluded ones.
  const meaning =
    empty || query.phrases.length > 0
      ? { status: 'off' as const, entries: { ids: [], sims: [] }, pages: { ids: [], sims: [] } }
      : await meaningMatches(
          ctx,
          targets.map((t) => t.id),
          query.anyWords.join(' '),
          [...(entriesToo ? ['entry' as const] : []), ...(pagesToo ? ['page' as const] : [])],
        )
  const gather = async (bm25: boolean) => [
    ...(entriesToo
      ? await entryCandidates(ctx, r, targets, include, query, empty, prefix, want, meaning.entries, bm25)
      : []),
    ...(pagesToo
      ? await pageCandidates(ctx, r, targets, include, query, empty, prefix, want, meaning.pages, bm25)
      : []),
  ]
  // BM25 when pg_search is there (spec v0.6); if it fails (an index dropped since it was found), the ranking
  // of PostgreSQL's own text search, so a search never fails because of the extension.
  const root = ctx.root ?? ctx.db
  const features: SearchFeatures = await searchFeatures(root)
  let candidates: Candidate[]
  try {
    candidates = await gather(features.bm25)
  } catch (err) {
    if (!features.bm25) throw err
    forgetSearchFeatures(root)
    candidates = await gather(false)
  }
  if (candidates.some((c) => c.sim !== null)) fuse(candidates)
  const ordered = candidates.sort(byOrder)
  const slice = ordered.slice(offset, offset + limit)
  const items = await describe(ctx.db, ctx.clock(), slice, query, empty)

  const out: SearchResult = {
    items,
    next: ordered.length > offset + limit && offset + limit <= MAX_OFFSET ? offset + limit : null,
  }
  if (r.neighbours) {
    const firstPages = items.filter((h) => h.kind === 'page').slice(0, 5)
    const statuses = pageStatuses(include)
    out.neighbours = (
      await neighboursOf(
        ctx.db,
        firstPages.map((h) => h.id),
        { hops: 1, direction: 'both', statuses },
      )
    ).filter((n) => !items.some((h) => h.kind === 'page' && h.id === n.id))
  }
  for (const t of targets) {
    await track(ctx.root ?? ctx.db, ctx, {
      brainId: t.id,
      kind: 'search',
      query: r.q,
      resultIds: [...items, ...(out.neighbours ?? [])].filter((h) => h.brain === t.slug).map((h) => h.id),
    })
  }
  if (meaning.status !== 'off') out.meaning = meaning.status
  const notes: string[] = []
  if (meaning.status === 'unavailable') notes.push('Meaning search unavailable: results are by words only.')
  if (items.length === 0) notes.push(noteFor(r, include))
  if (notes.length > 0) out.note = notes.join(' ')
  return out
}

function noteFor(r: SearchRequest, include: Set<Include>): string {
  const filtered =
    (r.brains?.length ?? 0) > 0 ||
    (r.types?.length ?? 0) > 0 ||
    (r.tags?.length ?? 0) > 0 ||
    include.size > 0 ||
    [r.prefix, r.from, r.to, r.before, r.author, r.client, r.session, r.ref].some((v) => v !== undefined) ||
    (r.in !== undefined && r.in !== 'both')
  return filtered ? 'No results. Try without filters, or in all your brains.' : 'No results. Try other words.'
}

function pageStatuses(include: Set<Include>): PageStatus[] {
  const s: PageStatus[] = ['current']
  if (include.has('stale')) s.push('stale')
  if (include.has('superseded')) s.push('superseded')
  return s
}

// Each value becomes a parameter only where the SQL uses it: PostgreSQL cannot type an unused one.
function paramList() {
  const params: unknown[] = []
  const p = (v: unknown) => {
    params.push(v)
    return `$${params.length}`
  }
  return { params, p }
}

type Near = { ids: string[]; sims: number[] }

// The match and the score of a search over one kind. With results close in meaning, a result matches by
// words or by meaning; `byWords` says which.
// `ranked`: rank by BM25 over this table's index (spec v0.6), for the brains in `scope`. What matches is still
// decided by the text search below (words, phrases, exclusions as before); BM25 only scores it, through `with`,
// a query of its own the caller puts in front. A match the index does not score goes after those it does.
function textConditions(
  col: string,
  idCol: string,
  q: ParsedQuery,
  empty: boolean,
  p: (v: unknown) => string,
  conditions: string[],
  near: Near,
  ranked: { table: Bm25Table; scope: string } | null = null,
): { score: string; byWords: string; word: string; sim: string; with?: string } {
  // Exclusions apply on their own, also with nothing else asked: a result with any excluded word, in
  // any of the three word forms, or with an excluded phrase, is left out.
  if (q.excluded.length > 0) {
    conditions.push(
      `NOT coalesce(${col} @@ brain_query(${p(q.excluded)}::text[], '{}'::text[], '{}'::text[]), false)`,
    )
  }
  for (const phrase of q.excludedPhrases) {
    conditions.push(
      `NOT coalesce(${col} @@ brain_query('{}'::text[], ${p([phrase])}::text[], '{}'::text[]), false)`,
    )
  }
  if (empty) return { score: '1', byWords: 'true', word: 'NULL::real', sim: 'NULL::real' }
  const tsq = `brain_query(${p(q.anyWords)}::text[], ${p(q.phrases)}::text[], '{}'::text[])`
  // A bare match, so the text index can serve it.
  const words = `${col} @@ ${tsq}`
  // Normalised by the length of the text, so a long page and a short entry compare. ts_rank, not the
  // cover-density ts_rank_cd: much cheaper on long pages, and the order is close (CA18).
  let rank = `ts_rank(${col}, ${tsq}, 1)`
  let bm: string | undefined
  const text = [...q.anyWords, ...q.phrases].join(' ')
  if (ranked && text.trim()) {
    const t = p(text)
    // Each field read three ways (plain, Spanish, English); the title weighs TITLE_BOOST times the rest.
    const match = BM25_FIELDS.map(
      (f) =>
        `${bm25Expr(ranked.table, f.part, 'x.')}::pdb.alias('${f.alias}') ||| ${t}::text${
          f.part === 'title' ? `::pdb.boost(${TITLE_BOOST})` : ''
        }`,
    ).join(' OR ')
    bm = `bm AS MATERIALIZED (SELECT x.id, pdb.score(x.id) AS s FROM ${ranked.table} x
                               WHERE x.brain_id = ANY(${ranked.scope}::text[]) AND (${match}))`
    rank = `coalesce((SELECT bm.s FROM bm WHERE bm.id = ${idCol}), 0)`
  }
  const withBm = bm ? { with: bm } : {}
  if (near.ids.length === 0) {
    conditions.push(words)
    return { score: rank, byWords: 'true', word: `(${rank})::real`, sim: 'NULL::real', ...withBm }
  }
  const ids = p(near.ids)
  const sim = `(SELECT u.s FROM unnest(${ids}::text[], ${p(near.sims)}::real[]) AS u(i, s) WHERE u.i = ${idCol})`
  conditions.push(`(${words} OR ${idCol} = ANY(${ids}::text[]))`)
  return {
    // What the database orders by to choose the candidates: words first, then closeness. The order shown
    // mixes the two by RRF (fuse), from `word` and `sim`.
    score: `(CASE WHEN ${words} THEN ${rank} ELSE coalesce(${sim}, 0) END)`,
    byWords: `coalesce(${words}, false)`,
    word: `(CASE WHEN ${words} THEN ${rank} END)::real`,
    sim: `${sim}::real`,
    ...withBm,
  }
}

// A superseded result never goes before what replaced it (spec B3 «El orden», CA17b): results are
// ordered first by how many replacements away they are from something current, so a successor always
// comes before what it replaced, a chain keeps its order, and the key is the row's own (pages of
// results are stable). Chains longer than 20, or loops, stop counting at 20.
const depthOf = (table: 'entries' | 'pages', alias: string) =>
  `CASE WHEN ${alias}.superseded_by IS NULL THEN 0 ELSE (
     WITH RECURSIVE chain(id, d) AS (
       SELECT ${alias}.superseded_by, 1
       UNION ALL
       SELECT x.superseded_by, c.d + 1 FROM chain c JOIN ${table} x ON x.id = c.id
        WHERE x.superseded_by IS NOT NULL AND c.d < 20)
     SELECT max(d) FROM chain) END`

const bandOf = (score: string) => `floor(ln(greatest(${score}, 1e-9)) / ${BAND})::int`

async function entryCandidates(
  ctx: Ctx,
  r: SearchRequest,
  targets: Target[],
  include: Set<Include>,
  query: ParsedQuery,
  empty: boolean,
  prefix: string | undefined,
  want: number,
  near: Near,
  bm25 = false,
): Promise<Candidate[]> {
  const { params, p } = paramList()
  const scope = p(targets.map((t) => t.id))
  const conditions = [`e.brain_id = ANY(${scope})`, "e.state <> 'purged'"]
  const curatorOf = targets.filter((t) => t.curator).map((t) => t.id)
  conditions.push(
    include.has('forgotten')
      ? `(e.state = 'active' OR e.brain_id = ANY(${p(curatorOf)}::text[]))`
      : "e.state = 'active'",
  )
  if (!include.has('superseded')) conditions.push('e.superseded_by IS NULL')
  if (!include.has('expired')) conditions.push(`(e.expires_at IS NULL OR e.expires_at > ${p(ctx.clock())})`)
  if (r.types?.length) conditions.push(`e.type = ANY(${p(r.types)}::text[])`)
  if (r.tags?.length) conditions.push(`e.tags @> ${p(r.tags)}::text[]`)
  if (prefix !== undefined) {
    const x = p(prefix)
    conditions.push(`(e.topic = ${x} OR left(e.topic, length(${x}) + 1) = ${x} || '/')`)
  }
  if (r.from) conditions.push(`e.created_at >= ${p(r.from)}`)
  if (r.to) conditions.push(`e.created_at <= ${p(r.to)}`)
  if (r.before) conditions.push(`e.created_at < ${p(r.before)}`)
  if (r.author) conditions.push(`e.author_id = ${p(r.author)}`)
  if (r.client) conditions.push(`e.credential_id = ${p(r.client)}`)
  if (r.session) conditions.push(`e.session_id = ${p(r.session)}`)
  // An entry belongs to a job's reference if any of its revisions was written under it (spec B1).
  if (r.ref) {
    conditions.push(
      `EXISTS (SELECT 1 FROM entry_revisions rv WHERE rv.entry_id = e.id AND rv.stamped_ref = ${p(r.ref)})`,
    )
  }
  const {
    score,
    byWords,
    with: bm,
    word,
    sim,
  } = textConditions(
    'e.search',
    'e.id',
    query,
    empty,
    p,
    conditions,
    near,
    bm25 ? { table: 'entries', scope } : null,
  )
  const band = empty ? '0' : bandOf(score)
  const rows = await ctx.db.query<Row>(
    chosen(
      bm,
      `SELECT e.id, b.slug, e.created_at AS at, ${depthOf('entries', 'e')} AS depth, ${band} AS band, ${byWords} AS by_words,
              ${word} AS word, ${sim} AS sim, row_number() OVER (ORDER BY ${byWords} DESC, ${word} DESC NULLS LAST) AS wr
         FROM entries e JOIN brains b ON b.id = e.brain_id
        WHERE ${conditions.join(' AND ')}`,
      'depth, by_words DESC, band DESC, at DESC, id',
      p(want),
      near.ids.length > 0,
    ),
    params,
  )
  return rows.map((x) => ({
    kind: 'entry' as const,
    id: String(x.id),
    brainSlug: String(x.slug),
    band: Number(x.band),
    first: 0,
    at: x.at as Date,
    depth: Number(x.depth),
    byWords: x.by_words !== false,
    tier: x.by_words !== false ? 1 : 0,
    word: x.word == null ? null : Number(x.word),
    sim: x.sim == null ? null : Number(x.sim),
  }))
}

async function pageCandidates(
  ctx: Ctx,
  r: SearchRequest,
  targets: Target[],
  include: Set<Include>,
  query: ParsedQuery,
  empty: boolean,
  prefix: string | undefined,
  want: number,
  near: Near,
  bm25 = false,
): Promise<Candidate[]> {
  const { params, p } = paramList()
  const scope = p(targets.map((t) => t.id))
  const conditions = [`p.brain_id = ANY(${scope})`, `p.status = ANY(${p(pageStatuses(include))}::text[])`]
  if (r.types?.length) conditions.push(`p.type = ANY(${p(r.types)}::text[])`)
  if (r.tags?.length) conditions.push(`p.tags @> ${p(r.tags)}::text[]`)
  if (prefix !== undefined) {
    const x = p(prefix)
    conditions.push(`(p.address = ${x} OR left(p.address, length(${x}) + 1) = ${x} || '/')`)
  }
  if (r.from) conditions.push(`p.updated_at >= ${p(r.from)}`)
  if (r.to) conditions.push(`p.updated_at <= ${p(r.to)}`)
  if (r.before) conditions.push(`p.updated_at < ${p(r.before)}`)
  // A page is by an author or a client if any of its revisions is.
  if (r.author) {
    conditions.push(
      `EXISTS (SELECT 1 FROM page_revisions rv WHERE rv.page_id = p.id AND rv.author_id = ${p(r.author)})`,
    )
  }
  if (r.client) {
    conditions.push(
      `EXISTS (SELECT 1 FROM page_revisions rv WHERE rv.page_id = p.id AND rv.credential_id = ${p(r.client)})`,
    )
  }
  const {
    score: raw,
    byWords,
    with: bm,
    word,
    sim,
  } = textConditions(
    'p.search',
    'p.id',
    query,
    empty,
    p,
    conditions,
    near,
    bm25 ? { table: 'pages', scope } : null,
  )
  const first = empty ? '0' : "(p.status = 'current')::int"
  const band = empty ? '0' : bandOf(`${raw} * CASE WHEN p.status = 'current' THEN ${CURRENT_LIFT} ELSE 1 END`)
  const rows = await ctx.db.query<Row>(
    chosen(
      bm,
      `SELECT p.id, b.slug, p.updated_at AS at, ${depthOf('pages', 'p')} AS depth, ${band} AS band, ${first} AS first,
              ${byWords} AS by_words, ${word} AS word, ${sim} AS sim,
              row_number() OVER (ORDER BY ${byWords} DESC, ${word} DESC NULLS LAST) AS wr
         FROM pages p JOIN brains b ON b.id = p.brain_id
        WHERE ${conditions.join(' AND ')}`,
      'depth, by_words DESC, band DESC, first DESC, at DESC, id',
      p(want),
      near.ids.length > 0,
    ),
    params,
  )
  return rows.map((x) => ({
    kind: 'page' as const,
    id: String(x.id),
    brainSlug: String(x.slug),
    band: Number(x.band),
    first: Number(x.first),
    at: x.at as Date,
    depth: Number(x.depth),
    byWords: x.by_words !== false,
    tier: x.by_words !== false ? 1 : 0,
    word: x.word == null ? null : Number(x.word),
    sim: x.sim == null ? null : Number(x.sim),
  }))
}

// The candidates of one kind. By words alone: the first `want` in the order shown. With meaning: the first
// `want` by words and every one close in meaning, so the mix (fuse) can put a close one before them.
function chosen(bm: string | undefined, select: string, order: string, want: string, mixed: boolean): string {
  const head = bm ? `WITH ${bm} ` : ''
  return mixed
    ? `${head}SELECT * FROM (${select}) c WHERE c.wr <= ${want} OR c.sim IS NOT NULL ORDER BY ${order}`
    : `${head}SELECT * FROM (${select}) c ORDER BY ${order} LIMIT ${want}`
}

function byOrder(a: Candidate, b: Candidate): number {
  return (
    a.depth - b.depth ||
    b.tier - a.tier ||
    b.band - a.band ||
    b.first - a.first ||
    b.at.getTime() - a.at.getTime() ||
    (a.kind === b.kind ? 0 : a.kind === 'page' ? -1 : 1) ||
    (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)
  )
}

const HEADLINE = "'StartSel=«,StopSel=»,MaxWords=30,MinWords=8,MaxFragments=2,FragmentDelimiter= … '"

// A fragment with what matched marked. The words are read as plain words first, then as Spanish and
// as English, so a form of the word ("claras" for "claro") is marked too. Only the start of a long
// text is read (a page body can hold 120 000 characters), so the cost of a page of results is bounded.
export const SNIPPET_WINDOW = 8000
const headline = (text: string, tsq: string) =>
  `(SELECT h FROM (SELECT left(${text}, ${SNIPPET_WINDOW}) AS t) w,
     LATERAL (SELECT 1 AS o, ts_headline('simple', w.t, ${tsq}, ${HEADLINE}) AS h
              UNION ALL SELECT 2, ts_headline('spanish', w.t, ${tsq}, ${HEADLINE})
              UNION ALL SELECT 3, ts_headline('english', w.t, ${tsq}, ${HEADLINE})) v
     ORDER BY position('«' IN h) > 0 DESC, o LIMIT 1)`

// The visible part of each chosen result, with what matched marked. Only for the page of results, so
// the costly part runs on ten rows, not on every candidate.
async function describe(
  db: Db,
  now: Date,
  slice: Candidate[],
  q: ParsedQuery,
  empty: boolean,
): Promise<Hit[]> {
  const entryIds = slice.filter((c) => c.kind === 'entry').map((c) => c.id)
  const pageIds = slice.filter((c) => c.kind === 'page').map((c) => c.id)
  const { params, p } = paramList()
  const tsq = empty ? '' : `brain_query(${p(q.anyWords)}::text[], ${p(q.phrases)}::text[], '{}'::text[])`
  const ids = p(entryIds)
  const pids = p(pageIds)
  const at = p(now)
  const rows = await db.query<Row>(
    `SELECT 'entry' AS kind, e.id, NULL AS address, e.type, e.title, b.slug,
            CASE WHEN e.state = 'forgotten' THEN 'forgotten'
                 WHEN e.superseded_by IS NOT NULL THEN 'superseded'
                 WHEN e.expires_at IS NOT NULL AND e.expires_at <= ${at} THEN 'expired'
                 ELSE 'active' END AS state,
            ${empty ? 'left(e.content, 200)' : headline("e.title || ' — ' || e.content", tsq)} AS snippet
       FROM entries e JOIN brains b ON b.id = e.brain_id WHERE e.id = ANY(${ids}::text[])
     UNION ALL
     SELECT 'page', p.id, p.address, p.type, p.title, b.slug, p.status,
            ${
              empty
                ? "left(CASE WHEN p.summary <> '' THEN p.summary ELSE p.body END, 200)"
                : headline("concat_ws(' — ', p.title, nullif(p.summary, ''), p.body)", tsq)
            }
       FROM pages p JOIN brains b ON b.id = p.brain_id WHERE p.id = ANY(${pids}::text[])`,
    params,
  )
  const byKey = new Map(rows.map((x) => [`${x.kind}:${x.id}`, x]))
  const out: Hit[] = []
  for (const c of slice) {
    const x = byKey.get(`${c.kind}:${c.id}`)
    if (!x) continue
    const hit: Hit = {
      kind: c.kind,
      id: c.id,
      brain: String(x.slug),
      type: String(x.type),
      state: String(x.state),
      title: String(x.title),
      snippet: String(x.snippet),
      why: empty ? 'recent' : c.byWords ? 'words' : 'meaning',
      reason: empty
        ? 'most recent'
        : c.byWords && c.sim !== null
          ? 'matched by words and meaning'
          : c.byWords
            ? 'matched by words'
            : 'matched by meaning',
      at: c.at.toISOString(),
    }
    if (c.kind === 'page') hit.address = String(x.address)
    out.push(hit)
  }
  return out
}

export type NeighbourOptions = {
  hops: 1 | 2
  direction: 'out' | 'in' | 'both'
  kinds?: string[]
  statuses: PageStatus[]
  max?: number
}

// The pages linked to the given ones, one or two links away, each marked with the link it came by.
// A typed link points at a page; a mention points at an address, read through its current owner.
export async function neighboursOf(db: Db, from: string[], o: NeighbourOptions): Promise<Hit[]> {
  const max = o.max ?? 50
  const seen = new Set(from)
  const out: Hit[] = []
  let frontier = from
  for (let hop = 0; hop < o.hops && frontier.length > 0 && out.length < max; hop++) {
    const { params, p } = paramList()
    const f = p(frontier)
    const parts: string[] = []
    if (o.direction !== 'in') {
      parts.push(`SELECT l.from_page AS src, coalesce(l.to_page, a.page_id) AS dst, l.kind, 'out' AS direction
                    FROM page_links l
                    LEFT JOIN page_addresses a ON l.to_page IS NULL AND a.brain_id = l.brain_id AND a.address = l.to_address
                   WHERE l.from_page = ANY(${f}::text[])`)
    }
    if (o.direction !== 'out') {
      parts.push(
        `SELECT l.to_page AS src, l.from_page AS dst, l.kind, 'in' AS direction FROM page_links l WHERE l.to_page = ANY(${f}::text[])`,
      )
      parts.push(`SELECT a.page_id AS src, l.from_page AS dst, l.kind, 'in' AS direction
                    FROM page_links l
                    JOIN page_addresses a ON l.to_page IS NULL AND a.brain_id = l.brain_id AND a.address = l.to_address
                   WHERE a.page_id = ANY(${f}::text[])`)
    }
    const kinds = o.kinds?.length ? ` AND x.kind = ANY(${p(o.kinds)}::text[])` : ''
    const rows = await db.query<Row>(
      `SELECT DISTINCT ON (n.id) n.id, n.address, n.type, n.title, n.status, n.updated_at, b.slug,
              x.kind, x.direction, s.id AS src_id, s.address AS src_address, s.title AS src_title
         FROM (${parts.join(' UNION ALL ')}) x
         JOIN pages n ON n.id = x.dst
         JOIN pages s ON s.id = x.src AND s.brain_id = n.brain_id
         JOIN brains b ON b.id = n.brain_id
        WHERE x.dst <> x.src AND n.id <> ALL(${p([...seen])}::text[])
          AND n.status = ANY(${p(o.statuses)}::text[])${kinds}
        ORDER BY n.id, x.direction DESC, x.kind
        LIMIT ${p(max - out.length)}`,
      params,
    )
    const next: string[] = []
    for (const x of rows) {
      const id = String(x.id)
      seen.add(id)
      next.push(id)
      const direction = x.direction as 'out' | 'in'
      const linkedFrom: LinkedFrom = {
        pageId: String(x.src_id),
        address: String(x.src_address),
        title: String(x.src_title),
        kind: String(x.kind),
        direction,
      }
      out.push({
        kind: 'page',
        id,
        address: String(x.address),
        brain: String(x.slug),
        type: String(x.type),
        state: String(x.status),
        title: String(x.title),
        snippet: '',
        why: 'link',
        reason:
          direction === 'out'
            ? `linked from ${linkedFrom.title} via ${linkedFrom.kind}`
            : `links to ${linkedFrom.title} via ${linkedFrom.kind}`,
        linkedFrom,
        at: (x.updated_at as Date).toISOString(),
      })
    }
    frontier = next
  }
  return out
}

// The neighbours of one page (spec B3 «Vecinos en el grafo»): any member of the brain can ask.
export async function pageNeighbours(
  ctx: Ctx,
  slug: string,
  address: string,
  o: { hops: 1 | 2; direction: 'out' | 'in' | 'both'; kinds?: string[] },
): Promise<{ page: { id: string; address: string }; items: Hit[] }> {
  const bad = o.kinds?.find((k) => !(LINK_KINDS as readonly string[]).includes(k))
  if (bad) throw invalid(`Unknown link kind "${bad}".`, `Use any of: ${LINK_KINDS.join(', ')}.`)
  const { brain } = await inBrain(ctx, { slug })
  const row = await ctx.db.one<Row>(
    `SELECT p.id, p.address FROM page_addresses a JOIN pages p ON p.id = a.page_id
      WHERE a.brain_id = $1 AND a.address = $2`,
    [brain.id, address],
  )
  if (!row) throw pageNotFound(address)
  const items = await neighboursOf(ctx.db, [String(row.id)], {
    ...o,
    statuses: ['current', 'stale', 'superseded'],
  })
  return { page: { id: String(row.id), address: String(row.address) }, items }
}
