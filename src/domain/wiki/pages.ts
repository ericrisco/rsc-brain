// Reading the wiki (spec B2): a page by its address (old addresses redirect), its links both ways, its
// sources and history; the map, the decisions and the log, which are worked out when read so they
// never fall behind. Any member of the brain reads all of it.
import { AppError } from '../../core/errors.ts'
import type { Db, Row } from '../../db/db.ts'
import { type Ctx, inBrain } from '../context.ts'
import { decode, encode, PAGE, type Page as PageOf } from '../listing.ts'
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
  state: 'ok' | 'broken' | 'retired' | 'superseded'
}

const stateOf = (status: unknown): LinkView['state'] =>
  status == null ? 'broken' : status === 'retired' ? 'retired' : status === 'superseded' ? 'superseded' : 'ok'

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

export type PageReading = {
  page: WikiPage
  redirectedFrom?: string
  notice?: string
  links: { out: LinkView[]; in: LinkView[] }
  sources: SourceView[]
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
  authorId: string
  proposalId: string | null
  corrected: boolean
  baseReviewed: boolean
  purged: { by: string; at: string; reason: string } | null
  createdAt: string
}

const revisionSummary = (r: Row): RevisionSummary => ({
  revision: Number(r.revision),
  address: String(r.address),
  title: r.purged_at ? '[purged]' : String(r.title),
  status: r.status as PageStatus,
  kind: r.kind as RevisionSummary['kind'],
  authorId: String(r.author_id),
  proposalId: r.proposal_id == null ? null : String(r.proposal_id),
  corrected: Boolean(r.corrected),
  baseReviewed: Boolean(r.base_reviewed),
  purged: r.purged_at
    ? { by: String(r.purged_by), at: (r.purged_at as Date).toISOString(), reason: String(r.purged_reason) }
    : null,
  createdAt: (r.created_at as Date).toISOString(),
})

export async function pageHistory(ctx: Ctx, slug: string, address: string): Promise<RevisionSummary[]> {
  const { page } = await getPage(ctx, slug, address)
  const rows = await ctx.db.query('SELECT * FROM page_revisions WHERE page_id = $1 ORDER BY revision', [
    page.id,
  ])
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
  const r = await ctx.db.one('SELECT * FROM page_revisions WHERE page_id = $1 AND revision = $2', [
    page.id,
    n,
  ])
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
  pages: { address: string; title: string; summary: string }[]
}

// The map: every current page, grouped by type and by the first part of its address, with its summary.
export async function wikiMap(
  ctx: Ctx,
  slug: string,
): Promise<{ intro: string; groups: MapGroup[]; count: number }> {
  const { brain } = await inBrain(ctx, { slug })
  const s = await settingsOf(ctx.db, brain.id)
  const rows = await ctx.db.query(
    "SELECT address, type, title, summary FROM pages WHERE brain_id = $1 AND status = 'current' ORDER BY type, split_part(address, '/', 1), address",
    [brain.id],
  )
  const groups: MapGroup[] = []
  for (const r of rows) {
    const area = String(r.address).split('/')[0] as string
    let g = groups.at(-1)
    if (!g || g.type !== r.type || g.area !== area) {
      g = { type: r.type as PageType, area, pages: [] }
      groups.push(g)
    }
    g.pages.push({ address: String(r.address), title: String(r.title), summary: String(r.summary) })
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
  kind: 'proposal' | 'direct' | 'revert' | 'purge'
  proposalId: string | null
  summary: string
  pages: string[]
}

export async function wikiLog(
  ctx: Ctx,
  slug: string,
  o: { cursor?: string; limit?: number } = {},
): Promise<PageOf<LogLine>> {
  const { brain } = await inBrain(ctx, { slug })
  const c = decode(o.cursor)
  const limit = o.limit ?? PAGE.default
  const rows = await ctx.db.query(
    `SELECT * FROM wiki_log WHERE brain_id = $1 AND ($2::timestamptz IS NULL OR (at, id) < ($2, $3))
      ORDER BY at DESC, id DESC LIMIT $4`,
    [brain.id, c?.at ?? null, c?.id ?? '', limit + 1],
  )
  const total = await ctx.db.one<{ n: number }>(
    'SELECT count(*)::int AS n FROM wiki_log WHERE brain_id = $1',
    [brain.id],
  )
  const page = rows.slice(0, limit)
  const last = page.at(-1)
  return {
    items: page.map((r) => ({
      id: String(r.id),
      at: (r.at as Date).toISOString(),
      actorId: String(r.actor_id),
      kind: r.kind as LogLine['kind'],
      proposalId: r.proposal_id == null ? null : String(r.proposal_id),
      summary: String(r.summary),
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
    staleDays: r ? Number(r.stale_days) : 90,
    longChars: r ? Number(r.long_chars) : 20_000,
    maintenanceEvery: r ? Number(r.maintenance_every) : 20,
    approvalsSince: r ? Number(r.approvals_since) : 0,
  }
}
