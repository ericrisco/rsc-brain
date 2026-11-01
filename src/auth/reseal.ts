// Values sealed before purposes (v1: no authenticated data) are sealed again as v2, bound to their column's
// purpose, when the server starts with its secret. One transaction; idempotent (only v1 values are looked at);
// a value sealed with another secret is left as it is. Opening v1 stays possible (a backup restored from
// before this release), but nothing new is ever written as v1.
import type { Db } from '../db/db.ts'
import { type Purpose, seal, unseal } from './vault.ts'

export async function resealV1(db: Db, secret: string | undefined): Promise<number> {
  if (!secret) return 0
  const again = (v: string, purpose: Purpose): string | null => {
    try {
      return seal(secret, unseal(secret, v, purpose), purpose)
    } catch {
      return null
    }
  }
  return db.tx(async (tx) => {
    let n = 0
    for (const col of ['totp_secret', 'totp_pending'] as const) {
      const rows = await tx.query<{ id: string; v: string }>(
        `SELECT id, ${col} AS v FROM accounts WHERE ${col} LIKE 'v1.%' FOR UPDATE`,
      )
      for (const r of rows) {
        const v2 = again(r.v, 'account.totp')
        if (!v2) continue
        await tx.query(`UPDATE accounts SET ${col} = $2 WHERE id = $1`, [r.id, v2])
        n += 1
      }
    }
    const inst = await tx.one<{ mail: { password?: string | null } | null }>(
      'SELECT mail FROM installation WHERE id = 1 FOR UPDATE',
    )
    const pw = inst?.mail?.password
    if (pw?.startsWith('v1.')) {
      const v2 = again(pw, 'mail.password')
      if (v2) {
        await tx.query('UPDATE installation SET mail = $1 WHERE id = 1', [
          JSON.stringify({ ...inst?.mail, password: v2 }),
        ])
        n += 1
      }
    }
    const ms = await tx.one<{ k: string | null }>(
      'SELECT openai_key AS k FROM meaning_settings WHERE id = 1 FOR UPDATE',
    )
    if (ms?.k?.startsWith('v1.')) {
      const v2 = again(ms.k, 'meaning.openai')
      if (v2) {
        await tx.query('UPDATE meaning_settings SET openai_key = $1 WHERE id = 1', [v2])
        n += 1
      }
    }
    return n
  })
}
