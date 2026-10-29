// A small router: "METHOD /v1/brains/:slug" patterns, matched in order. A last part written "*name"
// takes the rest of the path, slashes included (page addresses such as "audience/retention").
import type { IncomingHttpHeaders } from 'node:http'
import type { Principal } from '../auth/principal.ts'
import type { Clock } from '../core/clock.ts'
import type { Db } from '../db/db.ts'
import type { Outbox } from '../mail/mail.ts'
import type { Providers } from '../meaning/providers.ts'

// How a request arrived (spec B4): over TLS or not, from this machine or not, from where and with which
// client. A request through a proxy counts as local only if nothing says it came from elsewhere, and
// as encrypted only if a trusted proxy says the original was https.
export type Conn = { encrypted: boolean; local: boolean; ip: string; userAgent: string }

// The header only the Brain web sends: a form on another site cannot add it (CSRF).
export const WEB_HEADER = 'rsc-brain-web'

export type PublicReq = {
  headers: IncomingHttpHeaders
  params: Record<string, string>
  query: URLSearchParams
  body: unknown
  db: Db
  clock: Clock
  tz: string
  meaning: Providers
  secret: string | undefined
  mail: Outbox
  conn: Conn
  // The web session cookie, when one came, for public pages that also serve a signed-in person.
  cookie: string | null
}
export type Req = PublicReq & { who: Principal }
export type Reply = { status?: number; body: unknown; headers?: Record<string, string | string[]> }
export type Handler = (r: Req) => Promise<Reply>
export type Route = {
  method: string
  pattern: RegExp
  keys: string[]
  handler: Handler
  // No key needed: the setup, signing in, accepting an invitation, the sign-in pages of B4.
  public?: (r: PublicReq) => Promise<Reply>
  // Answers before the first-time setup is done.
  beforeSetup?: boolean
}

export function publicRoute(
  spec: string,
  handler: (r: PublicReq) => Promise<Reply>,
  o: { beforeSetup?: boolean } = {},
): Route {
  const r = route(spec, () => Promise.reject(new Error('a public route runs through `public`')))
  return { ...r, public: handler, ...(o.beforeSetup ? { beforeSetup: true } : {}) }
}

export function route(spec: string, handler: Handler): Route {
  const [method, path] = spec.split(' ') as [string, string]
  const keys: string[] = []
  const source = path
    .split('/')
    .map((part) => {
      if (part.startsWith('*')) {
        keys.push(part.slice(1))
        return '(.+)'
      }
      if (!part.startsWith(':')) return part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
      keys.push(part.slice(1))
      return '([^/]+)'
    })
    .join('/')
  return { method, pattern: new RegExp(`^${source}$`), keys, handler }
}

export function match(
  routes: Route[],
  method: string,
  path: string,
): { route: Route; params: Record<string, string> } | 'method' | null {
  let pathMatched = false
  for (const r of routes) {
    const m = r.pattern.exec(path)
    if (!m) continue
    pathMatched = true
    if (r.method !== method) continue
    const params: Record<string, string> = {}
    r.keys.forEach((k, i) => {
      const v = decodeURIComponent(m[i + 1] ?? '')
      // PostgreSQL text cannot hold NUL; refuse it here instead of failing in the database.
      if (v.includes('\u0000')) throw new URIError('NUL in path')
      params[k] = v
    })
    return { route: r, params }
  }
  return pathMatched ? 'method' : null
}
