// POST /v1/setup/companion (plan F1 §3.1, T047): rsc-factory sets up the rsc-brain its installer left waiting, with the
// one-time key, and gets the main key of its service account. Where the handshake must not answer (no companion mode,
// through a proxy, from outside the shared network) the route is not there: the same 404 as an unknown address.
import { AppError } from '../../core/errors.ts'
import { audit } from '../../domain/audit.ts'
import { fromSharedNetwork, sameKey } from '../../domain/companion.ts'
import { companionSetup, setupDone, setupGone } from '../../domain/installation.ts'
import { obj } from '../input.ts'
import { publicRoute, type Route } from '../router.ts'

const PATH = 'POST /v1/setup/companion'
const notThere = () => new AppError(404, 'no_such_route', `Nothing at ${PATH}.`, 'Check the method and path.')

export const companionRoutes: Route[] = [
  publicRoute(
    PATH,
    async (r) => {
      const c = r.companion
      const h = r.headers
      const proxied =
        h['x-forwarded-for'] !== undefined ||
        h['x-forwarded-proto'] !== undefined ||
        h.forwarded !== undefined
      if (!c || proxied || !fromSharedNetwork(r.conn.ip, c, c.proxies)) throw notThere()
      // Once set up, the key serves nothing (whoever asks).
      if (await setupDone(r.db)) throw setupGone()
      if (!sameKey(h.authorization, c.token)) {
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
]
