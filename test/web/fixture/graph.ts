// The graph and the full list of pages in the fixture API (spec B6 «Graph», plan §3.5 G9 and G10): one shape
// for the hand-made wiki and the seeded wikis of 300 and 5 000 pages, answered as the server answers. The
// graph is worked out by the server's own graphView, so the fixture cannot draw a different graph.
import { GRAPH_KINDS, graphView } from '../../../src/domain/wiki/graph.ts'
import { MAX_REPLY_CHARS } from '../../../src/http/bounds.ts'
import type { generate } from '../../../web/test/data/generate.ts'

const AT = '2026-10-29T10:00:00.000Z'

export type DataPage = {
  address: string
  title: string
  type: string
  status: string
  tags: string[]
  summary: string
  updatedAt: string
}
// `to` may name no page (a mention of an address that does not exist): it counts as a link out, never drawn.
export type DataLink = { from: string; to: string; kind: string }
export type GraphData = { pages: DataPage[]; links: DataLink[] }

type Q = URLSearchParams
type Answer = { status: number; body: unknown }
const err = (status: number, code: string, message: string, howToProceed: string): Answer => ({
  status,
  body: { error: { code, message, howToProceed } },
})
const invalid = (message: string, how: string) => err(400, 'invalid_request', message, how)

// The seeded wiki, with dates spread over a month so "updated" sorts.
export function seededData(g: ReturnType<typeof generate>): GraphData {
  return {
    pages: g.pages.map((p, i) => ({
      ...p,
      updatedAt: new Date(Date.UTC(2026, 9, 1) + (i % 28) * 86_400_000 + i * 1000).toISOString(),
    })),
    links: g.links.map(([from, to, kind]) => ({ from, to, kind })),
  }
}

// A lumpy wiki: 1 941 pages in eng/backend, 60 loose notes in eng, 100 loose pages at the top, 5 in sales, and
// a chain of related links through each part (the shape that once turned single pages into one-page groups).
export function lumpyData(): GraphData {
  const page = (address: string, i: number): DataPage => ({
    address,
    title: `${address.split('/').at(-1)} page`,
    type: i % 7 === 0 ? 'decision' : 'topic',
    status: 'current',
    tags: i % 3 === 0 ? ['core'] : [],
    summary: `About ${address}.`,
    updatedAt: new Date(Date.UTC(2026, 9, 1) + i * 1000).toISOString(),
  })
  const pages = [
    ...Array.from({ length: 1941 }, (_, i) => page(`eng/backend/s-${i}`, i)),
    ...Array.from({ length: 60 }, (_, i) => page(`eng/note-${i}`, i)),
    ...Array.from({ length: 100 }, (_, i) => page(`readme-${i}`, i)),
    ...Array.from({ length: 5 }, (_, i) => page(`sales/deal-${i}`, i)),
  ]
  const links = pages
    .slice(1)
    .map((p, i) => ({ from: (pages[i] as DataPage).address, to: p.address, kind: 'related' }))
  return { pages, links }
}

export const merge = (a: GraphData, b: GraphData): GraphData => ({
  pages: [...a.pages, ...b.pages],
  links: [...a.links, ...b.links],
})

// How many pages link into each page and how many each links to: only between pages that exist and are not
// retired, as the graph draws them (and as the server counts).
function counts(d: GraphData) {
  const drawn = new Set(d.pages.filter((p) => p.status !== 'retired').map((p) => p.address))
  const into = new Map<string, Set<string>>()
  const out = new Map<string, Set<string>>()
  for (const l of d.links) {
    if (l.from === l.to || !drawn.has(l.from) || !drawn.has(l.to)) continue
    if (!out.has(l.from)) out.set(l.from, new Set())
    out.get(l.from)?.add(l.to)
    if (!into.has(l.to)) into.set(l.to, new Set())
    into.get(l.to)?.add(l.from)
  }
  return { into, out }
}

// The filters of the list and the graph, refused the same way as the server refuses them.
function badFilters(q: Q): Answer | null {
  const type = q.get('type')
  const status = q.get('status')
  const linkKind = q.get('linkKind')
  if (type && !PAGE_TYPES.includes(type))
    return invalid(`"type" is one of: ${PAGE_TYPES.join(', ')}.`, 'Fix "type".')
  if (status && !status.split(',').every((x) => PAGE_STATUSES.includes(x)))
    return invalid(
      `"status" is one or more of: ${PAGE_STATUSES.join(', ')}, separated by commas.`,
      'Fix "status".',
    )
  if (linkKind && !(GRAPH_KINDS as readonly string[]).includes(linkKind))
    return invalid(`"linkKind" is one of: ${GRAPH_KINDS.join(', ')}.`, 'Fix "linkKind".')
  return null
}

const SORTS = ['address', 'title', 'type', 'status', 'in', 'out', 'updatedAt'] as const
const PAGE_TYPES = ['topic', 'entity', 'decision', 'guide', 'agent', 'source', 'overview']
const PAGE_STATUSES = ['current', 'stale', 'superseded', 'retired']
const b64 = (s: string) => Buffer.from(s, 'utf8').toString('base64url')

// G9: by pages, filtered and sorted as the server does (an address order goes by the last address; any
// other order by how many came before).
export function listPagesOf(d: GraphData, q: Q): Answer {
  const type = q.get('type')
  const status = q.get('status')
  const linkKind = q.get('linkKind')
  const sort = q.get('sort') ?? 'address'
  const column = sort.replace(/^-/, '') as (typeof SORTS)[number]
  if (type && !PAGE_TYPES.includes(type))
    return invalid(`"type" is one of: ${PAGE_TYPES.join(', ')}.`, 'Fix "type".')
  const bad = badFilters(q)
  if (bad) return bad
  if (!SORTS.includes(column))
    return invalid(
      `"sort" is one of: ${SORTS.join(', ')}, with "-" before it for the other way.`,
      'Fix "sort".',
    )
  const limit = Number(q.get('limit') ?? 50)
  if (!Number.isInteger(limit) || limit < 1 || limit > 200)
    return invalid('"limit" must be between 1 and 200.', 'Ask for at most 200 per page.')
  const { into, out } = counts(d)
  const drawn = new Set(d.pages.filter((p) => p.status !== 'retired').map((p) => p.address))
  const kinded = new Set<string>()
  if (linkKind)
    for (const l of d.links)
      if (l.kind === linkKind && l.from !== l.to && drawn.has(l.from) && drawn.has(l.to)) {
        kinded.add(l.from)
        kinded.add(l.to)
      }
  const words = (q.get('q') ?? '').trim().toLowerCase()
  const prefix = q.get('prefix')
  const tag = q.get('tag')
  const loose = q.get('loose')
  if (loose !== null && loose !== '1')
    return invalid('"loose" is "1" or left out.', 'Send loose=1 to open the pages gathered at a level.')
  // Addresses with a page that is not retired under them: not loose.
  const parents = new Set(
    drawn.size
      ? [...drawn].flatMap((a) =>
          a
            .split('/')
            .slice(0, -1)
            .map((_, k, parts) => parts.slice(0, k + 1).join('/')),
        )
      : [],
  )
  const depth = prefix ? prefix.split('/').length : 0
  const isLoose = (a: string) => a === prefix || (a.split('/').length === depth + 1 && !parents.has(a))
  const rows = d.pages
    .filter(
      (p) =>
        (!words || p.address.includes(words) || p.title.toLowerCase().includes(words)) &&
        (!type || p.type === type) &&
        (!status || status.split(',').includes(p.status)) &&
        (!tag || p.tags.includes(tag)) &&
        (!prefix || p.address === prefix || p.address.startsWith(`${prefix}/`)) &&
        (!loose || isLoose(p.address)) &&
        (!linkKind || kinded.has(p.address)),
    )
    .map((p) => ({
      address: p.address,
      title: p.title,
      type: p.type,
      status: p.status,
      tags: p.tags,
      in: into.get(p.address)?.size ?? 0,
      out: out.get(p.address)?.size ?? 0,
      updatedAt: p.updatedAt,
    }))
  const desc = sort.startsWith('-')
  const cmp = (a: string | number, b: string | number) => (a < b ? -1 : a > b ? 1 : 0)
  rows.sort(
    (a, b) =>
      (desc ? -1 : 1) * cmp(a[column], b[column]) || (column === 'address' ? 0 : cmp(a.address, b.address)),
  )
  const raw = q.get('cursor') ? Buffer.from(q.get('cursor') as string, 'base64url').toString() : null
  const byAddress = column === 'address' && !desc
  let from = 0
  if (raw !== null) {
    if (byAddress === raw.startsWith('#'))
      return invalid('"cursor" is not one this list gave.', 'Use "next" unchanged.')
    from = byAddress ? rows.findIndex((r) => r.address > raw) : Number(raw.slice(1))
    if (from < 0) from = rows.length
  }
  const items = rows.slice(from, from + limit)
  const more = rows.length > from + limit
  return {
    status: 200,
    body: {
      items,
      next: !more ? null : byAddress ? b64(items.at(-1)?.address ?? '') : b64(`#${from + limit}`),
      total: rows.length,
    },
  }
}

// G10, by the server's own rules.
export function graphOf(d: GraphData, q: Q): Answer {
  for (const k of q.keys())
    if (!['prefix', 'loose', 'q', 'type', 'status', 'tag', 'linkKind'].includes(k))
      return invalid(
        `"${k}" is not a parameter of the graph.`,
        'Use prefix, loose, q, type, status, tag or linkKind.',
      )
  const loose = q.get('loose')
  if (loose !== null && loose !== '1')
    return invalid('"loose" is "1" or left out.', 'Send loose=1 to open the pages gathered at a level.')
  const prefix = q.get('prefix')
  if (prefix !== null && !/^[a-z0-9]+(-[a-z0-9]+)*(\/[a-z0-9]+(-[a-z0-9]+)*)*$/.test(prefix))
    return invalid(
      '"prefix" is the start of an address: one or more parts of lowercase letters, digits and dashes, split by "/".',
      'Fix "prefix".',
    )
  const bad = badFilters(q)
  if (bad) return bad
  const filters = Object.fromEntries(
    (['q', 'type', 'status', 'tag', 'linkKind'] as const).flatMap((k) =>
      q.get(k) ? [[k, q.get(k) as string]] : [],
    ),
  )
  return {
    status: 200,
    body: graphView(d.pages, d.links, {
      maxChars: MAX_REPLY_CHARS,
      filters,
      ...(prefix === null ? {} : { prefix }),
      ...(loose ? { loose: true } : {}),
    }),
  }
}

// A seeded page read as the server reads one: its links both ways, no sources, one revision.
export function seededReading(d: GraphData, address: string): Answer | null {
  const p = d.pages.find((x) => x.address === address)
  if (!p) return null
  const byAddress = new Map(d.pages.map((x) => [x.address, x]))
  const state = (s: string | undefined) =>
    s === undefined ? 'broken' : s === 'retired' || s === 'superseded' || s === 'stale' ? s : 'ok'
  const view = (kind: string, other: string) => {
    const o = byAddress.get(other)
    return {
      kind,
      address: other,
      pageId: o ? `pg_${o.address.replace(/[^a-z0-9]/g, '_')}` : null,
      title: o?.title ?? null,
      state: state(o?.status),
    }
  }
  const id = `pg_${p.address.replace(/[^a-z0-9]/g, '_')}`
  return {
    status: 200,
    body: {
      page: {
        id,
        brainId: 'brn_growth',
        address: p.address,
        type: p.type,
        title: p.title,
        summary: p.summary,
        body: `${p.summary}\n`,
        tags: p.tags,
        status: p.status,
        supersededBy: null,
        revision: 1,
        createdAt: AT,
        updatedAt: p.updatedAt,
      },
      ...(p.status === 'retired' ? { notice: 'retired: this page is kept for its history only.' } : {}),
      lastChange: { revision: 1, authorId: 'acc_eric', authorName: 'Eric', at: p.updatedAt },
      corrections: [],
      links: {
        out: d.links.filter((l) => l.from === p.address && l.to !== p.address).map((l) => view(l.kind, l.to)),
        in: d.links
          .filter((l) => l.to === p.address && l.from !== p.address)
          .map((l) => view(l.kind, l.from)),
      },
      sources: [],
    },
  }
}
