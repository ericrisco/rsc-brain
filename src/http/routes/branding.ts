// The name and logo of the installation (spec B6 «Admin › Branding», plan §3.5 G1 and G2). Public and
// answered before the first-time setup: the sign-in page, an invitation and the setup itself show them
// before anyone has a key. They describe the installation and hold no data of any brain.
import { AppError } from '../../core/errors.ts'
import { installation, setupDone } from '../../domain/installation.ts'
import { mailConfigured } from '../../mail/mail.ts'
import { publicRoute, type Route } from '../router.ts'

export const brandingRoutes: Route[] = [
  publicRoute(
    'GET /v1/branding',
    async (r) => {
      const [i, done, mail] = await Promise.all([installation(r.db), setupDone(r.db), mailConfigured(r.db)])
      // The logo is uploaded through G3 (plan T045); until then an installation has none. Whether it can
      // send email lets the reset page say to ask an administrator instead of promising a link; it says
      // nothing about any account.
      return { body: { name: i.name, logo: null, setupRequired: !done, canSendMail: mail } }
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
