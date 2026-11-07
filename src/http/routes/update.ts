// Updating from the web (rsc-updates B3; spec CA27, CA28): POST /v1/admin/update and /update/retry. Only the
// administration, only signed in to the web (a key, an app, a token or a service gets 403 web_only), and only after
// typing the password again (and the code, with a second factor): a wrong one counts as a failed attempt, is audited and
// leaves nothing. What the request says besides the password and the code is not read: the mark that is left is empty,
// and the updater decides the version itself. The service never touches Docker; see src/ops/updates.ts.
import { VERSION } from '../../core/version.ts'
import { audit } from '../../domain/audit.ts'
import { adminOnly } from '../../domain/guards.ts'
import { reauth } from '../../domain/login.ts'
import { releaseView } from '../../ops/releases.ts'
import { obj } from '../input.ts'
import { type Req, type Route, route } from '../router.ts'
import { ctxOf } from './brains.ts'

async function ask(r: Req, retry: boolean) {
  const ctx = ctxOf(r)
  adminOnly(ctx)
  const body = obj(r.body)
  // Only these two are read. Everything else in the body is ignored.
  await reauth(ctx, r.conn, r.secret, { password: body.password, code: body.code }, 'Updating rsc-brain')
  const view = releaseView(r.releases?.state() ?? null, VERSION)
  const no = r.updates.refusal(view, retry)
  if (no) throw no
  await r.updates.mark(retry)
  await audit(r.db, {
    at: r.clock(),
    actorId: r.who.accountId,
    credentialId: r.who.credential.id,
    action: retry ? 'update.retry' : 'update.request',
    outcome: 'ok',
    detail: `to ${view.latest}`,
  })
  return { status: 202, body: { requested: true, to: view.latest } }
}

export const updateRoutes: Route[] = [
  route('POST /v1/admin/update', (r) => ask(r, false)),
  route('POST /v1/admin/update/retry', (r) => ask(r, true)),
]
