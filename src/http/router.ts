// A small router: "METHOD /v1/brains/:slug" patterns, matched in order.
import type { Principal } from '../auth/principal.ts'
import type { Clock } from '../core/clock.ts'
import type { Db } from '../db/db.ts'

export type Req = {
  params: Record<string, string>
  query: URLSearchParams
  body: unknown
  who: Principal
  db: Db
  clock: Clock
}
export type Reply = { status?: number; body: unknown }
export type Handler = (r: Req) => Promise<Reply>
export type Route = { method: string; pattern: RegExp; keys: string[]; handler: Handler }

export function route(spec: string, handler: Handler): Route {
  const [method, path] = spec.split(' ') as [string, string]
  const keys: string[] = []
  const source = path
    .split('/')
    .map((part) => {
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
