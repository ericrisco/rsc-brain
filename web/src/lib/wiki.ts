// The logic of the wiki screens (spec B6 «Wiki», PR19), kept free of the DOM so it is tested on its own:
// filters of the map and the decisions, links grouped by kind, the words that changed between two
// revisions, the `[[` autocomplete of the editor, and what an edit sends.
import { diffWordsWithSpace } from 'diff'

export const PAGE_TYPES = ['topic', 'entity', 'decision', 'guide', 'agent', 'source', 'overview'] as const
export const PAGE_STATUSES = ['current', 'stale', 'superseded', 'retired'] as const
export const LINK_KINDS = [
  'related',
  'depends-on',
  'contradicts',
  'supersedes',
  'part-of',
  'example-of',
] as const
// Mentions first (what the body says), then the typed links, the ones that warn last.
const LINK_ORDER = ['mentions', 'related', 'depends-on', 'part-of', 'example-of', 'supersedes', 'contradicts']

export type MapPage = { address: string; title: string; summary: string; tags: string[] }
export type MapGroup = { type: string; area: string; pages: MapPage[] }
export type MapFilter = { type?: string | undefined; tag?: string | undefined; q?: string | undefined }

const has = (text: string, q: string) => text.toLowerCase().includes(q)

export function filterMap(groups: MapGroup[], f: MapFilter): MapGroup[] {
  const q = f.q?.trim().toLowerCase()
  if (!f.type && !f.tag && !q) return groups
  const out: MapGroup[] = []
  for (const g of groups) {
    if (f.type && g.type !== f.type) continue
    const pages = g.pages.filter(
      (p) =>
        (!f.tag || p.tags.includes(f.tag)) &&
        (!q || has(p.title, q) || has(p.address, q) || has(p.summary, q)),
    )
    if (pages.length) out.push({ ...g, pages })
  }
  return out
}

export const mapTags = (groups: MapGroup[]) =>
  [...new Set(groups.flatMap((g) => g.pages.flatMap((p) => p.tags)))].sort()

export const mapTypes = (groups: MapGroup[]) => [...new Set(groups.map((g) => g.type))]

export type DecisionLike = { address: string; title: string; summary: string; status: string }

export function filterDecisions<D extends DecisionLike>(
  list: D[],
  f: { status?: string | undefined; q?: string | undefined },
): D[] {
  const q = f.q?.trim().toLowerCase()
  return list.filter(
    (d) =>
      (!f.status || d.status === f.status) &&
      (!q || has(d.title, q) || has(d.summary, q) || has(d.address, q)),
  )
}

export function groupLinks<L extends { kind: string }>(links: L[]): { kind: string; items: L[] }[] {
  const by = new Map<string, L[]>()
  for (const l of links) by.set(l.kind, [...(by.get(l.kind) ?? []), l])
  const rank = (k: string) => (LINK_ORDER.includes(k) ? LINK_ORDER.indexOf(k) : LINK_ORDER.length)
  return [...by.entries()].sort((a, b) => rank(a[0]) - rank(b[0])).map(([kind, items]) => ({ kind, items }))
}

export type Segment = { kind: 'same' | 'added' | 'removed'; text: string }

// What changed from `a` to `b`, word by word, spaces kept.
export function wordDiff(a: string, b: string): Segment[] {
  return diffWordsWithSpace(a, b).map((p) => ({
    kind: p.added ? 'added' : p.removed ? 'removed' : 'same',
    text: p.value,
  }))
}

// The two revisions to compare: those the address names (lower first), or the last two.
export function pickPair(raw: string | undefined, latest: number): [number, number] | null {
  if (latest < 2) return null
  const fallback: [number, number] = [latest - 1, latest]
  const m = /^(\d+),(\d+)$/.exec(raw ?? '')
  if (!m) return fallback
  const a = Number(m[1])
  const b = Number(m[2])
  if (a === b || Math.min(a, b) < 1 || Math.max(a, b) > latest) return fallback
  return [Math.min(a, b), Math.max(a, b)]
}

// The `[[` being typed at the caret: where its address starts and what is typed so far, or null.
export function completionAt(text: string, caret: number): { start: number; query: string } | null {
  const before = text.slice(0, caret)
  const open = before.lastIndexOf('[[')
  if (open < 0) return null
  const query = before.slice(open + 2)
  if (!/^[a-z0-9/-]*$/i.test(query)) return null
  return { start: open + 2, query }
}

// Puts `address` where the `[[` being typed starts, closes the mention and puts the caret after it.
export function completeAt(
  text: string,
  start: number,
  caret: number,
  address: string,
): { text: string; caret: number } {
  const rest = text.slice(caret)
  const closed = rest.startsWith(']]')
  const head = `${text.slice(0, start)}${address}]]`
  return { text: head + (closed ? rest.slice(2) : rest), caret: head.length }
}

export type Source = { entryId: string } | { url: string; title?: string }
export const sourceKey = (s: Source) => ('entryId' in s ? `entry:${s.entryId}` : `url:${s.url}`)

export type Editable = {
  type: string
  title: string
  summary: string
  body: string
  tags: string[]
  sources: Source[]
}

const sameList = (a: string[], b: string[]) => a.length === b.length && a.every((x, i) => x === b[i])

// What an edit sends: the fields that changed and the revision it was made on; null when nothing did.
export function editChanges(
  read: Editable & { revision: number },
  now: Editable,
): (Partial<Editable> & { baseRevision: number }) | null {
  const out: Partial<Editable> = {}
  if (now.type !== read.type) out.type = now.type
  if (now.title.trim() !== read.title) out.title = now.title.trim()
  if (now.summary.trim() !== read.summary) out.summary = now.summary.trim()
  if (now.body !== read.body) out.body = now.body
  if (!sameList(now.tags, read.tags)) out.tags = now.tags
  if (!sameList(now.sources.map(sourceKey), read.sources.map(sourceKey))) out.sources = now.sources
  return Object.keys(out).length ? { baseRevision: read.revision, ...out } : null
}

export const parseTags = (s: string) => [
  ...new Set(
    s
      .split(',')
      .map((t) => t.trim())
      .filter(Boolean),
  ),
]

// An edit's draft is kept by page, under a key made from the brain and the address (a short hash), so a
// name such as "claude-code" or "infra/token-rotation" never reads like a secret to the draft store.
export function draftKeyOf(slug: string, address: string): string {
  let h = 0x811c9dc5
  for (const ch of `${slug}\u0000${address}`) {
    h ^= ch.codePointAt(0) ?? 0
    h = Math.imul(h, 0x01000193) >>> 0
  }
  return `wiki-edit.${h.toString(36)}`
}

// A link or a status changed in the editor makes a new revision of the page without touching its
// content: the edit moves on to it. If the content changed too, someone else edited: it does not.
export const canRebase = (base: Editable, now: Editable) =>
  editChanges({ ...base, revision: 0 }, now) === null
