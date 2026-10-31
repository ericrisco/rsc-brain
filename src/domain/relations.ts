// Relations between entries (spec B1 «Contradicciones y relaciones»). The server never decides that
// two entries contradict each other; clients and people say so. A person's correction is only
// superseded or dismissed by a person, in the web: from any key it waits as a pending conflict (pack
// rule 4), and the person's own word on that pair settles it — the same relation confirms the one that
// waited, anything else turns it down. In the web, the entry superseded or the correction dismissed must
// be the person's own, or the person a curator (the rule of forgetting).
import { conflict, invalid, notFound } from '../core/errors.ts'
import { newId } from '../core/ids.ts'
import type { Db, Row } from '../db/db.ts'
import { redact } from '../privacy/redact.ts'
import { allow, type Ctx, inBrain, personInWeb } from './context.ts'
import {
  type Byline,
  bylines,
  type Entry,
  entryOf,
  type SessionRef,
  sessionRefs,
  withByline,
} from './entries.ts'
import { emit } from './events.ts'

export const RELATION_KINDS = ['contradicts', 'supersedes', 'not_related'] as const
export type RelationKind = (typeof RELATION_KINDS)[number]

export type Relation = {
  id: string
  fromId: string
  toId: string
  kind: RelationKind
  status: 'active' | 'pending_person' | 'rejected'
  reason: string
  createdBy: string
  createdAt: string
}

const relationOf = (r: Row): Relation => ({
  id: String(r.id),
  fromId: String(r.from_id),
  toId: String(r.to_id),
  kind: r.kind as RelationKind,
  status: r.status as Relation['status'],
  reason: String(r.reason),
  createdBy: String(r.created_by),
  createdAt: (r.created_at as Date).toISOString(),
})

export async function relate(
  ctx: Ctx,
  slug: string,
  r: { from: string; to: string; kind: string; reason?: string },
): Promise<Relation> {
  if (!(RELATION_KINDS as readonly string[]).includes(r.kind)) {
    throw invalid(`Unknown relation "${r.kind}".`, `Use one of: ${RELATION_KINDS.join(', ')}.`)
  }
  if (r.from === r.to) throw invalid('An entry cannot relate to itself.', 'Name two different entries.')
  const reason = redact((r.reason ?? '').trim()).text
  if (reason.length > 500) throw invalid('The reason is longer than 500 characters.', 'Shorten it.')
  return ctx.db.tx(async (db) => {
    const c = { ...ctx, db }
    const { brain, role } = await inBrain(c, { slug }, 'share')
    await allow(c, 'relation.write', { role, brainStatus: brain.status }, brain.id)
    const rows = await db.query(
      "SELECT * FROM entries WHERE id = ANY($1) AND brain_id = $2 AND state = 'active' FOR UPDATE",
      [[r.from, r.to], brain.id],
    )
    if (rows.length !== 2) throw notFound('entry')
    const from = rows.find((x) => x.id === r.from) as Row
    const to = rows.find((x) => x.id === r.to) as Row
    const touchesCorrection =
      (r.kind === 'supersedes' && to.type === 'correction') ||
      (r.kind === 'not_related' && (to.type === 'correction' || from.type === 'correction'))
    // Every key is an agent's; the person's own gesture is the web (spec B6).
    const person = personInWeb(ctx)
    // A person decides about the entry superseded, or the correction dismissed, only as its author or a
    // curator. An agent asking about a correction waits for a person instead (below). A person answering
    // what waits about their own entry may keep it: when an agent asked that `to` supersedes `from`, the
    // author of `from` (or a curator) records the opposite, and what waited is turned down. Dismissing is
    // about corrections only: a correction not related to an ordinary entry asks only for the correction.
    if (person) {
      const answering =
        r.kind === 'supersedes' &&
        (await db.one(
          `SELECT 1 AS hit FROM relations WHERE brain_id = $1 AND status = 'pending_person'
              AND kind = 'supersedes' AND from_id = $2 AND to_id = $3 LIMIT 1`,
          [brain.id, to.id, from.id],
        ))
      const decided =
        r.kind === 'supersedes'
          ? [answering ? from : to]
          : r.kind === 'not_related'
            ? [from, to].filter((x) => x.type === 'correction')
            : []
      for (const x of decided) {
        await allow(
          c,
          'relation.decide',
          { role, brainStatus: brain.status, isOwner: x.author_id === ctx.who.accountId },
          brain.id,
        )
      }
    }
    const status = touchesCorrection && !person ? 'pending_person' : 'active'
    // A person settles what agents asked about this pair: the same relation is confirmed (it takes
    // effect below, as the one that waited), any other is turned down.
    let confirmed: Row | null = null
    if (person && r.kind !== 'contradicts') {
      const waiting = await db.query(
        `SELECT * FROM relations WHERE brain_id = $1 AND status = 'pending_person'
            AND least(from_id, to_id) = least($2, $3) AND greatest(from_id, to_id) = greatest($2, $3)
          ORDER BY created_at FOR UPDATE`,
        [brain.id, r.from, r.to],
      )
      for (const x of waiting) {
        const same = !confirmed && x.from_id === r.from && x.to_id === r.to && x.kind === r.kind
        if (same) confirmed = x
        // Decided now: a relation confirmed takes effect from this moment, so it settles a contradiction
        // recorded after the agent asked (the settle rule reads decided_at before created_at).
        await db.query('UPDATE relations SET status = $2, decided_at = $3 WHERE id = $1', [
          x.id,
          same ? 'active' : 'rejected',
          ctx.clock(),
        ])
      }
    }
    if (r.kind === 'supersedes' && status === 'active') {
      // `to` loses to `from`; if `from` already loses, through any chain, to `to`, that closes a loop.
      // One supersede at a time per brain, so two at once cannot each close half of a loop.
      await db.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [`supersede:${brain.id}`])
      const loop = await db.one(
        `WITH RECURSIVE chain(id) AS (
           SELECT superseded_by FROM entries WHERE id = $1 AND superseded_by IS NOT NULL
           UNION SELECT e.superseded_by FROM entries e JOIN chain ON e.id = chain.id WHERE e.superseded_by IS NOT NULL
         ) SELECT 1 AS hit FROM chain WHERE id = $2 LIMIT 1`,
        [from.id, to.id],
      )
      if (loop) {
        throw conflict(
          'relation_cycle',
          'That would make entries supersede each other in a loop.',
          'Pick the one that wins.',
        )
      }
      await db.query('UPDATE entries SET superseded_by = $2, updated_at = $3 WHERE id = $1', [
        to.id,
        from.id,
        ctx.clock(),
      ])
    }
    const row = confirmed
      ? await db.one('SELECT * FROM relations WHERE id = $1', [confirmed.id])
      : await db.one(
          `INSERT INTO relations (id, brain_id, from_id, to_id, kind, status, reason, created_by, credential_id, created_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *`,
          [
            newId('rel'),
            brain.id,
            r.from,
            r.to,
            r.kind,
            status,
            reason,
            ctx.who.accountId,
            ctx.who.credential.id,
            ctx.clock(),
          ],
        )
    await emit(db, c, {
      brainId: brain.id,
      kind: 'entry.changed',
      targetId: String(to.id),
      label: `${r.kind} (${status})`,
    })
    return relationOf(row as Row)
  })
}

// A side of a conflict, as a person decides it: who wrote it and with what, and the session it is in.
export type ConflictSide = Entry & Byline & { session: SessionRef }

export type Conflict = {
  relation: Relation
  from: ConflictSide
  to: ConflictSide
  why: 'contradicts' | 'waiting for a person'
}

// An open conflict over a relation `r`: a `contradicts` not settled by a later `supersedes` or
// `not_related` on the same pair, or one waiting for a person; both entries still active. "Later" is when
// the settling relation took effect: when a person decided on it if it waited for one, else when it was
// made. The Conflicts list, the numbers of a brain and the badges of a session count the same ones.
export const OPEN_CONFLICT = `
  ((r.kind = 'contradicts' AND r.status = 'active'
    AND NOT EXISTS (SELECT 1 FROM relations s
                     WHERE s.brain_id = r.brain_id AND s.status = 'active'
                       AND s.kind IN ('supersedes', 'not_related')
                       AND coalesce(s.decided_at, s.created_at) >= r.created_at
                       AND least(s.from_id, s.to_id) = least(r.from_id, r.to_id)
                       AND greatest(s.from_id, s.to_id) = greatest(r.from_id, r.to_id)))
   OR r.status = 'pending_person')
  AND EXISTS (SELECT 1 FROM entries x WHERE x.id = r.from_id AND x.state = 'active')
  AND EXISTS (SELECT 1 FROM entries x WHERE x.id = r.to_id AND x.state = 'active')`

// Which of these entries have an open conflict.
export async function inConflict(db: Db, ids: string[]): Promise<Set<string>> {
  if (ids.length === 0) return new Set()
  const rows = await db.query<{ id: string }>(
    `SELECT unnest(ARRAY[r.from_id, r.to_id]) AS id FROM relations r
      WHERE (r.from_id = ANY($1) OR r.to_id = ANY($1)) AND ${OPEN_CONFLICT}`,
    [ids],
  )
  return new Set(rows.map((r) => r.id))
}

// Open conflicts (OPEN_CONFLICT), with each side's author, client and session.
export async function conflicts(
  ctx: Ctx,
  slug: string,
  o: { limit?: number; offset?: number } = {},
): Promise<{ conflicts: Conflict[]; total: number; next: string | null }> {
  const { brain } = await inBrain(ctx, { slug })
  const rows = await ctx.db.query(
    `SELECT r.* FROM relations r WHERE r.brain_id = $1 AND ${OPEN_CONFLICT} ORDER BY r.created_at, r.id`,
    [brain.id],
  )
  // By pages when asked (the web shows a few at a time); a whole list otherwise, as before.
  const start = o.offset ?? 0
  const end = o.limit === undefined ? rows.length : start + o.limit
  const page = rows.slice(start, end)
  const ids = [...new Set(page.flatMap((r) => [String(r.from_id), String(r.to_id)]))]
  const es = ids.length ? await ctx.db.query('SELECT * FROM entries WHERE id = ANY($1)', [ids]) : []
  const by = await bylines(ctx.db, ids)
  const sessions = await sessionRefs(
    ctx.db,
    es.map((e) => String(e.session_id)),
  )
  const side = (id: string): ConflictSide => {
    const e = entryOf(es.find((x) => x.id === id) as Row)
    return { ...withByline(e, by.get(id)), session: sessions.get(e.sessionId) as SessionRef }
  }
  const out: Conflict[] = page.map((r) => ({
    relation: relationOf(r),
    from: side(String(r.from_id)),
    to: side(String(r.to_id)),
    why: r.status === 'pending_person' ? 'waiting for a person' : 'contradicts',
  }))
  return {
    conflicts: out,
    total: rows.length,
    next: end < rows.length ? String(end) : null,
  }
}
