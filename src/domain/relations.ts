// Relations between entries (spec B1 «Contradicciones y relaciones»). The server never decides that
// two entries contradict each other; clients and people say so. A person's correction is only
// superseded or dismissed by a person: from any key it waits as a pending conflict (pack rule 4).
import { conflict, invalid, notFound } from '../core/errors.ts'
import { newId } from '../core/ids.ts'
import type { Row } from '../db/db.ts'
import { redact } from '../privacy/redact.ts'
import { allow, type Ctx, inBrain } from './context.ts'
import { type Entry, entryOf } from './entries.ts'
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
    const status = touchesCorrection ? 'pending_person' : 'active'
    if (r.kind === 'supersedes' && status === 'active') {
      // `to` loses to `from`; if `from` already loses, through any chain, to `to`, that closes a loop.
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
    const row = await db.one(
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

export type Conflict = {
  relation: Relation
  from: Entry
  to: Entry
  why: 'contradicts' | 'waiting for a person'
}

// Open conflicts: a `contradicts` not yet settled by a later `supersedes` or `not_related` on the same
// pair, and anything an agent asked about a person's correction.
export async function conflicts(ctx: Ctx, slug: string): Promise<Conflict[]> {
  const { brain } = await inBrain(ctx, { slug })
  const rows = await ctx.db.query(
    `SELECT r.* FROM relations r
      WHERE r.brain_id = $1
        AND ((r.kind = 'contradicts' AND r.status = 'active'
              AND NOT EXISTS (SELECT 1 FROM relations s
                               WHERE s.brain_id = r.brain_id AND s.status = 'active'
                                 AND s.kind IN ('supersedes', 'not_related') AND s.created_at >= r.created_at
                                 AND least(s.from_id, s.to_id) = least(r.from_id, r.to_id)
                                 AND greatest(s.from_id, s.to_id) = greatest(r.from_id, r.to_id)))
             OR r.status = 'pending_person')
      ORDER BY r.created_at`,
    [brain.id],
  )
  const out: Conflict[] = []
  for (const r of rows) {
    const es = await ctx.db.query("SELECT * FROM entries WHERE id = ANY($1) AND state = 'active'", [
      [r.from_id, r.to_id],
    ])
    const from = es.find((e) => e.id === r.from_id)
    const to = es.find((e) => e.id === r.to_id)
    if (!from || !to) continue
    out.push({
      relation: relationOf(r),
      from: entryOf(from),
      to: entryOf(to),
      why: r.status === 'pending_person' ? 'waiting for a person' : 'contradicts',
    })
  }
  return out
}
