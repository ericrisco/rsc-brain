// What a curator sees before deciding (spec B2 «Revisar una propuesta»): for each operation, the page
// before and after, its reason and sources, what it depends on, and whether the page changed since the
// proposal was written. The fingerprint pins the version seen: approving needs it (CA6).
import { createHash } from 'node:crypto'
import { AppError } from '../../core/errors.ts'
import type { Db, Row } from '../../db/db.ts'
import type { Ctx } from '../context.ts'
import { mentionsOf, type Op } from './model.ts'
import { type FullRevision, fullRevision } from './pages.ts'
import {
  named,
  type Proposal,
  type ProposalOp,
  proposalOf,
  proposalOpOf,
  type Warning,
  warningsOf,
} from './proposals.ts'

export const webOnly = (ctx: Ctx): void => {
  if (ctx.who.credential.kind !== 'web') {
    throw new AppError(
      403,
      'web_only',
      'Approval happens in the web.',
      'Open the proposal in the rsc-brain web. Agents and programs can propose, not approve or edit pages.',
    )
  }
}

// The addresses an operation brings into being or moves away, and those it relies on.
function produces(o: Op): string[] {
  if (o.op === 'create') return [o.address]
  if (o.op === 'move') return [o.address, o.to]
  if (o.op === 'merge') return [o.from]
  return []
}

export function uses(o: Op): string[] {
  const out = [o.address]
  if (o.op === 'move' || o.op === 'link' || o.op === 'unlink') out.push(o.to)
  if (o.op === 'status' && o.supersededBy) out.push(o.supersededBy)
  if (o.op === 'merge') out.push(o.from)
  if (o.op === 'create') for (const l of o.links) out.push(l.to)
  return out
}

// dependsOn[i]: the operations i cannot be approved without (spec B2 «Dependencias»).
export function dependencies(ops: Op[]): number[][] {
  return ops.map((o, i) => {
    const need = new Set<number>()
    const mine = new Set(uses(o))
    ops.forEach((p, j) => {
      if (j === i) return
      if (produces(p).some((a) => mine.has(a))) need.add(j)
      // Marking "superseded" goes with the "supersedes" link that justifies it.
      if (
        o.op === 'status' &&
        o.status === 'superseded' &&
        p.op === 'link' &&
        p.kind === 'supersedes' &&
        p.address === o.supersededBy &&
        p.to === o.address
      ) {
        need.add(j)
      }
    })
    return [...need].sort((a, b) => a - b)
  })
}

// How many times text was purged from a brain's wiki (each purge counts; see purgesOf in decide.ts).
export async function wikiPurges(db: Db, brainId: string): Promise<number> {
  return Number((await db.one('SELECT wiki_purges FROM brains WHERE id = $1', [brainId]))?.wiki_purges ?? 0)
}

// Everything that, if it changed, changes what the curator approves — a purge of the wiki included: the
// pages it shows may have lost text, and nothing written from what was seen before may be applied.
export function fingerprint(row: Row, ops: ProposalOp[], purges: number): string {
  return createHash('sha256')
    .update(
      JSON.stringify({
        id: row.id,
        status: row.status,
        title: row.title,
        reason: row.reason,
        collected: row.collected,
        supersededBy: row.superseded_by,
        purges,
        ops: ops.map((o) => [o.index, o.op, o.status, o.correctedBy, o.baseReviewedBy]),
      }),
    )
    .digest('hex')
}

export type PageState = {
  pageId: string
  address: string
  revision: number
  type: string
  title: string
  summary: string
  body: string
  tags: string[]
  status: string
  sources: unknown[]
  links: { kind: string; to: string }[]
  mentions: string[]
}

async function stateOf(db: Db, brainId: string, address: string): Promise<PageState | null> {
  const p = await db.one(
    'SELECT p.* FROM page_addresses a JOIN pages p ON p.id = a.page_id WHERE a.brain_id = $1 AND a.address = $2',
    [brainId, address],
  )
  if (!p) return null
  const sources = await db.query(
    'SELECT entry_id, url, title FROM page_sources WHERE page_id = $1 ORDER BY entry_id NULLS LAST, url',
    [p.id],
  )
  const links = await db.query(
    'SELECT l.kind, t.address FROM page_links l JOIN pages t ON t.id = l.to_page WHERE l.from_page = $1 ORDER BY l.kind, t.address',
    [p.id],
  )
  return {
    pageId: String(p.id),
    address: String(p.address),
    revision: Number(p.revision),
    type: String(p.type),
    title: String(p.title),
    summary: String(p.summary),
    body: String(p.body),
    tags: (p.tags as string[]) ?? [],
    status: String(p.status),
    sources: sources.map((s) =>
      s.entry_id != null ? { entryId: s.entry_id } : { url: s.url, title: s.title },
    ),
    links: links.map((l) => ({ kind: String(l.kind), to: String(l.address) })),
    mentions: mentionsOf(String(p.body)),
  }
}

export type ReviewedOp = {
  index: number
  op: Op
  status: ProposalOp['status']
  corrected: boolean
  before: PageState | null
  after: Partial<PageState> | null
  dependsOn: number[]
  stale: { base: FullRevision | null; current: PageState; proposed: Partial<PageState> } | null
  warnings: Warning[]
}

export type Review = {
  proposal: Proposal
  fingerprint: string
  ops: ReviewedOp[]
  warnings: Warning[]
  // The purges of the wiki so far: a correction echoes it (one written before a purge is refused).
  purges: number
  // The journal entries the operations cite, named as a wiki page names its sources: the review
  // carries them so nobody opens each entry to name it (opening one is a read). A forgotten entry
  // keeps its words only for a curator; a purged one for nobody.
  sourceEntries: SourceEntry[]
}

export type SourceEntry = { id: string; title: string | null; state: 'active' | 'forgotten' | 'purged' }

async function sourceEntriesOf(db: Db, brainId: string, ops: Op[], curator: boolean): Promise<SourceEntry[]> {
  const ids = [
    ...new Set(
      ops.flatMap((o) =>
        'sources' in o && Array.isArray(o.sources)
          ? o.sources.flatMap((s) => ('entryId' in s ? [s.entryId] : []))
          : [],
      ),
    ),
  ]
  if (ids.length === 0) return []
  // Only entries of the proposal's brain: an id from another brain names nothing here.
  const rows = await db.query(
    'SELECT id, title, state FROM entries WHERE id = ANY($1) AND brain_id = $2 ORDER BY id',
    [ids, brainId],
  )
  return rows.map((r) => {
    const state = r.state as SourceEntry['state']
    const shown = state === 'active' || (state === 'forgotten' && curator)
    return { id: String(r.id), title: shown ? String(r.title) : null, state }
  })
}

function afterOf(o: Op, before: PageState | null): Partial<PageState> | null {
  switch (o.op) {
    case 'create':
      return {
        address: o.address,
        type: o.type,
        title: o.title,
        summary: o.summary,
        body: o.body,
        tags: o.tags,
        status: 'current',
        sources: o.sources,
        links: o.links.map((l) => ({ kind: l.kind, to: l.to })),
        mentions: mentionsOf(o.body),
      }
    case 'edit': {
      const out: Partial<PageState> = { ...(before ?? {}) }
      if (o.type !== undefined) out.type = o.type
      if (o.title !== undefined) out.title = o.title
      if (o.summary !== undefined) out.summary = o.summary
      if (o.body !== undefined) {
        out.body = o.body
        out.mentions = mentionsOf(o.body)
      }
      if (o.tags !== undefined) out.tags = o.tags
      if (o.sources !== undefined) out.sources = o.sources
      return out
    }
    case 'move':
      return { ...(before ?? {}), address: o.to }
    case 'link':
      return { ...(before ?? {}), links: [...(before?.links ?? []), { kind: o.kind, to: o.to }] }
    case 'unlink':
      return {
        ...(before ?? {}),
        links: (before?.links ?? []).filter((l) => !(l.kind === o.kind && l.to === o.to)),
      }
    case 'status':
      return { ...(before ?? {}), status: o.status }
    case 'merge':
      return { ...(before ?? {}), body: o.body, mentions: mentionsOf(o.body) }
    case 'revert':
      return null
  }
}

export async function buildReview(ctx: Ctx, row: Row, curator: boolean): Promise<Review> {
  const brainId = String(row.brain_id)
  const rows = await ctx.db.query('SELECT * FROM proposal_ops WHERE proposal_id = $1 ORDER BY idx', [row.id])
  const ops = rows.map(proposalOpOf)
  const plain = ops.map((o) => o.op)
  const deps = dependencies(plain)
  const decided = new Set(ops.filter((o) => o.status !== 'pending').map((o) => o.index))
  const warnings = row.status === 'pending' ? await warningsOf(ctx.db, brainId, plain, decided) : []
  const purges = await wikiPurges(ctx.db, brainId)
  const reviewed: ReviewedOp[] = []
  for (const o of ops) {
    const before = await stateOf(ctx.db, brainId, o.op.address)
    let after = afterOf(o.op, before)
    if (o.op.op === 'revert' && before) {
      const r = await ctx.db.one('SELECT * FROM page_revisions WHERE page_id = $1 AND revision = $2', [
        before.pageId,
        o.op.toRevision,
      ])
      after = r ? (fullRevision(r) as unknown as Partial<PageState>) : null
    }
    let stale: ReviewedOp['stale'] = null
    if (
      o.op.op === 'edit' &&
      before &&
      o.op.baseRevision !== undefined &&
      o.op.baseRevision < before.revision
    ) {
      const base = await ctx.db.one('SELECT * FROM page_revisions WHERE page_id = $1 AND revision = $2', [
        before.pageId,
        o.op.baseRevision,
      ])
      stale = { base: base ? fullRevision(base) : null, current: before, proposed: after ?? {} }
    }
    reviewed.push({
      index: o.index,
      op: o.op,
      status: o.status,
      corrected: o.correctedBy !== null,
      before,
      after,
      dependsOn: deps[o.index] ?? [],
      stale: o.status === 'pending' ? stale : null,
      warnings: warnings.filter((w) => w.op === o.index),
    })
  }
  return {
    proposal: await named(ctx.db, proposalOf(row, ctx.clock())),
    fingerprint: fingerprint(row, ops, purges),
    purges,
    ops: reviewed,
    warnings: warnings.filter((w) => w.op === null),
    sourceEntries: await sourceEntriesOf(ctx.db, brainId, plain, curator),
  }
}
