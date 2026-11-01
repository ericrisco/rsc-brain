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
// `loose`: the pages that sit at this level with no deeper part, gathered when they are many (open the group
// with `loose`); its prefix is the level's own ("" for the whole wiki).
export type GraphGroup = { prefix: string; count: number; types: Record<string, number>; loose?: true }

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

// More pages than this sitting at one level with no deeper part are gathered into one group.
export const LOOSE_MAX = 50

// What the graph shows of a wiki: the pages of `prefix` (the whole wiki without one), or, when they are more
// than `max` or would not fit, the groups one part of the address deeper. A page with no deeper part (no
// other page under it) is not a group: it is drawn beside the groups, or, when there are more than
// LOOSE_MAX of them, they are gathered into one group of their own (`loose` opens it). More groups than `max`:
// too big (the list has them all). Whether it comes as pages, groups or too big is decided once, on all the
// pages at the prefix; the filters (the same as the list's) only narrow what is counted and drawn, so filtering
// never reshapes the picture or empties it.
export function graphView(
  allPages: GraphPage[],
  allLinks: GraphLink[],
  o: { prefix?: string; max?: number; maxChars?: number; filters?: GraphFilters; loose?: boolean } = {},
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
  const allDrawn = allLinks.filter(
    (l) => l.from !== l.to && known.has(l.from) && known.has(l.to) && kindOf.has(l.kind),
  )
  // Addresses with another page under them: those are groups, not loose pages.
  const parents = new Set<string>()
  for (const p of pages) {
    const parts = p.address.split('/')
    for (let k = 1; k < parts.length; k++) parents.add(parts.slice(0, k).join('/'))
  }
  const members = pages.filter((p) => under(prefix, p.address))
  // A page at this level with nothing under it (or the page at the prefix itself).
  const isLoose = (a: string) =>
    a === prefix || (a.split('/').length === depth + 1 && !parents.has(a) && under(prefix, a))
  const looseAll = members.filter((p) => isLoose(p.address))
  const gathered = looseAll.length > Math.min(LOOSE_MAX, max)
  const looseKey = prefix ?? ''
  // The group an address is in at this level: its own (one part deeper), the gathered one, or none.
  const groupOf = (a: string): string | null =>
    !under(prefix, a) ? null : isLoose(a) ? (gathered ? looseKey : null) : keyAt(a, depth)

  // The filters: words, type, statuses (a comma list), tag, and a link kind (pages with one, either way, to a
  // page that exists and is not retired, whatever the filters do to that page).
  const q = f.q?.trim().toLowerCase() ?? ''
  const statuses = f.status ? f.status.split(',') : null
  const kinded = f.linkKind
    ? new Set(allDrawn.filter((l) => l.kind === f.linkKind).flatMap((l) => [l.from, l.to]))
    : null
  const shown = (p: GraphPage) =>
    (!q || p.address.includes(q) || p.title.toLowerCase().includes(q)) &&
    (!f.type || p.type === f.type) &&
    (!statuses || statuses.includes(p.status)) &&
    (!f.tag || p.tags.includes(f.tag)) &&
    (!kinded || kinded.has(p.address))
  const filtering = Boolean(q || f.type || statuses || f.tag || kinded)
  const kept = filtering ? pages.filter(shown) : pages
  const keptSet = new Set(kept.map((p) => p.address))
  const links = allDrawn.filter(
    (l) =>
      (!f.linkKind || l.kind === f.linkKind) && (!filtering || (keptSet.has(l.from) && keptSet.has(l.to))),
  )
  const empty = { kinds: GRAPH_KINDS, nodes: [], edges: [], across: [], groups: [], groupEdges: [] }
  const nodeOf = (p: GraphPage): GraphNode => [p.address, p.title, p.type, p.status, p.tags]

  // [node, group, links both ways] for links between `nodes` and pages outside them.
  const acrossOf = (
    index: Map<string, number>,
    other: (address: string) => string | null,
    ls: GraphLink[],
  ) => {
    const across = new Map<string, number>()
    for (const l of ls) {
      const i = index.get(l.from)
      const j = index.get(l.to)
      if ((i === undefined) === (j === undefined)) continue
      const g = other(i === undefined ? l.from : l.to)
      if (g === null) continue
      const key = `${i ?? j} ${g}`
      across.set(key, (across.get(key) ?? 0) + 1)
    }
    return [...across]
      .map(([key, n]): [number, string, number] => {
        const at = key.indexOf(' ')
        return [Number(key.slice(0, at)), key.slice(at + 1), n]
      })
      .sort((a, b) => a[0] - b[0] || byText(a[1], b[1]))
  }

  // [from, to, kind] for the links between drawn pages, by index, each once.
  const edgesOf = (index: Map<string, number>, ls: GraphLink[]) => {
    const seen = new Set<string>()
    const edges: [number, number, number][] = []
    for (const l of ls) {
      const i = index.get(l.from)
      const j = index.get(l.to)
      if (i === undefined || j === undefined) continue
      const k = kindOf.get(l.kind) as number
      const key = `${i} ${j} ${k}`
      if (seen.has(key)) continue
      seen.add(key)
      edges.push([i, j, k])
    }
    return edges.sort((a, b) => a[0] - b[0] || a[1] - b[1] || a[2] - b[2])
  }

  // The pages drawn: of the prefix, or only its loose ones; links out go to the group they lead into.
  const asPages = (from: GraphPage[], ls: GraphLink[], within: GraphPage[]): GraphView => {
    const index = new Map(from.map((p, i) => [p.address, i]))
    const edges = edgesOf(index, ls)
    const outside = (a: string): string | null =>
      index.has(a)
        ? null
        : o.loose
          ? (groupOf(a) ?? (prefix === null ? null : outer(prefix, a)))
          : prefix === null
            ? null
            : outer(prefix, a)
    const across = prefix === null && !o.loose ? [] : acrossOf(index, outside, ls)
    const touched = new Set(across.map((x) => x[1]))
    return {
      ...empty,
      mode: 'pages',
      prefix,
      total: from.length,
      nodes: from.map(nodeOf),
      edges,
      across,
      groups: groupsOf(within, outside).filter((g) => touched.has(g.prefix)),
    }
  }

  const asGroups = (inside: GraphPage[], ls: GraphLink[]): GraphView => {
    const loose = gathered ? [] : inside.filter((p) => isLoose(p.address))
    const between = new Map<string, number>()
    for (const l of ls) {
      const a = groupOf(l.from)
      const b = groupOf(l.to)
      if (a === null || b === null || a === b) continue
      const key = a < b ? `${a} ${b}` : `${b} ${a}`
      between.set(key, (between.get(key) ?? 0) + 1)
    }
    const index = new Map(loose.map((p, i) => [p.address, i]))
    const groups = groupsOf(inside, (a) => (isLoose(a) ? null : keyAt(a, depth)))
    // The gathered pages come last, as one group of their own.
    const rest = inside.filter((p) => isLoose(p.address))
    if (gathered && rest.length)
      groups.push({ ...(groupsOf(rest, () => looseKey)[0] as GraphGroup), loose: true })
    return {
      ...empty,
      mode: 'groups',
      prefix,
      total: inside.length,
      nodes: loose.map(nodeOf),
      // The loose pages beside the groups keep the links between them.
      edges: edgesOf(index, ls),
      across: acrossOf(index, groupOf, ls),
      groups,
      groupEdges: [...between]
        .map(([key, n]): [string, string, number] => {
          const at = key.indexOf(' ')
          return [key.slice(0, at), key.slice(at + 1), n]
        })
        .sort((x, y) => byText(x[0], y[0]) || byText(x[1], y[1])),
    }
  }

  const keptMembers = filtering ? members.filter((p) => keptSet.has(p.address)) : members
  const tooBig: GraphView = { ...empty, mode: 'too-big', prefix, total: keptMembers.length }
  // The gathered loose pages, opened.
  if (o.loose) {
    const all = asPages(looseAll, allDrawn, pages)
    if (looseAll.length > max || !fits(all, maxChars))
      return { ...tooBig, total: looseAll.filter((p) => keptSet.has(p.address)).length }
    return asPages(
      looseAll.filter((p) => keptSet.has(p.address)),
      links,
      kept,
    )
  }
  // The shape, from all the pages at the prefix.
  if (members.length <= max && fits(asPages(members, allDrawn, pages), maxChars))
    return asPages(keptMembers, links, kept)
  const keys = new Set(members.flatMap((p) => groupOf(p.address) ?? []))
  // Nothing deeper to split by (every page sits at this level): too big; so are more groups than the limit.
  if (!members.some((p) => !isLoose(p.address)) || keys.size > max) return tooBig
  if (!fits(asGroups(members, allDrawn), maxChars)) return tooBig
  return asGroups(keptMembers, links)
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
  o: GraphFilters & { prefix?: string; loose?: boolean; maxChars: number },
): Promise<GraphView> {
  if (o.prefix !== undefined && !PREFIX.test(o.prefix))
    throw invalid(
      '"prefix" is the start of an address: one or more parts of lowercase letters, digits and dashes, split by "/".',
      'Fix "prefix".',
    )
  checkFilters(o)
  const { brain } = await inBrain(ctx, { slug })
  const { pages, links } = await graphData(ctx.db, brain.id)
  const { maxChars, prefix, loose, ...filters } = o
  return graphView(pages, links, {
    maxChars,
    filters,
    ...(prefix === undefined ? {} : { prefix }),
    ...(loose ? { loose } : {}),
  })
}
