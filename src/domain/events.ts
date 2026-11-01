// The activity of a brain: one row per thing that happened, read by the web and by programs that
// follow a brain (spec B5 «Flujo de eventos»). Identifiers, a short label and, for a search, the text
// searched (redacted like everything stored); never the body of an entry or a page.
import type { Principal } from '../auth/principal.ts'
import type { Clock } from '../core/clock.ts'
import type { Db, Row } from '../db/db.ts'
import { redact } from '../privacy/redact.ts'

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

// `who`: null when the installation itself did it (a session closed for being idle).
export async function emit(
  db: Db,
  ctx: { clock: Clock; who: Principal | null },
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
    `INSERT INTO events (brain_id, at, kind, account_id, credential_id, ref, target_id, label, query, result_ids,
                         client)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
    [
      e.brainId,
      ctx.clock(),
      e.kind,
      ctx.who?.accountId ?? null,
      ctx.who?.credential.id ?? null,
      ctx.who?.credential.kind === 'short' ? ctx.who.credential.ref : null,
      e.targetId ?? null,
      e.label ? redact(e.label).text.slice(0, 200) : null,
      e.query == null ? null : redact(e.query).text.slice(0, 1000),
      e.resultIds ?? [],
      // The client of the key, as the journal names it (domain/clients.ts); kept, never looked up again.
      ctx.who?.client ? redact(ctx.who.client).text.slice(0, 200) : null,
    ],
  )
}

export type EventRow = {
  id: number
  // The delivery number (see sequenceEvents): what streams, resuming and gaps go by.
  seq: number
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
  client: string | null
  // The state of the entry it names, if it names one (a forgotten title is not for everyone).
  targetState: string | null
  // The external reference of the session it happened in (or of the session it opened or closed).
  sessionRef: string | null
  // Who a short key acted for (Factory runs agents for people).
  onBehalf: { id: string; name: string } | null
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

// The title of an event's entry, as this viewer may see it: hidden when the entry is purged, and from all but
// curators when it is forgotten (the rule of the journal, entries.ts relationsOf).
// Forgetting and recovering an entry are labelled with what happened, not with its title: they say so to all.
const ACTIONS = new Set(['forgotten', 'recovered'])
export function labelFor(
  v: Pick<Viewer, 'curator'>,
  e: Pick<EventRow, 'label' | 'targetState'> & { kind?: string },
): string | null {
  if (e.kind === 'entry.changed' && e.label !== null && ACTIONS.has(e.label)) return e.label
  if (e.targetState === 'purged' || (e.targetState === 'forgotten' && !v.curator)) return null
  return e.label
}

// The state that rules an event's label: its entry's, or, for a closed session (whose label is its summary's
// title), the summary entry's. The session reference: of the session it opened or closed, or of the session
// an entry was written in, for the writing itself; a later change by someone else (entry.changed) happened
// outside that session and carries none.
const SELECT = `SELECT e.*, b.slug, a.name AS account_name, coalesce(en.state, sm.state) AS target_state,
                       se.ref AS session_ref, cr.on_behalf_id, ob.name AS on_behalf_name
                  FROM events e JOIN brains b ON b.id = e.brain_id LEFT JOIN accounts a ON a.id = e.account_id
                  LEFT JOIN entries en ON en.id = e.target_id
                  LEFT JOIN sessions se
                         ON se.id = CASE WHEN e.kind LIKE 'session.%' THEN e.target_id
                                         WHEN e.kind IN ('entry.saved', 'entry.revised', 'entry.repeated')
                                           THEN en.session_id END
                  LEFT JOIN entries sm ON e.kind = 'session.closed' AND sm.id = se.summary_entry_id
                  LEFT JOIN credentials cr ON cr.id = e.credential_id
                  LEFT JOIN accounts ob ON ob.id = cr.on_behalf_id`

const rowOf = (r: Row): EventRow => ({
  id: Number(r.id),
  seq: Number(r.seq),
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
  client: r.client == null ? null : String(r.client),
  targetState: r.target_state == null ? null : String(r.target_state),
  sessionRef: r.session_ref == null ? null : String(r.session_ref),
  onBehalf:
    r.on_behalf_id == null ? null : { id: String(r.on_behalf_id), name: String(r.on_behalf_name ?? '') },
})

// The highest delivery number given so far.
export async function lastSeq(db: Db): Promise<number> {
  const r = await db.one<{ seq: string | null }>('SELECT max(seq) AS seq FROM events')
  return r?.seq == null ? 0 : Number(r.seq)
}

// Numbers up to `limit` events that have none yet, oldest first, and returns the numbers given. One
// statement, committed on its own: what it numbers is visible to every reader from then on, so a feed
// that reads past its last number never misses one. A write still uncommitted is not seen (nor locked),
// and gets its number in a later round. Numbers come from one sequence and are given by one feed per
// installation (one process). A lock held until the round commits keeps two processes (an overlapping
// deploy) from numbering at once: otherwise a number could become visible after a later one was read.
export async function sequenceEvents(db: Db, limit: number): Promise<number[]> {
  const rows = await db.tx(async (t) => {
    await t.query("SELECT pg_advisory_xact_lock(hashtext('rsc-brain:events-seq'))")
    return t.query<{ seq: string }>(
      `UPDATE events e SET seq = n.seq
       FROM (SELECT id, nextval('events_seq') AS seq
               FROM (SELECT id FROM events WHERE seq IS NULL ORDER BY id LIMIT $1 FOR UPDATE SKIP LOCKED) p
              ORDER BY id) n
      WHERE e.id = n.id
      RETURNING e.seq`,
      [limit],
    )
  })
  return rows.map((r) => Number(r.seq)).sort((x, y) => x - y)
}

// Events of every brain after a delivery number, in delivery order (the live feed reads these).
export async function eventsAfter(db: Db, after: number, limit: number): Promise<EventRow[]> {
  const rows = await db.query(`${SELECT} WHERE e.seq > $1 ORDER BY e.seq LIMIT $2`, [after, limit])
  return rows.map(rowOf)
}

// Events of one brain numbered in (after, upTo], since a moment, in delivery order (resuming after a
// cut).
export async function eventsOfBrain(
  db: Db,
  brainId: string,
  after: number,
  upTo: number,
  since: Date,
  limit: number,
): Promise<EventRow[]> {
  const rows = await db.query(
    `${SELECT} WHERE e.brain_id = $1 AND e.seq > $2 AND e.seq <= $3 AND e.at >= $4 ORDER BY e.seq LIMIT $5`,
    [brainId, after, upTo, since, limit],
  )
  return rows.map(rowOf)
}

// Whether this viewer missed an event of the brain numbered after `after` that is older than `since`:
// those are not replayed, so the stream must say there is a gap (CA20).
export async function missedBefore(
  db: Db,
  brainId: string,
  after: number,
  since: Date,
  v: Viewer,
): Promise<boolean> {
  const r = await db.one(
    `SELECT 1 FROM events
      WHERE brain_id = $1 AND seq > $2 AND at < $3
        AND ($4 OR kind <> ALL($5::text[]) OR (CASE WHEN $6 THEN credential_id = $7 ELSE account_id = $8 END))
      -- In the order of events_brain_at: the planner walks that index instead of betting on a table scan
      -- (which reads everything when nothing matches).
      ORDER BY at DESC LIMIT 1`,
    [brainId, after, since, v.curator, LOOKS, v.short, v.credentialId, v.accountId],
  )
  return r !== undefined
}
