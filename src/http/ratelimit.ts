// The rate limit per key (spec B5 «Errores, límites y recibos»): at most N requests in any 60 seconds
// for one credential, counted in the memory of this process (one installation is one process). The
// window slides: each key keeps the times of its accepted requests within the last minute. A refused
// request is not counted, so a client that keeps knocking gets in as soon as the minute has passed.
import type { Clock } from '../core/clock.ts'
import { AppError } from '../core/errors.ts'

const WINDOW_MS = 60_000

export type RateLimiter = { take(credentialId: string, limit: number): void }

export function rateLimited(limit: number, retryAfter: number): AppError {
  const e = new AppError(
    429,
    'rate_limited',
    `This key made more than ${limit} requests per minute.`,
    `Wait ${retryAfter} seconds and retry; spread the requests out, or ask the administration to raise the limit.`,
  )
  e.headers = { 'retry-after': String(retryAfter) }
  e.extra = { retryAfter }
  return e
}

export function rateLimiter(clock: Clock): RateLimiter {
  const seen = new Map<string, number[]>()
  let calls = 0
  // Keys that made no request for a minute are forgotten, so the map does not grow with old keys.
  const sweep = (now: number) => {
    for (const [id, times] of seen) if ((times.at(-1) ?? 0) <= now - WINDOW_MS) seen.delete(id)
  }
  return {
    take(credentialId, limit) {
      const now = clock().getTime()
      calls += 1
      if (calls % 1000 === 0) sweep(now)
      const times = seen.get(credentialId) ?? []
      let old = 0
      while (old < times.length && (times[old] as number) <= now - WINDOW_MS) old += 1
      if (old > 0) times.splice(0, old)
      if (times.length >= limit) {
        // The request that frees a place is the one `limit` places back from the newest.
        const frees = times[times.length - limit] as number
        throw rateLimited(limit, Math.max(1, Math.ceil((frees + WINDOW_MS - now) / 1000)))
      }
      times.push(now)
      seen.set(credentialId, times)
    },
  }
}
