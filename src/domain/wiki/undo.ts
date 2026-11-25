// Undo (spec learning-memory A2, R7; plan §2.5): a curator in the web, or a key with the permission to write to the wiki,
// undoes a change of «Review later» whole or by parts. Each page goes back exactly as the change found it, through the
// one writer of pages (an internal «restore», kind 'undo'): a revision and a line in the log, so the log shows both the
// change and its undo. A page the change created is retired and its address freed (CA-A3, M7).
//   - By parts, dependencies hold: a part another part that stays needs is not undone alone (400 missing_dependencies).
//   - A page written again since is a conflict (409 undo_conflict): a person resends with «overwrite» for those pages;
//     what came after stays in the history (CA-A10).
//   - A revision before that was purged is not put back: that part is skipped, with the reason.
//   - Twice: 200 {alreadyUndone: true}, nothing changes (CA-A21); a request key returns the same answer.
//   - A comment becomes a correction for whoever made the change (CA-A25), redacted, as when a proposal is returned.
import { createHash } from 'node:crypto'
import { AppError, conflict, invalid } from '../../core/errors.ts'
import type { Row } from '../../db/db.ts'
import { redact } from '../../privacy/redact.ts'
import { allow, type Ctx, personInWeb } from '../context.ts'
import { type ApplyItem, applyOps, type RestoreOp } from './apply.ts'
import { type ChangeView, changeOf, partsOf, recordChange, teach, viewOfChange } from './changes.ts'
import { WIKI_LIMITS } from './model.ts'
import { hasPermission } from './writers.ts'

export type UndoInput = { parts?: number[]; comment?: string; overwrite?: string[]; requestKey?: string }
export type Undone =
  | {
      change: ChangeView
      undone: { address: string; revision: number }[]
      skipped: { address: string; reason: 'purged' }[]
      correction?: string
    }
  | { alreadyUndone: true }

// What a retry with the same request key gets: ids, addresses and revisions, never text (plan §8.3 H4).
type Stored =
  | { alreadyUndone: true }
  | {
      changeId: string
      undone: { address: string; revision: number }[]
      skipped: { address: string; reason: 'purged' }[]
      correction?: string
    }

const sha = (s: string) => createHash('sha256').update(s).digest('hex')

export async function undoChange(ctx: Ctx, id: string, input: UndoInput): Promise<Undone> {
  const comment = input.comment === undefined ? undefined : redact(input.comment.trim()).text
  if (comment !== undefined && (!comment || comment.length > WIKI_LIMITS.comment))
    throw invalid(
      `A comment has 1 to ${WIKI_LIMITS.comment} characters.`,
      'Say why, briefly; it teaches the agent.',
    )
  if (input.requestKey !== undefined && (!input.requestKey.trim() || input.requestKey.length > 200))
    throw invalid('A request key has 1 to 200 characters.', 'Use a fresh random id per request, e.g. a UUID.')
  return ctx.db.tx(async (db) => {
    const c = { ...ctx, db }
    const { row, brain, role } = await changeOf(c, id, true)
    // A curator in the web, or a key a curator let write to the wiki (asked inside, so a revoke counts at once).
    const byKey = !personInWeb(c)
    if (!byKey)
      await allow(c, 'wiki.decide', { role: role as 'curator', brainStatus: brain.status }, brain.id)
    else {
      if (!(await hasPermission(db, brain.id, ctx.who.credential, true)))
        throw new AppError(
          403,
          'web_only',
          'Undoing a change happens in the web, or with a key that may write to the wiki.',
          'Open «Review later» in the rsc-brain web as a curator; or ask a curator to give this key the permission to write to the wiki.',
        )
      await allow(c, 'wiki.propose', { role: role as 'contributor', brainStatus: brain.status }, brain.id)
    }
    let keep = async (_s: Stored) => {}
    if (input.requestKey !== undefined) {
      const key = sha(input.requestKey)
      const hash = sha(
        JSON.stringify(['wiki.undo', id, input.parts ?? null, comment ?? null, input.overwrite ?? null]),
      )
      await db.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [
        `${ctx.who.credential.id}:${key}`,
      ])
      const seen = await db.one<{ request_hash: string; receipt: Stored }>(
        'SELECT request_hash, receipt FROM request_keys WHERE credential_id = $1 AND key = $2',
        [ctx.who.credential.id, key],
      )
      if (seen) {
        if (seen.request_hash !== hash)
          throw conflict(
            'request_key_reused',
            'This request key was already used for a different request.',
            'Use a new request key for a new undo; reuse a key only to retry the very same request.',
          )
        const s = seen.receipt
        if ('alreadyUndone' in s) return s
        return { ...s, change: await viewOfChange(db, s.changeId) }
      }
      keep = async (s) => {
        await db.query(
          'INSERT INTO request_keys (credential_id, key, request_hash, receipt, created_at) VALUES ($1, $2, $3, $4, $5)',
          [ctx.who.credential.id, key, hash, JSON.stringify(s), ctx.clock()],
        )
      }
    }
    const done = async (s: Stored): Promise<Undone> => {
      await keep(s)
      return 'alreadyUndone' in s ? s : { ...s, change: await viewOfChange(db, id) }
    }
    // One writer of the brain's wiki at a time: the conflict check and the restore see the same pages.
    await db.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [`wiki:${brain.id}`])
    if (row.state === 'undone') return done({ alreadyUndone: true })
    const parts = await partsOf(db, row)
    const numbers = parts.map((p) => p.part)
    for (const n of input.parts ?? [])
      if (!numbers.includes(n))
        throw invalid(`The change has no part ${n}.`, `Its parts are 0 to ${numbers.length - 1}.`)
    const chosen = new Set(input.parts ?? numbers)
    const todo = parts.filter((p) => chosen.has(p.part) && p.state === 'applied')
    if (todo.length === 0) return done({ alreadyUndone: true })
    const going = new Set(todo.map((p) => p.part))
    const missing = parts
      .filter((p) => p.state === 'applied' && !going.has(p.part))
      .flatMap((p) => {
        const needs = p.dependsOn.filter((d) => going.has(d))
        return needs.length ? [{ part: p.part, needs }] : []
      })
    if (missing.length) {
      const err = new AppError(
        400,
        'missing_dependencies',
        `Some parts cannot be undone while others stay: ${missing.map((m) => `part ${m.part} needs ${m.needs.join(', ')}`).join('; ')}.`,
        'Undo them together, or leave them all.',
      )
      err.problems = missing
      throw err
    }
    const rows = new Map(
      (await db.query('SELECT * FROM wiki_change_parts WHERE change_id = $1', [id])).map((r) => [
        Number(r.part),
        r,
      ]),
    )
    const pages = new Map(
      (
        await db.query<{ id: string; revision: number; address: string }>(
          'SELECT id, revision, address FROM pages WHERE id = ANY($1)',
          [todo.map((p) => p.pageId)],
        )
      ).map((p) => [p.id, p]),
    )
    // Written again since: a person decides (CA-A10).
    const overwrite = new Set(input.overwrite ?? [])
    const conflicts = todo.flatMap((p) => {
      const now = pages.get(p.pageId)
      if (!now || Number(now.revision) <= p.revisionAfter) return []
      if (overwrite.has(p.address) || overwrite.has(now.address)) return []
      return [
        { address: now.address, changeRevision: p.revisionAfter, currentRevision: Number(now.revision) },
      ]
    })
    if (conflicts.length) {
      const err = conflict(
        'undo_conflict',
        `Some pages were written again after this change: ${conflicts.map((x) => `"${x.address}" (revision ${x.changeRevision}, now ${x.currentRevision})`).join(', ')}. Nothing was undone.`,
        'Look at what came after. To undo over it, send again with "overwrite": the addresses of those pages (what came after stays in the history); or undo only other parts.',
      )
      err.extra = { pages: conflicts }
      throw err
    }
    // A revision before that was purged cannot be put back.
    const skipped: { address: string; reason: 'purged' }[] = []
    const items: ApplyItem[] = []
    const restore: { part: number; op: RestoreOp; lost: boolean }[] = []
    for (const p of todo) {
      const r = rows.get(p.part) as Row
      if (!r.created) {
        const before = await db.one<{ purged: boolean }>(
          'SELECT purged_at IS NOT NULL AS purged FROM page_revisions WHERE page_id = $1 AND revision = $2',
          [p.pageId, r.revision_before],
        )
        if (!before || before.purged) {
          skipped.push({ address: p.address, reason: 'purged' })
          continue
        }
      }
      const addressesBefore = (r.addresses_before as string[]) ?? []
      // A page whose addresses another page now holds (a merge) goes first, so the others' links find it again.
      const held = addressesBefore.length
        ? await db.one<{ n: number }>(
            'SELECT count(*)::int AS n FROM page_addresses WHERE brain_id = $1 AND address = ANY($2) AND page_id <> $3',
            [brain.id, addressesBefore, p.pageId],
          )
        : { n: 0 }
      restore.push({
        part: p.part,
        lost: (held?.n ?? 0) > 0,
        op: {
          op: 'restore',
          address: pages.get(p.pageId)?.address ?? p.address,
          reason: comment ?? 'Undone.',
          pageId: p.pageId,
          created: Boolean(r.created),
          revisionBefore: r.revision_before == null ? null : Number(r.revision_before),
          addressBefore: r.address_before == null ? null : String(r.address_before),
          statusBefore: r.status_before == null ? null : String(r.status_before),
          supersededByBefore: r.superseded_by_before == null ? null : String(r.superseded_by_before),
          addressesBefore,
          addressesAdded: (r.addresses_added as string[]) ?? [],
          linksInBefore: (r.links_in_before as RestoreOp['linksInBefore']) ?? [],
          note: `undo of change ${id}`,
        },
      })
    }
    restore.sort((a, b) => Number(b.lost) - Number(a.lost))
    for (const r of restore) items.push({ op: r.op, index: r.part })
    if (items.length === 0) return done({ changeId: id, undone: [], skipped })
    const title = await titleOf(c, row)
    const all = parts.filter((p) => p.state === 'applied').length === restore.length
    const applied = await applyOps(c, db, brain.id, items, {
      kind: 'undo',
      ...(row.proposal_id ? { proposalId: String(row.proposal_id) } : {}),
      summary: `${all ? 'Undone' : 'Partly undone'}: ${title}`,
      reason: comment ?? '',
    })
    const last = new Map(applied.revised.map((r) => [r.pageId, r]))
    for (const r of restore) {
      await db.query(
        `UPDATE wiki_change_parts SET state = 'undone', undone_by_person = $3, undo_revision = $4
          WHERE change_id = $1 AND part = $2`,
        [id, r.part, !byKey, last.get(r.op.pageId)?.revision ?? null],
      )
    }
    const left = await db.one<{ n: number }>(
      "SELECT count(*)::int AS n FROM wiki_change_parts WHERE change_id = $1 AND state = 'applied'",
      [id],
    )
    await db.query(
      `UPDATE wiki_changes SET state = $2, decided_by = $3, decided_at = $4, comment = coalesce($5, comment),
              undo_log_id = $6 WHERE id = $1`,
      [
        id,
        left?.n ? 'partly_undone' : 'undone',
        ctx.who.accountId,
        ctx.clock(),
        comment ?? null,
        applied.logId,
      ],
    )
    // The log line of the undo belongs to this change; a key's undo is itself a change to review (plan §2.4).
    if (byKey)
      await recordChange(db, c, {
        brainId: brain.id,
        logId: applied.logId,
        before: applied.before,
        revised: applied.revised,
      })
    else await db.query('UPDATE wiki_log SET change_id = $2 WHERE id = $1', [applied.logId, id])
    const undone = restore.map((r) => {
      const v = last.get(r.op.pageId)
      return { address: v?.address ?? r.op.address, revision: v?.revision ?? 0 }
    })
    let correction: string | undefined
    if (comment) {
      const who = await whoMade(c, row)
      const receipt = await teach(
        c,
        brain.id,
        { ...who, title },
        comment,
        `Undone parts of change ${id}: ${undone.map((u) => u.address).join(', ')}.`,
        byKey,
        `Undone: ${title}`,
      )
      correction = receipt.entryId
    }
    return done({ changeId: id, undone, skipped, ...(correction ? { correction } : {}) })
  })
}

// What the change was called: its proposal's title, or its log line (a direct write: «Written directly by …: …»).
async function titleOf(ctx: Ctx, row: Row): Promise<string> {
  const r = await ctx.db.one<{ title: string }>(
    `SELECT coalesce(p.title, l.summary) AS title FROM wiki_log l LEFT JOIN proposals p ON p.id = $2 WHERE l.id = $1`,
    [row.log_id, row.proposal_id],
  )
  return r?.title ?? 'a change'
}

// Who made it, for the correction: the proposal's author and agent, or the account of the key that wrote it (M7). The
// correction refers to the proposal when there is one, so purging the proposal takes it away too.
async function whoMade(ctx: Ctx, row: Row): Promise<{ authorId: string; agent: string | null; ref: string }> {
  if (row.proposal_id) {
    const p = await ctx.db.one<{ author_id: string; agent: string | null }>(
      'SELECT author_id, agent FROM proposals WHERE id = $1',
      [row.proposal_id],
    )
    if (p) return { authorId: p.author_id, agent: p.agent, ref: String(row.proposal_id) }
  }
  return { authorId: String(row.actor_id), agent: null, ref: String(row.id) }
}
