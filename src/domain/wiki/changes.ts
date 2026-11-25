// «Review later» (spec learning-memory A1, A2; plan §2.4): every change to the wiki that a person in the web did not make
// — a proposal applied at once, a key's direct write, a key's decision on parts that waited — is recorded as one change
// with its parts, one per page it touched, and what each page was before (the snapshot of the one writer of pages).
// Its pages stay «unreviewed» while their revision is past the last one a person saw (pages.reviewed_revision).
import { AppError, conflict, denied, notFound } from '../../core/errors.ts'
import { newId } from '../../core/ids.ts'
import type { Db, Row } from '../../db/db.ts'
import { allow, type Brain, type Ctx, inBrain, personInWeb } from '../context.ts'
import { webCorrection } from '../entries.ts'
import { decode, encode, PAGE, type Page as PageOf } from '../listing.ts'
import type { PageBefore, Revised } from './apply.ts'
import type { Op, Source } from './model.ts'
import { bodyDiff, dependencies } from './review.ts'
import { hasPermission, keyName } from './writers.ts'

// A page is unreviewed while a change no person saw left it at a newer revision (CA-A9).
export const isUnreviewed = (row: Row): boolean =>
  row.reviewed_revision != null && Number(row.revision) > Number(row.reviewed_revision)

// SQL of the same, for a page alias.
export const unreviewedSql = (p: string) => `(${p}.revision > ${p}.reviewed_revision)`

// Records a change for review, inside the caller's transaction, right after the writer applied it. A person in the web
// records nothing (their own gesture is reviewed): null. Otherwise the change's id, for the answer's «undo».
export async function recordChange(
  db: Db,
  ctx: Ctx,
  c: { brainId: string; logId: string; proposalId?: string | null; before: PageBefore[]; revised: Revised[] },
): Promise<string | null> {
  if (personInWeb(ctx) || c.revised.length === 0) return null
  const id = newId('chg')
  const now = ctx.clock()
  await db.query(
    `INSERT INTO wiki_changes (id, brain_id, log_id, proposal_id, actor_id, credential_id, key_name, ref, created_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
    [
      id,
      c.brainId,
      c.logId,
      c.proposalId ?? null,
      ctx.who.accountId,
      ctx.who.credential.id,
      (await keyName(db, ctx)).slice(0, 200),
      ctx.who.credential.ref?.slice(0, 200) ?? null,
      now,
    ],
  )
  const last = new Map<string, Revised>()
  const first = new Map<string, Revised>()
  for (const r of c.revised) {
    last.set(r.pageId, r)
    if (!first.has(r.pageId)) first.set(r.pageId, r)
  }
  // One part per page the change revised, in the order the writer first locked them.
  let part = 0
  for (const b of c.before) {
    const after = last.get(b.pageId)
    if (!after) continue
    const now = await db.query<{ address: string }>('SELECT address FROM page_addresses WHERE page_id = $1', [
      b.pageId,
    ])
    const had = new Set(b.addresses)
    const added = now.map((a) => a.address).filter((a) => !had.has(a))
    const sourcesNow = await db.query<{ entry_id: string }>(
      'SELECT entry_id FROM page_sources WHERE page_id = $1 AND entry_id IS NOT NULL',
      [b.pageId],
    )
    let sourcesBefore = new Set<string>()
    if (b.revision !== null) {
      const r = await db.one<{ sources: Source[] }>(
        'SELECT sources FROM page_revisions WHERE page_id = $1 AND revision = $2',
        [b.pageId, b.revision],
      )
      sourcesBefore = new Set((r?.sources ?? []).flatMap((s) => ('entryId' in s ? [s.entryId] : [])))
    }
    const sourcesAdded = sourcesNow.map((s) => s.entry_id).filter((e) => !sourcesBefore.has(e))
    await db.query(
      `INSERT INTO wiki_change_parts (change_id, part, op_index, page_id, created, revision_before, revision_after,
         address_before, address_after, status_before, superseded_by_before, addresses_before, addresses_added,
         links_in_before, sources_added)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)`,
      [
        id,
        part,
        first.get(b.pageId)?.index ?? null,
        b.pageId,
        b.created,
        b.revision,
        after.revision,
        b.created ? null : b.address,
        after.address,
        b.status,
        b.supersededBy,
        JSON.stringify(b.addresses),
        JSON.stringify(added),
        JSON.stringify(b.linksIn),
        JSON.stringify(sourcesAdded),
      ],
    )
    part += 1
  }
  await db.query('UPDATE wiki_log SET change_id = $2 WHERE id = $1', [c.logId, id])
  return id
}

// A returned or undone part becomes a person's correction that applies to whoever proposed (spec B2, CA8; spec
// learning-memory A2, CA-A25): the agent learns why. `byKey`: a key with the wiki write permission decided.
export async function teach(
  ctx: Ctx,
  brainId: string,
  who: { authorId: string; agent: string | null; title: string; ref: string },
  comment: string,
  what: string,
  byKey: boolean,
  title = `Returned: ${who.title}`,
) {
  const author = await ctx.db.one<{ name: string }>('SELECT name FROM accounts WHERE id = $1', [who.authorId])
  const appliesTo = String(who.agent ?? author?.name ?? 'the proposer').slice(0, 80)
  return webCorrection(
    ctx,
    ctx.db,
    brainId,
    {
      title: title.slice(0, 200),
      content: `${comment}\n\n${what}`.slice(0, 32_000),
      appliesTo,
      refs: [who.ref],
    },
    { decidedByKey: byKey },
  )
}

export type ChangeState = 'pending_review' | 'kept' | 'undone' | 'partly_undone'
export const CHANGE_STATES: readonly ChangeState[] = ['pending_review', 'kept', 'undone', 'partly_undone']

export type ChangeView = {
  id: string
  at: string
  actor: { id: string; name: string }
  keyName: string | null
  ref: string | null
  proposalId: string | null
  title: string
  parts: number
  state: ChangeState
  decidedBy: string | null
  decidedAt: string | null
}

const VIEW = `SELECT c.*, a.name AS actor_name, coalesce(p.title, l.summary) AS title,
       (SELECT count(*)::int FROM wiki_change_parts x WHERE x.change_id = c.id) AS part_count
  FROM wiki_changes c JOIN accounts a ON a.id = c.actor_id JOIN wiki_log l ON l.id = c.log_id
  LEFT JOIN proposals p ON p.id = c.proposal_id`

const viewOf = (r: Row): ChangeView => ({
  id: String(r.id),
  at: (r.created_at as Date).toISOString(),
  actor: { id: String(r.actor_id), name: String(r.actor_name) },
  keyName: r.key_name == null ? null : String(r.key_name),
  ref: r.ref == null ? null : String(r.ref),
  proposalId: r.proposal_id == null ? null : String(r.proposal_id),
  title: String(r.title),
  parts: Number(r.part_count),
  state: r.state as ChangeState,
  decidedBy: r.decided_by == null ? null : String(r.decided_by),
  decidedAt: r.decided_at == null ? null : (r.decided_at as Date).toISOString(),
})

// Who sees «Review later» (plan §2.5): the curators, in the web and through their keys, and the keys a curator let write
// to the wiki. A reader, and a contributor without the permission, are told no; outside the brain, it does not exist.
async function mayRead(ctx: Ctx, brain: Brain, role: string): Promise<void> {
  if (role === 'curator') return
  if (ctx.who.credential.kind !== 'web' && (await hasPermission(ctx.db, brain.id, ctx.who.credential))) {
    await allow(ctx, 'wiki.propose', { role: role as 'contributor', brainStatus: brain.status }, brain.id)
    return
  }
  throw denied(
    '«Review later» is for the curators of the brain and the keys they let write to its wiki.',
    'Ask a curator of the brain to review it, or to give your key the permission to write to the wiki.',
  )
}

// A change by its id: the brain it belongs to is resolved first, and someone outside it gets the same 404 as for an id
// that does not exist (P4; plan §8.3 H2).
export async function changeOf(
  ctx: Ctx,
  id: string,
  lock = false,
): Promise<{ row: Row; brain: Brain; role: string }> {
  const row = await ctx.db.one(`SELECT * FROM wiki_changes WHERE id = $1${lock ? ' FOR UPDATE' : ''}`, [id])
  if (!row) throw notFound('change')
  const { brain, role } = await inBrain(ctx, { id: String(row.brain_id) }, lock ? 'share' : null).catch(
    () => {
      throw notFound('change')
    },
  )
  return { row, brain, role }
}

export async function listChanges(
  ctx: Ctx,
  slug: string,
  o: { state?: ChangeState | 'all'; cursor?: string; limit?: number },
): Promise<PageOf<ChangeView>> {
  const { brain, role } = await inBrain(ctx, { slug })
  await mayRead(ctx, brain, role)
  const state = o.state ?? 'pending_review'
  const c = decode(o.cursor)
  const limit = o.limit ?? PAGE.default
  const params: unknown[] = [brain.id, c?.at ?? null, c?.id ?? '', limit + 1]
  let filter = ''
  if (state !== 'all') {
    params.push(state)
    filter = ` AND c.state = $${params.length}`
  }
  // The oldest first: what has waited longest is reviewed first (spec A2).
  const rows = await ctx.db.query(
    `${VIEW} WHERE c.brain_id = $1${filter} AND ($2::timestamptz IS NULL OR (c.created_at, c.id) > ($2, $3))
      ORDER BY c.created_at, c.id LIMIT $4`,
    params,
  )
  const total = await ctx.db.one<{ n: number }>(
    `SELECT count(*)::int AS n FROM wiki_changes c WHERE c.brain_id = $1${state === 'all' ? '' : ' AND c.state = $2'}`,
    state === 'all' ? [brain.id] : [brain.id, state],
  )
  const page = rows.slice(0, limit)
  const last = page.at(-1)
  return {
    items: page.map(viewOf),
    total: total?.n ?? 0,
    next: rows.length > limit && last ? encode(last.created_at as Date, String(last.id)) : null,
  }
}

export type ChangePart = {
  part: number
  op: string | null
  address: string
  revisionBefore: number | null
  revisionAfter: number
  created: boolean
  dependsOn: number[]
  diff: string
  state: 'applied' | 'undone'
}

// The parts of a change and what each needs to stay (plan §2.5): a part needs the parts of the same operation (a merge,
// a «supersedes» link: one gesture, several pages), the parts that created a page it links to, and — for a proposal —
// the parts of the operations its own operation needed (dependencies of a proposal).
export async function partsOf(db: Db, row: Row): Promise<(ChangePart & { pageId: string })[]> {
  const rows = await db.query('SELECT * FROM wiki_change_parts WHERE change_id = $1 ORDER BY part', [row.id])
  const ops =
    row.proposal_id == null
      ? new Map<number, Op>()
      : new Map(
          (
            await db.query<{ idx: number; op: Op }>(
              'SELECT idx, op FROM proposal_ops WHERE proposal_id = $1',
              [row.proposal_id],
            )
          ).map((o) => [Number(o.idx), o.op]),
        )
  const opDeps = ops.size
    ? dependencies([...ops.keys()].sort((a, b) => a - b).map((i) => ops.get(i) as Op))
    : []
  type Built = { part: ChangePart & { pageId: string }; links: Set<string>; opIndex: number | null }
  const built: Built[] = []
  for (const r of rows) {
    const revs = await db.query<{
      revision: number
      body: string
      purged_at: Date | null
      links: { to: string }[]
    }>(
      'SELECT revision, body, purged_at, links FROM page_revisions WHERE page_id = $1 AND revision = ANY($2)',
      [r.page_id, [r.revision_before ?? -1, r.revision_after]],
    )
    const before = revs.find((x) => x.revision === r.revision_before)
    const after = revs.find((x) => x.revision === Number(r.revision_after))
    const purged = Boolean(before?.purged_at) || !after || Boolean(after.purged_at)
    const opIndex = r.op_index == null ? null : Number(r.op_index)
    built.push({
      links: new Set((after?.links ?? []).map((l) => l.to)),
      opIndex,
      part: {
        pageId: String(r.page_id),
        part: Number(r.part),
        op: opIndex == null ? null : (ops.get(opIndex)?.op ?? null),
        address: String(r.address_after),
        revisionBefore: r.revision_before == null ? null : Number(r.revision_before),
        revisionAfter: Number(r.revision_after),
        created: Boolean(r.created),
        dependsOn: [],
        diff: purged ? 'purged' : bodyDiff(before?.body ?? '', after?.body ?? ''),
        state: r.state as 'applied' | 'undone',
      },
    })
  }
  for (const a of built) {
    const needOps = new Set(a.opIndex == null ? [] : (opDeps[a.opIndex] ?? []))
    a.part.dependsOn = built
      .filter(
        (b) =>
          b !== a &&
          ((a.opIndex != null && b.opIndex === a.opIndex) ||
            (b.part.created && a.links.has(b.part.address)) ||
            (b.opIndex != null && needOps.has(b.opIndex))),
      )
      .map((b) => b.part.part)
  }
  return built.map((b) => b.part)
}

// A change as the tray shows it, read again.
export async function viewOfChange(db: Db, id: string): Promise<ChangeView> {
  return viewOf((await db.one(`${VIEW} WHERE c.id = $1`, [id])) as Row)
}

export async function getChange(ctx: Ctx, id: string): Promise<{ change: ChangeView; parts: ChangePart[] }> {
  const { row, brain, role } = await changeOf(ctx, id)
  await mayRead(ctx, brain, role)
  const view = (await ctx.db.one(`${VIEW} WHERE c.id = $1`, [id])) as Row
  return { change: viewOf(view), parts: (await partsOf(ctx.db, row)).map(({ pageId: _p, ...p }) => p) }
}

// Keep (spec A2): a person curator, in the web, has seen the change. Its pages count as reviewed up to the revision that
// change left in each (a later change no person saw keeps its mark). Keeping again changes nothing.
export async function keepChange(ctx: Ctx, id: string): Promise<{ change: ChangeView }> {
  return ctx.db.tx(async (db) => {
    const c = { ...ctx, db }
    const { row, brain, role } = await changeOf(c, id, true)
    if (!personInWeb(c))
      throw new AppError(
        403,
        'web_only',
        'Keep is a person’s, in the web.',
        'Open «Review later» in the rsc-brain web, signed in as a curator. A key may undo a change with the permission to write to the wiki, not keep it.',
      )
    await allow(c, 'wiki.decide', { role: role as 'curator', brainStatus: brain.status }, brain.id)
    if (row.state === 'undone')
      throw conflict('already_undone', 'This change was undone; there is nothing to keep.', 'Nothing to do.')
    if (row.state !== 'kept') {
      await db.query(
        `UPDATE pages p SET reviewed_revision = greatest(p.reviewed_revision, x.revision_after)
           FROM wiki_change_parts x WHERE x.change_id = $1 AND x.state = 'applied' AND p.id = x.page_id`,
        [id],
      )
      await db.query(
        "UPDATE wiki_changes SET state = 'kept', decided_by = $2, decided_at = $3 WHERE id = $1",
        [id, ctx.who.accountId, ctx.clock()],
      )
    }
    return { change: viewOf((await db.one(`${VIEW} WHERE c.id = $1`, [id])) as Row) }
  })
}
