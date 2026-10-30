// The logic of the wiki screens (spec B6 «Wiki», PR19), kept free of the DOM so it is tested on its own:
// filters of the map and the decisions, links grouped by kind, the words that changed between two
// revisions, the `[[` autocomplete of the editor, and what an edit sends.
import { diffArrays, diffWordsWithSpace } from 'diff'

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

export type MapPage = { address: string; title: string; summary: string; tags: string[]; status?: string }
export type MapGroup = { type: string; area: string; pages: MapPage[] }
export type MapFilter = {
  type?: string | undefined
  tag?: string | undefined
  q?: string | undefined
  status?: string | undefined
}

const has = (text: string, q: string) => text.toLowerCase().includes(q)

export function filterMap(groups: MapGroup[], f: MapFilter): MapGroup[] {
  const q = f.q?.trim().toLowerCase()
  if (!f.type && !f.tag && !q && !f.status) return groups
  const out: MapGroup[] = []
  for (const g of groups) {
    if (f.type && g.type !== f.type) continue
    const pages = g.pages.filter(
      (p) =>
        (!f.tag || p.tags.includes(f.tag)) &&
        (!f.status || (p.status ?? 'current') === f.status) &&
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

// Bounds of every difference worked out in the page (CA6: no task of the browser over 200 ms): past them the
// old and the new text are shown whole instead of word by word.
const DIFF_MS = 100
const DIFF_EDITS = 5000

// What changed from `a` to `b`, word by word, spaces kept; old and new whole when too different to compare.
export function wordDiff(a: string, b: string, ms = DIFF_MS): Segment[] {
  const parts = ms > 0 ? diffWordsWithSpace(a, b, { timeout: ms, maxEditLength: DIFF_EDITS }) : undefined
  if (!parts) {
    const out: Segment[] = []
    if (a) out.push({ kind: 'removed', text: a })
    if (b) out.push({ kind: 'added', text: b })
    return out
  }
  return parts.map((p) => ({
    kind: p.added ? 'added' : p.removed ? 'removed' : 'same',
    text: p.value,
  }))
}

export type DiffLine =
  | { kind: 'same' | 'added' | 'removed'; text: string }
  | { kind: 'changed'; words: Segment[] }

// How much of a line stayed (its unchanged letters over the longer of the two).
const kept = (words: Segment[], a: string, b: string) =>
  words.filter((w) => w.kind === 'same').reduce((n, w) => n + w.text.trim().length, 0) /
  Math.max(1, a.trim().length, b.trim().length)

// The lines of two texts compared, or undefined past `end` (a time of performance.now()): one deadline can
// be shared by every difference a screen works out, so together they stay under it.
type LineParts = ReturnType<typeof diffArrays<string>>
function lineParts(A: string[], B: string[], end: number): LineParts | undefined {
  const ms = Math.min(DIFF_MS, end - performance.now())
  return ms > 1 ? diffArrays(A, B, { timeout: ms, maxEditLength: DIFF_EDITS }) : undefined
}

// The body's differences by line: a line with a few words changed shows those words; a line mostly
// rewritten shows the old line and the new one whole (alternating words would be unreadable). Bounded in
// time like wordDiff.
export function bodyDiff(a: string, b: string): DiffLine[] {
  const end = performance.now() + DIFF_MS * 1.5
  const A = a.split('\n')
  const B = b.split('\n')
  return linesOf(A, B, lineParts(A, B, end), end)
}

function linesOf(A: string[], B: string[], parts: LineParts | undefined, end: number): DiffLine[] {
  const left = () => Math.max(0, end - performance.now())
  if (!parts) {
    return [
      ...A.map((text) => ({ kind: 'removed' as const, text })),
      ...B.map((text) => ({ kind: 'added' as const, text })),
    ]
  }
  const out: DiffLine[] = []
  for (let i = 0; i < parts.length; i++) {
    const p = parts[i] as (typeof parts)[number]
    if (!p.added && !p.removed) {
      for (const text of p.value) out.push({ kind: 'same', text })
      continue
    }
    const next = parts[i + 1]
    if (p.removed && next?.added) {
      const olds = p.value
      const news = next.value
      i++
      const n = Math.max(olds.length, news.length)
      for (let k = 0; k < n; k++) {
        const o = olds[k]
        const w = news[k]
        if (o !== undefined && w !== undefined) {
          const words = wordDiff(o, w, left())
          if (words.some((x) => x.kind === 'same') && kept(words, o, w) >= 0.5)
            out.push({ kind: 'changed', words })
          else out.push({ kind: 'removed', text: o }, { kind: 'added', text: w })
        } else if (o !== undefined) out.push({ kind: 'removed', text: o })
        else if (w !== undefined) out.push({ kind: 'added', text: w })
      }
      continue
    }
    for (const text of p.value) out.push({ kind: p.added ? 'added' : 'removed', text })
  }
  return out
}

// The changes from `base` to `other`, as hunks of base lines replaced by other lines.
type Hunk = { start: number; end: number; lines: string[] }
function hunksOf(parts: LineParts | undefined): Hunk[] | null {
  if (!parts) return null
  const out: Hunk[] = []
  let at = 0
  let cur: Hunk | null = null
  for (const p of parts) {
    if (!p.added && !p.removed) {
      if (cur) out.push(cur)
      cur = null
      at += p.value.length
      continue
    }
    cur ??= { start: at, end: at, lines: [] }
    if (p.removed) {
      cur.end += p.value.length
      at += p.value.length
    } else cur.lines.push(...p.value)
  }
  if (cur) out.push(cur)
  return out
}
const sameHunk = (a: Hunk, b: Hunk) =>
  a.start === b.start && a.end === b.end && a.lines.join('\n') === b.lines.join('\n')

// A three-way merge by line of what I changed and what they changed from the same base (the revision I
// started from): changes to different lines both stay; text both added at the same place stays twice,
// theirs first; the same line changed two ways does not merge.
export function merge3(
  base: string,
  mine: string,
  theirs: string,
): { ok: true; text: string } | { ok: false } {
  const end = performance.now() + DIFF_MS * 1.5
  const B = base.split('\n')
  const t = lineParts(B, theirs.split('\n'), end)
  return mergeOf(B, lineParts(B, mine.split('\n'), end), t)
}

function mergeOf(
  B: string[],
  mineParts: LineParts | undefined,
  theirParts: LineParts | undefined,
): { ok: true; text: string } | { ok: false } {
  const m = hunksOf(mineParts)
  const t = hunksOf(theirParts)
  if (!m || !t) return { ok: false }
  const out: string[] = []
  let pos = 0
  let i = 0
  let j = 0
  while (i < m.length || j < t.length) {
    const a = m[i]
    const b = t[j]
    let take: Hunk
    if (a && b && (a.start === b.start || (a.start < b.end && b.start < a.end))) {
      if (sameHunk(a, b)) take = a
      else if (a.start === a.end && b.start === b.end) take = { ...b, lines: [...b.lines, ...a.lines] }
      else return { ok: false }
      i++
      j++
    } else if (a && (!b || a.start < b.start)) {
      take = a
      i++
    } else {
      take = b as Hunk
      j++
    }
    out.push(...B.slice(pos, take.start), ...take.lines)
    pos = take.end
  }
  out.push(...B.slice(pos))
  return { ok: true, text: out.join('\n') }
}

// Everything a conflict on the body works out (CA6, review of PR19): what they changed, by line, and the
// merge of both sides, under one deadline for all of it. Their side is compared once and serves both;
// past the deadline their text is shown whole and the merge is not offered.
const CONFLICT_MS = 120
export const CONFLICT_MEASURE = 'wiki: conflict worked out'
export function conflictBody(
  base: string,
  mine: string,
  theirs: string,
): { merged: { ok: true; text: string } | { ok: false }; theirs: DiffLine[] } {
  const start = performance.now()
  const end = start + CONFLICT_MS
  const B = base.split('\n')
  const T = theirs.split('\n')
  const t = lineParts(B, T, end)
  const merged = mergeOf(B, t && lineParts(B, mine.split('\n'), end), t)
  const out = { merged, theirs: linesOf(B, T, t, end) }
  // Seen in the browser's performance tools: how long it took, and how often it ran.
  performance.measure(CONFLICT_MEASURE, { start, end: performance.now() })
  return out
}

// A list merged by item: theirs, without what I removed (unless they removed it too, or it is gone
// already), with what I added.
export function mergeList<T>(base: T[], mine: T[], theirs: T[], key: (x: T) => string): T[] {
  const inBase = new Set(base.map(key))
  const inMine = new Set(mine.map(key))
  const out = theirs.filter((x) => !(inBase.has(key(x)) && !inMine.has(key(x))))
  const have = new Set(out.map(key))
  for (const x of mine) if (!inBase.has(key(x)) && !have.has(key(x))) out.push(x)
  return out
}

// What a revision changed, in words (spec B6 «Wiki › Page», review of PR19).
export function changeLabel(r: { change?: string; status: string; restoredFrom?: number | null }): string {
  switch (r.change) {
    case 'status':
      return `status → ${r.status}`
    case 'restored':
      return r.restoredFrom ? `restored revision ${r.restoredFrom}` : 'restored'
    case 'created':
    case 'edited':
    case 'linked':
    case 'moved':
      return r.change
    default:
      return 'edited'
  }
}

// Who read a page: one line per person (and per agent client), with how many times and the last time.
export type ReadLine = {
  id: number
  at: string
  kind: string
  account: { id: string; name: string }
  credential: { kind: string; name: string }
}
export type Reader = {
  key: string
  name: string
  via: string | null
  count: number
  last: string
  kinds: string[]
}
export function groupReaders(lines: ReadLine[]): Reader[] {
  const by = new Map<string, Reader>()
  for (const l of lines) {
    const via = l.credential.kind === 'web' || !l.credential.name ? null : l.credential.name
    const key = `${l.account.id}\u0000${via ?? ''}`
    const r = by.get(key) ?? { key, name: l.account.name, via, count: 0, last: l.at, kinds: [] }
    r.count += 1
    if (l.at > r.last) r.last = l.at
    if (!r.kinds.includes(l.kind)) r.kinds.push(l.kind)
    by.set(key, r)
  }
  return [...by.values()].sort((a, b) => (a.last < b.last ? 1 : a.last > b.last ? -1 : 0))
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
  // Inside a link already there, what is left of its address goes with it, up to its ]].
  const rest = text.slice(caret)
  const inside = /^[a-z0-9/-]*\]\]/i.exec(rest)
  const head = `${text.slice(0, start)}${address}]]`
  return { text: head + (inside ? rest.slice(inside[0].length) : rest), caret: head.length }
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

// An edit's draft is kept per person, brain and page, under a key made from them (a short hash), so a
// name such as "claude-code" or "infra/token-rotation" never reads like a secret to the draft store, and
// another person signing in on the same tab never meets it. The hash is in hex: its letters (a to f)
// cannot spell a word the store refuses, as base 36 could («code»).
export function draftKeyOf(account: string, slug: string, page: string): string {
  let h = 0x811c9dc5
  for (const ch of `${account}\u0000${slug}\u0000${page}`) {
    h ^= ch.codePointAt(0) ?? 0
    h = Math.imul(h, 0x01000193) >>> 0
  }
  return `wiki-edit.${h.toString(16).padStart(8, '0')}`
}

// A link or a status changed in the editor makes a new revision of the page without touching its
// content: the edit moves on to it. If the content changed too, someone else edited: it does not.
export const canRebase = (base: Editable, now: Editable) =>
  editChanges({ ...base, revision: 0 }, now) === null
