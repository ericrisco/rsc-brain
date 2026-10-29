// The HTTP face of the server: JSON in, JSON out, a key on every /v1 request except /v1/health.
// Refusals carry { error: { code, message, howToProceed } }; an unexpected failure reveals nothing.
import type { IncomingMessage, ServerResponse } from 'node:http'
import { bearer, resolveKey, sessionCookie } from '../auth/principal.ts'
import type { Clock } from '../core/clock.ts'
import { AppError, invalid } from '../core/errors.ts'
import type { Db } from '../db/db.ts'
import type { Providers } from '../meaning/providers.ts'
import { match, type Route } from './router.ts'
import { brainRoutes } from './routes/brains.ts'
import { decideRoutes } from './routes/decide.ts'
import { journalRoutes } from './routes/journal.ts'
import { keyRoutes } from './routes/keys.ts'
import { meaningRoutes } from './routes/meaning.ts'
import { recallRoutes } from './routes/recall.ts'
import { wikiRoutes } from './routes/wiki.ts'

export const MAX_BODY = 1_048_576
export const WEB_HEADER = 'rsc-brain-web'

export type AppDeps = {
  db: Db
  clock: Clock
  tz?: string
  routes?: Route[]
  log?: (line: string) => void
  meaning?: Providers
}

export const ROUTES: Route[] = [
  ...brainRoutes,
  ...keyRoutes,
  ...journalRoutes,
  ...recallRoutes,
  ...decideRoutes,
  ...wikiRoutes,
  ...meaningRoutes,
]

async function readBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of req) {
    size += (chunk as Buffer).length
    if (size > MAX_BODY) {
      throw new AppError(
        413,
        'body_too_large',
        'The request body is larger than 1 MB.',
        'Send a smaller request.',
      )
    }
    chunks.push(chunk as Buffer)
  }
  if (size === 0) return undefined
  let parsed: unknown
  try {
    parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'))
  } catch {
    throw invalid('The request body is not valid JSON.', 'Send a JSON object.')
  }
  const bad = badText(parsed)
  if (bad) throw invalid(bad, 'Fix it and retry.')
  return parsed
}

export const MAX_DEPTH = 32

// Walks the body without recursion (a deeply nested body cannot exhaust the stack) and finds what
// PostgreSQL cannot store: NUL characters and broken UTF-16 (a lone surrogate).
function badText(root: unknown): string | null {
  const stack: [unknown, number][] = [[root, 0]]
  while (stack.length > 0) {
    const [v, depth] = stack.pop() as [unknown, number]
    if (depth > MAX_DEPTH) return `The request is nested more than ${MAX_DEPTH} levels deep.`
    const texts =
      typeof v === 'string' ? [v] : v && typeof v === 'object' && !Array.isArray(v) ? Object.keys(v) : []
    for (const t of texts) {
      if (t.includes('\u0000'))
        return 'The request contains a NUL character (\\u0000), which cannot be stored.'
      if (!t.isWellFormed()) return 'The request contains broken text (a lone UTF-16 surrogate).'
    }
    if (Array.isArray(v)) for (const x of v) stack.push([x, depth + 1])
    else if (v && typeof v === 'object') for (const x of Object.values(v)) stack.push([x, depth + 1])
  }
  return null
}

function send(res: ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
    'content-length': Buffer.byteLength(text),
  })
  res.end(text)
}

export function createHandler(deps: AppDeps) {
  const routes = deps.routes ?? ROUTES
  const log = deps.log ?? ((line: string) => process.stderr.write(`${line}\n`))
  return async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    try {
      const url = new URL(req.url ?? '/', 'http://localhost')
      const method = req.method ?? 'GET'
      if (url.pathname === '/v1/health' && (method === 'GET' || method === 'HEAD'))
        return send(res, 200, { ok: true })
      let found: ReturnType<typeof match>
      try {
        found = match(routes, method, url.pathname)
      } catch {
        throw invalid('The address is not valid.', 'Check the path.')
      }
      if (found === null) {
        throw new AppError(
          404,
          'no_such_route',
          `Nothing at ${method} ${url.pathname}.`,
          'Check the method and path.',
        )
      }
      if (found === 'method') {
        throw new AppError(405, 'method_not_allowed', `${method} is not allowed here.`, 'Check the method.')
      }
      // The query string holds text that reaches the database too.
      for (const [k, v] of url.searchParams) {
        const bad = badText(k) ?? badText(v)
        if (bad) throw invalid(bad.replace('The request', 'The query string'), 'Remove those characters.')
      }
      const key = bearer(req.headers.authorization)
      const cookie = key ? null : sessionCookie(req.headers.cookie)
      // A cookie-borne write must come from the web itself: a page elsewhere cannot add this header
      // to a cross-site request without the browser asking first (CSRF).
      if (cookie && method !== 'GET' && method !== 'HEAD' && req.headers['x-requested-with'] !== WEB_HEADER) {
        throw new AppError(
          403,
          'csrf',
          'This request from the web lacks its "X-Requested-With" header.',
          'Use the Brain web to do this.',
        )
      }
      const who = await resolveKey(deps.db, key ?? cookie, deps.clock(), key ? 'bearer' : 'cookie')
      const body = await readBody(req)
      const reply = await found.route.handler({
        params: found.params,
        query: url.searchParams,
        body,
        who,
        db: deps.db,
        clock: deps.clock,
        tz: deps.tz ?? 'UTC',
        meaning: deps.meaning ?? {},
      })
      send(res, reply.status ?? 200, reply.body)
    } catch (err) {
      if (err instanceof AppError) return send(res, err.status, { error: err.body() })
      const id = Math.random().toString(36).slice(2, 10)
      log(`internal error ${id}: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}`)
      send(res, 500, {
        error: {
          code: 'internal',
          message: `Something went wrong on the server (reference ${id}).`,
          howToProceed: 'Try again; if it keeps failing, give the reference to the administration.',
        },
      })
    }
  }
}
