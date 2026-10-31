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

export const merge = (a: GraphData, b: GraphData): GraphData => ({
  pages: [...a.pages, ...b.pages],
  links: [...a.links, ...b.links],
})

// How many pages link into each page and how many pages (or missing addresses) each links to.
function counts(d: GraphData) {
  const known = new Set(d.pages.map((p) => p.address))
  const into = new Map<string, Set<string>>()
  const out = new Map<string, Set<string>>()
  for (const l of d.links) {
    if (l.from === l.to) continue
    if (!out.has(l.from)) out.set(l.from, new Set())
    out.get(l.from)?.add(l.to)
    if (!known.has(l.to)) continue
    if (!into.has(l.to)) into.set(l.to, new Set())
    into.get(l.to)?.add(l.from)
  }
  return { into, out }
}

const SORTS = ['address', 'title', 'type', 'in', 'out', 'updatedAt'] as const
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
  if (status && !PAGE_STATUSES.includes(status))
    return invalid(`"status" is one of: ${PAGE_STATUSES.join(', ')}.`, 'Fix "status".')
  if (linkKind && !(GRAPH_KINDS as readonly string[]).includes(linkKind))
    return invalid(`"linkKind" is one of: ${GRAPH_KINDS.join(', ')}.`, 'Fix "linkKind".')
  if (!SORTS.includes(column))
    return invalid(
      `"sort" is one of: ${SORTS.join(', ')}, with "-" before it for the other way.`,
      'Fix "sort".',
    )
  const limit = Number(q.get('limit') ?? 50)
  if (!Number.isInteger(limit) || limit < 1 || limit > 200)
    return invalid('"limit" must be between 1 and 200.', 'Ask for at most 200 per page.')
  const { into, out } = counts(d)
  const kinded = new Set<string>()
  if (linkKind)
    for (const l of d.links)
      if (l.kind === linkKind && l.from !== l.to) {
        kinded.add(l.from)
        kinded.add(l.to)
      }
  const words = (q.get('q') ?? '').toLowerCase()
  const prefix = q.get('prefix')
  const tag = q.get('tag')
  const rows = d.pages
    .filter(
      (p) =>
        (!words || p.address.includes(words) || p.title.toLowerCase().includes(words)) &&
        (!type || p.type === type) &&
        (!status || p.status === status) &&
        (!tag || p.tags.includes(tag)) &&
        (!prefix || p.address === prefix || p.address.startsWith(`${prefix}/`)) &&
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
  const prefix = q.get('prefix')
  if (prefix !== null && !/^[a-z0-9]+(-[a-z0-9]+)*$/.test(prefix))
    return invalid(
      '"prefix" is the first part of an address: lowercase letters, digits and dashes.',
      'Fix "prefix".',
    )
  return {
    status: 200,
    body: graphView(d.pages, d.links, {
      maxChars: MAX_REPLY_CHARS,
      ...(prefix === null ? {} : { prefix }),
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
