// The name and logo of the installation (spec B6 «Admin › Branding», plan §3.5 G1 and G2). Public and
// answered before the first-time setup: the sign-in page, an invitation and the setup itself show them
// before anyone has a key. They describe the installation and hold no data of any brain.
import { AppError } from '../../core/errors.ts'
import { installation, setupDone } from '../../domain/installation.ts'
import { publicRoute, type Route } from '../router.ts'

export const brandingRoutes: Route[] = [
  publicRoute(
    'GET /v1/branding',
    async (r) => {
      const [i, done] = await Promise.all([installation(r.db), setupDone(r.db)])
      // The logo is uploaded through G3 (plan T045); until then an installation has none.
      return { body: { name: i.name, logo: null, setupRequired: !done } }
    },
    { beforeSetup: true },
  ),
  publicRoute(
    'GET /v1/branding/logo',
    async () => {
      throw new AppError(
        404,
        'no_logo',
        'This installation has no logo.',
        'The administration can add one in Admin › Branding; until then the web shows the RSC mark.',
      )
    },
    { beforeSetup: true },
  ),
]
