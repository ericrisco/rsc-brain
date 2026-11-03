// The HTTP face of the server: JSON in, JSON out, a key on every /v1 request except /v1/health.
// Refusals carry { error: { code, message, howToProceed } }; an unexpected failure reveals nothing.
import { createReadStream } from 'node:fs'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { gzipSync } from 'node:zlib'
import { bearer, resolveKey, sessionCookie } from '../auth/principal.ts'
import type { Clock } from '../core/clock.ts'
import { AppError, invalid } from '../core/errors.ts'
import { failureFields, type Log, stdoutLog } from '../core/log.ts'
import type { Db } from '../db/db.ts'
import { adminOnly } from '../domain/guards.ts'
import { installation, setupDone } from '../domain/installation.ts'
import { activeAt } from '../domain/maintenance.ts'
import type { Outbox } from '../mail/mail.ts'
import { mcpRoutes } from '../mcp/server.ts'
import type { Providers } from '../meaning/providers.ts'
import type { FetchPolicy } from '../oauth/fetch.ts'
import type { Copies } from '../ops/backup/copies.ts'
import { EXPORT_LIMITS, sweepExports } from '../ops/export/export.ts'
import type { ReleaseChecker } from '../ops/releases.ts'
import { boundJson } from './bounds.ts'
import { connOf } from './conn.ts'
import { EVENT_TIMINGS, type EventTimings, eventHub } from './hub.ts'
import { ENDS_ACCESS, isWrite, maintenance, underMaintenance } from './maintenance.ts'
import { openapi } from './openapi.ts'
import { rateLimiter } from './ratelimit.ts'
import { match, publicRoute, type Reply, type Route, type StreamOut, WEB_HEADER } from './router.ts'
import { authRoutes } from './routes/auth.ts'
import { backupRoutes } from './routes/backups.ts'
import { brainRoutes } from './routes/brains.ts'
import { brandingRoutes } from './routes/branding.ts'
import { connectRoutes } from './routes/connect.ts'
import { decideRoutes } from './routes/decide.ts'
import { eventRoutes } from './routes/events.ts'
import { exportRoutes } from './routes/export.ts'
import { importRoutes } from './routes/import.ts'
import { journalRoutes } from './routes/journal.ts'
import { keyRoutes } from './routes/keys.ts'
import { meaningRoutes } from './routes/meaning.ts'
import { oauthRoutes } from './routes/oauth.ts'
import { peopleRoutes } from './routes/people.ts'
import { recallRoutes } from './routes/recall.ts'
import { systemRoutes } from './routes/system.ts'
import { wikiRoutes } from './routes/wiki.ts'
import { answerWeb, openWeb } from './web.ts'

export const MAX_BODY = 1_048_576
export { WEB_HEADER } from './router.ts'

export type AppDeps = {
  db: Db
  clock: Clock
  tz?: string
  routes?: Route[]
  // Where the log goes (src/core/log.ts: closed fields, never content); standard output by default.
  log?: Log
  meaning?: Providers
  // The installation secret (RSC_BRAIN_SECRET) that seals what the server must read back.
  secret?: string | undefined
  // Addresses of proxies in front of Brain whose X-Forwarded-* headers are believed.
  trustedProxies?: string[]
  // RSC_BRAIN_LOCAL_ONLY: the container's gateway, whose plain requests count as this machine (src/http/conn.ts).
  localGateways?: string[]
  // Replaces SMTP (tests); the server sends with the mail settings of the installation.
  mailTransport?: Outbox['transport']
  // Only tests set this: client documents served from this machine over http.
  fetchPolicy?: FetchPolicy
  // The rhythm of the event streams; tests make it fast.
  events?: Partial<EventTimings>
  // The folder of the built web (dist/web next to the server); false serves no web at all.
  web?: string | false
  // Where the copies go (RSC_BRAIN_BACKUPS): Admin › Backups & system shows the free space there.
  backups?: string | undefined
  // The copies of this process (serve builds them with the daily copy; spec B7).
  copies?: Copies
  // Whether a newer release exists (plan §3.10).
  releases?: ReleaseChecker
  // Where exports are prepared before they are sent (a private folder of the system's temporary space).
  exportDir?: string
}

// How long the health address waits for the database before it says the database is down.
export const HEALTH_TIMEOUT_MS = 2000

// GET /v1/health (spec B7 C20): whether the service and its database answer, and whether it is under
// maintenance; 503 when the database does not answer in time. Never the version, nothing of an error.
async function health(db: Db, now: Date): Promise<{ status: number; body: Record<string, unknown> }> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    const row = await Promise.race([
      db.one('SELECT maintenance_until FROM installation WHERE id = 1'),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('timeout')), HEALTH_TIMEOUT_MS)
      }),
    ])
    return { status: 200, body: { ok: true, database: 'ok', maintenance: activeAt(row, now) !== null } }
  } catch {
    return { status: 503, body: { ok: false, database: 'down', maintenance: false } }
  } finally {
    clearTimeout(timer)
  }
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
  ...systemRoutes,
  ...backupRoutes,
  ...exportRoutes,
  ...importRoutes,
]
// The MCP endpoint calls the same routes a program would (spec B5 parity).
ROUTES.push(...mcpRoutes(() => ROUTES))
// The description of the API, generated from this table; it holds no data, so it needs no key.
ROUTES.push(
  // Sent whole as text: it describes, it holds no data, so the bound on answers (256 000 characters, for data) does
  // not cut it; it passed that size with the copies of B7.
  publicRoute('GET /v1/openapi.json', async (r) => ({
    body: JSON.stringify(openapi(ROUTES, (await installation(r.db)).publicUrl)),
    headers: { 'content-type': 'application/json; charset=utf-8' },
  })),
)

const tooLarge = (max: number) => {
  const e = new AppError(
    413,
    'body_too_large',
    `The request body is larger than ${Math.round(max / 1_048_576)} MB.`,
    'Send a smaller request.',
  )
  // The rest of the body is not read: the connection ends with the answer, so it is never reused mid-body.
  e.headers = { connection: 'close' }
  return e
}

// Reads the body up to `max` bytes and not one more: a declared length over it is refused before reading,
// and a body that passes it while it arrives is left unread from there (the stream is paused, not destroyed,
// so the refusal still reaches the client).
async function readBody(req: IncomingMessage, max = MAX_BODY): Promise<unknown> {
  const declared = Number(req.headers['content-length'])
  if (Number.isFinite(declared) && declared > max) throw tooLarge(max)
  const chunks: Buffer[] = []
  let size = 0
  await new Promise<void>((resolve, reject) => {
    const onData = (chunk: Buffer) => {
      size += chunk.length
      if (size > max) {
        req.off('data', onData)
        req.off('end', resolve)
        req.pause()
        chunks.length = 0
        reject(tooLarge(max))
        return
      }
      chunks.push(chunk)
    }
    req.on('data', onData)
    req.on('end', resolve)
    req.on('error', reject)
  })
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

// A body that is a file (an import's zip): its bytes, up to `max` and not one more, read like readBody.
const archiveTooLarge = (max: number) => {
  const e = new AppError(
    413,
    'archive_too_large',
    `The zip is larger than ${Math.round(max / 1_048_576)} MB.`,
    'Import a smaller zip, or ask an administrator to import the folder from the command line.',
  )
  e.headers = { connection: 'close' }
  return e
}
async function readRaw(req: IncomingMessage, max = MAX_BODY): Promise<Buffer> {
  const declared = Number(req.headers['content-length'])
  if (Number.isFinite(declared) && declared > max) throw archiveTooLarge(max)
  const chunks: Buffer[] = []
  let size = 0
  await new Promise<void>((resolve, reject) => {
    const onData = (chunk: Buffer) => {
      size += chunk.length
      if (size > max) {
        req.off('data', onData)
        req.off('end', resolve)
        req.pause()
        chunks.length = 0
        reject(archiveTooLarge(max))
        return
      }
      chunks.push(chunk)
    }
    req.on('data', onData)
    req.on('end', resolve)
    req.on('error', reject)
  })
  return Buffer.concat(chunks)
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

// JSON by default; a reply that names its own content type (a page) is sent as it is.
// A reply that asks for it (`compress`) travels gzipped when it passes 32 KB and the client accepts gzip
// (plan §3.5 G10: the graph).
export const COMPRESS_FROM = 32 * 1024
const acceptsGzip = (header: string | undefined) =>
  (header ?? '').split(',').some((part) => {
    const [name, ...params] = part.trim().toLowerCase().split(';')
    const q = params.map((x) => x.trim()).find((x) => x.startsWith('q='))
    return name?.trim() === 'gzip' && (!q || Number(q.slice(2)) > 0)
  })

function send(
  res: ServerResponse,
  status: number,
  body: unknown,
  headers: Record<string, string | string[]> = {},
  // The route compresses big answers (`compress`); whether this client takes gzip.
  compress: { route: boolean; accepts: boolean } = { route: false, accepts: false },
): void {
  // Nothing to say back (a password changed): no body at all, as 204 requires.
  if (status === 204 || status === 304) {
    res.writeHead(status, { 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', ...headers })
    res.end()
    return
  }
  // Bytes (the logo) go as they are, with the headers the route gave.
  if (Buffer.isBuffer(body)) {
    res.writeHead(status, {
      'cache-control': 'no-store',
      'x-content-type-options': 'nosniff',
      ...headers,
      'content-length': body.length,
    })
    res.end(body)
    return
  }
  const raw = typeof body === 'string' && headers['content-type'] !== undefined
  const bounded = raw ? { text: body as string, cut: false } : boundJson(JSON.stringify(body))
  const text = bounded.text
  const zipped =
    compress.route && compress.accepts && Buffer.byteLength(text) > COMPRESS_FROM ? gzipSync(text) : null
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
    ...headers,
    ...(bounded.cut ? { 'x-brain-cut': 'true' } : {}),
    // A cache keeps the plain and the gzipped answer apart, whichever this client got.
    ...(compress.route ? { vary: 'Accept-Encoding' } : {}),
    ...(zipped ? { 'content-encoding': 'gzip' } : {}),
    'content-length': zipped ? zipped.length : Buffer.byteLength(text),
  })
  res.end(zipped ?? text)
}

// An event stream: the headers go at once, then whatever the route writes, until it ends or the client
// leaves. A failure after the headers can only close the stream.
async function stream(
  res: ServerResponse,
  run: NonNullable<Reply['stream']>,
  log: Log,
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
    log.error('stream_error', failureFields(err))
  } finally {
    out.end()
  }
}

// A file to save, as it is on disk (a copy of the installation): never cached, never sniffed.
async function sendFile(
  res: ServerResponse,
  f: { path: string; bytes: number; name: string },
): Promise<void> {
  const from = createReadStream(f.path)
  await new Promise<void>((resolve, reject) => {
    from.once('open', () => {
      res.writeHead(200, {
        'content-type': 'application/octet-stream',
        'content-disposition': `attachment; filename="${f.name}"`,
        'content-length': f.bytes,
        'cache-control': 'no-store',
        'x-content-type-options': 'nosniff',
      })
      from.pipe(res)
    })
    from.once('error', (err) => {
      if (!res.headersSent) reject(err)
      else res.destroy(err)
    })
    res.once('close', () => {
      from.destroy()
      resolve()
    })
  })
}

// A file prepared on disk (an export, review of PR31): sent at the client's pace, its size said up front. A client
// that takes nothing for `stallMs` is let go; the file is removed whatever happens (sent, cut, stalled).
export async function sendDownload(
  res: ServerResponse,
  d: NonNullable<Reply['download']>,
  log: Log,
  stallMs: number,
): Promise<void> {
  try {
    // The client left while it was prepared: nothing to send, the file goes now.
    if (res.destroyed || res.writableEnded) return
    // From the handle it was written with: the file has no name any more.
    const from = d.fh.createReadStream({ start: 0, autoClose: false, highWaterMark: 64 * 1024 })
    res.writeHead(200, {
      'content-type': d.type,
      'content-disposition': `attachment; filename="${d.name}"`,
      'content-length': d.bytes,
      'cache-control': 'no-store',
      'x-content-type-options': 'nosniff',
    })
    await new Promise<void>((resolve) => {
      let timer: ReturnType<typeof setTimeout> | undefined
      const stall = () => {
        clearTimeout(timer)
        timer = setTimeout(() => res.destroy(), stallMs)
      }
      const finish = () => {
        clearTimeout(timer)
        from.destroy()
        resolve()
      }
      from.on('data', (chunk) => {
        if (!res.write(chunk)) {
          from.pause()
          stall()
        }
      })
      res.on('drain', () => {
        clearTimeout(timer)
        from.resume()
      })
      from.once('end', () => res.end())
      from.once('error', (err) => {
        log.error('download_failed', failureFields(err))
        res.destroy()
      })
      res.once('close', finish)
    })
  } finally {
    await d.done()
  }
}

export function createHandler(deps: AppDeps) {
  const routes = deps.routes ?? ROUTES
  const log = deps.log ?? stdoutLog
  const connOptions = { trusted: deps.trustedProxies ?? [], localGateways: deps.localGateways ?? [] }
  const rate = rateLimiter(deps.clock)
  const timings = { ...EVENT_TIMINGS, ...(deps.events ?? {}) }
  const hub = eventHub(deps.db, timings, log)
  const web = deps.web === false ? null : openWeb(deps.web ?? WEB_ROOT)
  const startedAt = deps.clock()
  // Where exports are prepared: the folder given, or one next to the copies (the server's data); without either, a
  // private folder of the system's temporary space for this process (export.ts).
  const exportDir = deps.exportDir ?? (deps.backups ? join(deps.backups, '.exports') : null)
  // What a crash left of an export goes now (by the files' own times: the wall clock, not the service's).
  if (exportDir) void sweepExports(exportDir, new Date())
  // Once the first-time setup is done it stays done: no need to ask the database again.
  let ready = false
  return async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    // Whether the body was read: a refusal sent before it (or instead of it) closes the connection.
    let bodyRead = false
    // One line per answered request: the method, the route as its template (never the path or the query),
    // the status and how long it took (plan §3.11).
    const started = performance.now()
    let template: string | undefined
    // Whether the client is still there, from the very start: what is prepared for it stops when it leaves.
    const left = new AbortController()
    res.once('close', () => left.abort())
    res.once('close', () => {
      try {
        log.info('request', {
          method: /^[A-Z]{3,7}$/.test(req.method ?? '') ? req.method : undefined,
          route: template,
          status: res.statusCode,
          ms: Math.min(86_400_000, Math.round(performance.now() - started)),
        })
      } catch {
        // The log never takes the server down.
      }
    })
    try {
      const url = new URL(req.url ?? '/', 'http://localhost')
      const method = req.method ?? 'GET'
      if (url.pathname === '/v1/health' && (method === 'GET' || method === 'HEAD')) {
        template = '/v1/health'
        const h = await health(deps.db, deps.clock())
        return send(res, h.status, h.body)
      }
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
      template = found.route.path
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
            'Open the rsc-brain web address to run the first-time setup.',
          )
        }
      }
      const conn = connOf(req, connOptions)
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
        startedAt,
        backups: deps.backups ?? null,
        copies: deps.copies ?? null,
        releases: deps.releases ?? null,
        exportDir,
        signal: left.signal,
        log,
      }
      // Maintenance (spec B7 C12): a write without a key (signing in, the standard sign-in) is refused here;
      // one with a key once the key is read, from the same row.
      const write = isWrite(found.route)
      const endsAccess = ENDS_ACCESS.has(`${found.route.method} ${found.route.path}`)
      if (found.route.public && write) {
        const m = await maintenance.current(deps.db, deps.clock())
        if (m) throw underMaintenance(m, deps.clock(), endsAccess)
      }
      if (found.route.public) {
        // A page that a browser posts to checks its own origin; JSON callers send no cookie here.
        const body = await readBody(req)
        bodyRead = true
        const reply = await found.route.public({ ...base, body })
        return send(res, reply.status ?? 200, reply.body, reply.headers)
      }
      // A cookie-borne write must come from the web itself: a page elsewhere cannot add this header
      // to a cross-site request without the browser asking first (CSRF).
      if (cookie && method !== 'GET' && method !== 'HEAD' && req.headers['x-requested-with'] !== WEB_HEADER) {
        throw new AppError(
          403,
          'csrf',
          'This request from the web lacks its "X-Requested-With" header.',
          'Use the rsc-brain web to do this.',
        )
      }
      const who = await resolveKey(deps.db, key ?? cookie, deps.clock(), key ? 'bearer' : 'cookie', conn)
      if (write && who.maintenance) throw underMaintenance(who.maintenance, deps.clock(), endsAccess)
      rate.take(who.credential.id, who.rateLimit)
      // A route only the administration uses refuses anyone else before reading a (large) body.
      if (found.route.admin) adminOnly({ db: deps.db, clock: deps.clock, who })
      if (found.route.before) await found.route.before({ ...base, body: undefined, who })
      const body = found.route.raw
        ? await readRaw(req, found.route.maxBody)
        : await readBody(req, found.route.maxBody)
      bodyRead = true
      const reply = await found.route.handler({ ...base, body, who })
      if (reply.stream) return await stream(res, reply.stream, log, timings.bufferBytes)
      if (reply.file) return await sendFile(res, reply.file)
      if (reply.download) return await sendDownload(res, reply.download, log, EXPORT_LIMITS.stallMs)
      send(res, reply.status ?? 200, reply.body, reply.headers, {
        route: Boolean(reply.compress),
        accepts: acceptsGzip(req.headers['accept-encoding']),
      })
    } catch (err) {
      // A refusal before the body was read (401, 403, 404, 413…): the rest of it is never read, so the
      // connection ends. The answer goes first; the socket is let go a moment after it is sent, so the client
      // reads the refusal before the connection drops.
      const unread =
        !bodyRead &&
        (Number(req.headers['content-length'] ?? 0) > 0 || req.headers['transfer-encoding'] !== undefined)
      if (unread && !res.headersSent) {
        res.setHeader('connection', 'close')
        res.once('finish', () => setTimeout(() => req.socket.destroy(), 100).unref())
      }
      const pathname = new URL(req.url ?? '/', 'http://localhost').pathname
      // The standard sign-in answers maintenance in its own words (any of its pages), with Retry-After.
      if (err instanceof AppError && err.code === 'under_maintenance' && pathname.startsWith('/oauth/')) {
        return send(
          res,
          err.status,
          { error: 'temporarily_unavailable', error_description: err.message },
          err.headers,
        )
      }
      // The standard sign-in's endpoints answer in the standard's shape, even for a malformed request.
      if (err instanceof AppError && /^\/oauth\/(token|register|revoke)$/.test(pathname)) {
        return send(
          res,
          err.status,
          { error: 'invalid_request', error_description: err.message },
          err.headers,
        )
      }
      // The MCP endpoint answers in JSON-RPC, even for a body that is not JSON.
      if (err instanceof AppError && pathname === '/mcp') {
        return send(res, err.status, {
          jsonrpc: '2.0',
          id: null,
          error: {
            code: err.code === 'invalid_request' ? -32700 : -32600,
            message: `${err.message} ${err.howToProceed}`,
          },
        })
      }
      if (err instanceof AppError)
        return send(res, err.status, { error: err.body(), ...(err.outer ?? {}) }, err.headers)
      const id = Math.random().toString(36).slice(2, 10)
      // The reference and where it failed; never the message, which may quote what was sent or stored.
      log.error('internal_error', { ref: id, route: template, ...failureFields(err) })
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
