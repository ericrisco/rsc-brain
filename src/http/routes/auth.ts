// Setting up, signing in and out, resetting a password and the second factor (spec B4). The routes that
// set the session cookie answer only to the Brain web itself (its header), never to a form on another
// site.

import { SESSION_COOKIE, WEB_SESSION_DAYS } from '../../auth/principal.ts'
import { AppError } from '../../core/errors.ts'
import { runSetup, setupState } from '../../domain/installation.ts'
import {
  adminResetLink,
  adminResetTotp,
  changePassword,
  confirmReset,
  confirmTotp,
  disableTotp,
  lookReset,
  requestReset,
  signIn,
  signOut,
  startTotp,
} from '../../domain/login.ts'
import { send } from '../../mail/mail.ts'
import { obj } from '../input.ts'
import { type Conn, type PublicReq, publicRoute, type Route, route, WEB_HEADER } from '../router.ts'
import { ctxOf } from './brains.ts'

export const cookie = (secret: string, conn: Conn) =>
  `${SESSION_COOKIE}=${secret}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${WEB_SESSION_DAYS * 86_400}${conn.encrypted ? '; Secure' : ''}`
const clearCookie = (conn: Conn) =>
  `${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${conn.encrypted ? '; Secure' : ''}`

export function fromWeb(r: PublicReq): void {
  if (r.headers['x-requested-with'] !== WEB_HEADER) {
    throw new AppError(
      403,
      'csrf',
      'This request lacks the header of the rsc-brain web.',
      'Use the rsc-brain web to do this.',
    )
  }
}

export const authRoutes: Route[] = [
  publicRoute(
    'GET /v1/setup',
    async (r) => ({
      body: await setupState(r.db, r.conn, r.query.get('publicUrl') ?? undefined),
    }),
    { beforeSetup: true },
  ),
  publicRoute(
    'POST /v1/setup',
    async (r) => {
      fromWeb(r)
      const b = obj(r.body)
      const out = await runSetup(r.db, r.clock, r.conn, {
        name: b.name,
        publicUrl: b.publicUrl,
        admin: obj(b.admin ?? {}) as { name: unknown; email: unknown; password: unknown },
      })
      return {
        status: 201,
        body: { done: true, publicUrl: out.publicUrl, warning: out.warning, adminId: out.adminId },
        headers: { 'set-cookie': cookie(out.session, r.conn) },
      }
    },
    { beforeSetup: true },
  ),
  publicRoute('POST /v1/auth/login', async (r) => {
    fromWeb(r)
    const b = obj(r.body)
    const s = await signIn(r.db, r.clock, r.conn, r.secret, {
      email: b.email,
      password: b.password,
      code: b.code,
    })
    return { body: { account: s.account }, headers: { 'set-cookie': cookie(s.session, r.conn) } }
  }),
  route('POST /v1/auth/logout', async (r) => {
    await signOut(ctxOf(r), false)
    return { body: { signedOut: true }, headers: { 'set-cookie': clearCookie(r.conn) } }
  }),
  route('POST /v1/auth/logout-everywhere', async (r) => {
    const n = await signOut(ctxOf(r), true)
    return { body: { signedOut: n }, headers: { 'set-cookie': clearCookie(r.conn) } }
  }),
  publicRoute('POST /v1/auth/reset', async (r) => {
    await requestReset(r.db, r.clock, r.conn, obj(r.body).email, async (to, link) => {
      await send(r.db, r.clock, r.mail, 'reset', {
        to,
        subject: 'Reset your rsc-brain password',
        text: [
          'Someone asked to reset the password of your rsc-brain account.',
          'Open this link to choose a new one. It works once, for 1 hour:',
          link,
          '',
          'If it was not you, ignore this mail: your password stays as it is.',
        ].join('\n'),
      })
    })
    return {
      status: 202,
      body: {
        message:
          'If that email has an account, a reset link is on its way. No mail? Ask an administrator for a link.',
      },
    }
  }),
  // The token travels in the body, never in the address (it would land in logs).
  publicRoute(
    'POST /v1/auth/reset/look',
    async (r) => ({ body: await lookReset(r.db, r.clock, obj(r.body).token) }),
    {
      maintenance: 'reads',
    },
  ),
  publicRoute('POST /v1/auth/reset/confirm', async (r) => {
    const b = obj(r.body)
    await confirmReset(r.db, r.clock, r.conn, { token: b.token, password: b.password })
    return { body: { reset: true } }
  }),
  // G6: a new password from the profile; nothing to say back.
  route('POST /v1/me/password', async (r) => {
    const b = obj(r.body)
    await changePassword(ctxOf(r), r.conn, r.secret, { current: b.current, next: b.next, code: b.code })
    return { status: 204, body: null }
  }),
  route('POST /v1/me/totp', async (r) => ({
    body: await startTotp(ctxOf(r), r.secret, (r.body as { code?: unknown } | undefined)?.code),
  })),
  route('POST /v1/me/totp/confirm', async (r) => ({
    body: await confirmTotp(ctxOf(r), r.secret, obj(r.body).code),
  })),
  route('DELETE /v1/me/totp', async (r) => ({
    body: await disableTotp(ctxOf(r), r.secret, obj(r.body).code),
  })),
  route('POST /v1/admin/accounts/:id/reset-link', async (r) => ({
    status: 201,
    body: await adminResetLink(ctxOf(r), r.params.id as string),
  })),
  route('DELETE /v1/admin/accounts/:id/totp', async (r) => ({
    body: await adminResetTotp(ctxOf(r), r.params.id as string),
  })),
]
