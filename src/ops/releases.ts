// What is published and whether a newer one exists (rsc-updates §0, §3.9; spec B7 C18, CA27, CA29b). A published
// version is a `vX.Y.Z` tag of the repository, in numeric order, and what it changes is the `## vX.Y.Z` section of the
// CHANGELOG.md in that tag: the same definition as the launcher's and as rsc-factory's, written again here (there is
// no shared package) and pinned by test/fixtures/published-vectors.json. The repository is asked the way git does, with
// no credential at all and nothing but `User-Agent: rsc-brain/<version>`, so a private one answers no_access and the
// web sends the operator to `rsc-brain.sh update --check`, which has the server's own access. An error never carries a
// version: nothing here can turn a failed check into «up to date». RSC_BRAIN_REPO_URL says where to ask; empty, as an
// empty RSC_BRAIN_RELEASES_URL, nothing is ever asked. What it learns stays in this process's memory.
import type { Clock } from '../core/clock.ts'

export const DEFAULT_REPO_URL = 'https://github.com/ericrisco/rsc-brain'
export const NOTES_MAX = 4000
export const MAX_BYTES = 2 * 1024 * 1024
const TIMEOUT_MS = 10_000
const MAX_REDIRECTS = 3
const ADVERTISEMENT = 'application/x-git-upload-pack-advertisement'
const TAG_PREFIX = 'refs/tags/'
const DAY_MS = 24 * 3600_000
// After a check that got no answer: again in 15 minutes, doubling up to 6 hours (review of PR #31).
const RETRY_FIRST_MS = 15 * 60_000
const RETRY_MAX_MS = 6 * 3600_000

export type PublishedError = 'no_access' | 'network' | 'none'
export type Checked = { latest: string; notes: string; at: string } | { error: PublishedError; at: string }
export type Comparison = 'newer' | 'up_to_date' | 'older'
export type CheckOptions = {
  fetch?: typeof fetch
  now?: () => Date
  timeoutMs?: number
  userAgent?: string
}

// No leading zeros: v01.0.0 is not a published version.
export const PUBLISHED = /^v(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$/

export function isPublished(tag: string): boolean {
  return PUBLISHED.test(tag)
}

const parts = (tag: string) => tag.slice(1).split('.').map(BigInt)

function order(a: string, b: string): number {
  const [x, y] = [parts(a), parts(b)]
  for (let i = 0; i < 3; i++) {
    const [p, q] = [x[i] ?? 0n, y[i] ?? 0n]
    if (p !== q) return p < q ? -1 : 1
  }
  return 0
}

export function newestOf(tags: readonly string[]): string | null {
  let best: string | null = null
  for (const tag of tags) if (isPublished(tag) && (best === null || order(tag, best) > 0)) best = tag
  return best
}

export function compareVersions(installed: string, newest: string): Comparison {
  const c = order(installed, newest)
  return c < 0 ? 'newer' : c === 0 ? 'up_to_date' : 'older'
}

// The whitespace of the definition: spaces, tabs and line ends, in the launcher too. A no-break space is text.
const blank = (c: string | undefined) => c === ' ' || c === '\t' || c === '\n'
function trimmed(text: string): string {
  let from = 0
  let to = text.length
  while (from < to && blank(text[from])) from++
  while (to > from && blank(text[to - 1])) to--
  return text.slice(from, to)
}

export function notesFor(changelog: string, tag: string): string {
  const lines = changelog.replace(/\r(\n|$)/g, '$1').split('\n')
  const heading = `## ${tag}`
  const start = lines.findIndex(
    (l) => l === heading || (l.startsWith(heading) && /[ \t]/.test(l[heading.length] ?? '')),
  )
  if (start < 0) return ''
  const rest = lines.slice(start + 1)
  const end = rest.findIndex((l) => l.startsWith('## '))
  const text = trimmed((end < 0 ? rest : rest.slice(0, end)).join('\n'))
  return text.length > NOTES_MAX ? Array.from(text).slice(0, NOTES_MAX).join('') : text
}

// Where to ask: https and no credentials, or nothing is asked. Without a trailing slash or `.git`.
function repository(repoUrl: string): URL | null {
  let url: URL
  try {
    url = new URL(repoUrl)
  } catch {
    return null
  }
  if (url.protocol !== 'https:' || url.username || url.password) return null
  url.pathname = url.pathname.replace(/\/+$/, '').replace(/\.git$/, '')
  url.search = ''
  url.hash = ''
  return url
}

class Unreadable extends Error {}

// A GET that sends nothing about anyone, within the time, and that follows a redirect only to https.
async function get(url: string, send: typeof fetch, signal: AbortSignal, agent: string): Promise<Response> {
  let at = url
  for (let hop = 0; ; hop++) {
    const res = await send(at, { redirect: 'manual', signal, headers: { 'user-agent': agent } })
    if (res.status < 300 || res.status >= 400) return res
    await res.body?.cancel().catch(() => {})
    const location = res.headers.get('location')
    if (!location || hop >= MAX_REDIRECTS) throw new Unreadable('too many redirects')
    const next = new URL(location, at)
    if (next.protocol !== 'https:' || next.username || next.password) throw new Unreadable('unsafe redirect')
    at = next.href
  }
}

// The whole body, up to the limit; past it, or past the time, it stops reading and says so.
async function capped(res: Response, signal: AbortSignal): Promise<Buffer> {
  if (!res.body) return Buffer.alloc(0)
  const reader = res.body.getReader()
  const stopped = new Promise<never>((_resolve, reject) => {
    const stop = () => reject(new Unreadable('out of time'))
    if (signal.aborted) stop()
    else signal.addEventListener('abort', stop, { once: true })
  })
  const chunks: Uint8Array[] = []
  let size = 0
  try {
    for (;;) {
      const { done, value } = await Promise.race([reader.read(), stopped])
      if (done) return Buffer.concat(chunks)
      size += value.byteLength
      if (size > MAX_BYTES) throw new Unreadable('too large')
      chunks.push(value)
    }
  } finally {
    reader.cancel().catch(() => {})
  }
}

// The answer of `info/refs`: a service line, a flush, the refs, a flush. Anything else is unreadable.
function tagsIn(body: Buffer): string[] {
  const lines: Array<string | null> = []
  for (let i = 0; i < body.length; ) {
    const head = body.toString('latin1', i, i + 4)
    if (!/^[0-9a-fA-F]{4}$/.test(head)) throw new Unreadable('bad length')
    const size = Number.parseInt(head, 16)
    if (size === 0) {
      lines.push(null)
      i += 4
      continue
    }
    if (size < 5 || i + size > body.length) throw new Unreadable('bad length')
    lines.push(body.toString('utf8', i + 4, i + size))
    i += size
  }
  if (lines[0] !== '# service=git-upload-pack\n' || lines[1] !== null || lines.at(-1) !== null)
    throw new Unreadable('not an advertisement')
  const tags: string[] = []
  for (const line of lines.slice(2, -1)) {
    const m = line === null ? null : /^[0-9a-f]{40,64} ([^\0\n]+)/.exec(line)
    if (!m?.[1]) throw new Unreadable('not a ref')
    if (m[1].startsWith(TAG_PREFIX)) tags.push(m[1].slice(TAG_PREFIX.length))
  }
  return tags
}

// Only github.com serves a file of a tag at an address known in advance. Notes are a help: without them
// the version still stands.
async function notesOf(
  repo: URL,
  tag: string,
  send: typeof fetch,
  ms: number,
  agent: string,
): Promise<string> {
  if (repo.host !== 'github.com') return ''
  try {
    const signal = AbortSignal.timeout(ms)
    const res = await get(`${repo.href}/raw/${tag}/CHANGELOG.md`, send, signal, agent)
    if (!res.ok) {
      await res.body?.cancel().catch(() => {})
      return ''
    }
    return notesFor((await capped(res, signal)).toString('utf8'), tag)
  } catch {
    return ''
  }
}

export async function check(repoUrl: string, o: CheckOptions = {}): Promise<Checked> {
  const at = (o.now?.() ?? new Date()).toISOString()
  const send = o.fetch ?? fetch
  const ms = o.timeoutMs ?? TIMEOUT_MS
  const agent = o.userAgent ?? 'rsc-brain'
  const repo = repository(repoUrl)
  if (!repo) return { error: 'no_access', at }
  try {
    const signal = AbortSignal.timeout(ms)
    const res = await get(`${repo.href}/info/refs?service=git-upload-pack`, send, signal, agent)
    const type = res.headers.get('content-type')?.toLowerCase() ?? ''
    if ([401, 403, 404].includes(res.status) || (res.ok && !type.startsWith(ADVERTISEMENT))) {
      await res.body?.cancel().catch(() => {})
      return { error: 'no_access', at }
    }
    if (!res.ok) {
      await res.body?.cancel().catch(() => {})
      return { error: 'network', at }
    }
    const latest = newestOf(tagsIn(await capped(res, signal)))
    if (!latest) return { error: 'none', at }
    return { latest, notes: await notesOf(repo, latest, send, ms, agent), at }
  } catch {
    return { error: 'network', at }
  }
}

export type ReleaseState = {
  installed: string
  latest: string | null
  notes: string | null
  // When the repository last gave an answer about its versions.
  checkedAt: string | null
  // What went wrong the last time it was asked; null when that went well.
  error: PublishedError | null
  lastAttemptAt: string | null
}
export type ReleaseChecker = {
  state(): ReleaseState
  // Asks the repository, unless it was asked less than a day ago (or there is no repository to ask).
  check(): Promise<void>
  // Checks now and then every 15 minutes (a check asks once a day after an answer, sooner after a failure).
  start(): void
  stop(): void
}

// Where to ask, from the environment: unset, the public repository; empty, nowhere (off). RSC_BRAIN_RELEASES_URL is
// from before: its address means nothing any more, but empty still turns the check off.
export function repoUrl(env: Record<string, string | undefined>): string | null {
  if (env.RSC_BRAIN_RELEASES_URL?.trim() === '') return null
  const v = env.RSC_BRAIN_REPO_URL
  if (v === undefined) return DEFAULT_REPO_URL
  return v.trim() === '' ? null : v.trim()
}

const tagOf = (version: string) => (version.startsWith('v') ? version : `v${version}`)

export function releaseChecker(o: {
  repo: string | null
  version: string
  clock: Clock
  fetch?: typeof fetch
}): ReleaseChecker {
  const s: ReleaseState = {
    installed: tagOf(o.version),
    latest: null,
    notes: null,
    checkedAt: null,
    error: null,
    lastAttemptAt: null,
  }
  // When the next check may ask: a day after an answer, sooner after none.
  let nextAt = 0
  let failures = 0
  let timer: ReturnType<typeof setInterval> | null = null
  let busy: Promise<void> | null = null
  const run = async () => {
    if (!o.repo) return
    const now = o.clock().getTime()
    if (now < nextAt) return
    if (busy !== null) return busy
    const repo = o.repo
    busy = (async () => {
      const when = new Date(now).toISOString()
      const got = await check(repo, {
        now: () => new Date(now),
        userAgent: `rsc-brain/${o.version}`,
        ...(o.fetch ? { fetch: o.fetch } : {}),
      })
      s.lastAttemptAt = when
      if ('latest' in got) {
        s.latest = got.latest
        s.notes = got.notes
        s.checkedAt = when
        s.error = null
      } else {
        // What it knew stays, and the web says the last check failed.
        s.error = got.error
        if (got.error === 'none') {
          s.latest = null
          s.notes = null
          s.checkedAt = when
        }
      }
      if (s.error === 'network') {
        failures++
        nextAt = now + Math.min(RETRY_MAX_MS, RETRY_FIRST_MS * 2 ** (failures - 1))
      } else {
        // No access will not change in a few minutes either: it is an answer.
        failures = 0
        nextAt = now + DAY_MS
      }
      busy = null
    })()
    return busy
  }
  return {
    state: () => ({ ...s }),
    check: run,
    start() {
      if (!o.repo || timer) return
      void run()
      timer = setInterval(() => void run(), RETRY_FIRST_MS)
      timer.unref()
    },
    stop() {
      if (timer) clearInterval(timer)
      timer = null
    },
  }
}

export type ReleaseView = ReleaseState & { newer: boolean; ahead: boolean }

// How what is running stands against what is published. A preview (v0.3.0-rc.1) comes before its release, and after
// the release before it, as the launcher's own `newer` orders them.
export function releaseView(s: ReleaseState | null, version: string): ReleaseView {
  const installed = tagOf(version)
  const base = {
    installed,
    latest: s?.latest ?? null,
    notes: s?.notes ?? null,
    checkedAt: s?.checkedAt ?? null,
    error: s?.error ?? null,
    lastAttemptAt: s?.lastAttemptAt ?? null,
  }
  const core = /^(v[0-9]+\.[0-9]+\.[0-9]+)(-.+)?$/.exec(installed)
  if (!base.latest || !core?.[1]) return { ...base, newer: false, ahead: false }
  const c = compareVersions(core[1], base.latest)
  const preview = core[2] !== undefined
  return { ...base, newer: c === 'newer' || (c === 'up_to_date' && preview), ahead: c === 'older' }
}
