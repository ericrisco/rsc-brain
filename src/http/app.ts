// The HTTP face of the server: JSON in, JSON out, a key on every /v1 request except /v1/health.
// Refusals carry { error: { code, message, howToProceed } }; an unexpected failure reveals nothing.
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { TLSSocket } from 'node:tls'
import { fileURLToPath } from 'node:url'
import { bearer, resolveKey, sessionCookie } from '../auth/principal.ts'
import type { Clock } from '../core/clock.ts'
import { AppError, invalid } from '../core/errors.ts'
import type { Db } from '../db/db.ts'
import { installation, setupDone } from '../domain/installation.ts'
import type { Outbox } from '../mail/mail.ts'
import { mcpRoutes } from '../mcp/server.ts'
import type { Providers } from '../meaning/providers.ts'
import type { FetchPolicy } from '../oauth/fetch.ts'
import { boundJson } from './bounds.ts'
import { EVENT_TIMINGS, type EventTimings, eventHub } from './hub.ts'
import { openapi } from './openapi.ts'
import { rateLimiter } from './ratelimit.ts'
import {
  type Conn,
  match,
  publicRoute,
  type Reply,
  type Route,
  type StreamOut,
  WEB_HEADER,
} from './router.ts'
import { authRoutes } from './routes/auth.ts'
import { brainRoutes } from './routes/brains.ts'
import { brandingRoutes } from './routes/branding.ts'
import { connectRoutes } from './routes/connect.ts'
import { decideRoutes } from './routes/decide.ts'
import { eventRoutes } from './routes/events.ts'
import { journalRoutes } from './routes/journal.ts'
import { keyRoutes } from './routes/keys.ts'
import { meaningRoutes } from './routes/meaning.ts'
import { oauthRoutes } from './routes/oauth.ts'
import { peopleRoutes } from './routes/people.ts'
import { recallRoutes } from './routes/recall.ts'
import { wikiRoutes } from './routes/wiki.ts'
import { answerWeb, openWeb } from './web.ts'

export const MAX_BODY = 1_048_576
export { WEB_HEADER } from './router.ts'

export type AppDeps = {
  db: Db
  clock: Clock
  tz?: string
  routes?: Route[]
  log?: (line: string) => void
  meaning?: Providers
  // The installation secret (RSC_BRAIN_SECRET) that seals what the server must read back.
  secret?: string | undefined
  // Addresses of proxies in front of Brain whose X-Forwarded-* headers are believed.
  trustedProxies?: string[]
  // Replaces SMTP (tests); the server sends with the mail settings of the installation.
  mailTransport?: Outbox['transport']
  // Only tests set this: client documents served from this machine over http.
  fetchPolicy?: FetchPolicy
  // The rhythm of the event streams; tests make it fast.
  events?: Partial<EventTimings>
  // The folder of the built web (dist/web next to the server); false serves no web at all.
  web?: string | false
}

// Where the build puts the web: dist/web, next to dist/http where this module lands.
export const WEB_ROOT = fileURLToPath(new URL('../web/', import.meta.url))

export const ROUTES: Route[] = [
  ...authRoutes,
  ...brainRoutes,
  ...keyRoutes,
  ...journalRoutes,
  ...recallRoutes,
  ...decideRoutes,
  ...wikiRoutes,
  ...meaningRoutes,
  ...peopleRoutes,
  ...oauthRoutes,
  ...eventRoutes,
  ...connectRoutes,
  ...brandingRoutes,
]
// The MCP endpoint calls the same routes a program would (spec B5 parity).
ROUTES.push(...mcpRoutes(() => ROUTES))
// The description of the API, generated from this table; it holds no data, so it needs no key.
ROUTES.push(
  publicRoute('GET /v1/openapi.json', async (r) => ({
    body: openapi(ROUTES, (await installation(r.db)).publicUrl),
  })),
)

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
  // Forms (the sign-in and consent pages, and the token endpoint of the standard sign-in) arrive
  // url-encoded; a parameter given twice is refused, as the standard asks.
  if (String(req.headers['content-type'] ?? '').startsWith('application/x-www-form-urlencoded')) {
    const form: Record<string, string> = {}
    for (const [k, v] of new URLSearchParams(Buffer.concat(chunks).toString('utf8'))) {
      if (Object.hasOwn(form, k))
        throw invalid(`"${k}" is given more than once.`, 'Send each parameter once.')
      form[k] = v
    }
    parsed = form
  } else {
    try {
      parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'))
    } catch {
      throw invalid('The request body is not valid JSON.', 'Send a JSON object.')
    }
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

const LOOPBACK = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1'])

function connOf(req: IncomingMessage, trusted: string[]): Conn {
  const remote = req.socket.remoteAddress ?? ''
  const h = req.headers
  const proxied =
    h['x-forwarded-for'] !== undefined || h['x-forwarded-proto'] !== undefined || h.forwarded !== undefined
  const userAgent = String(h['user-agent'] ?? '').slice(0, 200)
  if (proxied && trusted.includes(remote)) {
    // The trusted proxy appends what it saw: the last entry is its own; earlier ones the client wrote.
    const last = (v: string | string[] | undefined) =>
      String(v ?? '')
        .split(',')
        .at(-1)
        ?.trim() ?? ''
    return {
      encrypted: last(h['x-forwarded-proto']) === 'https',
      local: false,
      ip: last(h['x-forwarded-for']) || remote,
      userAgent,
    }
  }
  return {
    encrypted: Boolean((req.socket as TLSSocket).encrypted),
    local: LOOPBACK.has(remote) && !proxied,
    ip: remote,
    userAgent,
  }
}

// JSON by default; a reply that names its own content type (a page) is sent as it is.
function send(
  res: ServerResponse,
  status: number,
  body: unknown,
  headers: Record<string, string | string[]> = {},
): void {
  const raw = typeof body === 'string' && headers['content-type'] !== undefined
  const bounded = raw ? { text: body as string, cut: false } : boundJson(JSON.stringify(body))
  const text = bounded.text
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
    ...headers,
    ...(bounded.cut ? { 'x-brain-cut': 'true' } : {}),
    'content-length': Buffer.byteLength(text),
  })
  res.end(text)
}

// An event stream: the headers go at once, then whatever the route writes, until it ends or the client
// leaves. A failure after the headers can only close the stream.
async function stream(
  res: ServerResponse,
  run: NonNullable<Reply['stream']>,
  log: (line: string) => void,
  bufferBytes: number,
): Promise<void> {
  res.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
    'x-accel-buffering': 'no',
    connection: 'keep-alive',
  })
  res.flushHeaders()
  const closed = () => res.destroyed || res.writableEnded
  const out: StreamOut = {
    // A client that stops reading is let go before what waits for it grows without end.
    write: (text) => {
      if (closed()) return
      res.write(text)
      if (res.writableLength > bufferBytes) res.destroy()
    },
    end: () => {
      if (!closed()) res.end()
    },
    closed,
    onClose: (f) => {
      res.on('close', f)
    },
    drained: () =>
      new Promise<void>((resolve) => {
        if (closed() || !res.writableNeedDrain) return resolve()
        const done = () => {
          res.off('drain', done)
          res.off('close', done)
          resolve()
        }
        res.on('drain', done)
        res.on('close', done)
      }),
  }
  try {
    await run(out)
  } catch (err) {
    log(`event stream: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}`)
  } finally {
    out.end()
  }
}

export function createHandler(deps: AppDeps) {
  const routes = deps.routes ?? ROUTES
  const log = deps.log ?? ((line: string) => process.stderr.write(`${line}\n`))
  const trusted = deps.trustedProxies ?? []
  const rate = rateLimiter(deps.clock)
  const timings = { ...EVENT_TIMINGS, ...(deps.events ?? {}) }
  const hub = eventHub(deps.db, timings, log)
  const web = deps.web === false ? null : openWeb(deps.web ?? WEB_ROOT)
  // Once the first-time setup is done it stays done: no need to ask the database again.
  let ready = false
  return async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    try {
      const url = new URL(req.url ?? '/', 'http://localhost')
      const method = req.method ?? 'GET'
      if (url.pathname === '/v1/health' && (method === 'GET' || method === 'HEAD'))
        return send(res, 200, { ok: true })
      // The web answers before the first-time setup (it is what runs the setup) and never on the API's
      // prefixes (spec B6, plan §3.1).
      if (web) {
        const page = answerWeb(web, method, req.url ?? '/', String(req.headers['accept-encoding'] ?? ''))
        if (page !== 'pass') {
          res.writeHead(page.status, { ...page.headers, 'content-length': Buffer.byteLength(page.body) })
          res.end(method === 'HEAD' ? undefined : page.body)
          return
        }
      }
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
      // Until the first-time setup is done, everything leads to it (spec B4 CA1).
      if (!ready && !found.route.beforeSetup) {
        ready = await setupDone(deps.db)
        if (!ready) {
          throw new AppError(
            503,
            'setup_required',
            'This installation is not set up yet.',
            'Open the Brain web address to run the first-time setup.',
          )
        }
      }
      const conn = connOf(req, trusted)
      const key = bearer(req.headers.authorization)
      const cookie = key ? null : sessionCookie(req.headers.cookie)
      const base = {
        headers: req.headers,
        params: found.params,
        query: url.searchParams,
        db: deps.db,
        clock: deps.clock,
        tz: deps.tz ?? 'UTC',
        meaning: deps.meaning ?? {},
        secret: deps.secret,
        mail: { secret: deps.secret, ...(deps.mailTransport ? { transport: deps.mailTransport } : {}) },
        fetchPolicy: deps.fetchPolicy ?? {},
        conn,
        cookie,
        rate,
        hub,
        timings,
      }
      if (found.route.public) {
        // A page that a browser posts to checks its own origin; JSON callers send no cookie here.
        const reply = await found.route.public({ ...base, body: await readBody(req) })
        return send(res, reply.status ?? 200, reply.body, reply.headers)
      }
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
      const who = await resolveKey(deps.db, key ?? cookie, deps.clock(), key ? 'bearer' : 'cookie', conn)
      rate.take(who.credential.id, who.rateLimit)
      const body = await readBody(req)
      const reply = await found.route.handler({ ...base, body, who })
      if (reply.stream) return await stream(res, reply.stream, log, timings.bufferBytes)
      send(res, reply.status ?? 200, reply.body, reply.headers)
    } catch (err) {
      // The standard sign-in's endpoints answer in the standard's shape, even for a malformed request.
      if (
        err instanceof AppError &&
        /^\/oauth\/(token|register|revoke)$/.test(new URL(req.url ?? '/', 'http://localhost').pathname)
      ) {
        return send(
          res,
          err.status,
          { error: 'invalid_request', error_description: err.message },
          err.headers,
        )
      }
      // The MCP endpoint answers in JSON-RPC, even for a body that is not JSON.
      if (err instanceof AppError && new URL(req.url ?? '/', 'http://localhost').pathname === '/mcp') {
        return send(res, err.status, {
          jsonrpc: '2.0',
          id: null,
          error: {
            code: err.code === 'invalid_request' ? -32700 : -32600,
            message: `${err.message} ${err.howToProceed}`,
          },
        })
      }
      if (err instanceof AppError) return send(res, err.status, { error: err.body() }, err.headers)
      const id = Math.random().toString(36).slice(2, 10)
      log(`internal error ${id}: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}`)
      send(res, 500, {
        error: {
          code: 'internal',
          message: `Something went wrong on the server (reference ${id}).`,
          howToProceed: 'Try again; if it keeps failing, give the reference to an administrator.',
        },
      })
    }
  }
}
