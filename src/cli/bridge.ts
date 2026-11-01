// rsc-brain bridge (spec B5 CA15): MCP over stdio for agents that only start local MCP programs, carried
// to the remote /mcp of an installation with a token. One JSON-RPC message per line in; each request
// becomes one POST, with the headers the server checks, and its answer one line out. Notifications get
// no answer. Whatever goes wrong comes back as a JSON-RPC error that says how to proceed; the bridge
// keeps running.
import { createInterface } from 'node:readline'
import { VERSION } from '../core/version.ts'
import { requestHeaders } from '../mcp/headers.ts'

type Json = Record<string, unknown>
type Out = (line: string) => void

const REQUEST_TIMEOUT_MS = 120_000

const errorLine = (id: unknown, code: number, message: string) =>
  JSON.stringify({ jsonrpc: '2.0', id: id ?? null, error: { code, message } })

function reason(err: unknown): string {
  const e = err as { name?: string; cause?: { code?: string; message?: string }; message?: string }
  if (e?.name === 'TimeoutError') return `no answer in ${REQUEST_TIMEOUT_MS / 1000} seconds`
  // Only a network code: the message of a request that could not be built can quote its headers.
  if (e?.cause?.code) return e.cause.code
  return e?.name === 'TypeError' ? 'the request could not be sent' : 'network error'
}

export async function runBridge(o: {
  url: URL
  token: string
  input: NodeJS.ReadableStream
  out: Out
  log: Out
}): Promise<number> {
  // The version an older client agreed in initialize, sent with its later requests.
  let legacy: string | undefined
  const pending = new Set<Promise<void>>()

  async function forward(msg: Json): Promise<void> {
    const notification = !('id' in msg)
    let res: Response
    try {
      res = await fetch(o.url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          accept: 'application/json, text/event-stream',
          authorization: `Bearer ${o.token}`,
          // Who is asking, as the profile and the live check of the web name it.
          'user-agent': `rsc-brain-bridge/${VERSION}`,
          ...requestHeaders(msg, legacy),
        },
        body: JSON.stringify(msg),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      })
    } catch (err) {
      const why = `Cannot reach rsc-brain at ${o.url.origin} (${reason(err)}).`
      if (notification) o.log(`${why}\n`)
      else
        o.out(
          errorLine(
            msg.id,
            -32000,
            `${why} How to proceed: check the address and your network, or try again in a moment. Keep working without the brain and tell the person it did not answer.`,
          ),
        )
      return
    }
    const text = await res.text().catch(() => '')
    if (notification) return
    let body: Json | null = null
    try {
      const parsed = JSON.parse(text) as unknown
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) body = parsed as Json
    } catch {}
    if (body?.jsonrpc !== '2.0') {
      o.out(
        errorLine(
          msg.id,
          -32603,
          `rsc-brain answered HTTP ${res.status} without a JSON-RPC message. How to proceed: check that --url is the MCP address of the installation (it ends in /mcp); if it is, try again later.`,
        ),
      )
      return
    }
    // Errors decided before the server read the request (no key, rate limit) carry no id.
    if (body.id === null || body.id === undefined) body.id = msg.id
    if (msg.method === 'initialize' && body.result && typeof body.result === 'object') {
      const v = (body.result as Json).protocolVersion
      if (typeof v === 'string') legacy = v
    }
    o.out(JSON.stringify(body))
  }

  const lines = createInterface({ input: o.input, crlfDelay: Number.POSITIVE_INFINITY })
  for await (const raw of lines) {
    const line = raw.trim()
    if (!line) continue
    let msg: unknown
    try {
      msg = JSON.parse(line)
    } catch {
      o.out(errorLine(null, -32700, 'Parse error: each line must be one JSON-RPC message.'))
      continue
    }
    if (!msg || typeof msg !== 'object' || Array.isArray(msg)) {
      o.out(
        errorLine(null, -32600, 'Not a JSON-RPC message: send one object per line (batches are not taken).'),
      )
      continue
    }
    const m = msg as Json
    // An answer from the client to the server: the server asks nothing, so there is nothing to carry.
    if (typeof m.method !== 'string') {
      if ('id' in m && !('result' in m) && !('error' in m)) {
        o.out(errorLine(m.id, -32600, 'A request needs a "method", as text.'))
      }
      continue
    }
    const p: Promise<void> = forward(m)
      .catch((err: unknown) => {
        if ('id' in m) o.out(errorLine(m.id, -32603, `The bridge failed: ${reason(err)}.`))
      })
      .then(() => {
        pending.delete(p)
      })
    pending.add(p)
  }
  await Promise.all([...pending])
  return 0
}
