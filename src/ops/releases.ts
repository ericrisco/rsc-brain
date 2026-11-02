// Whether a newer release of rsc-brain exists (spec B7 «Actualizar», C18; plan §3.10). One request a day to the
// public list of releases, with `User-Agent: rsc-brain/<version>` and nothing else: no query, no body, no cookie,
// nothing about the installation. RSC_BRAIN_RELEASES_URL replaces the list; empty, nothing is ever asked. What it
// learns stays in this process's memory: the newest release, its notes and when it was checked. A failure keeps
// what it knew and never throws (the web says when it last checked).
import { request as httpRequest } from 'node:http'
import { request as httpsRequest } from 'node:https'
import type { Clock } from '../core/clock.ts'

export const DEFAULT_RELEASES_URL = 'https://api.github.com/repos/ericrisco/rsc-brain/releases'
const DAY_MS = 24 * 3600_000
// After a failed check: again in 15 minutes, doubling up to 6 hours (review of PR #31).
const RETRY_FIRST_MS = 15 * 60_000
const RETRY_MAX_MS = 6 * 3600_000
const TIMEOUT_MS = 10_000
// A list of releases is a few kilobytes; more is not read.
const MAX_BYTES = 2_000_000
const MAX_NOTES = 4000

export type ReleaseState = {
  installed: string
  latest: string | null
  notes: string | null
  checkedAt: string | null
}
export type ReleaseChecker = {
  state(): ReleaseState
  // Asks the list, unless it was asked less than a day ago (or there is no list).
  check(): Promise<void>
  // Checks now and then every 15 minutes (a check asks once a day after an answer, sooner after a failure).
  start(): void
  stop(): void
}

// The list from the environment: unset, the public one; empty, none (off).
export function releasesUrl(env: Record<string, string | undefined>): string | null {
  const v = env.RSC_BRAIN_RELEASES_URL
  if (v === undefined) return DEFAULT_RELEASES_URL
  return v.trim() === '' ? null : v.trim()
}

const parts = (v: string): number[] | null => {
  const m = /^v?(\d+)\.(\d+)\.(\d+)$/.exec(v.trim())
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null
}

// `a` is a release after `b` (plain x.y.z; anything else is not newer).
export function newer(a: string, b: string): boolean {
  const x = parts(a)
  const y = parts(b)
  if (!x || !y) return false
  for (let i = 0; i < 3; i++)
    if ((x[i] as number) !== (y[i] as number)) return (x[i] as number) > (y[i] as number)
  return false
}

// GET with only the User-Agent (Node adds Host and Connection, as HTTP needs); at most MAX_BYTES, in TIMEOUT_MS.
function get(url: string, agent: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const u = new URL(url)
    const send = u.protocol === 'https:' ? httpsRequest : u.protocol === 'http:' ? httpRequest : null
    if (!send) return reject(new Error('not http'))
    const req = send(u, { method: 'GET', headers: { 'user-agent': agent }, timeout: TIMEOUT_MS }, (res) => {
      if (res.statusCode !== 200) {
        res.resume()
        return reject(new Error(`status ${res.statusCode}`))
      }
      let size = 0
      const chunks: Buffer[] = []
      res.on('data', (c: Buffer) => {
        size += c.length
        if (size > MAX_BYTES) {
          req.destroy(new Error('too large'))
          return
        }
        chunks.push(c)
      })
      res.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
      res.on('error', reject)
    })
    req.on('timeout', () => req.destroy(new Error('timeout')))
    req.on('error', reject)
    req.end()
  })
}

// The newest published release of the list (GitHub's shape: newest first; drafts and pre-releases skipped).
function newest(text: string): { latest: string; notes: string } | null {
  const list = JSON.parse(text) as unknown
  if (!Array.isArray(list)) return null
  for (const r of list) {
    if (!r || typeof r !== 'object') continue
    const x = r as { tag_name?: unknown; draft?: unknown; prerelease?: unknown; body?: unknown }
    if (x.draft === true || x.prerelease === true || typeof x.tag_name !== 'string') continue
    const p = parts(x.tag_name)
    if (!p) continue
    return {
      latest: p.join('.'),
      notes: typeof x.body === 'string' ? x.body.slice(0, MAX_NOTES) : '',
    }
  }
  return null
}

export function releaseChecker(o: { url: string | null; version: string; clock: Clock }): ReleaseChecker {
  const s: ReleaseState = { installed: o.version, latest: null, notes: null, checkedAt: null }
  // When the next check may ask: a day after one that answered, sooner after one that failed.
  let nextAt = 0
  let failures = 0
  let timer: ReturnType<typeof setInterval> | null = null
  let busy: Promise<void> | null = null
  const check = async () => {
    if (!o.url) return
    const now = o.clock().getTime()
    if (now < nextAt) return
    if (busy !== null) return busy
    const url = o.url
    busy = (async () => {
      let found: { latest: string; notes: string } | null = null
      try {
        found = newest(await get(url, `rsc-brain/${o.version}`))
      } catch {
        found = null
      }
      if (found) {
        s.latest = found.latest
        s.notes = found.notes
        s.checkedAt = new Date(now).toISOString()
        failures = 0
        nextAt = now + DAY_MS
      } else {
        // Kept as it was (the web says when it last checked); asked again soon, then less often.
        failures++
        nextAt = now + Math.min(RETRY_MAX_MS, RETRY_FIRST_MS * 2 ** (failures - 1))
      }
      busy = null
    })()
    return busy
  }
  return {
    state: () => ({ ...s }),
    check,
    start() {
      if (!o.url || timer) return
      void check()
      timer = setInterval(() => void check(), RETRY_FIRST_MS)
      timer.unref()
    },
    stop() {
      if (timer) clearInterval(timer)
      timer = null
    },
  }
}
