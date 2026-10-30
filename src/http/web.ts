// The Brain web (spec B6 «Dónde vive la web», plan §3.1): the built single-page app in dist/web, served by
// the same process and origin as the API. The folder is read once, at start, into a list of the files
// it holds; nothing outside that list is ever read. The API's prefixes are never answered here, so an
// address a program uses can never turn into a web page.
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { extname, join, relative, sep } from 'node:path'

export const WEB_CSP =
  "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data: blob:; connect-src 'self'; worker-src 'self'; font-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'; object-src 'none'"

const SECURITY = {
  'content-security-policy': WEB_CSP,
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'same-origin',
  'x-frame-options': 'DENY',
}

const IMMUTABLE = 'public, max-age=31536000, immutable'

const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.webp': 'image/webp',
  '.jpg': 'image/jpeg',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
}

type WebFile = { type: string; body: Buffer; br?: Buffer; gz?: Buffer }
export type WebFiles = { kind: 'built'; files: Map<string, WebFile>; index: WebFile }
export type NotBuilt = { kind: 'not-built' }
export type WebReply = { status: number; headers: Record<string, string>; body: Buffer | string }

function* walk(dir: string): Generator<string> {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name)
    if (e.isDirectory()) yield* walk(p)
    else if (e.isFile()) yield p
  }
}

// Reads the built web once. Without index.html there is no web: the API still works.
export function openWeb(root: string): WebFiles | NotBuilt {
  if (!existsSync(join(root, 'index.html')) || !statSync(root).isDirectory()) return { kind: 'not-built' }
  const files = new Map<string, WebFile>()
  const all = [...walk(root)]
  const present = new Set(all)
  for (const p of all) {
    // The compressed copies travel with their original; they are never addressed on their own.
    if (p.endsWith('.br') || p.endsWith('.gz')) continue
    const url = `/${relative(root, p).split(sep).join('/')}`
    const file: WebFile = {
      type: TYPES[extname(p)] ?? 'application/octet-stream',
      body: readFileSync(p),
    }
    if (present.has(`${p}.br`)) file.br = readFileSync(`${p}.br`)
    if (present.has(`${p}.gz`)) file.gz = readFileSync(`${p}.gz`)
    files.set(url, file)
  }
  const index = files.get('/index.html') as WebFile
  return { kind: 'built', files, index }
}

// The prefixes of the API, the MCP endpoint and the standard sign-in: never the web (plan §0).
export function reserved(pathname: string): boolean {
  return (
    pathname === '/v1' ||
    pathname.startsWith('/v1/') ||
    pathname === '/mcp' ||
    pathname.startsWith('/mcp/') ||
    pathname === '/oauth' ||
    pathname.startsWith('/oauth/') ||
    pathname === '/.well-known' ||
    pathname.startsWith('/.well-known/')
  )
}

// The path as the API's router sees it (app.ts parses the request with the same base).
function normalised(rawPath: string): string {
  try {
    return new URL(rawPath, 'http://localhost').pathname
  } catch {
    return rawPath
  }
}

const notFound = (pathname: string): WebReply => ({
  status: 404,
  headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...SECURITY },
  body: JSON.stringify({
    error: {
      code: 'no_such_route',
      message: `Nothing at GET ${pathname.slice(0, 200)}.`,
      howToProceed: 'Check the path.',
    },
  }),
})

// A path that could climb out of the folder or confuse it is refused before anything is looked up.
const UNSAFE = /\.\.|\\|\0|%2e%2e|%00|%5c|%2f/i

// The encodings the browser accepts, without those it refuses with q=0.
function accepted(header: string): Set<string> {
  const out = new Set<string>()
  for (const part of header.split(',')) {
    const [name, ...params] = part.trim().toLowerCase().split(';')
    const q = params.map((x) => x.trim()).find((x) => x.startsWith('q='))
    if (name && (!q || Number(q.slice(2)) > 0)) out.add(name.trim())
  }
  return out
}

function fileReply(f: WebFile, cache: string, acceptEncoding: string): WebReply {
  const accepts = accepted(acceptEncoding)
  const headers: Record<string, string> = { 'content-type': f.type, 'cache-control': cache, ...SECURITY }
  if (f.br || f.gz) headers.vary = 'Accept-Encoding'
  if (f.br && accepts.has('br'))
    return { status: 200, headers: { ...headers, 'content-encoding': 'br' }, body: f.br }
  if (f.gz && accepts.has('gzip'))
    return { status: 200, headers: { ...headers, 'content-encoding': 'gzip' }, body: f.gz }
  return { status: 200, headers, body: f.body }
}

// What the web answers for a request, or 'pass' when the API should. `rawPath` is the path as the
// browser sent it, before any normalisation, so ".." cannot slip through.
export function answerWeb(
  web: WebFiles | NotBuilt,
  method: string,
  rawPath: string,
  acceptEncoding: string,
): WebReply | 'pass' {
  if (method !== 'GET' && method !== 'HEAD') return 'pass'
  const pathname = rawPath.split('?')[0] ?? '/'
  // The API routes on the WHATWG-normalised path ("/./v1/me", the absolute form "http://host/v1/me"),
  // so the check runs on that one too: what the API would answer never turns into a web page.
  if (reserved(pathname) || reserved(normalised(rawPath))) return 'pass'
  if (UNSAFE.test(pathname)) return notFound(pathname)
  if (web.kind === 'not-built') {
    return {
      status: 503,
      headers: { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store', ...SECURITY },
      body: 'The web is not built: run npm run build. The API at /v1 works without it.\n',
    }
  }
  if (pathname === '/assets' || pathname.startsWith('/assets/')) {
    const f = web.files.get(pathname)
    return f ? fileReply(f, IMMUTABLE, acceptEncoding) : notFound(pathname)
  }
  const f = pathname === '/' ? undefined : web.files.get(pathname)
  return fileReply(f ?? web.index, 'no-cache', acceptEncoding)
}
