// The trail of what clients searched, read or asked as context (spec B3 «Rastro», minimum for B1).
// Identifiers only; the query text is redacted like everything stored.
import type { Db } from '../db/db.ts'
import { redact } from '../privacy/redact.ts'
import type { Ctx } from './context.ts'

export async function track(
  db: Db,
  ctx: Ctx,
  t: {
    brainId: string
    kind: 'search' | 'read' | 'context'
    query?: string | null
    resultIds: string[]
    ref?: string | null
  },
): Promise<void> {
  const ref = t.ref ?? (ctx.who.credential.kind === 'short' ? ctx.who.credential.ref : null)
  await db.query(
    `INSERT INTO trail (brain_id, at, account_id, credential_id, ref, kind, query, result_ids)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
    [
      t.brainId,
      ctx.clock(),
      ctx.who.accountId,
      ctx.who.credential.id,
      ref,
      t.kind,
      t.query == null ? null : redact(t.query).text,
      t.resultIds,
    ],
  )
}
