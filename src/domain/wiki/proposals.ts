// Proposals (spec B2): a package of operations an agent sends, with its reason and sources. Checked on
// arrival: blocking problems refuse it with the full list; the rest travels as warnings, worked out
// again whenever it is read (a source forgotten after sending shows up for the curator). Only people,
// in the web, decide (decide.ts); here agents send, read, withdraw and replace their own.
import { AppError, conflict, invalid, notFound } from '../../core/errors.ts'
import { newId } from '../../core/ids.ts'
import type { Db, Row } from '../../db/db.ts'
import { send } from '../../mail/mail.ts'
import { redact } from '../../privacy/redact.ts'
import { allow, type Ctx, inBrain } from '../context.ts'
import { emit } from '../events.ts'
import { installation } from '../installation.ts'
import { decode, encode, PAGE, type Page as PageOf } from '../listing.ts'
import { type Checked, checkChange } from './coherence.ts'
import { mentionsOf, nearlySame, type Op, type Problem, readOp, WIKI_LIMITS } from './model.ts'

export const OLD_AFTER_MS = 30 * 24 * 60 * 60 * 1000

export type Warning = { op: number | null; code: string; message: string }

export type ProposalStatus =
  | 'pending'
  | 'approved'
  | 'partially_approved'
  | 'returned'
  | 'withdrawn'
  | 'superseded'

export type ProposalOp = {
  index: number
  op: Op
  status: 'pending' | 'approved' | 'returned'
  correctedBy: string | null
  baseReviewedBy: string | null
  appliedPage: string | null
  appliedRevision: number | null
}

export type Proposal = {
  id: string
  brainId: string
  title: string
  reason: string
  authorId: string
  agent: string | null
  status: ProposalStatus
  old: boolean
  supersedes: string | null
  supersededBy: string | null
  collected: string[]
  comment: string | null
  decidedBy: string | null
  decidedAt: string | null
  lastError: string | null
  createdAt: string
  purged: boolean
}

export const proposalOf = (r: Row, now: Date): Proposal => ({
  id: String(r.id),
  brainId: String(r.brain_id),
  title: String(r.title),
  reason: String(r.reason),
  authorId: String(r.author_id),
  agent: r.agent == null ? null : String(r.agent),
  status: r.status as ProposalStatus,
  old: r.status === 'pending' && now.getTime() - (r.created_at as Date).getTime() > OLD_AFTER_MS,
  supersedes: r.supersedes_id == null ? null : String(r.supersedes_id),
  supersededBy: r.superseded_by == null ? null : String(r.superseded_by),
  collected: (r.collected as string[]) ?? [],
  comment: r.comment == null ? null : String(r.comment),
  decidedBy: r.decided_by == null ? null : String(r.decided_by),
  decidedAt: r.decided_at == null ? null : (r.decided_at as Date).toISOString(),
  lastError: r.last_error == null ? null : String(r.last_error),
  createdAt: (r.created_at as Date).toISOString(),
  purged: r.purged_at != null,
})

// Who proposed and who decided, by name: what a person reads in the inbox (spec B6 «Proposals»).
export type NamedProposal = Proposal & { authorName: string; decidedByName: string | null }

export async function named(db: Db, p: Proposal): Promise<NamedProposal> {
  const ids = [p.authorId, ...(p.decidedBy ? [p.decidedBy] : [])]
  const rows = await db.query<{ id: string; name: string }>(
    'SELECT id, name FROM accounts WHERE id = ANY($1)',
    [ids],
  )
  const nameOf = (id: string | null) => (id ? (rows.find((r) => r.id === id)?.name ?? '') : null)
  return { ...p, authorName: nameOf(p.authorId) ?? '', decidedByName: nameOf(p.decidedBy) }
}

export const proposalOpOf = (r: Row): ProposalOp => ({
  index: Number(r.idx),
  op: r.op as Op,
  status: r.status as ProposalOp['status'],
  correctedBy: r.corrected_by == null ? null : String(r.corrected_by),
  baseReviewedBy: r.base_reviewed_by == null ? null : String(r.base_reviewed_by),
  appliedPage: r.applied_page == null ? null : String(r.applied_page),
  appliedRevision: r.applied_revision == null ? null : Number(r.applied_revision),
})

// What the addresses of a proposal lead to now: the page behind each address it names.
type Known = Map<string, { pageId: string; address: string; status: string; revision: number; title: string }>

export function addressesOf(ops: Op[]): Set<string> {
  const out = new Set<string>()
  for (const o of ops) {
    out.add(o.address)
    if (o.op === 'create') for (const l of o.links) out.add(l.to)
    if (o.op === 'move' || o.op === 'link' || o.op === 'unlink') out.add(o.to)
    if (o.op === 'status' && o.supersededBy) out.add(o.supersededBy)
    if (o.op === 'merge') out.add(o.from)
    if ('body' in o && typeof o.body === 'string') for (const m of mentionsOf(o.body)) out.add(m)
  }
  out.delete('')
  return out
}

export async function knownAddresses(db: Db, brainId: string, ops: Op[]): Promise<Known> {
  const rows = await db.query(
    `SELECT a.address AS asked, p.id, p.address, p.status, p.revision, p.title
       FROM page_addresses a JOIN pages p ON p.id = a.page_id
      WHERE a.brain_id = $1 AND a.address = ANY($2)`,
    [brainId, [...addressesOf(ops)]],
  )
  return new Map(
    rows.map((r) => [
      String(r.asked),
      {
        pageId: String(r.id),
        address: String(r.address),
        status: String(r.status),
        revision: Number(r.revision),
        title: String(r.title),
      },
    ]),
  )
}

// Addresses the proposal itself brings into being (new pages and new addresses of moved pages).
export function bornIn(ops: Op[]): Set<string> {
  const out = new Set<string>()
  for (const o of ops) {
    if (o.op === 'create') out.add(o.address)
    if (o.op === 'move') out.add(o.to)
  }
  return out
}

// The blocking checks (spec B2 «Al enviarla»).
// Operations that could not be read are null here and skipped; the others keep their index.
// `byAgent`: a new page proposed by an agent must cite a source; a curator writing in the web need not.
export async function problemsOf(
  db: Db,
  brainId: string,
  all: (Op | null)[],
  collected: string[],
  byAgent = true,
): Promise<Problem[]> {
  const problems: Problem[] = []
  const ops = all.filter((o): o is Op => o !== null)
  const known = await knownAddresses(db, brainId, ops)
  // Which page each address names once the proposal's own creates and moves are played in order: an
  // existing page's id, or "new:<op>" for a page the proposal creates. Self-references and "is it an
  // existing page" are decided on that, not on the address text (an old address is the same page).
  const ident = new Map<string, string>([...known].map(([a, k]) => [a, k.pageId]))
  const byId = new Map([...known.values()].map((k) => [k.pageId, k]))
  all.forEach((o, i) => {
    if (o?.op === 'create' && !ident.has(o.address)) ident.set(o.address, `new:${i}`)
  })
  for (const o of all) {
    if (o?.op !== 'move') continue
    const id = ident.get(o.address)
    if (id && !ident.has(o.to)) ident.set(o.to, id)
  }
  const exists = (a: string) => ident.has(a)
  const same = (a: string, b: string) => ident.get(a) !== undefined && ident.get(a) === ident.get(b)
  const claimed = new Map<string, number>()
  all.forEach((o, i) => {
    if (o === null) return
    const p = (message: string) => problems.push({ op: i, message })
    const claim = (a: string, ownPage: string | null) => {
      const k = known.get(a)
      if (k && k.pageId !== ownPage) {
        p(
          k.address === a
            ? `The address "${a}" is already taken by the page "${k.title}".`
            : `The address "${a}" is reserved: it was an address of the page now at "${k.address}".`,
        )
      }
      const prev = claimed.get(a)
      if (prev !== undefined) p(`Operation ${prev} already gives the address "${a}" to a page.`)
      claimed.set(a, i)
    }
    if (o.op === 'create') {
      claim(o.address, null)
      if (byAgent && o.sources.length === 0) {
        p(
          `The new page "${o.address}" cites no sources. Cite the journal entries (or addresses) it comes from.`,
        )
      }
      for (const l of o.links) {
        if (!exists(l.to))
          p(`The ${l.kind} link points at "${l.to}", which does not exist and is not created here.`)
        else if (same(l.to, o.address)) p(`The ${l.kind} link points at the page itself.`)
      }
      return
    }
    if (!exists(o.address)) {
      p(`There is no page at "${o.address}", and this proposal does not create it.`)
      return
    }
    const id = ident.get(o.address) as string
    const k = byId.get(id)
    switch (o.op) {
      case 'edit':
        if (k && o.baseRevision === undefined) {
          p(`Say which revision of "${o.address}" you edited, in "baseRevision" (it is at ${k.revision}).`)
        }
        if (k && o.baseRevision !== undefined && o.baseRevision > k.revision) {
          p(`"${o.address}" has no revision ${o.baseRevision}; it is at ${k.revision}.`)
        }
        break
      case 'move':
        claim(o.to, k?.pageId ?? null)
        break
      case 'link':
      case 'unlink':
        if (!exists(o.to))
          p(`The ${o.kind} link points at "${o.to}", which does not exist and is not created here.`)
        else if (same(o.to, o.address)) p(`"${o.to}" is the page itself; a page cannot link to itself.`)
        break
      case 'status':
        if (o.supersededBy !== undefined && !exists(o.supersededBy)) {
          p(`"supersededBy" points at "${o.supersededBy}", which does not exist and is not created here.`)
        } else if (o.supersededBy !== undefined && same(o.supersededBy, o.address)) {
          p('A page cannot supersede itself.')
        }
        break
      case 'merge':
        if (!exists(o.from))
          p(`There is no page at "${o.from}" to merge, and this proposal does not create it.`)
        else if (same(o.from, o.address))
          p(`"${o.from}" is the page itself; a page cannot be merged into itself.`)
        break
      case 'revert':
        if (!k) p(`"${o.address}" is created in this proposal; there is nothing to go back to.`)
        else if (o.toRevision >= k.revision) {
          p(`"${o.address}" is at revision ${k.revision}; go back to an earlier one.`)
        }
        break
    }
  })
  // Sources and collected entries: journal entries of this very brain that still exist.
  const cited = new Set<string>(collected)
  for (const o of ops) {
    if (o.op === 'create' || o.op === 'edit')
      for (const s of o.sources ?? []) if ('entryId' in s) cited.add(s.entryId)
  }
  if (cited.size > 0) {
    const rows = await db.query(
      "SELECT id FROM entries WHERE brain_id = $1 AND id = ANY($2) AND state <> 'purged'",
      [brainId, [...cited]],
    )
    const found = new Set(rows.map((r) => String(r.id)))
    for (const id of cited) {
      if (!found.has(id)) problems.push({ op: null, message: `There is no entry "${id}" in this brain.` })
    }
  }
  return problems
}

// The warnings that do not block (spec B2), worked out on arrival and again whenever it is read.
export async function warningsOf(
  db: Db,
  brainId: string,
  ops: Op[],
  skip: Set<number> = new Set(),
): Promise<Warning[]> {
  const out: Warning[] = []
  const known = await knownAddresses(db, brainId, ops)
  const born = bornIn(ops)
  const titles = await db.query(
    "SELECT address, title FROM pages WHERE brain_id = $1 AND status <> 'retired'",
    [brainId],
  )
  const entryIds = new Set<string>()
  ops.forEach((o, i) => {
    if (skip.has(i)) return
    const w = (code: string, message: string) => out.push({ op: i, code, message })
    if (o.op === 'create') {
      if (o.links.length === 0 && mentionsOf(o.body).length === 0) {
        w('no_links', `The new page "${o.address}" links to no other page.`)
      }
      if (!o.summary.trim())
        w('empty_summary', `The new page "${o.address}" has no summary; the map shows it.`)
    }
    if (o.op === 'create' || (o.op === 'edit' && o.title !== undefined)) {
      const title = o.title as string
      const twin = titles.find(
        (t) =>
          t.address !== o.address &&
          known.get(o.address)?.address !== t.address &&
          nearlySame(title, String(t.title)),
      )
      if (twin) w('similar_title', `The title "${title}" is almost the same as the page "${twin.address}".`)
    }
    if ('body' in o && typeof o.body === 'string') {
      for (const m of mentionsOf(o.body)) {
        if (!known.has(m) && !born.has(m)) {
          w('broken_mention', `[[${m}]] points at no page yet; it will show as a broken link.`)
        }
      }
    }
    if (o.op === 'create' || o.op === 'edit')
      for (const s of o.sources ?? []) if ('entryId' in s) entryIds.add(s.entryId)
  })
  if (entryIds.size > 0) {
    const gone = await db.query(
      "SELECT id, state FROM entries WHERE brain_id = $1 AND id = ANY($2) AND state <> 'active'",
      [brainId, [...entryIds]],
    )
    const state = new Map(gone.map((r) => [String(r.id), String(r.state)]))
    ops.forEach((o, i) => {
      if (skip.has(i) || (o.op !== 'create' && o.op !== 'edit')) return
      for (const s of o.sources ?? []) {
        if ('entryId' in s && state.has(s.entryId)) {
          out.push({
            op: i,
            code: state.get(s.entryId) === 'purged' ? 'source_purged' : 'source_forgotten',
            message: `The source ${s.entryId} was ${state.get(s.entryId)} after this proposal was written.`,
          })
        }
      }
    })
  }
  return out
}

export type ProposalInput = {
  title: string
  reason?: string
  ops?: unknown
  collected?: unknown
  supersedes?: string
  agent?: string
}

const loadOps = async (db: Db, id: string): Promise<ProposalOp[]> =>
  (await db.query('SELECT * FROM proposal_ops WHERE proposal_id = $1 ORDER BY idx', [id])).map(proposalOpOf)

// What a proposal and a direct write both carry (spec v0.6: «las mismas operaciones»), read and redacted, with
// the problems of each operation collected so the agent gets them all at once.
export type Package = {
  title: string
  reason: string
  collected: string[]
  agent: string | null
  ops: (Op | null)[]
  problems: Problem[]
}

export function readPackage(ctx: Ctx, input: ProposalInput, what = 'A proposal'): Package {
  const title = redact(input.title.trim()).text
  const reason = redact((input.reason ?? '').trim()).text
  if (!title || title.length > WIKI_LIMITS.title) {
    throw invalid(
      `${what} needs a title of 1 to ${WIKI_LIMITS.title} characters.`,
      'Say in one line what it changes.',
    )
  }
  if (reason.length > WIKI_LIMITS.reason) {
    throw invalid(`The reason is longer than ${WIKI_LIMITS.reason} characters.`, 'Shorten it.')
  }
  if (!Array.isArray(input.ops) || input.ops.length === 0) {
    throw invalid(`${what} carries a list "ops" with at least one operation.`, 'Add the operations.')
  }
  const collectedRaw = input.collected ?? []
  if (
    !Array.isArray(collectedRaw) ||
    collectedRaw.some((x) => typeof x !== 'string' || !/^ent_[0-9a-f]{12}$/.test(x)) ||
    collectedRaw.length > WIKI_LIMITS.collected
  ) {
    throw invalid(
      `"collected" is a list of at most ${WIKI_LIMITS.collected} entry ids ("ent_…").`,
      'List the entries read that add nothing new.',
    )
  }
  const collected = [...new Set(collectedRaw as string[])]
  const agent = redact((ctx.who.credential.agent ?? input.agent ?? '').trim()).text || null
  if (agent && agent.length > WIKI_LIMITS.agent)
    throw invalid('"agent" is too long.', 'Name the agent briefly.')
  const problems: Problem[] = []
  if (input.ops.length > WIKI_LIMITS.ops) {
    problems.push({
      op: null,
      message: `${what} has at most ${WIKI_LIMITS.ops} operations; this one has ${input.ops.length}.`,
    })
  }
  const ops = input.ops.slice(0, WIKI_LIMITS.ops).map((raw, i) => readOp(raw, i, problems))
  return { title, reason, collected, agent, ops, problems }
}

export async function submitProposal(
  ctx: Ctx,
  slug: string,
  input: ProposalInput,
): Promise<{ proposal: Proposal; ops: ProposalOp[]; warnings: Warning[] } & Checked> {
  const { title, reason, collected, agent, ops, problems } = readPackage(ctx, input)
  const out = await ctx.db.tx(async (db) => {
    const c = { ...ctx, db }
    const { brain, role } = await inBrain(c, { slug }, 'share')
    await allow(c, 'wiki.propose', { role, brainStatus: brain.status }, brain.id)
    const good = ops.filter((o): o is Op => o !== null)
    problems.push(...(await problemsOf(db, brain.id, ops, collected)))
    let replaced: Row | undefined
    if (input.supersedes !== undefined) {
      replaced = await db.one('SELECT * FROM proposals WHERE id = $1 AND brain_id = $2 FOR UPDATE', [
        input.supersedes,
        brain.id,
      ])
      if (!replaced)
        problems.push({ op: null, message: `There is no proposal "${input.supersedes}" in this brain.` })
      else if (replaced.author_id !== ctx.who.accountId) {
        problems.push({ op: null, message: 'Only the author of a proposal can replace it.' })
      } else if (replaced.status !== 'pending') {
        problems.push({
          op: null,
          message: `Proposal ${replaced.id} is ${replaced.status}; only a pending one can be replaced.`,
        })
      }
    }
    if (problems.length > 0) {
      const err = new AppError(
        400,
        'proposal_invalid',
        `The proposal has ${problems.length} problem${problems.length === 1 ? '' : 's'}; nothing was saved.`,
        'Fix each problem listed in "problems" and send it again.',
      )
      err.problems = problems
      throw err
    }
    const now = ctx.clock()
    const id = newId('prp')
    const row = await db.one(
      `INSERT INTO proposals (id, brain_id, title, reason, author_id, credential_id, agent, supersedes_id, collected, created_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *`,
      [
        id,
        brain.id,
        title,
        reason,
        ctx.who.accountId,
        ctx.who.credential.id,
        agent,
        replaced?.id ?? null,
        collected,
        now,
      ],
    )
    for (const [i, op] of good.entries()) {
      await db.query('INSERT INTO proposal_ops (proposal_id, idx, op) VALUES ($1, $2, $3)', [
        id,
        i,
        JSON.stringify(op),
      ])
    }
    if (replaced) {
      await db.query("UPDATE proposals SET status = 'superseded', superseded_by = $2 WHERE id = $1", [
        replaced.id,
        id,
      ])
    }
    await emit(db, c, { brainId: brain.id, kind: 'proposal.submitted', targetId: id, label: title })
    return {
      brain,
      proposal: proposalOf(row as Row, now),
      ops: await loadOps(db, id),
      warnings: await warningsOf(db, brain.id, good),
      // What it would leave incoherent, on the wiki as it would be, and what is linked to it (spec v0.6 CA7, CA9).
      checked: await checkChange(c, db, brain.id, good, { keep: false }),
    }
  })
  await proposalNotice(ctx, out.brain, out.proposal.id, out.ops.length)
  return { proposal: out.proposal, ops: out.ops, warnings: out.warnings, ...out.checked }
}

// Curators who asked for it get a mail: which brain, who proposes, how many changes and a link that
// needs signing in. Never the content (spec B4 «Avisos por email»).
async function proposalNotice(
  ctx: Ctx,
  brain: { id: string; slug: string; name: string },
  id: string,
  n: number,
) {
  const to = await ctx.db.query(
    `SELECT a.email FROM memberships m JOIN accounts a ON a.id = m.account_id
      WHERE m.brain_id = $1 AND m.role = 'curator' AND m.notify_proposals AND a.status = 'active'
        AND a.email IS NOT NULL AND a.id <> $2`,
    [brain.id, ctx.who.accountId],
  )
  if (!to.length) return
  const base = (await installation(ctx.db)).publicUrl ?? ''
  const by = ctx.who.credential.ref ? `${ctx.who.name} (${ctx.who.credential.ref})` : ctx.who.name
  for (const r of to) {
    await send(ctx.db, ctx.clock, ctx.mail, 'proposal', {
      to: String(r.email),
      subject: `New proposal in "${brain.name}"`,
      text: [
        `${by} proposed ${n} change${n === 1 ? '' : 's'} to the wiki of "${brain.name}".`,
        '',
        `Review it (you will be asked to sign in): ${base}/b/${brain.slug}/proposals/${id}`,
      ].join('\n'),
    })
  }
}

async function loadProposal(ctx: Ctx, id: string, lock = false): Promise<{ row: Row; slug: string }> {
  const row = await ctx.db.one(`SELECT * FROM proposals WHERE id = $1${lock ? ' FOR UPDATE' : ''}`, [id])
  if (!row) throw notFound('proposal')
  const { brain } = await inBrain(ctx, { id: String(row.brain_id) }).catch(() => {
    throw notFound('proposal')
  })
  return { row, slug: brain.slug }
}

export async function getProposal(
  ctx: Ctx,
  id: string,
): Promise<{ proposal: NamedProposal; ops: ProposalOp[]; warnings: Warning[] }> {
  const { row } = await loadProposal(ctx, id)
  const ops = await loadOps(ctx.db, id)
  const pending = new Set(ops.filter((o) => o.status !== 'pending').map((o) => o.index))
  return {
    proposal: await named(ctx.db, proposalOf(row, ctx.clock())),
    ops,
    warnings:
      row.status === 'pending' || row.status === 'partially_approved'
        ? await warningsOf(
            ctx.db,
            String(row.brain_id),
            ops.map((o) => o.op),
            pending,
          )
        : [],
  }
}

export type InboxItem = NamedProposal & { opCount: number }

const STATUSES: ProposalStatus[] = [
  'pending',
  'approved',
  'partially_approved',
  'returned',
  'withdrawn',
  'superseded',
]

// `counts`: how many proposals of the brain are in each status (mine=1: of mine), on the first page only.
export async function listProposals(
  ctx: Ctx,
  slug: string,
  o: {
    status?: ProposalStatus | 'all'
    cursor?: string
    limit?: number
    mine?: boolean
    // oldest: what waited longest first (the inbox of the web reviews pending ones in that order).
    order?: 'newest' | 'oldest'
  },
): Promise<PageOf<InboxItem> & { counts?: Record<ProposalStatus, number> }> {
  const { brain } = await inBrain(ctx, { slug })
  const status = o.status ?? 'pending'
  const c = decode(o.cursor)
  const limit = o.limit ?? PAGE.default
  const params: unknown[] = [brain.id, c?.at ?? null, c?.id ?? '', limit + 1]
  // "mine": the proposals of the caller's account (an agent asking what became of its proposals).
  let filter = ''
  if (status !== 'all') {
    params.push(status)
    filter += ` AND p.status = $${params.length}`
  }
  if (o.mine) {
    params.push(ctx.who.accountId)
    filter += ` AND p.author_id = $${params.length}`
  }
  const rows = await ctx.db.query(
    `SELECT p.*, (SELECT count(*)::int FROM proposal_ops o WHERE o.proposal_id = p.id) AS op_count,
            (SELECT name FROM accounts a WHERE a.id = p.author_id) AS author_name,
            (SELECT name FROM accounts a WHERE a.id = p.decided_by) AS decider_name
       FROM proposals p
      WHERE p.brain_id = $1${filter} AND ($2::timestamptz IS NULL OR (p.created_at, p.id) ${o.order === 'oldest' ? '>' : '<'} ($2, $3))
      ORDER BY p.created_at ${o.order === 'oldest' ? 'ASC, p.id ASC' : 'DESC, p.id DESC'} LIMIT $4`,
    params,
  )
  const totalArgs: unknown[] = [brain.id]
  let totalFilter = ''
  if (status !== 'all') {
    totalArgs.push(status)
    totalFilter += ` AND p.status = $${totalArgs.length}`
  }
  if (o.mine) {
    totalArgs.push(ctx.who.accountId)
    totalFilter += ` AND p.author_id = $${totalArgs.length}`
  }
  const total = await ctx.db.one<{ n: number }>(
    `SELECT count(*)::int AS n FROM proposals p WHERE p.brain_id = $1${totalFilter}`,
    totalArgs,
  )
  const page = rows.slice(0, limit)
  const last = page.at(-1)
  const now = ctx.clock()
  const out: PageOf<InboxItem> & { counts?: Record<ProposalStatus, number> } = {
    items: page.map((r) => ({
      ...proposalOf(r, now),
      authorName: r.author_name == null ? '' : String(r.author_name),
      decidedByName: r.decider_name == null ? null : String(r.decider_name),
      opCount: Number(r.op_count),
    })),
    total: total?.n ?? 0,
    next: rows.length > limit && last ? encode(last.created_at as Date, String(last.id)) : null,
  }
  if (!c) {
    const by = await ctx.db.query<{ status: string; n: number }>(
      `SELECT p.status, count(*)::int AS n FROM proposals p
        WHERE p.brain_id = $1${o.mine ? ' AND p.author_id = $2' : ''} GROUP BY p.status`,
      o.mine ? [brain.id, ctx.who.accountId] : [brain.id],
    )
    out.counts = Object.fromEntries(
      STATUSES.map((st) => [st, by.find((r) => r.status === st)?.n ?? 0]),
    ) as Record<ProposalStatus, number>
  }
  return out
}

export async function withdrawProposal(ctx: Ctx, id: string): Promise<Proposal> {
  return ctx.db.tx(async (db) => {
    const c = { ...ctx, db }
    const { row } = await loadProposal(c, id, true)
    // Withdrawing is a write: the same bar as proposing (a read-only key or an archived brain cannot).
    const { brain, role } = await inBrain(c, { id: String(row.brain_id) }, 'share')
    await allow(c, 'wiki.propose', { role, brainStatus: brain.status }, brain.id)
    if (row.author_id !== ctx.who.accountId) {
      throw new AppError(
        403,
        'forbidden',
        'Only the author of a proposal can withdraw it.',
        'Ask its author.',
      )
    }
    if (row.status !== 'pending') {
      throw conflict(
        'proposal_decided',
        `This proposal is ${row.status}; only a pending one can be withdrawn.`,
        'Nothing to do.',
      )
    }
    const out = await db.one("UPDATE proposals SET status = 'withdrawn' WHERE id = $1 RETURNING *", [id])
    await emit(db, c, {
      brainId: String(row.brain_id),
      kind: 'proposal.withdrawn',
      targetId: id,
      label: String(row.title),
    })
    return proposalOf(out as Row, ctx.clock())
  })
}
