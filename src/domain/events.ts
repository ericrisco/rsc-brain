// The activity of a brain: one row per thing that happened, read by the web and by programs that
// follow a brain (spec B5 «Flujo de eventos»). Identifiers, a short label and, for a search, the text
// searched (redacted like everything stored); never the body of an entry or a page.
import type { Db, Row } from '../db/db.ts'
import { redact } from '../privacy/redact.ts'
import type { Ctx } from './context.ts'

export type EventKind =
  | 'session.opened'
  | 'session.closed'
  | 'entry.saved'
  | 'entry.revised'
  | 'entry.repeated'
  | 'entry.changed'
  | 'search'
  | 'read'
  | 'proposal.submitted'
  | 'proposal.withdrawn'
  | 'proposal.decided'
  | 'wiki.changed'

// What someone looked at, as opposed to what they changed: only curators and whoever looked see these.
export const LOOKS: readonly EventKind[] = ['search', 'read']

export async function emit(
  db: Db,
  ctx: Ctx,
  e: {
    brainId: string
    kind: EventKind
    targetId?: string | null
    label?: string | null
    query?: string | null
    // What a search returned: kept only so a purge can find it, never sent.
    resultIds?: string[]
  },
): Promise<void> {
  await db.query(
    `INSERT INTO events (brain_id, at, kind, account_id, credential_id, ref, target_id, label, query, result_ids)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
    [
      e.brainId,
      ctx.clock(),
      e.kind,
      ctx.who.accountId,
      ctx.who.credential.id,
      ctx.who.credential.kind === 'short' ? ctx.who.credential.ref : null,
      e.targetId ?? null,
      e.label ? redact(e.label).text.slice(0, 200) : null,
      e.query == null ? null : redact(e.query).text.slice(0, 1000),
      e.resultIds ?? [],
    ],
  )
}

export type EventRow = {
  id: number
  brainId: string
  brain: string
  at: Date
  kind: string
  accountId: string | null
  accountName: string | null
  credentialId: string | null
  ref: string | null
  targetId: string | null
  label: string | null
  query: string | null
}

// Who follows a brain, and so which of its events they get (pack rule 7, the same rule as the trail of
// B3): a curator gets everything; anyone else gets every change and proposal, and only their own
// searches and reads (a service: what any of its keys did; an agent's short key: what it did itself,
// since one service runs agents for several people).
export type Viewer = { curator: boolean; accountId: string; credentialId: string; short: boolean }

export function visibleTo(v: Viewer, e: Pick<EventRow, 'kind' | 'accountId' | 'credentialId'>): boolean {
  if (v.curator || !(LOOKS as readonly string[]).includes(e.kind)) return true
  return v.short ? e.credentialId === v.credentialId : e.accountId === v.accountId
}

const SELECT = `SELECT e.*, b.slug, a.name AS account_name
                  FROM events e JOIN brains b ON b.id = e.brain_id LEFT JOIN accounts a ON a.id = e.account_id`

const rowOf = (r: Row): EventRow => ({
  id: Number(r.id),
  brainId: String(r.brain_id),
  brain: String(r.slug),
  at: r.at as Date,
  kind: String(r.kind),
  accountId: r.account_id == null ? null : String(r.account_id),
  accountName: r.account_name == null ? null : String(r.account_name),
  credentialId: r.credential_id == null ? null : String(r.credential_id),
  ref: r.ref == null ? null : String(r.ref),
  targetId: r.target_id == null ? null : String(r.target_id),
  label: r.label == null ? null : String(r.label),
  query: r.query == null ? null : String(r.query),
})

export async function lastEventId(db: Db): Promise<number> {
  const r = await db.one<{ id: string | null }>('SELECT max(id) AS id FROM events')
  return r?.id == null ? 0 : Number(r.id)
}

// Events of every brain after an id, oldest first (the live feed reads these).
export async function eventsAfter(db: Db, after: number, limit: number): Promise<EventRow[]> {
  const rows = await db.query(`${SELECT} WHERE e.id > $1 ORDER BY e.id LIMIT $2`, [after, limit])
  return rows.map(rowOf)
}

// Events of one brain in (after, upTo], since a moment, oldest first (resuming after a cut).
export async function eventsOfBrain(
  db: Db,
  brainId: string,
  after: number,
  upTo: number,
  since: Date,
  limit: number,
): Promise<EventRow[]> {
  const rows = await db.query(
    `${SELECT} WHERE e.brain_id = $1 AND e.id > $2 AND e.id <= $3 AND e.at >= $4 ORDER BY e.id LIMIT $5`,
    [brainId, after, upTo, since, limit],
  )
  return rows.map(rowOf)
}

// Whether this viewer missed an event of the brain after `after` that is older than `since`: those are
// not replayed, so the stream must say there is a gap (CA20).
export async function missedBefore(
  db: Db,
  brainId: string,
  after: number,
  since: Date,
  v: Viewer,
): Promise<boolean> {
  const r = await db.one(
    `SELECT 1 FROM events
      WHERE brain_id = $1 AND id > $2 AND at < $3
        AND ($4 OR kind <> ALL($5::text[]) OR (CASE WHEN $6 THEN credential_id = $7 ELSE account_id = $8 END))
      LIMIT 1`,
    [brainId, after, since, v.curator, LOOKS, v.short, v.credentialId, v.accountId],
  )
  return r !== undefined
}
