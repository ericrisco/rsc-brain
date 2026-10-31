// The graph of a wiki (spec B6 «Graph», plan §3.5 G10): one node a page and one edge a link, retired pages
// left out, superseded ones kept with their status. Up to 2 000 pages it comes whole; above that, as groups
// by the first part of the address, and each group opens on its own (`prefix`). Nodes and edges are arrays
// and edges point at nodes by index, so 2 000 pages stay within the size of an answer (spec B5); an answer
// that would still pass it comes as groups, or, for one group, says it is too big (the list has it all).
import { invalid } from '../../core/errors.ts'
import type { Db } from '../../db/db.ts'
import { type Ctx, inBrain } from '../context.ts'
import { LINK_KINDS } from './model.ts'

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

const areaOf = (address: string) => address.split('/', 1)[0] as string
const byText = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0)

function groupsOf(pages: GraphPage[], keep: (prefix: string) => boolean = () => true): GraphGroup[] {
  const by = new Map<string, GraphGroup>()
  for (const p of pages) {
    const prefix = areaOf(p.address)
    if (!keep(prefix)) continue
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

export function graphView(
  allPages: GraphPage[],
  allLinks: GraphLink[],
  o: { prefix?: string; max?: number; maxChars?: number } = {},
): GraphView {
  const max = o.max ?? GRAPH_MAX_PAGES
  // The route passes the size of an answer (spec B5); without it nothing is too big.
  const maxChars = o.maxChars ?? Number.POSITIVE_INFINITY
  const prefix = o.prefix ?? null
  const pages = allPages.filter((p) => p.status !== 'retired').sort((a, b) => byText(a.address, b.address))
  const known = new Set(pages.map((p) => p.address))
  const kindOf = new Map<string, number>(GRAPH_KINDS.map((k, i) => [k, i]))
  const links = allLinks.filter(
    (l) => l.from !== l.to && known.has(l.from) && known.has(l.to) && kindOf.has(l.kind),
  )
  const inside = (a: string) => prefix === null || a === prefix || a.startsWith(`${prefix}/`)
  const members = pages.filter((p) => inside(p.address))
  const empty = { kinds: GRAPH_KINDS, nodes: [], edges: [], across: [], groups: [], groupEdges: [] }

  const asPages = (): GraphView => {
    const index = new Map(members.map((p, i) => [p.address, i]))
    const seen = new Set<string>()
    const edges: [number, number, number][] = []
    const across = new Map<string, number>()
    const others = new Set<string>()
    for (const l of links) {
      const i = index.get(l.from)
      const j = index.get(l.to)
      if (i !== undefined && j !== undefined) {
        const k = kindOf.get(l.kind) as number
        const key = `${i} ${j} ${k}`
        if (!seen.has(key)) {
          seen.add(key)
          edges.push([i, j, k])
        }
      } else if (prefix !== null && (i !== undefined || j !== undefined)) {
        const node = (i ?? j) as number
        const other = areaOf(i === undefined ? l.from : l.to)
        others.add(other)
        const key = `${node} ${other}`
        across.set(key, (across.get(key) ?? 0) + 1)
      }
    }
    edges.sort((a, b) => a[0] - b[0] || a[1] - b[1] || a[2] - b[2])
    return {
      ...empty,
      mode: 'pages',
      prefix,
      total: members.length,
      nodes: members.map((p) => [p.address, p.title, p.type, p.status, p.tags]),
      edges,
      across: [...across]
        .map(([key, n]): [number, string, number] => {
          const [node, other] = key.split(' ') as [string, string]
          return [Number(node), other, n]
        })
        .sort((a, b) => a[0] - b[0] || byText(a[1], b[1])),
      groups: groupsOf(pages, (g) => others.has(g)),
    }
  }

  const asGroups = (): GraphView => {
    const between = new Map<string, number>()
    for (const l of links) {
      const a = areaOf(l.from)
      const b = areaOf(l.to)
      if (a === b) continue
      const key = a < b ? `${a} ${b}` : `${b} ${a}`
      between.set(key, (between.get(key) ?? 0) + 1)
    }
    return {
      ...empty,
      mode: 'groups',
      prefix: null,
      total: pages.length,
      groups: groupsOf(pages),
      groupEdges: [...between]
        .map(([key, n]): [string, string, number] => {
          const [a, b] = key.split(' ') as [string, string]
          return [a, b, n]
        })
        .sort((x, y) => byText(x[0], y[0]) || byText(x[1], y[1])),
    }
  }

  const tooBig: GraphView = { ...empty, mode: 'too-big', prefix, total: members.length }
  if (members.length <= max) {
    const v = asPages()
    if (fits(v, maxChars)) return v
  }
  if (prefix !== null) return tooBig
  const g = asGroups()
  return fits(g, maxChars) ? g : { ...tooBig, total: pages.length }
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

export const PREFIX = /^[a-z0-9]+(-[a-z0-9]+)*$/

// The graph of a brain's wiki, whole or one group (any member reads it, like every reading of the wiki).
export async function wikiGraph(
  ctx: Ctx,
  slug: string,
  o: { prefix?: string; maxChars: number },
): Promise<GraphView> {
  if (o.prefix !== undefined && !PREFIX.test(o.prefix))
    throw invalid(
      '"prefix" is the first part of an address: lowercase letters, digits and dashes.',
      'Fix "prefix".',
    )
  const { brain } = await inBrain(ctx, { slug })
  const { pages, links } = await graphData(ctx.db, brain.id)
  return graphView(pages, links, {
    maxChars: o.maxChars,
    ...(o.prefix === undefined ? {} : { prefix: o.prefix }),
  })
}
