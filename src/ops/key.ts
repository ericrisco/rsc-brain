// The installation key (spec B7 «La llave de la instalación»; plan §3.3, §3.4): RSC_BRAIN_SECRET seals what the
// server must read back (second-factor seeds, the mail password, the key of the meaning provider) and keys the
// fingerprint of where meaning search sends text. Restoring a copy into another installation, and rotating the key,
// seal all of it again from one key to another, in the caller's transaction.
import { type Purpose, seal, unseal } from '../auth/vault.ts'
import type { Db } from '../db/db.ts'
import { openai } from '../meaning/providers.ts'
import { destinationOf } from '../meaning/stored.ts'

export { keyId } from './backup/format.ts'

export type ResealCount = {
  // Opened with the old key and sealed with the new one.
  resealed: number
  // Already sealed with the new key (a rotation run again after it stopped halfway).
  already: number
  // Opened with neither: left as they are (they did not open before either; the screens say so).
  notResealed: number
}

// Every sealed value, from `from` to `to`, and the fingerprint of the meaning provider's destination with it (the
// warning accepted for that key stays accepted: same provider, same key). The rows are locked until the caller's
// transaction ends.
export async function resealAll(tx: Db, from: string, to: string): Promise<ResealCount> {
  const n: ResealCount = { resealed: 0, already: 0, notResealed: 0 }
  const open = (secret: string, v: string, purpose: Purpose): string | null => {
    try {
      return unseal(secret, v, purpose)
    } catch {
      return null
    }
  }
  const again = (v: string, purpose: Purpose): string | null => {
    const plain = open(from, v, purpose)
    if (plain !== null) {
      n.resealed += 1
      return seal(to, plain, purpose)
    }
    if (open(to, v, purpose) !== null) n.already += 1
    else n.notResealed += 1
    return null
  }
  for (const col of ['totp_secret', 'totp_pending'] as const) {
    const rows = await tx.query<{ id: string; v: string }>(
      `SELECT id, ${col} AS v FROM accounts WHERE ${col} IS NOT NULL ORDER BY id FOR UPDATE`,
    )
    for (const r of rows) {
      const v = again(r.v, 'account.totp')
      if (v !== null) await tx.query(`UPDATE accounts SET ${col} = $2 WHERE id = $1`, [r.id, v])
    }
  }
  const inst = await tx.one<{ mail: { password?: string | null } | null }>(
    'SELECT mail FROM installation WHERE id = 1 FOR UPDATE',
  )
  const pw = inst?.mail?.password
  if (pw) {
    const v = again(pw, 'mail.password')
    if (v !== null)
      await tx.query('UPDATE installation SET mail = $1 WHERE id = 1', [
        JSON.stringify({ ...inst?.mail, password: v }),
      ])
  }
  const ms = await tx.one<{ k: string | null; destination: string | null }>(
    'SELECT openai_key AS k, destination FROM meaning_settings WHERE id = 1 FOR UPDATE',
  )
  if (ms?.k) {
    const plain = open(from, ms.k, 'meaning.openai')
    const v = again(ms.k, 'meaning.openai')
    if (v !== null) {
      // The destination was accepted for this key under the old fingerprint: the same destination under the new one.
      const p = plain === null ? null : openai(plain)
      const destination =
        p && ms.destination === destinationOf(p, from) ? destinationOf(p, to) : ms.destination
      await tx.query('UPDATE meaning_settings SET openai_key = $1, destination = $2 WHERE id = 1', [
        v,
        destination,
      ])
    }
  }
  return n
}
