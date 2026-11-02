// Maintenance (spec B7 «Actualizar», C12; plan §3.1): while an update or a restore runs, rsc-brain refuses
// every write and keeps serving reads, without writing their trail, so nothing accepted during it can be
// lost if the update is rolled back. One row of the installation says until when and why; it ends on its
// own after 30 minutes at most, so a command that died halfway never leaves the installation without
// writes. The HTTP side (which requests are writes, the 503) is src/http/maintenance.ts.
import type { Clock } from '../core/clock.ts'
import { invalid } from '../core/errors.ts'
import type { Db } from '../db/db.ts'

export const MAINTENANCE_MAX_SECONDS = 1800
export const MAINTENANCE_MIN_SECONDS = 60
export const REASONS = ['update', 'restore', 'manual'] as const
export type MaintenanceReason = (typeof REASONS)[number]
export type Maintenance = { until: Date; reason: MaintenanceReason }

// What the row says, read against `now`: a maintenance whose moment has passed is none.
export function activeAt(
  row: { maintenance_until?: unknown; maintenance_reason?: unknown } | undefined,
  now: Date,
): Maintenance | null {
  const until = row?.maintenance_until
  if (!(until instanceof Date) || until.getTime() <= now.getTime()) return null
  return { until, reason: (row?.maintenance_reason ?? 'manual') as MaintenanceReason }
}

async function on(
  db: Db,
  now: Date,
  o: { seconds?: number; reason: MaintenanceReason },
): Promise<{ until: Date }> {
  const seconds = o.seconds ?? MAINTENANCE_MAX_SECONDS
  if (!Number.isInteger(seconds) || seconds < MAINTENANCE_MIN_SECONDS || seconds > MAINTENANCE_MAX_SECONDS) {
    throw invalid(
      `A maintenance lasts ${MAINTENANCE_MIN_SECONDS} to ${MAINTENANCE_MAX_SECONDS} seconds.`,
      `Pass --seconds between ${MAINTENANCE_MIN_SECONDS} and ${MAINTENANCE_MAX_SECONDS}.`,
    )
  }
  if (!REASONS.includes(o.reason)) {
    throw invalid(`The reason is one of ${REASONS.join(', ')}.`, 'Pass --reason update, restore or manual.')
  }
  const until = new Date(now.getTime() + seconds * 1000)
  await db.query('UPDATE installation SET maintenance_until = $1, maintenance_reason = $2 WHERE id = 1', [
    until,
    o.reason,
  ])
  return { until }
}

async function off(db: Db): Promise<void> {
  await db.query('UPDATE installation SET maintenance_until = NULL, maintenance_reason = NULL WHERE id = 1')
}

async function current(db: Db, now: Date): Promise<Maintenance | null> {
  return activeAt(
    await db.one('SELECT maintenance_until, maintenance_reason FROM installation WHERE id = 1'),
    now,
  )
}

// The last maintenance set and not turned off, even if it expired: the status command says it expired.
async function last(db: Db): Promise<Maintenance | null> {
  const r = await db.one('SELECT maintenance_until, maintenance_reason FROM installation WHERE id = 1')
  return r?.maintenance_until instanceof Date
    ? { until: r.maintenance_until, reason: String(r.maintenance_reason ?? 'manual') as MaintenanceReason }
    : null
}

export const maintenance = { on, off, current, last }

// The sweeps of `serve` (closing idle sessions, folding the trail, reminders, meaning in batches) write;
// during maintenance they wait for the next round.
export async function whenOpen(db: Db, clock: Clock, fn: () => Promise<unknown>): Promise<void> {
  if (await current(db, clock())) return
  await fn()
}
