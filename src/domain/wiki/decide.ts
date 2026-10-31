// A curator decides, in the web (spec B2 «Revisar una propuesta»): approve all, approve part and return
// the rest with a comment, correct an operation first, or return it all. What is approved applies all
// at once or not at all; a returned comment becomes a correction in the journal for the agent that
// proposed, so it learns why. Only what was seen is approved: the fingerprint must match.
import { can } from '../../auth/can.ts'
import { actorOf } from '../../auth/principal.ts'
import { AppError, conflict, invalid, notFound } from '../../core/errors.ts'
import type { Row } from '../../db/db.ts'
import { redact } from '../../privacy/redact.ts'
import { allow, type Ctx, inBrain } from '../context.ts'
import { webCorrection } from '../entries.ts'
import { emit } from '../events.ts'
import { ApplyError, type ApplyItem, applyOps, type Revised } from './apply.ts'
import { type Op, type Problem, readOp, WIKI_LIMITS } from './model.ts'
import { named, type Proposal, type ProposalOp, proposalOf, proposalOpOf } from './proposals.ts'
import { buildReview, dependencies, fingerprint, type Review, webOnly, wikiPurges } from './review.ts'

// `decide`: the person is about to decide (a curator of an active brain); otherwise only reading the
// review, which every member may do in the web (spec B6 CA17: a reader sees the inbox, read-only).
async function load(
  ctx: Ctx,
  id: string,
  lock: boolean,
  decide = true,
): Promise<{ row: Row; brainId: string; slug: string; canDecide: boolean }> {
  const row = await ctx.db.one(`SELECT * FROM proposals WHERE id = $1${lock ? ' FOR UPDATE' : ''}`, [id])
  if (!row) throw notFound('proposal')
  const { brain, role } = await inBrain(ctx, { id: String(row.brain_id) }, lock ? 'share' : null).catch(
    () => {
      throw notFound('proposal')
    },
  )
  webOnly(ctx)
  const facts = { role, brainStatus: brain.status }
  if (decide) await allow(ctx, 'wiki.decide', facts, brain.id)
  const canDecide = can(actorOf(ctx.who), 'wiki.decide', facts).ok
  return { row, brainId: brain.id, slug: brain.slug, canDecide }
}

export async function reviewProposal(ctx: Ctx, id: string): Promise<Review & { canDecide: boolean }> {
  const { row, canDecide } = await load(ctx, id, false, false)
  return { ...(await buildReview(ctx, row)), canDecide }
}

// Only a pending proposal is decided, and only in the version the curator saw.
async function stillAsSeen(ctx: Ctx, row: Row, seen: string): Promise<ProposalOp[]> {
  if (row.status === 'superseded') {
    const err = conflict(
      'proposal_changed',
      'Its author replaced this proposal; nothing was applied.',
      'Review the new version (in "current").',
    )
    err.current = { supersededBy: row.superseded_by }
    throw err
  }
  if (row.status !== 'pending') {
    const by = await ctx.db.one<{ name: string }>('SELECT name FROM accounts WHERE id = $1', [row.decided_by])
    const err = conflict(
      'already_decided',
      row.decided_by
        ? `Already ${String(row.status).replace('_', ' ')} by ${by?.name ?? 'someone'} on ${(row.decided_at as Date).toISOString()}.`
        : `This proposal is ${row.status}.`,
      'Nothing to do; open the brain log to see what changed.',
    )
    err.current = { status: row.status, decidedBy: row.decided_by, decidedAt: row.decided_at }
    throw err
  }
  const ops = (
    await ctx.db.query('SELECT * FROM proposal_ops WHERE proposal_id = $1 ORDER BY idx', [row.id])
  ).map(proposalOpOf)
  if (fingerprint(row, ops, await wikiPurges(ctx.db, String(row.brain_id))) !== seen) {
    const err = conflict(
      'proposal_changed',
      'The proposal changed while you were looking at it; nothing was applied.',
      'Review it again (the new version is in "current").',
    )
    err.current = await buildReview(ctx, row)
    throw err
  }
  return ops
}

const commentOf = (raw: string | undefined): string | undefined => {
  if (raw === undefined) return undefined
  // Stored and shown to the agent: redacted first, like every stored text (pack rule 1).
  const c = redact(raw.trim()).text
  if (!c || c.length > WIKI_LIMITS.comment) {
    throw invalid(`A comment has 1 to ${WIKI_LIMITS.comment} characters.`, 'Say why, briefly.')
  }
  return c
}

// The returned part becomes a person's correction that applies to whoever proposed (spec B2, CA8).
async function teach(ctx: Ctx, brainId: string, row: Row, comment: string, returned: ProposalOp[]) {
  const author = await ctx.db.one<{ name: string }>('SELECT name FROM accounts WHERE id = $1', [
    row.author_id,
  ])
  const appliesTo = String(row.agent ?? author?.name ?? 'the proposer').slice(0, 80)
  const which = returned.map((o) => `${o.index} (${o.op.op} ${o.op.address})`).join(', ')
  await webCorrection(ctx, ctx.db, brainId, {
    title: `Returned: ${String(row.title)}`.slice(0, 200),
    content: `${comment}\n\nReturned operations of proposal ${row.id}: ${which}.`.slice(0, 32_000),
    appliesTo,
    refs: [String(row.id)],
  })
}

// What a person may correct before approving (spec B2: «Edit de una operación»): the words of a new page,
// of an edit and of a merge — only those they edited — and for an edit the revision they saw. Never a whole
// operation (it could carry tags, sources or another page), never tags or sources. `purges` echoes the
// purges of the wiki the review showed: a correction written before a purge could put purged text back,
// so it is refused (409, as a proposal that changed).
const CORRECTABLE: Record<string, readonly string[]> = {
  create: ['title', 'summary', 'body'],
  edit: ['title', 'summary', 'body'],
  merge: ['body'],
}
function overlay(
  op: Op,
  raw: unknown,
  i: number,
  purges: number,
  problems: Problem[],
): Record<string, unknown> | null {
  const allowed = CORRECTABLE[op.op] ?? []
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    problems.push({ op: i, message: 'A correction is an object of the fields you edited.' })
    return null
  }
  const out: Record<string, unknown> = { ...op }
  let words = 0
  const { revision, purges: seen, ...fields } = raw as Record<string, unknown>
  for (const [key, v] of Object.entries(fields)) {
    if (!allowed.includes(key)) {
      problems.push({
        op: i,
        message: allowed.length
          ? `A correction of a ${op.op} changes only ${allowed.join(', ')}; not "${key}".`
          : `A ${op.op} operation cannot be corrected; return it instead.`,
      })
    } else if (typeof v !== 'string') {
      problems.push({ op: i, message: `"${key}" is text.` })
    } else {
      out[key] = v
      words += 1
    }
  }
  if (words === 0 && allowed.length) {
    problems.push({
      op: i,
      message: `A correction changes at least one of ${allowed.join(', ')} (to accept an old base as it is, mark it "base reviewed").`,
    })
  }
  if (revision !== undefined) {
    if (op.op !== 'edit' || typeof revision !== 'number' || !Number.isSafeInteger(revision) || revision < 1)
      problems.push({ op: i, message: '"revision" is the revision of the page you saw (edits only).' })
    else out.baseRevision = revision
  }
  if (typeof seen !== 'number' || !Number.isSafeInteger(seen) || seen < 0) {
    problems.push({ op: i, message: '"purges" echoes the "purges" of the review you corrected.' })
  } else if (seen !== purges && !problems.some((p) => p.op === i)) {
    const err = conflict(
      'proposal_changed',
      'Text was purged from this wiki after your edit was written; nothing was applied.',
      'Review it again and write your edit anew from what the pages hold now.',
    )
    err.current = { purged: true }
    throw err
  }
  return out
}

export type Decision = { proposal: Proposal; ops: ProposalOp[]; applied: Revised[] }

export type ApproveInput = {
  fingerprint: string
  approve?: number[]
  comment?: string
  corrections?: Record<string, unknown>
  baseReviewed?: number[]
}

export async function approveProposal(ctx: Ctx, id: string, input: ApproveInput): Promise<Decision> {
  const comment = commentOf(input.comment)
  let failure: ApplyError | null = null
  const out = await ctx.db.tx(async (db) => {
    const c = { ...ctx, db }
    const { row, brainId } = await load(c, id, true)
    const ops = await stillAsSeen(c, row, input.fingerprint)
    const all = ops.map((o) => o.index)
    const original = ops.map((o) => o.op)
    const approve = [...new Set(input.approve ?? all)].sort((a, b) => a - b)
    if (approve.length === 0)
      throw invalid('Approve at least one operation.', 'To approve none, return the proposal.')
    for (const i of [...approve, ...(input.baseReviewed ?? [])]) {
      if (!all.includes(i))
        throw invalid(`The proposal has no operation ${i}.`, `Its operations are 0 to ${all.length - 1}.`)
    }
    // A curator's correction replaces the operation, checked like any operation.
    const corrected = new Set<number>()
    const problems: Problem[] = []
    const purges = await wikiPurges(db, brainId)
    for (const [k, raw] of Object.entries(input.corrections ?? {})) {
      const i = Number(k)
      if (!all.includes(i))
        throw invalid(`The proposal has no operation ${k}.`, 'Correct an existing operation.')
      const was = ops[i] as ProposalOp
      // The fields the person edited, laid over the stored operation and checked like any operation; an
      // edit's base revision is the one the person saw, and the base check below runs for it too.
      const merged = overlay(was.op, raw, i, purges, problems)
      if (!merged) continue
      const op = readOp(merged, i, problems)
      if (op && (op.op !== was.op.op || op.address !== was.op.address)) {
        problems.push({ op: i, message: 'A correction keeps the kind of operation and its page.' })
      } else if (op) {
        was.op = op
        corrected.add(i)
      }
    }
    if (problems.length > 0) {
      const err = invalid(
        'A correction has problems; nothing was applied.',
        'Fix each one listed in "problems".',
      )
      err.problems = problems
      throw err
    }
    const rest = all.filter((i) => !approve.includes(i))
    if (rest.length > 0 && !comment) {
      throw invalid(
        'Approving part of a proposal returns the rest, and that needs a comment.',
        'Write in "comment" why the rest goes back.',
      )
    }
    const plain = ops.map((o) => o.op)
    const deps = dependencies(plain)
    const missing = approve.flatMap((i) => {
      const needs = (deps[i] ?? []).filter((j) => !approve.includes(j))
      return needs.length > 0 ? [{ op: i, needs }] : []
    })
    if (missing.length > 0) {
      const err = new AppError(
        400,
        'missing_dependencies',
        `Some operations cannot be approved without others: ${missing.map((m) => `${m.op} needs ${m.needs.join(', ')}`).join('; ')}.`,
        'Approve them together, or leave them all out.',
      )
      err.problems = missing
      throw err
    }
    // An edit written on an older revision is approved only once corrected or marked "base reviewed".
    const reviewedBase = new Set(input.baseReviewed ?? [])
    for (const i of approve) {
      const o = plain[i] as Op
      if (o.op !== 'edit' || o.baseRevision === undefined || reviewedBase.has(i)) continue
      const p = await db.one(
        'SELECT p.revision FROM page_addresses a JOIN pages p ON p.id = a.page_id WHERE a.brain_id = $1 AND a.address = $2',
        [brainId, o.address],
      )
      if (p && Number(p.revision) !== o.baseRevision) {
        const err = conflict(
          'stale_base',
          `Operation ${i}: "${o.address}" changed since revision ${o.baseRevision} (it is at ${p.revision}).`,
          'Correct the operation, mark it "base reviewed" if the change does not matter, or return it.',
        )
        err.problems = [{ op: i, base: o.baseRevision, current: Number(p.revision) }]
        throw err
      }
    }
    const items: ApplyItem[] = approve.map((i) => ({
      op: plain[i] as Op,
      index: i,
      corrected: corrected.has(i),
      baseReviewed: reviewedBase.has(i),
    }))
    // Apply under a savepoint: if it fails, nothing of it stays, but the error is kept on the proposal.
    await db.query('SAVEPOINT apply')
    let applied: Revised[]
    try {
      applied = (
        await applyOps(c, db, brainId, items, {
          kind: 'proposal',
          proposalId: String(row.id),
          summary: `${rest.length > 0 ? 'Partly approved' : 'Approved'}: ${String(row.title)}`,
        })
      ).revised
    } catch (err) {
      await db.query('ROLLBACK TO SAVEPOINT apply')
      // A deadlock or a serialisation failure is the database's, not the proposal's: let it fail whole
      // so the curator retries, instead of recording it on the proposal.
      const code = (err as { code?: string }).code
      if (code === '40P01' || code === '40001') throw err
      const e =
        err instanceof ApplyError ? err : new ApplyError(undefined, 'the change could not be applied.')
      await db.query('UPDATE proposals SET last_error = $2 WHERE id = $1', [row.id, e.message])
      failure = e
      return null
    }
    const now = ctx.clock()
    for (const o of ops) {
      const ok = approve.includes(o.index)
      // The operation's own page (a supersedes link also revises the page it supersedes, after).
      const first = applied.find((r) => r.index === o.index)
      await db.query(
        `UPDATE proposal_ops SET status = $3, op = $4, corrected_by = $5, base_reviewed_by = $6,
                applied_page = $7, applied_revision = $8 WHERE proposal_id = $1 AND idx = $2`,
        [
          row.id,
          o.index,
          ok ? 'approved' : 'returned',
          // A returned operation stays as its author sent it; corrections and marks are for what applied.
          JSON.stringify(ok ? o.op : original[o.index]),
          ok && corrected.has(o.index) ? ctx.who.accountId : null,
          ok && reviewedBase.has(o.index) ? ctx.who.accountId : null,
          first?.pageId ?? null,
          first?.revision ?? null,
        ],
      )
    }
    // The entries the approved part cites, and those collected without changes, are compiled (B1 CA23).
    const cited = new Set<string>(row.collected as string[])
    for (const i of approve) {
      const o = plain[i] as Op
      if (o.op === 'create' || o.op === 'edit')
        for (const s of o.sources ?? []) if ('entryId' in s) cited.add(s.entryId)
    }
    if (cited.size > 0) {
      await db.query('UPDATE entries SET compiled = true WHERE brain_id = $1 AND id = ANY($2)', [
        brainId,
        [...cited],
      ])
    }
    const status = rest.length > 0 ? 'partially_approved' : 'approved'
    const done = await db.one(
      `UPDATE proposals SET status = $2, decided_by = $3, decided_at = $4, comment = $5, last_error = NULL
        WHERE id = $1 RETURNING *`,
      [row.id, status, ctx.who.accountId, now, comment ?? null],
    )
    if (rest.length > 0 && comment) {
      await teach(
        c,
        brainId,
        row,
        comment,
        ops.filter((o) => rest.includes(o.index)),
      )
    }
    await db.query(
      `INSERT INTO wiki_settings (brain_id, approvals_since) VALUES ($1, 1)
       ON CONFLICT (brain_id) DO UPDATE SET approvals_since = wiki_settings.approvals_since + 1`,
      [brainId],
    )
    await emit(db, c, { brainId, kind: 'proposal.decided', targetId: String(row.id), label: status })
    const final = (
      await db.query('SELECT * FROM proposal_ops WHERE proposal_id = $1 ORDER BY idx', [row.id])
    ).map(proposalOpOf)
    return { proposal: await named(db, proposalOf(done as Row, now)), ops: final, applied }
  })
  if (failure) throw failure
  return out as Decision
}

export async function returnProposal(
  ctx: Ctx,
  id: string,
  input: { fingerprint: string; comment: string },
): Promise<Decision> {
  const comment = commentOf(input.comment) as string
  return ctx.db.tx(async (db) => {
    const c = { ...ctx, db }
    const { row, brainId } = await load(c, id, true)
    const ops = await stillAsSeen(c, row, input.fingerprint)
    const now = ctx.clock()
    await db.query("UPDATE proposal_ops SET status = 'returned' WHERE proposal_id = $1", [row.id])
    const done = await db.one(
      `UPDATE proposals SET status = 'returned', decided_by = $2, decided_at = $3, comment = $4 WHERE id = $1 RETURNING *`,
      [row.id, ctx.who.accountId, now, comment],
    )
    await teach(c, brainId, row, comment, ops)
    await emit(db, c, { brainId, kind: 'proposal.decided', targetId: String(row.id), label: 'returned' })
    const final = (
      await db.query('SELECT * FROM proposal_ops WHERE proposal_id = $1 ORDER BY idx', [row.id])
    ).map(proposalOpOf)
    return { proposal: await named(db, proposalOf(done as Row, now)), ops: final, applied: [] }
  })
}
