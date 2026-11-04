// Companion mode (plan F1 §3.1, spec F1 C24): rsc-factory's installer leaves rsc-brain installed but not set up, with
// a one-time key both keep (RSC_BRAIN_COMPANION_TOKEN). While it waits, the setup of the web says to finish in
// rsc-factory. rsc-factory's own setup then calls POST /v1/setup/companion with that key, from the network the two
// share, and gets the main key of its service account. The handshake answers only:
// - while the installation is not set up (the setup's own transaction makes a second call fail, so two at once make
//   one administration);
// - straight from the shared network: never through a proxy, never from the network's gateway (this machine), never
//   from elsewhere; anywhere else the route is not there;
// - with the key, compared in constant time.
import { createHash, timingSafeEqual } from 'node:crypto'
import type { Clock } from '../core/clock.ts'
import { AppError, denied } from '../core/errors.ts'
import type { Db } from '../db/db.ts'
import { createAccount } from './accounts.ts'
import { audit } from './audit.ts'
import { COMPANION_SERVICE, type ConnFacts, markCompanionService, setupDone } from './installation.ts'
import { mintMainKey } from './keys.ts'
import { checkCredentials } from './login.ts'

// The address of an IPv4 dotted quad as a number, or null.
export function ipv4(s: string): number | null {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(s)
  if (!m) return null
  const parts = m.slice(1).map(Number)
  if (parts.some((p) => p > 255)) return null
  return parts.reduce((n, p) => n * 256 + p, 0)
}

// An IPv4 network in CIDR form, as its first address and the length of its prefix; null if it is not one. A prefix
// shorter than 8 would take in a good part of the internet: not a container network.
export function cidrOf(s: string): { base: number; bits: number } | null {
  const m = /^([\d.]+)\/(\d{1,2})$/.exec(s)
  if (!m) return null
  const base = ipv4(m[1] as string)
  const bits = Number(m[2])
  if (base === null || bits < 8 || bits > 30) return null
  return { base, bits }
}

export function inNetwork(ip: string, cidr: string): boolean {
  const n = ipv4(ip)
  const c = cidrOf(cidr)
  if (n === null || c === null) return false
  const size = 2 ** (32 - c.bits)
  return Math.floor(n / size) === Math.floor(c.base / size)
}

const plain = (ip: string) => (ip.startsWith('::ffff:') ? ip.slice(7) : ip)

// Straight from the shared network: inside it, and neither its gateway (where this machine's own requests come from)
// nor a proxy (whatever a proxy relays comes from elsewhere).
export function fromSharedNetwork(
  remote: string,
  net: { network: string; gateway: string | null },
  proxies: string[],
): boolean {
  const ip = plain(remote)
  if (net.gateway !== null && ip === net.gateway) return false
  if (proxies.map(plain).includes(ip)) return false
  return inNetwork(ip, net.network)
}

// The key of an `Authorization: Bearer <key>` header against the one kept, in constant time whatever the lengths.
export function sameKey(header: string | undefined, token: string): boolean {
  const m = /^Bearer (\S+)$/.exec(header ?? '')
  if (!m) return false
  const digest = (s: string) => createHash('sha256').update(s).digest()
  return timingSafeEqual(digest(m[1] as string), digest(token))
}

export const companionPending = (factoryUrl: string) => {
  const e = new AppError(
    409,
    'companion_pending',
    'Finish the setup in rsc-factory.',
    `rsc-brain was installed with rsc-factory: open rsc-factory at ${factoryUrl} and finish its first-time setup. rsc-brain is set up with the same administration.`,
  )
  e.extra = { factoryUrl }
  return e
}

// The setup of the web, while rsc-factory is to set rsc-brain up: refused, with where to finish.
export async function refuseWhileCompanion(db: Db, c: { factoryUrl: string } | null): Promise<void> {
  if (c && !(await setupDone(db))) throw companionPending(c.factoryUrl)
}

// After the setup (spec F1 C24 «Finish connecting rsc-brain»): rsc-factory lost its main key (an answer that never
// arrived, a restore that killed every key). With the one-time key it already holds and an administrator's email and
// password (the brake of signing in, shared with it), it gets a new main key for the service account the first
// handshake made (never another); the ones before, and what hangs from them, stop working. If an administrator removed
// that account, nothing is made: 409 service_removed. Audited either way.
export async function companionReconnect(
  db: Db,
  clock: Clock,
  conn: ConnFacts,
  secret: string | undefined,
  input: { email: unknown; password: unknown; code?: unknown },
): Promise<{ serviceKey: string; serviceId: string; adminId: string }> {
  const who = await checkCredentials(db, clock, conn, secret, input)
  if (!who.isAdmin) {
    await audit(db, {
      at: clock(),
      actorId: who.id,
      credentialId: null,
      action: 'installation.companion.reconnect',
      outcome: 'denied',
      detail: `not an administrator, from ${conn.ip}`,
    })
    throw denied(
      'Only an administrator of rsc-brain can reconnect rsc-factory.',
      'Use the email and password of an administrator of rsc-brain.',
    )
  }
  const out = await db.tx(
    async (tx): Promise<{ removed: string } | { serviceKey: string; serviceId: string; adminId: string }> => {
      // One reconnect at a time: the row of the installation is the lock.
      await tx.query('SELECT 1 FROM installation WHERE id = 1 FOR UPDATE')
      // The account the first handshake made (whatever its name now); none only when rsc-brain was set up without the
      // handshake (the command line), and then it is made here, once.
      const marked = await tx.one<{ id: string; status: string | null }>(
        `SELECT m.target AS id, a.status FROM audit m LEFT JOIN accounts a ON a.id = m.target
        WHERE m.action = $1 ORDER BY m.id DESC LIMIT 1`,
        [COMPANION_SERVICE],
      )
      // Removed by an administrator (accounts are never deleted, so a missing one counts the same): not made again. Said
      // after the transaction, so its audit row is kept.
      if (marked && marked.status !== 'active') return { removed: marked.id }
      let serviceId = marked?.id ?? ''
      if (!marked) {
        serviceId = await createAccount(tx, clock, {
          kind: 'service',
          name: 'rsc-factory',
          canCreateBrains: true,
          canInvite: true,
        })
        await markCompanionService(tx, clock(), serviceId)
      }
      const now = clock()
      await tx.query(
        `UPDATE credentials SET revoked_at = $2
        WHERE revoked_at IS NULL AND ((account_id = $1 AND kind = 'main')
           OR parent_id IN (SELECT id FROM credentials WHERE account_id = $1 AND kind = 'main'))`,
        [serviceId, now],
      )
      const key = await mintMainKey(tx, clock, { accountId: serviceId, name: 'main' })
      await audit(tx, {
        at: now,
        actorId: who.id,
        credentialId: null,
        action: 'installation.companion.reconnect',
        outcome: 'ok',
        target: serviceId,
        detail: `${marked ? 'new main key for' : 'made'} ${serviceId}, from ${conn.ip}`,
      })
      return { serviceKey: key.secret, serviceId, adminId: who.id }
    },
  )
  if ('removed' in out) {
    await audit(db, {
      at: clock(),
      actorId: who.id,
      credentialId: null,
      action: 'installation.companion.reconnect',
      target: out.removed,
      outcome: 'denied',
      detail: `service removed, from ${conn.ip}`,
    })
    throw new AppError(
      409,
      'service_removed',
      'An administrator removed the rsc-factory account in rsc-brain.',
      'Reactivate it there first (Admin › People), then finish connecting again.',
    )
  }
  return out
}
