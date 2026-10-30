// The MCP endpoint (spec B5): JSON-RPC over HTTP POST at /mcp, for both eras of the protocol. Modern
// clients (2026-07-28) send their version and identity in every request and may ask server/discover;
// older ones (2025-11-25, 2025-06-18) start with initialize. Every answer is one JSON object. A tool call
// runs the same /v1 route a program would, with the same key.
import { bearer, resolveKey } from '../auth/principal.ts'
import { AppError, invalid } from '../core/errors.ts'
import { installation } from '../domain/installation.ts'
import { CUT_HOW, head, MAX_REPLY_CHARS } from '../http/bounds.ts'
import { match, type PublicReq, type Reply, type Route } from '../http/router.ts'
import { headerValue, NAMED_METHODS } from './headers.ts'
import { INSTRUCTIONS, PROMPTS } from './instructions.ts'
import { allowed, defaultBrain, TOOLS } from './tools.ts'

export const MODERN = '2026-07-28'
// 2025-03-26 is not offered: it asks servers to take batches, which later revisions dropped.
export const LEGACY = ['2025-11-25', '2025-06-18']
export const SUPPORTED = [MODERN, ...LEGACY]
// One limit for the API and the MCP endpoint.
export { MAX_REPLY_CHARS }

const SERVER_INFO = { name: 'rsc-brain', title: 'RSC Brain', version: '0.1.0' }
const CAPABILITIES = { tools: { listChanged: false }, prompts: { listChanged: false } }

type Msg = { jsonrpc?: unknown; id?: unknown; method?: unknown; params?: Record<string, unknown> }
type Json = Record<string, unknown>

class RpcError extends Error {
  code: number
  status: number
  data: unknown
  constructor(status: number, code: number, message: string, data?: unknown) {
    super(message)
    this.status = status
    this.code = code
    this.data = data
  }
}

const rpc = (status: number, body: unknown, headers: Record<string, string> = {}): Reply => ({
  status,
  body,
  headers: { 'content-type': 'application/json; charset=utf-8', ...headers },
})
const raw = (status: number, body: unknown, headers: Record<string, string> = {}): Reply => ({
  status,
  body: JSON.stringify(body),
  headers: { 'content-type': 'application/json; charset=utf-8', ...headers },
})
const failure = (id: unknown, e: RpcError) =>
  raw(e.status, {
    jsonrpc: '2.0',
    id: id ?? null,
    error: { code: e.code, message: e.message, ...(e.data ? { data: e.data } : {}) },
  })

// The id of a request, when it is one a reply may carry (a string or a whole number).
function idOf(body: unknown): string | number | null {
  const id = body && typeof body === 'object' ? (body as Msg).id : undefined
  return typeof id === 'string' || Number.isSafeInteger(id) ? (id as string | number) : null
}

// Browsers send Origin; a page on another site must not drive this endpoint (DNS rebinding).
async function originAllowed(r: PublicReq): Promise<boolean> {
  const o = r.headers.origin
  if (o === undefined) return true
  let u: URL
  try {
    u = new URL(String(o))
  } catch {
    return false
  }
  if (['localhost', '127.0.0.1', '[::1]'].includes(u.hostname)) return true
  const pub = (await installation(r.db)).publicUrl
  return pub !== null && new URL(pub).origin === u.origin
}

async function unauthorized(r: PublicReq, err: AppError | null): Promise<Reply> {
  const base = (await installation(r.db)).publicUrl ?? ''
  const meta = `${base}/.well-known/oauth-protected-resource/mcp`
  return raw(
    401,
    {
      jsonrpc: '2.0',
      id: null,
      error: {
        code: -32001,
        message: err
          ? `${err.message} ${err.howToProceed}`
          : 'Sign in: this server needs a key or a connection.',
      },
    },
    {
      'www-authenticate': `Bearer resource_metadata="${meta}"${err ? ', error="invalid_token"' : ''}`,
    },
  )
}

export function mcpRoutes(routes: () => Route[]): Route[] {
  const handler = async (r: PublicReq): Promise<Reply> => {
    if (!(await originAllowed(r))) {
      return raw(403, {
        jsonrpc: '2.0',
        error: { code: -32600, message: 'This origin may not call the MCP endpoint.' },
      })
    }
    const key = bearer(r.headers.authorization)
    if (!key) return unauthorized(r, null)
    let who: Awaited<ReturnType<typeof resolveKey>>
    try {
      who = await resolveKey(r.db, key, r.clock(), 'bearer', r.conn)
    } catch (err) {
      if (err instanceof AppError && err.status === 401) return unauthorized(r, err)
      throw err
    }
    // The same limit as every other request of this key (spec B5), said in JSON-RPC.
    try {
      r.rate.take(who.credential.id, who.rateLimit)
    } catch (err) {
      if (!(err instanceof AppError)) throw err
      const e = err.body()
      return raw(
        err.status,
        {
          jsonrpc: '2.0',
          id: idOf(r.body),
          error: {
            code: -32029,
            message: `${e.code}: ${e.message} How to proceed: ${e.howToProceed}`,
            data: e,
          },
        },
        err.headers ?? {},
      )
    }
    const m = r.body as Msg
    if (
      !m ||
      typeof m !== 'object' ||
      Array.isArray(m) ||
      m.jsonrpc !== '2.0' ||
      typeof m.method !== 'string'
    ) {
      return failure(
        m && typeof m === 'object' ? (m as Msg).id : null,
        new RpcError(400, -32600, 'Not a JSON-RPC 2.0 request.'),
      )
    }
    const notification = !('id' in m)
    // A request id is a string or a whole number (MCP narrows JSON-RPC here).
    if (!notification && !(typeof m.id === 'string' || Number.isSafeInteger(m.id))) {
      return failure(null, new RpcError(400, -32600, 'A request "id" is a string or a whole number.'))
    }
    // The reply carries the id back, within the limit of every answer: an id has room, not all of it.
    if (!notification && JSON.stringify(m.id).length > MAX_ID_CHARS) {
      return failure(
        null,
        new RpcError(
          400,
          -32600,
          `A request "id" has at most ${MAX_ID_CHARS} characters; use a shorter one.`,
        ),
      )
    }
    if (notification) return { status: 202, body: '', headers: { 'content-type': 'text/plain' } }
    const params = (m.params && typeof m.params === 'object' ? m.params : {}) as Json
    const meta = (params._meta ?? {}) as Json
    const asked = meta['io.modelcontextprotocol/protocolVersion']
    const modern = typeof asked === 'string'
    try {
      // A name that is not text could not even be written into an error.
      if (NAMED_METHODS.has(m.method) && typeof params.name !== 'string') {
        throw new RpcError(modern ? 400 : 200, -32602, '"name" must be text.')
      }
      if (modern) {
        // In _meta only the stateless version is spoken; the older ones start with initialize.
        if (asked !== MODERN) {
          throw new RpcError(400, -32022, 'Unsupported protocol version', {
            supported: [MODERN],
            requested: asked,
          })
        }
        const hv = headerValue(r.headers['mcp-protocol-version'])
        if (hv !== asked)
          throw new RpcError(
            400,
            -32020,
            `Header mismatch: MCP-Protocol-Version is "${hv ?? ''}", the body says "${asked}".`,
          )
        const hm = headerValue(r.headers['mcp-method'])
        if (hm !== m.method)
          throw new RpcError(
            400,
            -32020,
            `Header mismatch: Mcp-Method is "${hm ?? ''}", the body says "${m.method}".`,
          )
        if (NAMED_METHODS.has(m.method)) {
          const hn = headerValue(r.headers['mcp-name'])
          if (hn !== params.name)
            throw new RpcError(
              400,
              -32020,
              `Header mismatch: Mcp-Name is "${hn ?? ''}", the body says "${params.name}".`,
            )
        }
      } else {
        const hv = headerValue(r.headers['mcp-protocol-version'])
        if (hv === MODERN && m.method !== 'initialize') {
          throw new RpcError(
            400,
            -32602,
            `A ${MODERN} request carries its version in params._meta["io.modelcontextprotocol/protocolVersion"].`,
          )
        }
        if (hv !== undefined && !LEGACY.includes(hv) && m.method !== 'initialize') {
          throw new RpcError(400, -32022, 'Unsupported protocol version', {
            supported: SUPPORTED,
            requested: hv,
          })
        }
      }
      // The reply carries the request id back: its room comes out of the limit too.
      const idChars = JSON.stringify(m.id).length
      const result = await dispatch(r, who, m.method, params, modern, routes, idChars)
      return rpc(200, {
        jsonrpc: '2.0',
        id: m.id,
        result: modern ? { resultType: 'complete', ...result } : result,
      })
    } catch (err) {
      if (err instanceof RpcError) return failure(m.id, err)
      throw err
    }
  }
  const notHere = async (): Promise<Reply> =>
    raw(
      405,
      { jsonrpc: '2.0', error: { code: -32600, message: 'The MCP endpoint takes POST only.' } },
      { allow: 'POST' },
    )
  return [
    { ...route('POST /mcp'), public: handler },
    { ...route('GET /mcp'), public: notHere },
    { ...route('DELETE /mcp'), public: notHere },
  ]
}

function route(spec: string): Route {
  const [method, path] = spec.split(' ') as [string, string]
  return {
    method,
    path,
    pattern: new RegExp(`^${path.replace(/\//g, '\\/')}$`),
    keys: [],
    handler: () => Promise.reject(new Error('the MCP endpoint runs through `public`')),
  }
}

type Who = Awaited<ReturnType<typeof resolveKey>>

async function dispatch(
  r: PublicReq,
  who: Who,
  method: string,
  params: Json,
  modern: boolean,
  routes: () => Route[],
  idChars: number,
): Promise<Json> {
  switch (method) {
    case 'initialize': {
      if (modern)
        throw new RpcError(400, -32600, '"initialize" is for older clients; send server/discover instead.')
      const wanted = typeof params.protocolVersion === 'string' ? params.protocolVersion : LEGACY[0]
      return {
        protocolVersion: LEGACY.includes(wanted as string) ? wanted : LEGACY[0],
        capabilities: CAPABILITIES,
        serverInfo: SERVER_INFO,
        instructions: INSTRUCTIONS,
      }
    }
    case 'server/discover':
      return {
        supportedVersions: SUPPORTED,
        capabilities: CAPABILITIES,
        _meta: { 'io.modelcontextprotocol/serverInfo': SERVER_INFO },
        instructions: INSTRUCTIONS,
      }
    case 'ping':
      return {}
    case 'tools/list':
      return {
        tools: TOOLS.filter((t) => allowed(t, who) === null).map((t) => ({
          name: t.name,
          title: t.title,
          description: t.description,
          inputSchema: t.inputSchema,
          annotations: t.annotations,
        })),
      }
    case 'tools/call':
      return callTool(r, who, params, modern, routes, idChars)
    case 'prompts/list':
      return {
        prompts: PROMPTS.map((p) => ({
          name: p.name,
          title: p.title,
          description: p.description,
          arguments: p.arguments,
        })),
      }
    case 'prompts/get': {
      const p = PROMPTS.find((x) => x.name === params.name)
      if (!p) throw new RpcError(modern ? 400 : 200, -32602, `Unknown prompt: ${params.name}`)
      // Only text arguments reach the prompt; anything else is left out.
      const given = params.arguments && typeof params.arguments === 'object' ? (params.arguments as Json) : {}
      const args = Object.fromEntries(
        Object.entries(given).filter(([, v]) => typeof v === 'string'),
      ) as Record<string, string>
      return {
        description: p.description,
        messages: [{ role: 'user', content: { type: 'text', text: p.text(args) } }],
      }
    }
    default:
      throw new RpcError(modern ? 404 : 200, -32601, `Method not found: ${method}`)
  }
}

const toolError = (text: string) => ({ content: [{ type: 'text', text }], isError: true })

async function callTool(
  r: PublicReq,
  who: Who,
  params: Json,
  modern: boolean,
  routes: () => Route[],
  idChars: number,
): Promise<Json> {
  const tool = TOOLS.find((t) => t.name === params.name)
  if (!tool) {
    throw new RpcError(
      modern ? 400 : 200,
      -32602,
      `Unknown tool: ${params.name}. Call tools/list for the tools this key can use.`,
    )
  }
  const why = allowed(tool, who)
  if (why) return toolError(`${why.code}: ${why.message} How to proceed: ${why.howToProceed}`)
  const args = (params.arguments ?? {}) as Json
  if (typeof args !== 'object' || args === null || Array.isArray(args)) {
    return toolError(
      'invalid_request: "arguments" must be an object. How to proceed: Send the arguments as {"name": value, …}.',
    )
  }
  try {
    const call = await tool.call(args, { db: r.db, who, brain: (a) => defaultBrain(r.db, who, a) })
    const query = new URLSearchParams(call.query ?? {})
    const found = match(routes(), call.method, call.path)
    // A path no route takes means a value in it was malformed (such as an empty id).
    if (!found || found === 'method' || found.route.public) {
      throw invalid(
        'A value in this call is not one Brain can use (an empty or malformed id or address).',
        'Check the arguments and try again.',
      )
    }
    const reply = await found.route.handler({ ...r, params: found.params, query, body: call.body, who })
    const body = reply.body as Json
    return toolResult(body, idChars)
  } catch (err) {
    if (err instanceof AppError) {
      const e = err.body()
      const problems = e.problems ? `\nProblems: ${JSON.stringify(e.problems)}` : ''
      return toolError(`${e.code}: ${e.message} How to proceed: ${e.howToProceed}${problems}`)
    }
    throw err
  }
}

// Room for the rest of the JSON-RPC answer (jsonrpc, resultType, isError), besides the request id,
// which the client chooses and so is counted as it is (`idChars`, its length written as JSON).
const ENVELOPE = 1_000
export const MAX_ID_CHARS = 10_000

// The result goes as text and, when it fits too, as structured content. What counts is the size once
// written as JSON (quotes and line breaks in the text are escaped), so the whole answer stays within
// the limit of the API (spec B5 «Respuestas acotadas»).
export function toolResult(body: Json, idChars = 0): Json {
  const full = JSON.stringify(body)
  const sent = (text: string, structured?: Json) =>
    JSON.stringify({ content: [{ type: 'text', text }], structuredContent: structured }).length +
    ENVELOPE +
    idChars
  if (!Array.isArray(body) && sent(full, body) <= MAX_REPLY_CHARS) {
    return { content: [{ type: 'text', text: full }], structuredContent: body, isError: false }
  }
  if (sent(full) <= MAX_REPLY_CHARS) return { content: [{ type: 'text', text: full }], isError: false }
  const note = `\n[cut at ${MAX_REPLY_CHARS} characters. ${CUT_HOW}]`
  let keep = MAX_REPLY_CHARS - note.length - ENVELOPE - idChars
  let text = `${head(full, keep)}${note}`
  while (sent(text) > MAX_REPLY_CHARS) {
    keep -= sent(text) - MAX_REPLY_CHARS
    text = `${head(full, keep)}${note}`
  }
  return { content: [{ type: 'text', text }], isError: false }
}
