// The audit trail: who did what, when, with which key and how it ended. Written alongside the act,
// never edited.
import type { Db } from '../db/db.ts'

export type AuditEntry = {
  at: Date
  actorId: string | null
  credentialId: string | null
  action: string
  brainId?: string | null
  target?: string | null
  outcome: 'ok' | 'denied'
  detail?: string
}

export async function audit(db: Db, e: AuditEntry): Promise<void> {
  await db.query(
    `INSERT INTO audit (at, actor_id, credential_id, action, brain_id, target, outcome, detail)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
    [
      e.at,
      e.actorId,
      e.credentialId,
      e.action,
      e.brainId ?? null,
      e.target ?? null,
      e.outcome,
      e.detail ?? '',
    ],
  )
}
