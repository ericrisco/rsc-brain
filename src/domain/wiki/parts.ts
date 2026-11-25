// Spec learning-memory A1 (plan §2.1, §2.2): which parts of a proposal apply at once, which wait for a person and
// which come back to be redone on the current page. Pure: the facts are read by the caller, under the wiki's lock.
//   - «Ask first»: every part waits (CA-A7).
//   - A part that writes a protected page waits, unless the key has the wiki write permission (CA-A4, A17).
//   - A part that writes a page a live correction points at, or declares a «contradicts» or «supersedes» link towards
//     one, waits, with the permission too: only people write corrections (pack rule 4; CA-A6).
//   - An edit written on a revision that is no longer the page's comes back with the current one (CA-A20).
//   - Parts that depend on one another share their fate (CA-A24): what needs a part that comes back comes back; what
//     needs a part that waits waits. Needing both, it comes back: it must be redone anyway.
import type { Op } from './model.ts'
import { dependencies } from './review.ts'

export type Facts = {
  mode: 'auto' | 'ask_first'
  // The key has the wiki write permission in this brain (wiki_writers), or a person in the web writes.
  canWrite: boolean
  // Page ids.
  protectedPages: Set<string>
  correctedPages: Set<string>
  // Address (any address a page answers to) → the page and its revision now.
  current: Map<string, { pageId: string; revision: number }>
}

export type HoldReason = 'protected' | 'correction' | 'ask_first' | 'depends'
export type Held = { op: number; address: string; reason: HoldReason; detail: string }
export type Returned = {
  op: number
  address: string
  reason: 'stale' | 'depends'
  currentRevision: number | null
}
export type Classified = { apply: number[]; held: Held[]; returned: Returned[] }

// The addresses a part writes: its own; the other page of a «supersedes» link (it changes that page's state); the page
// a merge takes in. Never one it only reads (the target of another link, the page that supersedes in a status).
export function writesTo(op: Op): string[] {
  const out = [op.address]
  if ((op.op === 'link' || op.op === 'unlink') && op.kind === 'supersedes') out.push(op.to)
  if (op.op === 'create') for (const l of op.links) if (l.kind === 'supersedes') out.push(l.to)
  if (op.op === 'merge') out.push(op.from)
  return [...new Set(out)]
}

// The pages a part declares a «contradicts» or «supersedes» link towards (a «status superseded» writes its own page).
function declaresAgainst(op: Op): string[] {
  if (op.op === 'link' && (op.kind === 'contradicts' || op.kind === 'supersedes')) return [op.to]
  if (op.op === 'create')
    return op.links.filter((l) => l.kind === 'contradicts' || l.kind === 'supersedes').map((l) => l.to)
  return []
}

type Own =
  | { kind: 'held'; address: string; reason: HoldReason; detail: string }
  | { kind: 'returned'; held: Returned }

function ownFate(op: Op, i: number, f: Facts): Own | null {
  const pageOf = (a: string) => f.current.get(a)?.pageId
  if (!f.canWrite) {
    const p = writesTo(op).find((a) => {
      const id = pageOf(a)
      return id !== undefined && f.protectedPages.has(id)
    })
    if (p !== undefined)
      return {
        kind: 'held',
        address: p,
        reason: 'protected',
        detail: `The page "${p}" is protected: only a person or a key with the wiki write permission writes there. A curator decides this part.`,
      }
  }
  const corrected = (a: string) => {
    const id = pageOf(a)
    return id !== undefined && f.correctedPages.has(id)
  }
  const c = writesTo(op).find(corrected) ?? declaresAgainst(op).find(corrected)
  if (c !== undefined)
    return {
      kind: 'held',
      address: c,
      reason: 'correction',
      detail: `A person's correction points at the page "${c}": a person decides this part.`,
    }
  if (op.op === 'edit' && op.baseRevision !== undefined) {
    const now = f.current.get(op.address)
    if (now && now.revision !== op.baseRevision)
      return {
        kind: 'returned',
        held: { op: i, address: op.address, reason: 'stale', currentRevision: now.revision },
      }
  }
  return null
}

export function classify(ops: Op[], f: Facts): Classified {
  if (f.mode === 'ask_first')
    return {
      apply: [],
      held: ops.map((o, i) => ({
        op: i,
        address: o.address,
        reason: 'ask_first',
        detail: 'This brain asks first: a curator decides every change to its wiki.',
      })),
      returned: [],
    }
  const own = ops.map((o, i) => ownFate(o, i, f))
  const deps = dependencies(ops)
  // Every part a part needs, directly or through others.
  const needs = (i: number): number[] => {
    const seen = new Set<number>()
    const stack = [...(deps[i] ?? [])]
    while (stack.length) {
      const j = stack.pop() as number
      if (seen.has(j) || j === i) continue
      seen.add(j)
      stack.push(...(deps[j] ?? []))
    }
    return [...seen].sort((a, b) => a - b)
  }
  const out: Classified = { apply: [], held: [], returned: [] }
  ops.forEach((o, i) => {
    const mine = own[i]
    if (mine?.kind === 'returned') {
      out.returned.push(mine.held)
      return
    }
    const needed = needs(i)
    const back = needed.filter((j) => own[j]?.kind === 'returned')
    if (back.length) {
      out.returned.push({
        op: i,
        address: o.address,
        reason: 'depends',
        currentRevision: f.current.get(o.address)?.revision ?? null,
      })
      return
    }
    if (mine?.kind === 'held') {
      out.held.push({ op: i, address: mine.address, reason: mine.reason, detail: mine.detail })
      return
    }
    const waiting = needed.filter((j) => own[j]?.kind === 'held')
    if (waiting.length) {
      out.held.push({
        op: i,
        address: o.address,
        reason: 'depends',
        detail: `It needs ${waiting.map((j) => `part ${j}`).join(', ')}, which waits for a person; it goes with it.`,
      })
      return
    }
    out.apply.push(i)
  })
  return out
}
