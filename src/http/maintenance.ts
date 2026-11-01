// The maintenance gate (spec B7 C12, plan §3.1 and risk 1): which requests are writes, and the refusal they
// get while maintenance lasts. A write is every request other than GET or HEAD, unless its route says it
// changes nothing (`maintenance: 'reads'`) or applies the gate itself (`'own'`: the MCP endpoint, per tool).
// So a new route is a write until someone decides otherwise; test/http/maintenance-gate.test.ts pins the
// exceptions.
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

export const isWrite = (r: { method: string; maintenance?: 'reads' | 'own' }): boolean =>
  r.method !== 'GET' && r.method !== 'HEAD' && r.maintenance === undefined

export function underMaintenance(m: Maintenance, now: Date): AppError {
  const seconds = retryAfter(m, now)
  const e = new AppError(
    503,
    'under_maintenance',
    MAINTENANCE_MESSAGE(seconds),
    'Send it again after that time; reading keeps working meanwhile.',
  )
  e.headers = { 'retry-after': String(seconds) }
  e.extra = { retryAfter: seconds }
  e.outer = { retryAfter: seconds }
  return e
}
