// When the daily copy runs (spec B7 C2; plan §3.3): at HH:MM of the installation's time zone
// (RSC_BRAIN_BACKUP_AT, default 03:00; RSC_BRAIN_TIMEZONE), in `serve`, one process. A check that comes late
// (the machine slept) makes one copy, not one per missed day.
import type { Clock } from '../../core/clock.ts'

export const DEFAULT_BACKUP_AT = '03:00'
export const DEFAULT_BACKUP_KEEP = 14

export function parseBackupAt(v: string): string {
  if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(v))
    throw new Error(`RSC_BRAIN_BACKUP_AT must be HH:MM (24-hour), for example 03:00; got "${v}".`)
  return v
}

// How far the wall clock of `tz` is ahead of UTC at this instant, in milliseconds.
function offsetMs(tz: string, at: Date): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).formatToParts(at)
  const get = (type: string) => Number(parts.find((p) => p.type === type)?.value)
  const wall = Date.UTC(get('year'), get('month') - 1, get('day'), get('hour'), get('minute'), get('second'))
  return wall - (at.getTime() - at.getUTCMilliseconds())
}

function localDay(tz: string, at: Date): { y: number; m: number; d: number } {
  const local = new Date(at.getTime() + offsetMs(tz, at))
  return { y: local.getUTCFullYear(), m: local.getUTCMonth(), d: local.getUTCDate() }
}

// The instant the wall clock of `tz` shows y-m-d h:mi (twice round, for the days the clocks change).
function instantOf(tz: string, y: number, m: number, d: number, h: number, mi: number): Date {
  const wall = Date.UTC(y, m, d, h, mi)
  let t = wall - offsetMs(tz, new Date(wall))
  t = wall - offsetMs(tz, new Date(t))
  return new Date(t)
}

// The next time HH:MM comes in `tz`, strictly after `now`.
export function nextRun(at: string, tz: string, now: Date): Date {
  const [h, mi] = parseBackupAt(at).split(':').map(Number) as [number, number]
  const { y, m, d } = localDay(tz, now)
  for (let i = 0; i < 3; i += 1) {
    const t = instantOf(tz, y, m, d + i, h, mi)
    if (t.getTime() > now.getTime()) return t
  }
  // Unreachable: two days on there is always a later one.
  return instantOf(tz, y, m, d + 3, h, mi)
}

export type Scheduler = { next(): Date; check(): Promise<boolean> }

// `check` is called often (every minute in `serve`); it runs the copy when its moment has come, and says so.
// The next moment is fixed before the copy runs, so a copy that fails does not run again until the next day.
// With `lastScheduledAt` (the newest scheduled copy in the folder, null for none): a process that starts more than
// a day after it makes one copy at once, then keeps the daily time; not when that time is within the hour anyway.
// A run that answers 'busy' (another copy was running) is tried again every 2 minutes, for 30 minutes at most,
// before the next daily time is taken.
const DAY_MS = 24 * 3600_000
const HOUR_MS = 3600_000
const RETRY_MS = 2 * 60_000
const RETRY_FOR_MS = 30 * 60_000
export function createScheduler(o: {
  at: string
  tz: string
  clock: Clock
  run: () => Promise<unknown> // 'busy' when another copy was running
  lastScheduledAt?: Date | null
}): Scheduler {
  const start = o.clock()
  let next = nextRun(o.at, o.tz, start)
  if (o.lastScheduledAt !== undefined) {
    const stale = o.lastScheduledAt === null || start.getTime() - o.lastScheduledAt.getTime() > DAY_MS
    if (stale && next.getTime() - start.getTime() > HOUR_MS) next = start
  }
  let retryUntil: number | null = null
  return {
    next: () => next,
    async check() {
      const now = o.clock()
      if (now.getTime() < next.getTime()) return false
      if (retryUntil === null) retryUntil = now.getTime() + RETRY_FOR_MS
      next = nextRun(o.at, o.tz, now)
      try {
        const r = await o.run()
        if (r === 'busy' && now.getTime() + RETRY_MS <= retryUntil) {
          next = new Date(now.getTime() + RETRY_MS)
          return true
        }
      } catch (err) {
        retryUntil = null
        throw err
      }
      retryUntil = null
      return true
    },
  }
}
