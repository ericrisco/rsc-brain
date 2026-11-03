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
import { AppError } from '../core/errors.ts'
import type { Db } from '../db/db.ts'
import { setupDone } from './installation.ts'

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
