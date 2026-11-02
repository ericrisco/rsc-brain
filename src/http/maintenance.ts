// The maintenance gate (spec B7 C12, plan §3.1 and risk 1): which requests are writes, and the refusal they
// get while maintenance lasts. A write is every request other than GET or HEAD, unless its route says it
// changes nothing (`maintenance: 'reads'`) or applies the gate itself (`'own'`: the MCP endpoint per tool, the
// sign-in forms with a page); and a GET that writes is marked `'writes'` (the audit export records itself). So a
// new route is a write until someone decides otherwise; test/http/maintenance-gate.test.ts pins the exceptions
// and checks, table by table, that no other GET writes.
import { AppError } from '../core/errors.ts'
import type { Maintenance } from '../domain/maintenance.ts'

export {
  MAINTENANCE_MAX_SECONDS,
  MAINTENANCE_MIN_SECONDS,
  type Maintenance,
  maintenance,
  whenOpen,
} from '../domain/maintenance.ts'

export const MAINTENANCE_MESSAGE = (seconds: number) =>
  `rsc-brain is under maintenance, retry after ${seconds} seconds`

// What is left of it, said in whole seconds: at most two minutes (a client comes back to check), at least 5.
export const retryAfter = (m: Maintenance, now: Date): number =>
  Math.max(5, Math.min(120, Math.ceil((m.until.getTime() - now.getTime()) / 1000)))

export const isWrite = (r: { method: string; maintenance?: 'reads' | 'own' | 'writes' }): boolean =>
  r.maintenance === 'writes' || (r.method !== 'GET' && r.method !== 'HEAD' && r.maintenance === undefined)

// What ends someone's access: refused too, since rolling the update back would silently undo it (CA7b). Their
// refusal names the way out for whoever cannot wait.
export const ENDS_ACCESS = new Set([
  'POST /v1/auth/logout',
  'POST /v1/auth/logout-everywhere',
  'DELETE /v1/keys/:id',
  'DELETE /v1/me/tokens/:id',
  'POST /v1/me/revoke-all',
  'DELETE /v1/me/apps/:id',
  'DELETE /v1/admin/apps/:id',
  'POST /v1/admin/accounts/:id/remove',
  // Taking someone out of a brain; changing an account (it can take the administration away).
  'DELETE /v1/brains/:slug/members/:account',
  'PATCH /v1/admin/accounts/:id',
])

export function underMaintenance(m: Maintenance, now: Date, endsAccess = false): AppError {
  const seconds = retryAfter(m, now)
  const e = new AppError(
    503,
    'under_maintenance',
    MAINTENANCE_MESSAGE(seconds),
    endsAccess
      ? 'Send it again after that time. An admin can end maintenance with `rsc-brain maintenance off`.'
      : 'Send it again after that time; reading keeps working meanwhile.',
  )
  e.headers = { 'retry-after': String(seconds) }
  e.extra = { retryAfter: seconds }
  e.outer = { retryAfter: seconds }
  return e
}
