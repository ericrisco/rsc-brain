// The name of the client behind a key: the web for a person's web session (never its browser's user
// agent), else the agent of a short key, the app of a connection, or the program that used a token. It is
// kept with each session and entry when written (review of PR20), so what the journal and the overview
// show does not change when the same key is later used by another program.
import type { Principal } from '../auth/principal.ts'
import type { Db } from '../db/db.ts'
import { redact } from '../privacy/redact.ts'

// Only a web session is "web": a key whose agent or program merely says "web" is named by the key itself.
// The name is redacted like everything stored (an agent name may carry a pasted secret).
const notWeb = (v: unknown): string | null =>
  typeof v === 'string' && v.trim() && v.trim().toLowerCase() !== 'web' ? v : null

export function clientOfKey(k: {
  kind: string
  agent: unknown
  clientName: unknown
  program: unknown
  name?: unknown
}): string | null {
  if (k.kind === 'web') return 'web'
  for (const v of [k.agent, k.clientName, k.program, k.name]) {
    const ok = notWeb(v)
    if (ok) return redact(ok).text.slice(0, 200)
  }
  return null
}

// The same in SQL, over a credential `c` and its connection `g` (what was written before it was kept).
export const CLIENT_SQL = `CASE WHEN c.kind = 'web' THEN 'web'
  ELSE coalesce(${['c.agent', 'g.client_name', 'c.last_client', 'c.name']
    .map((x) => `CASE WHEN lower(btrim(${x})) IN ('', 'web') THEN NULL ELSE ${x} END`)
    .join(', ')}) END`

// The client writing now with a key: the caller's own (named from this request), or that of another key
// it writes for (a service opening the session of one of its short keys).
export async function clientNow(db: Db, who: Principal, credentialId: string = who.credential.id) {
  if (credentialId === who.credential.id && who.client !== undefined) return who.client
  const r = await db.one<{ client: string | null }>(
    `SELECT ${CLIENT_SQL} AS client FROM credentials c LEFT JOIN oauth_grants g ON g.id = c.grant_id
      WHERE c.id = $1`,
    [credentialId],
  )
  return r?.client ?? null
}
