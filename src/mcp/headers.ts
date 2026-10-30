// The HTTP headers that mirror a modern MCP request (2026-07-28): the server checks them against the
// body, and the local bridge writes them from the body. One set of rules for both sides.

// Methods whose target is named in Mcp-Name.
export const NAMED_METHODS = new Set(['tools/call', 'prompts/get'])

// A value that is not plain printable ASCII, or has spaces at its ends, travels as "=?base64?…?=".
export function encodeHeaderValue(v: string): string {
  return /^[\x21-\x7E]([\x20-\x7E]*[\x21-\x7E])?$/.test(v)
    ? v
    : `=?base64?${Buffer.from(v, 'utf8').toString('base64')}?=`
}

// An encoded header value is compared after decoding.
export function headerValue(v: string | string[] | undefined): string | undefined {
  if (v === undefined) return undefined
  const s = Array.isArray(v) ? (v[0] ?? '') : v
  const m = /^=\?base64\?([A-Za-z0-9+/=]*)\?=$/.exec(s)
  return m ? Buffer.from(m[1] as string, 'base64').toString('utf8') : s
}

type Msg = { method?: unknown; params?: unknown }

// The headers a client sends with one message. A modern message carries its version in
// params._meta; an older client, after initialize, sends the version it agreed (`legacy`).
export function requestHeaders(msg: Msg, legacy?: string): Record<string, string> {
  const params = (msg.params && typeof msg.params === 'object' ? msg.params : {}) as Record<string, unknown>
  const meta = (params._meta && typeof params._meta === 'object' ? params._meta : {}) as Record<
    string,
    unknown
  >
  const version = meta['io.modelcontextprotocol/protocolVersion']
  if (typeof version !== 'string') {
    return legacy && msg.method !== 'initialize' ? { 'mcp-protocol-version': legacy } : {}
  }
  const h: Record<string, string> = { 'mcp-protocol-version': encodeHeaderValue(version) }
  if (typeof msg.method === 'string') h['mcp-method'] = encodeHeaderValue(msg.method)
  if (typeof msg.method === 'string' && NAMED_METHODS.has(msg.method) && typeof params.name === 'string') {
    h['mcp-name'] = encodeHeaderValue(params.name)
  }
  return h
}
