// The name and logo of the installation (spec B6 «Admin › Branding», plan §3.5 G1–G3). Reading them is
// public and answered before the first-time setup: the sign-in page, an invitation and the setup itself
// show them before anyone has a key. They describe the installation and hold no data of any brain.
// Changing the logo is the administration's.
import { AppError } from '../../core/errors.ts'
import { LOGO_MAX_BODY, logoBytes, logoRef, removeLogo, setLogo } from '../../domain/branding.ts'
import { installation, setupDone } from '../../domain/installation.ts'
import { mailConfigured } from '../../mail/mail.ts'
import { obj } from '../input.ts'
import { publicRoute, type Route, route } from '../router.ts'
import { ctxOf } from './brains.ts'

// If-None-Match as caches send it: a list, weak (W/) or strong, or "*".
export function etagMatches(header: string | undefined, sha: string): boolean {
  if (!header) return false
  return header.split(',').some((t) => {
    const v = t.trim().replace(/^W\//, '')
    return v === '*' || v === `"${sha}"`
  })
}

export const brandingRoutes: Route[] = [
  publicRoute(
    'GET /v1/branding',
    async (r) => {
      const [i, done, mail, logo] = await Promise.all([
        installation(r.db),
        setupDone(r.db),
        mailConfigured(r.db),
        logoRef(r.db),
      ])
      // Whether it can send email lets the reset page say to ask an administrator instead of promising a
      // link; it says nothing about any account.
      return { body: { name: i.name, logo, setupRequired: !done, canSendMail: mail } }
    },
    { beforeSetup: true },
  ),
  publicRoute(
    'GET /v1/branding/logo',
    async (r) => {
      const logo = await logoBytes(r.db)
      if (!logo) {
        throw new AppError(
          404,
          'no_logo',
          'This installation has no logo.',
          'The administration can add one in Admin › Branding; until then the web shows the RSC mark.',
        )
      }
      const etag = `"${logo.sha256}"`
      // Only ever an image: its own type, never sniffed, and sandboxed if opened as a page.
      const headers = {
        'content-type': logo.type,
        'x-content-type-options': 'nosniff',
        'content-security-policy': "default-src 'none'; sandbox",
        'cross-origin-resource-policy': 'same-origin',
        'content-disposition': 'inline; filename="logo"',
        'cache-control': 'no-cache',
        etag,
      }
      if (etagMatches(r.headers['if-none-match'], logo.sha256)) return { status: 304, body: null, headers }
      return { body: logo.bytes, headers }
    },
    { beforeSetup: true },
  ),
  {
    ...route('PUT /v1/admin/branding/logo', async (r) => {
      const b = obj(r.body)
      return { body: await setLogo(ctxOf(r), { contentType: b.contentType, data: b.data }) }
    }),
    maxBody: LOGO_MAX_BODY,
    admin: true,
  },
  route('DELETE /v1/admin/branding/logo', async (r) => ({ body: await removeLogo(ctxOf(r)) })),
]
