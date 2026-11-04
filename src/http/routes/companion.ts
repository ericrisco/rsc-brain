// Companion mode (plan F1 §3.1, T047): rsc-factory sets up the rsc-brain its installer left waiting, with the one-time
// key, and gets the main key of its service account (POST /v1/setup/companion). Afterwards, when that key is lost (an
// answer that never arrived, a restore), it gets a new one with the same one-time key and an administrator's email and
// password (POST /v1/setup/companion/reconnect, spec F1 C24 «Finish connecting rsc-brain»). Where the handshake must
// not answer (no companion mode, through a proxy, from outside the shared network) the routes are not there: the same
// 404 as an unknown address.
import { AppError } from '../../core/errors.ts'
import { audit } from '../../domain/audit.ts'
import { companionPending, companionReconnect, fromSharedNetwork, sameKey } from '../../domain/companion.ts'
import { companionSetup, setupDone, setupGone } from '../../domain/installation.ts'
import { obj } from '../input.ts'
import { type PublicReq, publicRoute, type Route } from '../router.ts'

const PATH = 'POST /v1/setup/companion'
const RECONNECT = 'POST /v1/setup/companion/reconnect'

// Only in companion mode, straight from the shared network: anywhere else the route is not there.
function sharedOnly(r: PublicReq, path: string) {
  const c = r.companion
  const h = r.headers
  const proxied =
    h['x-forwarded-for'] !== undefined || h['x-forwarded-proto'] !== undefined || h.forwarded !== undefined
  if (!c || proxied || !fromSharedNetwork(r.conn.ip, c, c.proxies)) {
    throw new AppError(404, 'no_such_route', `Nothing at ${path}.`, 'Check the method and path.')
  }
  return c
}

// The one-time key, or 401; each wrong one audited (never the key).
async function keyed(r: PublicReq, token: string): Promise<void> {
  if (sameKey(r.headers.authorization, token)) return
  await audit(r.db, {
    at: r.clock(),
    actorId: null,
    credentialId: null,
    action: 'installation.companion',
    outcome: 'denied',
    detail: `wrong key from ${r.conn.ip}`,
  })
  throw new AppError(
    401,
    'unauthorized',
    'The key of the companion setup is missing or wrong.',
    'Send Authorization: Bearer <companionToken>, the key rsc-brain.sh install --companion --json gave.',
  )
}

export const companionRoutes: Route[] = [
  publicRoute(
    PATH,
    async (r) => {
      const c = sharedOnly(r, PATH)
      // Once set up, the key serves nothing here (whoever asks): reconnecting is the other route.
      if (await setupDone(r.db)) throw setupGone()
      await keyed(r, c.token)
      const b = obj(r.body)
      const out = await companionSetup(r.db, r.clock, {
        name: b.name ?? 'rsc-brain',
        publicUrl: b.publicUrl ?? c.publicUrl ?? undefined,
        admin: obj(b.admin ?? {}) as { name: unknown; email: unknown; password: unknown },
        serviceName: typeof b.serviceName === 'string' ? b.serviceName : 'rsc-factory',
        factoryUrl: b.factoryUrl ?? c.factoryUrl,
        ip: r.conn.ip,
      })
      return {
        status: 201,
        body: { serviceKey: out.serviceKey, serviceId: out.serviceId, adminId: out.adminId },
      }
    },
    { beforeSetup: true },
  ),
  publicRoute(
    RECONNECT,
    async (r) => {
      const c = sharedOnly(r, RECONNECT)
      if (!(await setupDone(r.db))) throw companionPending(c.factoryUrl)
      await keyed(r, c.token)
      const b = obj(r.body)
      const out = await companionReconnect(r.db, r.clock, r.conn, r.secret, {
        email: b.email,
        password: b.password,
        code: b.code,
      })
      return { status: 201, body: out }
    },
    { beforeSetup: true },
  ),
]
