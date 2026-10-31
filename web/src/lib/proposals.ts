// The logic of the proposals inbox (spec B6 «Proposals: la bandeja», B2 «Revisar una propuesta»), kept
// free of the DOM so it is tested on its own: the operations that go together and why, choosing some of
// them (what one needs comes with it), what keeps each decision from being sent and why, what a decision
// sends (only what was seen, by its fingerprint), the choices kept when the proposal changes meanwhile, the
// live notice of another person's decision, and how an operation reads.
import { T } from '../text.ts'

export type Op = { op: string; address: string; reason: string; [k: string]: unknown }

export type PageState = {
  address?: string
  revision?: number
  type?: string
  title?: string
  summary?: string
  body?: string
  tags?: string[]
  status?: string
  sources?: Array<{ entryId: string } | { url: string; title?: string }>
  links?: Array<{ kind: string; to: string }>
}

export type ReviewOp = {
  index: number
  op: Op
  status: 'pending' | 'approved' | 'returned'
  corrected: boolean
  before: PageState | null
  after: PageState | null
  dependsOn: number[]
  stale: { base: PageState | null; current: PageState; proposed: PageState } | null
  warnings: Array<{ op: number | null; code: string; message: string }>
}

// What the person chose on a proposal, kept in a draft until it is decided: the changes chosen, their own
// versions of some (by operation number), the old bases reviewed, and the comment.
export type Choices = {
  selected: number[]
  corrections: Record<number, Record<string, unknown>>
  baseReviewed: number[]
  comment: string
}

const sorted = (xs: Iterable<number>) => [...new Set(xs)].sort((a, b) => a - b)

// The operations that depend on each other, in groups (spec B2 «Dependencias»), each in the order of the
// proposal, the groups in the order of their first operation.
export function groupsOf(ops: Pick<ReviewOp, 'index' | 'dependsOn'>[]): number[][] {
  const parent = new Map<number, number>(ops.map((o) => [o.index, o.index]))
  const root = (i: number): number => {
    let r = i
    while (parent.get(r) !== r) r = parent.get(r) ?? r
    return r
  }
  for (const o of ops) for (const d of o.dependsOn) if (parent.has(d)) parent.set(root(o.index), root(d))
  const by = new Map<number, number[]>()
  for (const o of [...ops].sort((a, b) => a.index - b.index)) {
    const r = root(o.index)
    by.set(r, [...(by.get(r) ?? []), o.index])
  }
  return [...by.values()].sort((a, b) => (a[0] ?? 0) - (b[0] ?? 0))
}

// Why a group goes together, in a line: «Change 2 needs change 1; change 3 needs changes 1 and 2.»
export function togetherWhy(group: number[], ops: Pick<ReviewOp, 'index' | 'dependsOn'>[]): string {
  const parts = group.flatMap((i) => {
    const deps = ops.find((o) => o.index === i)?.dependsOn ?? []
    return deps.length
      ? [
          T.proposals.needs(
            i + 1,
            deps.map((d) => d + 1),
          ),
        ]
      : []
  })
  const line = parts.join('; ')
  return line ? `${line[0]?.toUpperCase()}${line.slice(1)}.` : ''
}

// Choosing a change brings what it needs; leaving one out takes what needs it (the server refuses part of
// a proposal without its dependencies). Only pending changes are chosen.
export function choose(
  selected: number[],
  i: number,
  on: boolean,
  ops: Pick<ReviewOp, 'index' | 'dependsOn' | 'status'>[],
): number[] {
  const pending = new Set(ops.filter((o) => o.status === 'pending').map((o) => o.index))
  if (!pending.has(i)) return sorted(selected.filter((x) => pending.has(x)))
  const out = new Set(selected.filter((x) => pending.has(x)))
  const depsOf = (x: number) => ops.find((o) => o.index === x)?.dependsOn ?? []
  if (on) {
    const todo = [i]
    while (todo.length) {
      const x = todo.pop() as number
      if (out.has(x) && x !== i) continue
      out.add(x)
      for (const d of depsOf(x)) if (pending.has(d) && !out.has(d)) todo.push(d)
    }
  } else {
    const todo = [i]
    while (todo.length) {
      const x = todo.pop() as number
      out.delete(x)
      for (const o of ops) if (out.has(o.index) && o.dependsOn.includes(x)) todo.push(o.index)
    }
  }
  return sorted(out)
}

// An edit written on an older revision is approved only once the person edits it or marks the base
// reviewed (spec B2 CA7).
export function needsBase(o: Pick<ReviewOp, 'index' | 'stale'>, c: Choices): boolean {
  return o.stale !== null && !c.baseReviewed.includes(o.index) && !(o.index in c.corrections)
}

export type Blockers = {
  all: string | null
  some: string | null
  back: string | null
  // The comment is what is missing (the keyboard goes to it).
  someNeedsComment: boolean
  backNeedsComment: boolean
}

// Why each decision cannot be sent now, or null (spec B6: «el botón explica por qué está desactivado»).
export function blockers(ops: ReviewOp[], c: Choices): Blockers {
  const p = T.proposals
  const pending = ops.filter((o) => o.status === 'pending')
  const staleIn = (list: ReviewOp[]) => list.find((o) => needsBase(o, c))
  const said = c.comment.trim() !== ''
  const firstStale = staleIn(pending)
  const all = firstStale ? p.staleBlocks(firstStale.index + 1) : null
  const chosen = pending.filter((o) => c.selected.includes(o.index))
  let some: string | null = null
  let someNeedsComment = false
  if (chosen.length === 0) some = p.chooseSome
  else if (chosen.length === pending.length) some = p.allChosen
  else {
    const s = staleIn(chosen)
    if (s) some = p.staleBlocks(s.index + 1)
    else if (!said) {
      some = p.writeWhyRest
      someNeedsComment = true
    }
  }
  return { all, some, back: said ? null : p.writeWhy, someNeedsComment, backNeedsComment: !said }
}

// What a decision sends: the fingerprint of what was seen, and for part of it the chosen changes and the
// comment. Corrections and reviewed bases only for what is approved.
export function approveBody(
  fingerprint: string,
  ops: ReviewOp[],
  c: Choices,
  how: 'all' | 'some',
): Record<string, unknown> {
  const pending = ops.filter((o) => o.status === 'pending').map((o) => o.index)
  const approve = how === 'all' ? pending : sorted(c.selected.filter((i) => pending.includes(i)))
  const out: Record<string, unknown> = { fingerprint }
  if (how === 'some') {
    out.approve = approve
    out.comment = c.comment.trim()
  }
  const corrections = Object.fromEntries(
    Object.entries(c.corrections).filter(([k]) => approve.includes(Number(k))),
  )
  if (Object.keys(corrections).length) out.corrections = corrections
  const reviewed = sorted(
    c.baseReviewed.filter((i) => approve.includes(i) && ops.find((o) => o.index === i)?.stale),
  )
  if (reviewed.length) out.baseReviewed = reviewed
  return out
}

// After the proposal changed meanwhile: the comment always stays; the rest stays for changes still pending.
// Nothing to drop gives back the same choices (the same object), so nothing is written again.
export function keepChoices(c: Choices, ops: ReviewOp[]): Choices {
  const pending = new Set(ops.filter((o) => o.status === 'pending').map((o) => o.index))
  const stale = new Set(ops.filter((o) => o.stale).map((o) => o.index))
  const same =
    c.selected.every((i) => pending.has(i)) &&
    c.baseReviewed.every((i) => pending.has(i) && stale.has(i)) &&
    Object.keys(c.corrections).every((k) => pending.has(Number(k)))
  if (same) return c
  return {
    selected: sorted(c.selected.filter((i) => pending.has(i))),
    comment: c.comment,
    baseReviewed: sorted(c.baseReviewed.filter((i) => pending.has(i) && stale.has(i))),
    corrections: Object.fromEntries(Object.entries(c.corrections).filter(([k]) => pending.has(Number(k)))),
  }
}

// Another person decided (or its author withdrew) the proposal on screen, heard on the live feed (B5):
// «Approved by Eva just now» and the view goes read-only. My own decision says its own result instead.
export function decidedNotice(
  e: { kind?: unknown; who?: unknown; target?: unknown },
  proposal: string,
  me: string,
): { who: string; text: string } | null {
  if (e.kind !== 'proposal.decided' && e.kind !== 'proposal.withdrawn') return null
  const t = e.target as { id?: unknown; label?: unknown } | null | undefined
  const who = e.who as { id?: unknown; name?: unknown } | null | undefined
  if (!t || t.id !== proposal || !who || typeof who.name !== 'string' || who.id === me) return null
  const how =
    e.kind === 'proposal.withdrawn'
      ? T.proposals.live.withdrawn
      : (T.proposals.live[String(t.label)] ?? T.proposals.live.approved)
  return { who: who.name, text: T.proposals.liveNotice(how as string, who.name) }
}

// An operation as a person says it: «Edit audience/intros», «Merge b into a».
export function opWords(o: Op): string {
  const w = T.proposals.op
  const kind = (k: unknown) => T.proposals.linkKinds[String(k)] ?? String(k)
  switch (o.op) {
    case 'create':
      return w.create(o.address)
    case 'edit':
      return w.edit(o.address)
    case 'move':
      return w.move(o.address, String(o.to))
    case 'link':
      return w.link(o.address, String(o.to), kind(o.kind))
    case 'unlink':
      return w.unlink(o.address, String(o.to), kind(o.kind))
    case 'status':
      return w.status(o.address, (T.wiki.statuses[String(o.status)] ?? String(o.status)).toLowerCase())
    case 'merge':
      return w.merge(o.address, String(o.from))
    case 'revert':
      return w.revert(o.address, Number(o.toRevision))
    default:
      return `${o.op} ${o.address}`
  }
}

// The fields a person may edit before approving, by kind of operation (a correction keeps its kind and
// page, B2): the words of a new page, of an edit, and the merged text.
export function editableParts(o: Op): Array<'title' | 'summary' | 'body'> {
  if (o.op === 'create') return ['title', 'summary', 'body']
  if (o.op === 'edit')
    return (['title', 'summary', 'body'] as const).filter((k) => typeof o[k] === 'string' || k === 'body')
  if (o.op === 'merge') return ['body']
  return []
}

// A person's choices on a proposal are kept per person and proposal, under a short hash in hex (it can
// never spell a word the draft store refuses), and leave with the session (clearDrafts).
export function inboxDraftKey(account: string, proposal: string): string {
  let h = 0x811c9dc5
  for (const ch of `${account}\u0000${proposal}`) {
    h ^= ch.codePointAt(0) ?? 0
    h = Math.imul(h, 0x01000193) >>> 0
  }
  return `inbox.${h.toString(16).padStart(8, '0')}`
}
