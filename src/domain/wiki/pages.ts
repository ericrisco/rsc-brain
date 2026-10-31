// Reading the wiki (spec B2): a page by its address (old addresses redirect), its links both ways, its
// sources and history; the map, the decisions and the log, which are worked out when read so they
// never fall behind. Any member of the brain reads all of it.
import { AppError, invalid } from '../../core/errors.ts'
import type { Db, Row } from '../../db/db.ts'
import { type Ctx, inBrain } from '../context.ts'
import { decode, encode, PAGE, type Page as PageOf } from '../listing.ts'
import { checkFilters } from './graph.ts'
import type { LinkKind, PageStatus, PageType, Source } from './model.ts'

export const pageNotFound = (address: string) =>
  new AppError(
    404,
    'page_not_found',
    `There is no page at "${address}" in this brain.`,
    'Check the address in the map (GET /v1/brains/:slug/wiki/map), or propose the page.',
  )

export type WikiPage = {
  id: string
  brainId: string
  address: string
  type: PageType
  title: string
  summary: string
  body: string
  tags: string[]
  status: PageStatus
  supersededBy: string | null
  revision: number
  createdAt: string
  updatedAt: string
}

export const pageOf = (r: Row): WikiPage => ({
  id: String(r.id),
  brainId: String(r.brain_id),
  address: String(r.address),
  type: r.type as PageType,
  title: String(r.title),
  summary: String(r.summary),
  body: String(r.body),
  tags: (r.tags as string[]) ?? [],
  status: r.status as PageStatus,
  supersededBy: r.superseded_by == null ? null : String(r.superseded_by),
  revision: Number(r.revision),
  createdAt: (r.created_at as Date).toISOString(),
  updatedAt: (r.updated_at as Date).toISOString(),
})

// The page an address leads to, through any address it ever had.
export async function resolve(db: Db, brainId: string, address: string): Promise<Row | undefined> {
  return db.one(
    `SELECT p.* FROM page_addresses a JOIN pages p ON p.id = a.page_id
      WHERE a.brain_id = $1 AND a.address = $2`,
    [brainId, address],
  )
}

export type LinkView = {
  kind: LinkKind | 'mentions'
  address: string
  pageId: string | null
  title: string | null
  state: 'ok' | 'broken' | 'stale' | 'retired' | 'superseded'
}

const stateOf = (status: unknown): LinkView['state'] =>
  status == null
    ? 'broken'
    : status === 'retired' || status === 'superseded' || status === 'stale'
      ? status
      : 'ok'

export async function linksOf(db: Db, page: { id: string; brainId: string }) {
  const out = await db.query(
    // One row per kind and page: a body that mentions a page by its current and an old address names it
    // once; a page that mentions itself is not its own link.
    `SELECT * FROM (
       SELECT DISTINCT ON (l.kind, coalesce(p.id, l.to_address))
              l.kind, coalesce(p.address, l.to_address) AS address, p.id, p.title, p.status
         FROM page_links l
         LEFT JOIN page_addresses a ON l.to_page IS NULL AND a.brain_id = l.brain_id AND a.address = l.to_address
         LEFT JOIN pages p ON p.id = coalesce(l.to_page, a.page_id)
        WHERE l.from_page = $1 AND p.id IS DISTINCT FROM $1
        ORDER BY l.kind, coalesce(p.id, l.to_address)
     ) x ORDER BY kind, address`,
    [page.id],
  )
  const inbound = await db.query(
    `SELECT DISTINCT l.kind, p.address, p.id, p.title, p.status
       FROM page_links l JOIN pages p ON p.id = l.from_page
      WHERE l.from_page <> $1 AND (l.to_page = $1
             OR (l.to_page IS NULL AND l.brain_id = $2
                 AND l.to_address IN (SELECT address FROM page_addresses WHERE page_id = $1)))
      ORDER BY l.kind, p.address`,
    [page.id, page.brainId],
  )
  const view = (r: Row): LinkView => ({
    kind: r.kind as LinkView['kind'],
    address: String(r.address),
    pageId: r.id == null ? null : String(r.id),
    title: r.title == null ? null : String(r.title),
    state: stateOf(r.status),
  })
  return { out: out.map(view), in: inbound.map(view) }
}

export type SourceView =
  | { entryId: string; title: string | null; state: 'active' | 'forgotten' | 'purged' }
  | { url: string; title: string | null }

export async function sourcesOf(db: Db, pageId: string): Promise<SourceView[]> {
  const rows = await db.query(
    `SELECT s.entry_id, s.url, s.title AS url_title, e.title, e.state
       FROM page_sources s LEFT JOIN entries e ON e.id = s.entry_id
      WHERE s.page_id = $1 ORDER BY s.entry_id NULLS LAST, s.url`,
    [pageId],
  )
  return rows.map((r) =>
    r.entry_id != null
      ? {
          entryId: String(r.entry_id),
          // A forgotten or purged source keeps its place but not its words.
          title: r.state === 'active' ? String(r.title) : null,
          state: r.state as 'active' | 'forgotten' | 'purged',
        }
      : { url: String(r.url), title: r.url_title == null ? null : String(r.url_title) },
  )
}

export async function currentSources(db: Db, pageId: string): Promise<Source[]> {
  const rows = await db.query('SELECT entry_id, url, title FROM page_sources WHERE page_id = $1', [pageId])
  return rows.map((r) =>
    r.entry_id != null
      ? { entryId: String(r.entry_id) }
      : r.title == null
        ? { url: String(r.url) }
        : { url: String(r.url), title: String(r.title) },
  )
}

// The references a correction written in the web uses for these pages: "page:<address>" for every address
// each has had (the current one and those it moved from).
export async function pageRefs(db: Db, brainId: string, pageIds: string[]): Promise<string[]> {
  if (pageIds.length === 0) return []
  const rows = await db.query<{ address: string }>(
    `SELECT address FROM page_addresses WHERE brain_id = $1 AND page_id = ANY($2)
      UNION SELECT address FROM pages WHERE brain_id = $1 AND id = ANY($2)`,
    [brainId, pageIds],
  )
  return rows.map((r) => `page:${r.address}`)
}

// The corrections in force about a page, newest first («Something wrong here?»): written in the web about
// it under any of its addresses, not forgotten, superseded or expired.
export type PageCorrection = {
  id: string
  title: string
  appliesTo: string | null
  author: { id: string; name: string }
  createdAt: string
}

async function correctionsOf(ctx: Ctx, page: { id: string; brainId: string }): Promise<PageCorrection[]> {
  const rows = await ctx.db.query(
    `SELECT e.id, e.title, e.applies_to, e.created_at, a.id AS a_id, a.name AS a_name
       FROM entries e JOIN accounts a ON a.id = e.author_id
      WHERE e.brain_id = $1 AND e.type = 'correction' AND e.state = 'active' AND e.superseded_by IS NULL
        AND (e.expires_at IS NULL OR e.expires_at > $2) AND e.refs && $3::text[]
      ORDER BY e.created_at DESC, e.id LIMIT 20`,
    [page.brainId, ctx.clock(), await pageRefs(ctx.db, page.brainId, [page.id])],
  )
  return rows.map((r) => ({
    id: String(r.id),
    title: String(r.title),
    appliesTo: r.applies_to == null ? null : String(r.applies_to),
    author: { id: String(r.a_id), name: String(r.a_name) },
    createdAt: (r.created_at as Date).toISOString(),
  }))
}

export type PageReading = {
  page: WikiPage
  redirectedFrom?: string
  notice?: string
  links: { out: LinkView[]; in: LinkView[] }
  sources: SourceView[]
  // Who saved the revision the page is at (an edit that meets a newer revision names them).
  lastChange: { revision: number; authorId: string; authorName: string; at: string } | null
  corrections: PageCorrection[]
}

async function lastChangeOf(db: Db, pageId: string, revision: number): Promise<PageReading['lastChange']> {
  const r = await db.one(
    `SELECT r.revision, r.author_id, a.name, r.created_at FROM page_revisions r
       LEFT JOIN accounts a ON a.id = r.author_id WHERE r.page_id = $1 AND r.revision = $2`,
    [pageId, revision],
  )
  return r
    ? {
        revision: Number(r.revision),
        authorId: String(r.author_id),
        authorName: r.name == null ? '' : String(r.name),
        at: (r.created_at as Date).toISOString(),
      }
    : null
}

export async function getPage(ctx: Ctx, slug: string, address: string): Promise<PageReading> {
  const { brain } = await inBrain(ctx, { slug })
  const row = await resolve(ctx.db, brain.id, address)
  if (!row) throw pageNotFound(address)
  const page = pageOf(row)
  const out: PageReading = {
    page,
    links: await linksOf(ctx.db, page),
    sources: await sourcesOf(ctx.db, page.id),
    lastChange: await lastChangeOf(ctx.db, page.id, page.revision),
    corrections: await correctionsOf(ctx, page),
  }
  if (page.address !== address) out.redirectedFrom = address
  if (page.status === 'retired') out.notice = 'retired: this page is kept for its history only.'
  if (page.status === 'superseded' && page.supersededBy) {
    const s = await ctx.db.one('SELECT address FROM pages WHERE id = $1', [page.supersededBy])
    out.notice = `superseded by "${s?.address ?? '?'}".`
  }
  return out
}

export type RevisionSummary = {
  revision: number
  address: string
  title: string
  status: PageStatus
  kind: 'proposal' | 'direct' | 'revert' | 'purge'
  change: RevisionChange
  restoredFrom: number | null
  reason: string | null
  authorId: string
  // Who made it, by name, for a person reading the history (spec B6 «Wiki › Page»).
  authorName: string
  proposalId: string | null
  corrected: boolean
  baseReviewed: boolean
  purged: { by: string; at: string; reason: string } | null
  createdAt: string
}

// What kind of change made a revision, from the revision before it (spec B6 «Wiki › Page», review of
// PR19): one operation leaves one revision, so a new address is a move, a new status a status change,
// other typed links a link or an unlink, and anything else an edit.
export type RevisionChange = 'created' | 'edited' | 'linked' | 'status' | 'moved' | 'restored'

function changeOf(r: Row): RevisionChange {
  if (r.kind === 'revert') return 'restored'
  if (r.prev_revision == null) return 'created'
  if (r.address !== r.prev_address) return 'moved'
  if (r.status !== r.prev_status) return 'status'
  if (JSON.stringify(r.links ?? []) !== JSON.stringify(r.prev_links ?? [])) return 'linked'
  return 'edited'
}

const revisionSummary = (r: Row): RevisionSummary => ({
  revision: Number(r.revision),
  address: String(r.address),
  title: r.purged_at ? '[purged]' : String(r.title),
  status: r.status as PageStatus,
  kind: r.kind as RevisionSummary['kind'],
  change: changeOf(r),
  restoredFrom:
    r.kind === 'revert' ? Number(/back to revision (\d+)/.exec(String(r.note ?? ''))?.[1]) || null : null,
  // The curator's reason for a change by hand or a restore; the operation's for a proposal.
  reason: r.purged_at || r.why == null ? null : String(r.why),
  authorId: String(r.author_id),
  authorName: r.author_name == null ? '' : String(r.author_name),
  proposalId: r.proposal_id == null ? null : String(r.proposal_id),
  corrected: Boolean(r.corrected),
  baseReviewed: Boolean(r.base_reviewed),
  purged: r.purged_at
    ? { by: String(r.purged_by), at: (r.purged_at as Date).toISOString(), reason: String(r.purged_reason) }
    : null,
  createdAt: (r.created_at as Date).toISOString(),
})

// Every revision of a page with its author's name, its reason and the revision before it (to say what
// kind of change it was).
const REVISIONS = `SELECT r.*, a.name AS author_name, coalesce(r.reason, o.op ->> 'reason') AS why,
         lag(r.revision) OVER w AS prev_revision, lag(r.address) OVER w AS prev_address,
         lag(r.status) OVER w AS prev_status, lag(r.links) OVER w AS prev_links
    FROM page_revisions r
    LEFT JOIN accounts a ON a.id = r.author_id
    LEFT JOIN proposal_ops o ON o.proposal_id = r.proposal_id AND o.idx = r.op_index
   WHERE r.page_id = $1
  WINDOW w AS (ORDER BY r.revision)`

export async function pageHistory(ctx: Ctx, slug: string, address: string): Promise<RevisionSummary[]> {
  const { page } = await getPage(ctx, slug, address)
  return historyOf(ctx.db, page.id)
}

export async function historyOf(db: Db, pageId: string): Promise<RevisionSummary[]> {
  const rows = await db.query(`${REVISIONS} ORDER BY r.revision`, [pageId])
  return rows.map(revisionSummary)
}

export type FullRevision = RevisionSummary & {
  type: PageType
  summary: string
  body: string
  tags: string[]
  sources: Source[]
  links: { kind: LinkKind; to: string }[]
}

export const fullRevision = (r: Row): FullRevision => ({
  ...revisionSummary(r),
  type: r.type as PageType,
  summary: r.purged_at ? '' : String(r.summary),
  body: r.purged_at ? '' : String(r.body),
  tags: r.purged_at ? [] : ((r.tags as string[]) ?? []),
  sources: r.purged_at ? [] : ((r.sources as Source[]) ?? []),
  links: r.purged_at ? [] : ((r.links as FullRevision['links']) ?? []),
})

export async function pageRevision(
  ctx: Ctx,
  slug: string,
  address: string,
  n: number,
): Promise<FullRevision> {
  const { page } = await getPage(ctx, slug, address)
  const r = await ctx.db.one(`SELECT * FROM (${REVISIONS}) x WHERE x.revision = $2`, [page.id, n])
  if (!r) {
    throw new AppError(
      404,
      'revision_not_found',
      `Page "${page.address}" has no revision ${n}.`,
      'See its history.',
    )
  }
  return fullRevision(r)
}

export type MapGroup = {
  type: PageType
  area: string
  pages: { address: string; title: string; summary: string; tags: string[]; status: PageStatus }[]
}

// The map: every current page, grouped by type and by the first part of its address, with its summary
// (B2). `all`: every page whatever its status, each saying it (the web's map, which filters by status).
export async function wikiMap(
  ctx: Ctx,
  slug: string,
  o: { all?: boolean } = {},
): Promise<{ intro: string; groups: MapGroup[]; count: number }> {
  const { brain } = await inBrain(ctx, { slug })
  const s = await settingsOf(ctx.db, brain.id)
  const rows = await ctx.db.query(
    `SELECT address, type, title, summary, tags, status FROM pages
      WHERE brain_id = $1 AND ($2 OR status = 'current')
      ORDER BY type, split_part(address, '/', 1), address`,
    [brain.id, Boolean(o.all)],
  )
  const groups: MapGroup[] = []
  for (const r of rows) {
    const area = String(r.address).split('/')[0] as string
    let g = groups.at(-1)
    if (!g || g.type !== r.type || g.area !== area) {
      g = { type: r.type as PageType, area, pages: [] }
      groups.push(g)
    }
    g.pages.push({
      address: String(r.address),
      title: String(r.title),
      summary: String(r.summary),
      tags: (r.tags as string[]) ?? [],
      status: r.status as PageStatus,
    })
  }
  return { intro: s.mapIntro, groups, count: rows.length }
}

// The decisions, newest first, with their state (retired ones are left out).
export async function wikiDecisions(ctx: Ctx, slug: string) {
  const { brain } = await inBrain(ctx, { slug })
  const rows = await ctx.db.query(
    `SELECT address, title, summary, status, created_at, updated_at FROM pages
      WHERE brain_id = $1 AND type = 'decision' AND status <> 'retired' ORDER BY created_at DESC, id DESC`,
    [brain.id],
  )
  return rows.map((r) => ({
    address: String(r.address),
    title: String(r.title),
    summary: String(r.summary),
    status: r.status as PageStatus,
    createdAt: (r.created_at as Date).toISOString(),
    updatedAt: (r.updated_at as Date).toISOString(),
  }))
}

export type LogLine = {
  id: string
  at: string
  actorId: string
  actorName: string
  kind: LogKind
  proposalId: string | null
  summary: string
  // Why: the curator's for a change by hand, the proposal's for an approval.
  reason: string | null
  pages: string[]
}

export const LOG_KINDS = ['proposal', 'direct', 'revert', 'purge'] as const
export type LogKind = (typeof LOG_KINDS)[number]

// The log, newest first; by kind of change and by a page it touched, when asked.
export async function wikiLog(
  ctx: Ctx,
  slug: string,
  o: { cursor?: string; limit?: number; kind?: string; page?: string } = {},
): Promise<PageOf<LogLine>> {
  if (o.kind !== undefined && !(LOG_KINDS as readonly string[]).includes(o.kind))
    throw invalid(`"kind" is one of: ${LOG_KINDS.join(', ')}.`, 'Fix "kind".')
  const { brain } = await inBrain(ctx, { slug })
  const c = decode(o.cursor)
  const limit = o.limit ?? PAGE.default
  const only = `($2::text IS NULL OR l.kind = $2) AND ($3::text IS NULL OR $3 = ANY(l.pages))`
  const rows = await ctx.db.query(
    `SELECT l.*, a.name AS actor_name, coalesce(l.reason, pr.reason) AS why
       FROM wiki_log l LEFT JOIN accounts a ON a.id = l.actor_id LEFT JOIN proposals pr ON pr.id = l.proposal_id
      WHERE l.brain_id = $1 AND ${only}
        AND ($4::timestamptz IS NULL OR (l.at, l.id) < ($4, $5))
      ORDER BY l.at DESC, l.id DESC LIMIT $6`,
    [brain.id, o.kind ?? null, o.page ?? null, c?.at ?? null, c?.id ?? '', limit + 1],
  )
  const total = await ctx.db.one<{ n: number }>(
    `SELECT count(*)::int AS n FROM wiki_log l WHERE l.brain_id = $1 AND ${only}`,
    [brain.id, o.kind ?? null, o.page ?? null],
  )
  const page = rows.slice(0, limit)
  const last = page.at(-1)
  return {
    items: page.map((r) => ({
      id: String(r.id),
      at: (r.at as Date).toISOString(),
      actorId: String(r.actor_id),
      actorName: r.actor_name == null ? '' : String(r.actor_name),
      kind: r.kind as LogLine['kind'],
      proposalId: r.proposal_id == null ? null : String(r.proposal_id),
      summary: String(r.summary),
      reason: r.why == null || r.kind === 'purge' ? null : String(r.why),
      pages: (r.pages as string[]) ?? [],
    })),
    total: total?.n ?? 0,
    next: rows.length > limit && last ? encode(last.at as Date, String(last.id)) : null,
  }
}

export type WikiSettings = {
  guide: string
  customGuide: boolean
  mapIntro: string
  usageNote: string
  meaningExcluded: boolean
  staleDays: number
  longChars: number
  maintenanceEvery: number
  approvalsSince: number
}

export const DEFAULT_GUIDE = `How to compile this brain's journal into its wiki.

- One page per topic, entity, decision, guide or agent. Short pages; split rather than grow.
- Every new page cites the journal entries it comes from. Never write what no entry says.
- Link before you repeat: mention other pages with [[address]] and add typed links (related,
  depends-on, contradicts, supersedes, part-of, example-of) where they hold.
- One decision per "decision" page: context, what was decided, alternatives, consequences, status.
- Corrections from people win over what agents wrote. Fold them into the pages they correct.
- When entries add nothing new, list them as "collected" so they leave the uncompiled list.
- Prefer editing an existing page over creating a near-duplicate; propose a merge when two overlap.
- Say why in every operation's reason. A curator reads it before approving.`

export async function settingsOf(db: Db, brainId: string): Promise<WikiSettings> {
  const r = await db.one('SELECT * FROM wiki_settings WHERE brain_id = $1', [brainId])
  return {
    guide: r?.guide == null ? DEFAULT_GUIDE : String(r.guide),
    customGuide: r?.guide != null,
    mapIntro: r ? String(r.map_intro) : '',
    usageNote: r ? String(r.usage_note) : '',
    meaningExcluded: Boolean(r?.meaning_excluded),
    staleDays: r ? Number(r.stale_days) : 90,
    longChars: r ? Number(r.long_chars) : 20_000,
    maintenanceEvery: r ? Number(r.maintenance_every) : 20,
    approvalsSince: r ? Number(r.approvals_since) : 0,
  }
}

export type PageListItem = {
  address: string
  title: string
  type: PageType
  status: PageStatus
  tags: string[]
  in: number
  out: number
  updatedAt: string
}

export type PageListQuery = {
  q?: string
  prefix?: string
  type?: string
  status?: string
  tag?: string
  linkKind?: string
  sort?: string
  cursor?: string
  limit?: number
}

// The columns the list sorts by ("-" before one: the other way), each with its tie broken by address.
const SORTS = {
  address: 'p.address COLLATE "C"',
  title: 'p.title COLLATE "C"',
  type: 'p.type',
  status: 'p.status',
  in: 'in_n',
  out: 'out_n',
  updatedAt: 'p.updated_at',
} as const
export const PAGE_SORTS = Object.keys(SORTS) as (keyof typeof SORTS)[]

// The cursor of the list: in address order, the last address given (the next page starts after it); in
// any other order, how many came before ("#" and the number: no address starts with "#").
const cursorOf = (address: string) => Buffer.from(address, 'utf8').toString('base64url')
function cursorFrom(cursor: string): { after: string } | { offset: number } {
  const a = Buffer.from(cursor, 'base64url').toString('utf8')
  if (/^#\d{1,7}$/.test(a)) return { offset: Number(a.slice(1)) }
  if (!a || a.length > 400 || a.startsWith('#'))
    throw invalid('"cursor" is not one this list gave.', 'Use "next" unchanged.')
  return { after: a }
}
const likeText = (s: string) => s.replace(/[\\%_]/g, (c) => `\\${c}`)

// The pages of a wiki by pages, with how many pages link in and out (spec B6 «Graph», plan §3.5 G9): the list
// beside the graph and the `[[` autocomplete of the editor. Every status unless `status` (one or more) says
// otherwise; the other filters are the graph's (a link kind: pages with a link of that kind, either way). The
// counts are the graph's too: links between pages that exist and are not retired, worked out once for the
// brain (never once a row). In address order unless `sort` says otherwise.
export async function listPages(
  ctx: Ctx,
  slug: string,
  o: PageListQuery = {},
): Promise<PageOf<PageListItem>> {
  checkFilters(o)
  const desc = o.sort?.startsWith('-') ?? false
  const column = (o.sort === undefined ? 'address' : o.sort.replace(/^-/, '')) as keyof typeof SORTS
  if (!(PAGE_SORTS as string[]).includes(column))
    throw invalid(
      `"sort" is one of: ${PAGE_SORTS.join(', ')}, with "-" before it for the other way.`,
      'Fix "sort".',
    )
  const { brain } = await inBrain(ctx, { slug })
  const limit = o.limit ?? PAGE.default
  const params: unknown[] = [brain.id]
  const p = (v: unknown) => {
    params.push(v)
    return `$${params.length}`
  }
  const where = ['p.brain_id = $1']
  if (o.q !== undefined) {
    const like = p(`%${likeText(o.q)}%`)
    where.push(`(p.address ILIKE ${like} OR p.title ILIKE ${like})`)
  }
  if (o.prefix !== undefined)
    where.push(`(p.address = ${p(o.prefix)} OR p.address LIKE ${p(`${likeText(o.prefix)}/%`)})`)
  if (o.type !== undefined) where.push(`p.type = ${p(o.type)}`)
  if (o.status !== undefined) where.push(`p.status = ANY(${p(o.status.split(','))}::text[])`)
  if (o.tag !== undefined) where.push(`${p(o.tag)} = ANY(p.tags)`)
  if (o.linkKind !== undefined) {
    // A semi-join on the set of pages with such a link (a hash, not a scan of the links for every page).
    const k = p(o.linkKind)
    where.push(
      `p.id IN (SELECT from_page FROM l WHERE kind = ${k} UNION SELECT to_id FROM l WHERE kind = ${k})`,
    )
  }
  const filtered = where.join(' AND ')
  // Every link of the brain between two pages that exist and are not retired (a mention through any address
  // the page it leads to ever had), once per kind: what the graph draws.
  const links = `WITH l AS MATERIALIZED (
      SELECT DISTINCT l.from_page, t.id AS to_id, l.kind
        FROM page_links l
        JOIN pages f ON f.id = l.from_page AND f.status <> 'retired'
        LEFT JOIN page_addresses a ON l.to_page IS NULL AND a.brain_id = l.brain_id AND a.address = l.to_address
        JOIN pages t ON t.id = coalesce(l.to_page, a.page_id) AND t.status <> 'retired'
       WHERE l.brain_id = $1 AND t.id <> l.from_page)`
  const total = await ctx.db.one<{ n: number }>(
    `${links} SELECT count(*)::int AS n FROM pages p WHERE ${filtered}`,
    [...params],
  )
  const c = o.cursor === undefined ? null : cursorFrom(o.cursor)
  if (c && column === 'address' && !desc && !('after' in c))
    throw invalid('"cursor" is not one this list gave.', 'Use "next" unchanged.')
  if (c && (column !== 'address' || desc) && !('offset' in c))
    throw invalid('"cursor" is not one this list gave.', 'Use "next" unchanged.')
  const keyset = c && 'after' in c ? ` AND p.address COLLATE "C" > ${p(c.after)}` : ''
  const offset = c && 'offset' in c ? c.offset : 0
  const dir = desc ? 'DESC' : 'ASC'
  const order =
    column === 'address' ? `p.address COLLATE "C" ${dir}` : `${SORTS[column]} ${dir}, p.address COLLATE "C"`
  const rows = await ctx.db.query(
    `${links},
     o AS (SELECT from_page AS id, count(DISTINCT to_id)::int AS n FROM l GROUP BY from_page),
     i AS (SELECT to_id AS id, count(DISTINCT from_page)::int AS n FROM l GROUP BY to_id)
     SELECT p.address, p.title, p.type, p.status, p.tags, p.updated_at,
            coalesce(o.n, 0) AS out_n, coalesce(i.n, 0) AS in_n
       FROM pages p LEFT JOIN o ON o.id = p.id LEFT JOIN i ON i.id = p.id
      WHERE ${filtered}${keyset}
      ORDER BY ${order} LIMIT ${p(limit + 1)} OFFSET ${p(offset)}`,
    params,
  )
  const items = rows.slice(0, limit).map(
    (r): PageListItem => ({
      address: String(r.address),
      title: String(r.title),
      type: r.type as PageType,
      status: r.status as PageStatus,
      tags: (r.tags as string[]) ?? [],
      in: Number(r.in_n),
      out: Number(r.out_n),
      updatedAt: (r.updated_at as Date).toISOString(),
    }),
  )
  const last = items.at(-1)
  const more = rows.length > limit && last
  const next = !more
    ? null
    : column === 'address' && !desc
      ? cursorOf(last.address)
      : cursorOf(`#${offset + limit}`)
  return { items, total: total?.n ?? 0, next }
}
