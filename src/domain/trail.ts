// The trail of what clients searched, read or asked as context (spec B3 «Rastro de lo consultado»).
// Identifiers only; the query text is redacted like everything stored. Who sees a line: the curators of
// the brain, and whoever made it (a service sees what its own keys did, never what others did; an
// agent's short key only what it did itself, since one service runs agents for several people).
import { invalid } from '../core/errors.ts'
import type { Db, Row } from '../db/db.ts'
import { redact } from '../privacy/redact.ts'
import { type Ctx, inBrain } from './context.ts'
import { emit } from './events.ts'
import { dayIn } from './sessions.ts'
import { resolve } from './wiki/pages.ts'

export const TRAIL_DAYS = 90

export async function track(
  db: Db,
  ctx: Ctx,
  t: {
    brainId: string
    kind: 'search' | 'read' | 'context'
    query?: string | null
    resultIds: string[]
    ref?: string | null
    // For a read: the address or title of what was read, for the event (spec B5).
    label?: string | null
  },
): Promise<void> {
  // During maintenance reads leave no trail, so the copy taken for an update stays current (spec B7 C12).
  if (ctx.who.maintenance) return
  const ref = t.ref ?? (ctx.who.credential.kind === 'short' ? ctx.who.credential.ref : null)
  // The session is the one the key's writes in that brain go to (as sessionFor picks it, without
  // opening one): its newest explicit or bound session, else its implicit session of the day.
  await db.query(
    `INSERT INTO trail (brain_id, at, account_id, credential_id, ref, kind, query, result_ids, session_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8,
             (SELECT id FROM sessions WHERE credential_id = $4 AND brain_id = $1 AND status = 'open'
                 AND (day IS NULL OR day = $9::date)
               ORDER BY (day IS NULL) DESC, opened_at DESC, id DESC LIMIT 1))`,
    [
      t.brainId,
      ctx.clock(),
      ctx.who.accountId,
      ctx.who.credential.id,
      ref,
      t.kind,
      t.query == null ? null : redact(t.query).text,
      t.resultIds,
      dayIn(ctx.tz ?? 'UTC', ctx.clock()),
    ],
  )
  // Searches and reads are also events of the brain, for whoever follows it live (spec B5 CA12).
  if (t.kind === 'search') {
    await emit(db, ctx, { brainId: t.brainId, kind: 'search', query: t.query ?? '', resultIds: t.resultIds })
  }
  if (t.kind === 'read') {
    await emit(db, ctx, {
      brainId: t.brainId,
      kind: 'read',
      targetId: t.resultIds[0] ?? null,
      label: t.label ?? null,
    })
  }
}

// A read of a page by address (its current version, an old revision, a comparison or its history).
export async function trackPageRead(ctx: Ctx, slug: string, address: string): Promise<void> {
  const { brain } = await inBrain(ctx, { slug })
  const row = await resolve(ctx.db, brain.id, address)
  if (row)
    await track(ctx.root ?? ctx.db, ctx, {
      brainId: brain.id,
      kind: 'read',
      resultIds: [String(row.id)],
      label: String(row.address),
    })
}

export type TrailLine = {
  id: number
  at: string
  kind: 'search' | 'read' | 'context'
  query: string | null
  resultIds: string[]
  account: { id: string; name: string }
  credential: { id: string; kind: string; name: string }
  ref: string | null
  sessionId: string | null
}

export type TrailQuery = { ref?: string; session?: string; page?: string; after?: number; limit?: number }

export type Older = { reads: number; searches: number; contexts: number; until: string }

// Lines of a brain's trail, oldest first, by external reference, by session or by page («who read
// this»: the reads and contexts that returned it). One rule of visibility, here only.
export async function readTrail(
  ctx: Ctx,
  slug: string,
  q: TrailQuery,
): Promise<{ items: TrailLine[]; next: number | null; older?: Older }> {
  const { brain, role } = await inBrain(ctx, { slug })
  const given = [q.ref, q.session, q.page].filter((v) => v !== undefined).length
  if (given > 1) throw invalid('Ask by one of "ref", "session" or "page".', 'Keep only one of them.')
  const limit = q.limit ?? 100
  const params: unknown[] = [brain.id]
  const p = (v: unknown) => {
    params.push(v)
    return `$${params.length}`
  }
  const where = ['t.brain_id = $1']
  if (role !== 'curator') {
    where.push(
      ctx.who.credential.kind === 'short'
        ? `t.credential_id = ${p(ctx.who.credential.id)}`
        : `t.account_id = ${p(ctx.who.accountId)}`,
    )
  }
  if (q.ref !== undefined) where.push(`t.ref = ${p(q.ref)}`)
  if (q.session !== undefined) where.push(`t.session_id = ${p(q.session)}`)
  let pageId: string | null = null
  if (q.page !== undefined) {
    const row = await resolve(ctx.db, brain.id, q.page)
    // A page that does not exist has nobody who read it; nothing is said about why.
    if (!row) return { items: [], next: null }
    pageId = String(row.id)
    where.push(`t.kind IN ('read', 'context') AND t.result_ids @> ARRAY[${p(pageId)}]::text[]`)
  }
  if (q.after !== undefined) where.push(`t.id > ${p(q.after)}`)
  const rows = await ctx.db.query<Row>(
    `SELECT t.*, a.name AS account_name, c.kind AS credential_kind, c.name AS credential_name
       FROM trail t
       JOIN accounts a ON a.id = t.account_id
       LEFT JOIN credentials c ON c.id = t.credential_id
      WHERE ${where.join(' AND ')}
      ORDER BY t.id
      LIMIT ${p(limit + 1)}`,
    params,
  )
  const items = rows.slice(0, limit).map(
    (r): TrailLine => ({
      id: Number(r.id),
      at: (r.at as Date).toISOString(),
      kind: r.kind as TrailLine['kind'],
      query: r.query == null ? null : String(r.query),
      resultIds: r.result_ids as string[],
      account: { id: String(r.account_id), name: String(r.account_name) },
      credential: {
        id: String(r.credential_id),
        kind: r.credential_kind == null ? 'deleted' : String(r.credential_kind),
        name: r.credential_name == null ? '' : String(r.credential_name),
      },
      ref: r.ref == null ? null : String(r.ref),
      sessionId: r.session_id == null ? null : String(r.session_id),
    }),
  )
  const out: { items: TrailLine[]; next: number | null; older?: Older } = {
    items,
    next: rows.length > limit ? (items.at(-1)?.id ?? null) : null,
  }
  // What is older than 90 days survives as counters, for curators.
  if (pageId && role === 'curator') {
    const c = await ctx.db.one<Row>('SELECT * FROM trail_counts WHERE brain_id = $1 AND target_id = $2', [
      brain.id,
      pageId,
    ])
    if (c) {
      out.older = {
        reads: Number(c.reads),
        searches: Number(c.searches),
        contexts: Number(c.contexts),
        until: (c.until as Date).toISOString(),
      }
    }
  }
  return out
}

// Folds the trail older than 90 days into per-target counters and deletes it. Runs from the server's
// maintenance loop; safe to run at any time and from several servers (one transaction, row locks).
export async function foldTrail(db: Db, now: Date): Promise<number> {
  const cutoff = new Date(now.getTime() - TRAIL_DAYS * 86_400_000)
  return db.tx(async (tx) => {
    const old = await tx.query<{ id: string }>(
      'SELECT id FROM trail WHERE at < $1 ORDER BY id LIMIT 50000 FOR UPDATE SKIP LOCKED',
      [cutoff],
    )
    if (old.length === 0) return 0
    const ids = old.map((r) => r.id)
    await tx.query(
      `INSERT INTO trail_counts (brain_id, target_id, reads, searches, contexts, until)
       SELECT t.brain_id, x.target,
              count(*) FILTER (WHERE t.kind = 'read'), count(*) FILTER (WHERE t.kind = 'search'),
              count(*) FILTER (WHERE t.kind = 'context'), $2
         FROM trail t CROSS JOIN LATERAL unnest(t.result_ids) AS x(target)
        WHERE t.id = ANY($1::bigint[])
        GROUP BY t.brain_id, x.target
       ON CONFLICT (brain_id, target_id) DO UPDATE
         SET reads = trail_counts.reads + EXCLUDED.reads,
             searches = trail_counts.searches + EXCLUDED.searches,
             contexts = trail_counts.contexts + EXCLUDED.contexts,
             until = greatest(trail_counts.until, EXCLUDED.until)`,
      [ids, cutoff],
    )
    await tx.query('DELETE FROM trail WHERE id = ANY($1::bigint[])', [ids])
    return ids.length
  })
}
