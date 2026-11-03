// The one door of the web to the network (plan §3.2). Same-origin cookie; every write carries the header
// only the Brain web sends (B4, CSRF); every refusal arrives as { status, code, message, howToProceed }
// so a screen can always say what happened and what to do. A lost session leads to sign-in and back.
import { signInPath } from '../lib/nav.ts'
import { type OpName, ROUTE_TABLE } from './routes.ts'

export const WEB_HEADER = 'rsc-brain-web'

export class ApiError extends Error {
  readonly status: number
  readonly code: string
  readonly howToProceed: string
  readonly retryAfter: number | undefined
  // The current version after a conflict (an edit on a page that moved on), when the server sends it.
  readonly current: unknown
  // Everything wrong with a change checked as a whole, each with its operation.
  readonly problems: Array<{ op: number | null; message: string }>
  // The operations the problems are about (an old base names its operation without a message).
  readonly problemOps: number[]
  constructor(
    status: number,
    code: string,
    message: string,
    howToProceed: string,
    retryAfter?: number,
    extra: { current?: unknown; problems?: unknown } = {},
  ) {
    super(message)
    this.status = status
    this.code = code
    this.howToProceed = howToProceed
    this.retryAfter = retryAfter
    this.current = extra.current
    this.problemOps = Array.isArray(extra.problems)
      ? extra.problems.flatMap((p) => (typeof p?.op === 'number' ? [p.op] : []))
      : []
    this.problems = Array.isArray(extra.problems)
      ? extra.problems
          .filter((p): p is { op?: unknown; message: string } => typeof p?.message === 'string')
          .map((p) => ({ op: typeof p.op === 'number' ? p.op : null, message: p.message }))
      : []
  }
}

// The subset of fetch the client uses, so tests can stand in for the network.
export type Transport = (
  url: string,
  init: { method: string; headers: Record<string, string>; body?: string; credentials: 'same-origin' },
) => Promise<{
  status: number
  text(): Promise<string>
  // A download reads these (the browser's fetch has both).
  headers?: { get(name: string): string | null }
  body?: ReadableStream<Uint8Array> | null
}>

export type CallOptions = {
  path?: Record<string, string>
  query?: Record<string, string | number | boolean | undefined | null>
  body?: unknown
  // A 401 is reported to the caller without leading to sign-in (asking "who am I" at start).
  quiet?: boolean
}

// How a file goes up (an import): the browser's XMLHttpRequest, which says how much has been sent; tests stand in.
export type Upload = (
  url: string,
  init: { method: string; headers: Record<string, string>; body: Blob },
  progress?: (sent: number, total: number) => void,
) => Promise<{ status: number; text(): Promise<string> }>

// A file the server makes for the person to save (an export): its bytes, and the name the server gave it.
export type Downloaded = { blob: Blob; name: string; bytes: number }

export type Client = {
  call<T = Record<string, unknown>>(op: OpName, o?: CallOptions): Promise<T>
  // `progress` hears how many bytes have arrived so far.
  download(op: OpName, o?: CallOptions, progress?: (bytes: number) => void): Promise<Downloaded>
  // A file as the body of a write (an import's zip); `progress` hears how much of it has gone.
  upload<T = Record<string, unknown>>(
    op: OpName,
    o: CallOptions,
    file: Blob,
    progress?: (sent: number, total: number) => void,
  ): Promise<T>
}

const nameOf = (disposition: string | null | undefined) =>
  /filename="([^"]+)"/.exec(disposition ?? '')?.[1] ?? 'rsc-brain-export.zip'

function urlOf(route: string, o: CallOptions): { method: string; url: string } {
  const [method, template] = route.split(' ') as [string, string]
  const path = template.replace(/\{(\w+)\}/g, (_, k: string) => {
    const v = o.path?.[k]
    if (v === undefined) throw new Error(`missing path parameter ${k} for ${route}`)
    // A page address keeps its slashes; every other part is one segment.
    return k === 'address' ? v.split('/').map(encodeURIComponent).join('/') : encodeURIComponent(v)
  })
  const q = new URLSearchParams()
  for (const [k, v] of Object.entries(o.query ?? {}))
    if (v !== undefined && v !== null && v !== '') q.set(k, String(v))
  const qs = q.toString()
  return { method, url: qs ? `${path}?${qs}` : path }
}

function errorOf(status: number, text: string): ApiError {
  try {
    const e = (JSON.parse(text) as { error?: Record<string, unknown> }).error
    if (e && typeof e.code === 'string' && typeof e.message === 'string') {
      return new ApiError(
        status,
        e.code,
        e.message,
        typeof e.howToProceed === 'string' ? e.howToProceed : 'Try again.',
        typeof e.retryAfter === 'number' ? e.retryAfter : undefined,
        { current: e.current, problems: e.problems },
      )
    }
  } catch {
    // Not the envelope: a proxy or a server that is not Brain answered.
  }
  return new ApiError(
    status,
    'bad_answer',
    `rsc-brain answered with an unexpected reply (HTTP ${status}).`,
    'Try again in a moment; if it keeps failing, tell an administrator.',
  )
}

export function createClient(o: {
  transport: Transport
  upload?: Upload
  onSignedOut: (signInAddress: string) => void
  here: () => string
}): Client {
  const offline = () =>
    new ApiError(0, 'offline', 'rsc-brain could not be reached.', 'Check your connection and try again.')
  return {
    async upload<T>(
      op: OpName,
      c: CallOptions,
      file: Blob,
      progress?: (sent: number, total: number) => void,
    ) {
      const def = ROUTE_TABLE[op]
      const { method, url } = urlOf(def.route, c)
      if (!o.upload) throw offline()
      let res: Awaited<ReturnType<Upload>>
      try {
        res = await o.upload(
          url,
          {
            method,
            headers: {
              accept: 'application/json',
              'x-requested-with': WEB_HEADER,
              'content-type': 'application/zip',
            },
            body: file,
          },
          progress,
        )
      } catch {
        throw offline()
      }
      const text = await res.text()
      if (res.status >= 200 && res.status < 300) return (text ? JSON.parse(text) : {}) as T
      const err = errorOf(res.status, text)
      if (res.status === 401 && !c.quiet) o.onSignedOut(signInPath(o.here()))
      throw err
    },
    async download(op, c = {}, progress) {
      const def = ROUTE_TABLE[op]
      const { method, url } = urlOf(def.route, c)
      let res: Awaited<ReturnType<Transport>>
      try {
        res = await o.transport(url, { method, headers: {}, credentials: 'same-origin' })
      } catch {
        throw offline()
      }
      if (res.status < 200 || res.status >= 300) {
        const err = errorOf(res.status, await res.text())
        if (res.status === 401 && !c.quiet) o.onSignedOut(signInPath(o.here()))
        throw err
      }
      const parts: Array<Uint8Array<ArrayBuffer> | string> = []
      let bytes = 0
      try {
        if (res.body) {
          const reader = res.body.getReader()
          for (;;) {
            const { done, value } = await reader.read()
            if (done) break
            parts.push(value as Uint8Array<ArrayBuffer>)
            bytes += value.length
            progress?.(bytes)
          }
        } else {
          const text = await res.text()
          parts.push(text)
          bytes = new TextEncoder().encode(text).length
          progress?.(bytes)
        }
      } catch {
        // The connection was cut while the file came: what arrived is not the whole file.
        throw new ApiError(
          0,
          'download_cut',
          'The download stopped before the end.',
          'Try again; if it keeps stopping, tell an administrator.',
        )
      }
      return {
        blob: new Blob(parts, { type: 'application/zip' }),
        name: nameOf(res.headers?.get('content-disposition')),
        bytes,
      }
    },
    async call<T>(op: OpName, c: CallOptions = {}): Promise<T> {
      const def = ROUTE_TABLE[op]
      const { method, url } = urlOf(def.route, c)
      const headers: Record<string, string> = { accept: 'application/json' }
      const write = method !== 'GET' && method !== 'HEAD'
      if (write) headers['x-requested-with'] = WEB_HEADER
      const init: Parameters<Transport>[1] = { method, headers, credentials: 'same-origin' }
      if (c.body !== undefined) {
        headers['content-type'] = 'application/json'
        init.body = JSON.stringify(c.body)
      }
      let res: Awaited<ReturnType<Transport>>
      try {
        res = await o.transport(url, init)
      } catch {
        throw offline()
      }
      const text = await res.text()
      if (res.status >= 200 && res.status < 300) return (text ? JSON.parse(text) : {}) as T
      const err = errorOf(res.status, text)
      if (res.status === 401 && !('public' in def) && !c.quiet) o.onSignedOut(signInPath(o.here()))
      throw err
    },
  }
}
