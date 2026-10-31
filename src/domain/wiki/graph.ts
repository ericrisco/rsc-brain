// The graph of a wiki (spec B6 «Graph», plan §3.5 G10): one node a page and one edge a link, retired pages
// left out, superseded ones kept with their status. Up to 2 000 pages it comes whole; above that, as groups
// by the first part of the address, and each group opens on its own (`prefix`). Nodes and edges are arrays
// and edges point at nodes by index, so 2 000 pages stay within the size of an answer (spec B5); an answer
// that would still pass it comes as groups, or, for one group, says it is too big (the list has it all).
import { invalid } from '../../core/errors.ts'
import type { Db } from '../../db/db.ts'
import { type Ctx, inBrain } from '../context.ts'
import { LINK_KINDS, PAGE_STATUSES, PAGE_TYPES } from './model.ts'

export const GRAPH_MAX_PAGES = 2000
// A body mentions a page with [[address]]; the typed links come after. Edges carry the index of their kind.
export const GRAPH_KINDS = ['mentions', ...LINK_KINDS] as const

export type GraphPage = { address: string; title: string; type: string; status: string; tags: string[] }
export type GraphLink = { from: string; to: string; kind: string }
export type GraphNode = [address: string, title: string, type: string, status: string, tags: string[]]
export type GraphGroup = { prefix: string; count: number; types: Record<string, number> }

export type GraphView = {
  mode: 'pages' | 'groups' | 'too-big'
  prefix: string | null
  // The pages this view stands for: the whole wiki, or the group.
  total: number
  kinds: readonly string[]
  nodes: GraphNode[]
  // [from node, to node, kind index]
  edges: [number, number, number][]
  // In one group: [node, other group, links between them both ways].
  across: [number, string, number][]
  // The groups of the wiki; in one group, the other groups its pages link with.
  groups: GraphGroup[]
  // [group, group, links between them both ways], the two in order.
  groupEdges: [string, string, number][]
}

const byText = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0)
const depthOf = (prefix: string | null) => (prefix === null ? 0 : prefix.split('/').length)
// The group an address is in, `depth` parts deep (a shorter address is its own key).
const keyAt = (address: string, depth: number) =>
  address
    .split('/')
    .slice(0, depth + 1)
    .join('/')
const under = (prefix: string | null, address: string) =>
  prefix === null || address === prefix || address.startsWith(`${prefix}/`)
// The widest group that holds `address` and not `prefix`: what a link out of the group leads to.
function outer(prefix: string, address: string): string {
  const a = address.split('/')
  const p = prefix.split('/')
  let common = 0
  while (common < p.length && a[common] === p[common]) common += 1
  return a.slice(0, common + 1).join('/')
}

export type GraphFilters = { q?: string; type?: string; status?: string; tag?: string; linkKind?: string }

// The filters the graph and the list share, checked the same way for both: a type, one or more statuses
// (comma separated), a link kind, and words, a tag and a prefix of at most 200 characters.
export function checkFilters(o: GraphFilters & { prefix?: string }): void {
  if (o.type !== undefined && !(PAGE_TYPES as readonly string[]).includes(o.type))
    throw invalid(`"type" is one of: ${PAGE_TYPES.join(', ')}.`, 'Fix "type".')
  if (
    o.status !== undefined &&
    !o.status.split(',').every((x) => (PAGE_STATUSES as readonly string[]).includes(x))
  )
    throw invalid(
      `"status" is one or more of: ${PAGE_STATUSES.join(', ')}, separated by commas.`,
      'Fix "status".',
    )
  if (o.linkKind !== undefined && !(GRAPH_KINDS as readonly string[]).includes(o.linkKind))
    throw invalid(`"linkKind" is one of: ${GRAPH_KINDS.join(', ')}.`, 'Fix "linkKind".')
  for (const [k, v] of [
    ['q', o.q],
    ['prefix', o.prefix],
    ['tag', o.tag],
  ] as const) {
    if (v !== undefined && v.length > 200)
      throw invalid(`"${k}" has at most 200 characters.`, `Shorten "${k}".`)
  }
}

function groupsOf(pages: GraphPage[], keyOf: (address: string) => string | null): GraphGroup[] {
  const by = new Map<string, GraphGroup>()
  for (const p of pages) {
    const prefix = keyOf(p.address)
    if (prefix === null) continue
    let g = by.get(prefix)
    if (!g) {
      g = { prefix, count: 0, types: {} }
      by.set(prefix, g)
    }
    g.count += 1
    g.types[p.type] = (g.types[p.type] ?? 0) + 1
  }
  // Types in name order, so the same wiki always reads the same.
  return [...by.values()]
    .sort((a, b) => byText(a.prefix, b.prefix))
    .map((g) => ({
      ...g,
      types: Object.fromEntries(Object.entries(g.types).sort(([a], [b]) => byText(a, b))),
    }))
}

const fits = (v: GraphView, maxChars: number) => JSON.stringify(v).length <= maxChars

// What the graph shows of a wiki: the pages of `prefix` (the whole wiki without one), or, when they are more
// than `max` or would not fit, the groups one part of the address deeper, with any page that sits at the
// prefix itself beside them. More groups than `max`: too big (the list has them all). The filters (the same as
// the list's) narrow what is counted and drawn; whether it comes as pages or groups is decided by all pages, so
// filtering never reshapes the picture.
export function graphView(
  allPages: GraphPage[],
  allLinks: GraphLink[],
  o: { prefix?: string; max?: number; maxChars?: number; filters?: GraphFilters } = {},
): GraphView {
  const max = o.max ?? GRAPH_MAX_PAGES
  // The route passes the size of an answer (spec B5); without it nothing is too big.
  const maxChars = o.maxChars ?? Number.POSITIVE_INFINITY
  const prefix = o.prefix ?? null
  const f = o.filters ?? {}
  const depth = depthOf(prefix)
  const pages = allPages.filter((p) => p.status !== 'retired').sort((a, b) => byText(a.address, b.address))
  const known = new Set(pages.map((p) => p.address))
  const kindOf = new Map<string, number>(GRAPH_KINDS.map((k, i) => [k, i]))
  let links = allLinks.filter(
    (l) => l.from !== l.to && known.has(l.from) && known.has(l.to) && kindOf.has(l.kind),
  )
  const members = pages.filter((p) => under(prefix, p.address))
  // The filters: words, type, statuses (a comma list), tag, and a link kind (pages with one, either way).
  const q = f.q?.trim().toLowerCase() ?? ''
  const statuses = f.status ? f.status.split(',') : null
  if (f.linkKind) links = links.filter((l) => l.kind === f.linkKind)
  const kinded = new Set(links.flatMap((l) => [l.from, l.to]))
  const shown = (p: GraphPage) =>
    (!q || p.address.includes(q) || p.title.toLowerCase().includes(q)) &&
    (!f.type || p.type === f.type) &&
    (!statuses || statuses.includes(p.status)) &&
    (!f.tag || p.tags.includes(f.tag)) &&
    (!f.linkKind || kinded.has(p.address))
  const filtering = Boolean(q || f.type || statuses || f.tag || f.linkKind)
  const kept = filtering ? pages.filter(shown) : pages
  const keptSet = new Set(kept.map((p) => p.address))
  if (filtering) links = links.filter((l) => keptSet.has(l.from) && keptSet.has(l.to))
  const inside = kept.filter((p) => under(prefix, p.address))
  const empty = { kinds: GRAPH_KINDS, nodes: [], edges: [], across: [], groups: [], groupEdges: [] }
  const nodeOf = (p: GraphPage): GraphNode => [p.address, p.title, p.type, p.status, p.tags]

  // [node, group, links both ways] for links between `nodes` and pages outside them, by `groupOf`.
  const acrossOf = (index: Map<string, number>, groupOf: (address: string) => string | null) => {
    const across = new Map<string, number>()
    for (const l of links) {
      const i = index.get(l.from)
      const j = index.get(l.to)
      if ((i === undefined) === (j === undefined)) continue
      const other = groupOf(i === undefined ? l.from : l.to)
      if (other === null) continue
      const key = `${i ?? j} ${other}`
      across.set(key, (across.get(key) ?? 0) + 1)
    }
    return [...across]
      .map(([key, n]): [number, string, number] => {
        const at = key.indexOf(' ')
        return [Number(key.slice(0, at)), key.slice(at + 1), n]
      })
      .sort((a, b) => a[0] - b[0] || byText(a[1], b[1]))
  }

  const asPages = (): GraphView => {
    const index = new Map(inside.map((p, i) => [p.address, i]))
    const seen = new Set<string>()
    const edges: [number, number, number][] = []
    for (const l of links) {
      const i = index.get(l.from)
      const j = index.get(l.to)
      if (i === undefined || j === undefined) continue
      const k = kindOf.get(l.kind) as number
      const key = `${i} ${j} ${k}`
      if (seen.has(key)) continue
      seen.add(key)
      edges.push([i, j, k])
    }
    edges.sort((a, b) => a[0] - b[0] || a[1] - b[1] || a[2] - b[2])
    const across = prefix === null ? [] : acrossOf(index, (a) => outer(prefix, a))
    const touched = new Set(across.map((x) => x[1]))
    return {
      ...empty,
      mode: 'pages',
      prefix,
      total: inside.length,
      nodes: inside.map(nodeOf),
      edges,
      across,
      groups:
        prefix === null
          ? []
          : groupsOf(kept, (a) => (under(prefix, a) ? null : outer(prefix, a))).filter((g) =>
              touched.has(g.prefix),
            ),
    }
  }

  const asGroups = (): GraphView => {
    // A page at the prefix itself is not a group of its own: it is drawn beside the groups.
    const loose = inside.filter((p) => p.address === prefix)
    const groupOf = (a: string) => (a === prefix || !under(prefix, a) ? null : keyAt(a, depth))
    const between = new Map<string, number>()
    for (const l of links) {
      const a = groupOf(l.from)
      const b = groupOf(l.to)
      if (a === null || b === null || a === b) continue
      const key = a < b ? `${a} ${b}` : `${b} ${a}`
      between.set(key, (between.get(key) ?? 0) + 1)
    }
    const index = new Map(loose.map((p, i) => [p.address, i]))
    return {
      ...empty,
      mode: 'groups',
      prefix,
      total: inside.length,
      nodes: loose.map(nodeOf),
      across: acrossOf(index, groupOf),
      groups: groupsOf(inside, groupOf),
      groupEdges: [...between]
        .map(([key, n]): [string, string, number] => {
          const [a, b] = key.split(' ') as [string, string]
          return [a, b, n]
        })
        .sort((x, y) => byText(x[0], y[0]) || byText(x[1], y[1])),
    }
  }

  const tooBig: GraphView = { ...empty, mode: 'too-big', prefix, total: inside.length }
  if (members.length <= max) {
    const v = asPages()
    if (fits(v, maxChars)) return v
  }
  // Groups: as many as the pages unfiltered would make (the picture keeps its shape under a filter).
  const keys = new Set(members.filter((p) => p.address !== prefix).map((p) => keyAt(p.address, depth)))
  if (keys.size > max) return tooBig
  const g = asGroups()
  return fits(g, maxChars) ? g : tooBig
}

// Every page of a brain that is not retired, and every link between two of them with both ends resolved
// to a current address (a mention names an address, which may be an old one of the page it leads to).
export async function graphData(
  db: Db,
  brainId: string,
): Promise<{ pages: GraphPage[]; links: GraphLink[] }> {
  const pages = await db.query(
    `SELECT address, title, type, status, tags FROM pages
      WHERE brain_id = $1 AND status <> 'retired' ORDER BY address COLLATE "C"`,
    [brainId],
  )
  const links = await db.query(
    `SELECT DISTINCT f.address AS "from", t.address AS "to", l.kind
       FROM page_links l
       JOIN pages f ON f.id = l.from_page
       LEFT JOIN page_addresses a ON l.to_page IS NULL AND a.brain_id = l.brain_id AND a.address = l.to_address
       JOIN pages t ON t.id = coalesce(l.to_page, a.page_id)
      WHERE l.brain_id = $1 AND f.status <> 'retired' AND t.status <> 'retired' AND t.id <> f.id`,
    [brainId],
  )
  return {
    pages: pages.map((r) => ({
      address: String(r.address),
      title: String(r.title),
      type: String(r.type),
      status: String(r.status),
      tags: (r.tags as string[]) ?? [],
    })),
    links: links.map((r) => ({ from: String(r.from), to: String(r.to), kind: String(r.kind) })),
  }
}

// A group: one or more parts of an address.
export const PREFIX = /^[a-z0-9]+(-[a-z0-9]+)*(\/[a-z0-9]+(-[a-z0-9]+)*)*$/

// The graph of a brain's wiki, whole or one group (any member reads it, like every reading of the wiki).
export async function wikiGraph(
  ctx: Ctx,
  slug: string,
  o: GraphFilters & { prefix?: string; maxChars: number },
): Promise<GraphView> {
  if (o.prefix !== undefined && !PREFIX.test(o.prefix))
    throw invalid(
      '"prefix" is the start of an address: one or more parts of lowercase letters, digits and dashes, split by "/".',
      'Fix "prefix".',
    )
  checkFilters(o)
  const { brain } = await inBrain(ctx, { slug })
  const { pages, links } = await graphData(ctx.db, brain.id)
  const { maxChars, prefix, ...filters } = o
  return graphView(pages, links, { maxChars, filters, ...(prefix === undefined ? {} : { prefix }) })
}
