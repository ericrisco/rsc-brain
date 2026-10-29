// The words of the wiki (spec B2): page types and states, link kinds, limits, and the operations a
// proposal carries, read from JSON with one message per mistake. Pure: no database here.
import { redact } from '../../privacy/redact.ts'

export const PAGE_TYPES = ['topic', 'entity', 'decision', 'guide', 'agent', 'source', 'overview'] as const
export type PageType = (typeof PAGE_TYPES)[number]
export const PAGE_STATUSES = ['current', 'stale', 'superseded', 'retired'] as const
export type PageStatus = (typeof PAGE_STATUSES)[number]
export const LINK_KINDS = [
  'related',
  'depends-on',
  'contradicts',
  'supersedes',
  'part-of',
  'example-of',
] as const
export type LinkKind = (typeof LINK_KINDS)[number]

export const WIKI_LIMITS = {
  address: 200,
  title: 200,
  summary: 300,
  body: 100_000,
  tag: 40,
  tags: 20,
  sources: 50,
  links: 50,
  reason: 2000,
  comment: 4000,
  ops: 50,
  collected: 500,
  url: 2000,
  sourceTitle: 300,
  agent: 80,
}

export const ADDRESS = /^[a-z0-9]+(-[a-z0-9]+)*(\/[a-z0-9]+(-[a-z0-9]+)*)*$/
export const isAddress = (a: unknown): a is string =>
  typeof a === 'string' && a.length <= WIKI_LIMITS.address && ADDRESS.test(a)

export type Source = { entryId: string } | { url: string; title?: string }
export type LinkRef = { kind: LinkKind; to: string }

export type Op =
  | {
      op: 'create'
      address: string
      type: PageType
      title: string
      summary: string
      body: string
      tags: string[]
      sources: Source[]
      links: LinkRef[]
      reason: string
    }
  | {
      op: 'edit'
      address: string
      baseRevision?: number
      type?: PageType
      title?: string
      summary?: string
      body?: string
      tags?: string[]
      sources?: Source[]
      reason: string
    }
  | { op: 'move'; address: string; to: string; reason: string }
  | { op: 'link' | 'unlink'; address: string; kind: LinkKind; to: string; reason: string }
  | { op: 'status'; address: string; status: PageStatus; supersededBy?: string; reason: string }
  | {
      op: 'merge'
      address: string
      from: string
      body: string
      dropSources: Source[]
      dropLinks: LinkRef[]
      reason: string
    }
  | { op: 'revert'; address: string; toRevision: number; reason: string }

export type OpKind = Op['op']
export const OP_KINDS: readonly OpKind[] = [
  'create',
  'edit',
  'move',
  'link',
  'unlink',
  'status',
  'merge',
  'revert',
]

// [[address]] or [[address|text]] in a body. Only well-formed addresses count as mentions.
export function mentionsOf(body: string): string[] {
  const out = new Set<string>()
  for (const m of body.matchAll(/\[\[([^\]|\n]{1,250})(?:\|[^\]\n]{0,250})?\]\]/g)) {
    const a = (m[1] ?? '').trim()
    if (isAddress(a)) out.add(a)
  }
  return [...out]
}

export type Problem = { op: number | null; message: string }

// A value from the request, shown in a message without trusting it to turn into text by itself.
const shown = (v: unknown): string => (typeof v === 'string' ? v.slice(0, 80) : typeof v)

type Raw = Record<string, unknown>

// Reads one operation. Every string is redacted first (pack rule 1); limits are measured on what is
// stored, after redaction. Problems are collected, not thrown, so the agent gets them all at once.
export function readOp(raw: unknown, i: number, problems: Problem[]): Op | null {
  const bad = (message: string) => {
    problems.push({ op: i, message })
    return null
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return bad('An operation must be a JSON object.')
  const o = raw as Raw
  const kind = o.op
  if (typeof kind !== 'string' || !(OP_KINDS as readonly string[]).includes(kind)) {
    return bad(`Unknown operation "${shown(kind)}". Use one of: ${OP_KINDS.join(', ')}.`)
  }
  const before = problems.length
  const text = (key: string, max: number, required: boolean): string | undefined => {
    const v = o[key]
    if (v === undefined || v === null) {
      if (required) problems.push({ op: i, message: `"${key}" is required for "${kind}".` })
      return undefined
    }
    if (typeof v !== 'string') {
      problems.push({ op: i, message: `"${key}" must be text.` })
      return undefined
    }
    const r = redact(key === 'body' ? v : v.trim()).text
    if (r.length > max) problems.push({ op: i, message: `"${key}" is longer than ${max} characters.` })
    return r
  }
  const addr = (key: string): string => {
    const v = o[key]
    if (!isAddress(v)) {
      problems.push({
        op: i,
        message: `"${key}" is not a valid address: lowercase words with hyphens, levels split by "/", e.g. "audience/retention".`,
      })
      return ''
    }
    return v
  }
  const reason = text('reason', WIKI_LIMITS.reason, true) ?? ''
  if (typeof o.reason === 'string' && !reason.trim())
    problems.push({ op: i, message: 'Say why, in "reason".' })
  const address = addr('address')
  const pageType = (required: boolean): PageType | undefined => {
    const v = o.type
    if (v === undefined || v === null) {
      if (required) problems.push({ op: i, message: '"type" is required for "create".' })
      return undefined
    }
    if (typeof v !== 'string' || !(PAGE_TYPES as readonly string[]).includes(v)) {
      problems.push({
        op: i,
        message: `Unknown page type "${shown(v)}". Use one of: ${PAGE_TYPES.join(', ')}.`,
      })
      return undefined
    }
    return v as PageType
  }
  const tags = (): string[] | undefined => {
    const v = o.tags
    if (v === undefined || v === null) return undefined
    if (!Array.isArray(v) || v.some((t) => typeof t !== 'string' || !t.trim())) {
      problems.push({ op: i, message: '"tags" must be a list of non-empty texts.' })
      return undefined
    }
    const out = [...new Set((v as string[]).map((t) => redact(t.trim()).text))]
    if (out.length > WIKI_LIMITS.tags || out.some((t) => t.length > WIKI_LIMITS.tag)) {
      problems.push({
        op: i,
        message: `Up to ${WIKI_LIMITS.tags} tags of up to ${WIKI_LIMITS.tag} characters.`,
      })
    }
    return out
  }
  const sources = (key: string): Source[] | undefined => {
    const v = o[key]
    if (v === undefined || v === null) return undefined
    if (!Array.isArray(v)) {
      problems.push({ op: i, message: `"${key}" must be a list.` })
      return undefined
    }
    if (v.length > WIKI_LIMITS.sources)
      problems.push({ op: i, message: `At most ${WIKI_LIMITS.sources} ${key}.` })
    const out: Source[] = []
    for (const s of v) {
      const x = (s ?? {}) as Raw
      if (typeof x.entryId === 'string' && x.url === undefined && /^ent_[0-9a-f]{12}$/.test(x.entryId)) {
        out.push({ entryId: x.entryId })
      } else if (typeof x.url === 'string' && x.entryId === undefined && /^https?:\/\/\S+$/i.test(x.url)) {
        const url = redact(x.url).text
        const title = typeof x.title === 'string' ? redact(x.title.trim()).text : undefined
        if (url.length > WIKI_LIMITS.url || (title?.length ?? 0) > WIKI_LIMITS.sourceTitle) {
          problems.push({ op: i, message: 'A source address or its title is too long.' })
        }
        out.push(title ? { url, title } : { url })
      } else {
        problems.push({
          op: i,
          message: `Each item of "${key}" is {"entryId": "ent_…"} or {"url": "https://…", "title"?: "…"}.`,
        })
      }
    }
    // The same source twice is one source.
    const seen = new Set<string>()
    return out.filter((s) => !seen.has(sourceKey(s)) && Boolean(seen.add(sourceKey(s))))
  }
  const links = (key: string): LinkRef[] => {
    const v = o[key]
    if (v === undefined || v === null) return []
    if (!Array.isArray(v) || v.length > WIKI_LIMITS.links) {
      problems.push({ op: i, message: `"${key}" must be a list of at most ${WIKI_LIMITS.links} links.` })
      return []
    }
    const out: LinkRef[] = []
    for (const l of v) {
      const x = (l ?? {}) as Raw
      if (
        typeof x.kind !== 'string' ||
        !(LINK_KINDS as readonly string[]).includes(x.kind) ||
        !isAddress(x.to)
      ) {
        problems.push({
          op: i,
          message: `Each link is {"kind": one of ${LINK_KINDS.join(', ')}, "to": "<address>"}.`,
        })
        continue
      }
      if (!out.some((l) => l.kind === x.kind && l.to === x.to))
        out.push({ kind: x.kind as LinkKind, to: x.to })
    }
    return out
  }
  const linkKind = (): LinkKind => {
    const v = o.kind
    if (typeof v !== 'string' || !(LINK_KINDS as readonly string[]).includes(v)) {
      problems.push({ op: i, message: `"kind" must be one of: ${LINK_KINDS.join(', ')}.` })
      return 'related'
    }
    return v as LinkKind
  }
  const whole = (key: string, required: boolean): number | undefined => {
    const v = o[key]
    if (v === undefined || v === null) {
      if (required) problems.push({ op: i, message: `"${key}" is required for "${kind}".` })
      return undefined
    }
    if (typeof v !== 'number' || !Number.isSafeInteger(v) || v < 1) {
      problems.push({ op: i, message: `"${key}" must be a revision number (1 or more).` })
      return undefined
    }
    return v
  }

  let op: Op | null = null
  switch (kind as OpKind) {
    case 'create': {
      const title = text('title', WIKI_LIMITS.title, true) ?? ''
      if (o.title !== undefined && !title) problems.push({ op: i, message: 'A page needs a title.' })
      op = {
        op: 'create',
        address,
        type: pageType(true) ?? 'topic',
        title,
        summary: text('summary', WIKI_LIMITS.summary, false) ?? '',
        body: text('body', WIKI_LIMITS.body, false) ?? '',
        tags: tags() ?? [],
        sources: sources('sources') ?? [],
        links: links('links'),
        reason,
      }
      if (op.links.some((l) => l.to === address))
        problems.push({ op: i, message: 'A page cannot link to itself.' })
      break
    }
    case 'edit': {
      const e: Extract<Op, { op: 'edit' }> = { op: 'edit', address, reason }
      const base = whole('baseRevision', false)
      if (base !== undefined) e.baseRevision = base
      const t = pageType(false)
      if (t) e.type = t
      const title = text('title', WIKI_LIMITS.title, false)
      if (title !== undefined) {
        if (!title) problems.push({ op: i, message: 'A page needs a title.' })
        e.title = title
      }
      const summary = text('summary', WIKI_LIMITS.summary, false)
      if (summary !== undefined) e.summary = summary
      const body = text('body', WIKI_LIMITS.body, false)
      if (body !== undefined) e.body = body
      const tg = tags()
      if (tg) e.tags = tg
      const src = sources('sources')
      if (src) e.sources = src
      if ([e.type, e.title, e.summary, e.body, e.tags, e.sources].every((x) => x === undefined)) {
        problems.push({
          op: i,
          message: 'An edit changes at least one of type, title, summary, body, tags, sources.',
        })
      }
      op = e
      break
    }
    case 'move':
      op = { op: 'move', address, to: addr('to'), reason }
      if (op.to && op.to === address)
        problems.push({ op: i, message: 'The new address is the same as the old one.' })
      break
    case 'link':
    case 'unlink':
      op = { op: kind as 'link' | 'unlink', address, kind: linkKind(), to: addr('to'), reason }
      if (op.to && op.to === address) problems.push({ op: i, message: 'A page cannot link to itself.' })
      break
    case 'status': {
      const v = o.status
      if (typeof v !== 'string' || !(PAGE_STATUSES as readonly string[]).includes(v)) {
        problems.push({ op: i, message: `"status" must be one of: ${PAGE_STATUSES.join(', ')}.` })
      }
      const s: Extract<Op, { op: 'status' }> = {
        op: 'status',
        address,
        status: (v as PageStatus) ?? 'current',
        reason,
      }
      if (s.status === 'superseded') {
        s.supersededBy = addr('supersededBy')
        if (s.supersededBy === address) problems.push({ op: i, message: 'A page cannot supersede itself.' })
      } else if (o.supersededBy !== undefined) {
        problems.push({ op: i, message: '"supersededBy" only goes with status "superseded".' })
      }
      op = s
      break
    }
    case 'merge': {
      const from = addr('from')
      if (from && from === address) problems.push({ op: i, message: 'A page cannot be merged into itself.' })
      op = {
        op: 'merge',
        address,
        from,
        body: text('body', WIKI_LIMITS.body, true) ?? '',
        dropSources: sources('dropSources') ?? [],
        dropLinks: links('dropLinks'),
        reason,
      }
      break
    }
    case 'revert':
      op = { op: 'revert', address, toRevision: whole('toRevision', true) ?? 1, reason }
      break
  }
  return problems.length > before ? null : op
}

// Title words, for "a title shares almost all its words with another one".
export function titleWords(title: string): Set<string> {
  return new Set(
    title
      .normalize('NFKD')
      .replace(/[̀-ͯ]/g, '')
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter((w) => w.length >= 2),
  )
}

export function nearlySame(a: string, b: string): boolean {
  const x = titleWords(a)
  const y = titleWords(b)
  if (x.size === 0 || y.size === 0) return false
  let common = 0
  for (const w of x) if (y.has(w)) common += 1
  return common / Math.max(x.size, y.size) >= 0.8
}

export const sourceKey = (s: Source): string => ('entryId' in s ? `e:${s.entryId}` : `u:${s.url}`)
