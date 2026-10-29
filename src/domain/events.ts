// The activity of a brain: one row per thing that happened, read by the web and by programs that
// follow a brain (spec B5). Identifiers and a short label, never the body of an entry.
import type { Db } from '../db/db.ts'
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

export async function emit(
  db: Db,
  ctx: Ctx,
  e: { brainId: string; kind: EventKind; targetId?: string | null; label?: string | null },
): Promise<void> {
  await db.query(
    `INSERT INTO events (brain_id, at, kind, account_id, credential_id, ref, target_id, label)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
    [
      e.brainId,
      ctx.clock(),
      e.kind,
      ctx.who.accountId,
      ctx.who.credential.id,
      ctx.who.credential.kind === 'short' ? ctx.who.credential.ref : null,
      e.targetId ?? null,
      e.label ? e.label.slice(0, 200) : null,
    ],
  )
}
