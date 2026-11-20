// The one door of the web to the network (plan §3.2). Same-origin cookie; every write carries the header
// only the Brain web sends (B4, CSRF); every refusal arrives as { status, code, message, howToProceed }
// so a screen can always say what happened and what to do. A lost session leads to sign-in and back.
import { signInPath } from '../lib/nav.ts'
import { localizeMessage } from '../text.ts'
import { type OpName, ROUTE_TABLE } from './routes.ts'

export const WEB_HEADER = 'rsc-brain-web'

export class ApiError extends Error {
  readonly status: number
  readonly code: string
  readonly retryAfter: number | undefined
  // The current version after a conflict (an edit on a page that moved on), when the server sends it.
  readonly current: unknown
  // Everything wrong with a change checked as a whole, each with its operation.
  private readonly rawMessage: string
  private readonly rawHowToProceed: string
  private readonly rawProblems: Array<{ op: number | null; message: string }>
  // The operations the problems are about (an old base names its operation without a message).
  readonly problemOps: number[]
  // Where rsc-factory is, while it is to set this installation up (companion_pending); only a plain http(s) address.
  readonly factoryUrl: string | null
  constructor(
    status: number,
    code: string,
    message: string,
    howToProceed: string,
    retryAfter?: number,
    extra: { current?: unknown; problems?: unknown; factoryUrl?: unknown } = {},
  ) {
    super(message)
    this.rawMessage = message
    this.rawHowToProceed = howToProceed
    Object.defineProperty(this, 'message', {
      configurable: true,
      get: () => localizeMessage(this.rawMessage),
    })
    this.status = status
    this.code = code
    this.retryAfter = retryAfter
    this.current = extra.current
    this.factoryUrl =
      typeof extra.factoryUrl === 'string' && /^https?:\/\/[A-Za-z0-9.:/_~-]+$/.test(extra.factoryUrl)
        ? extra.factoryUrl
        : null
    this.problemOps = Array.isArray(extra.problems)
      ? extra.problems.flatMap((p) => (typeof p?.op === 'number' ? [p.op] : []))
      : []
    this.rawProblems = Array.isArray(extra.problems)
      ? extra.problems
          .filter((p): p is { op?: unknown; message: string } => typeof p?.message === 'string')
          .map((p) => ({ op: typeof p.op === 'number' ? p.op : null, message: p.message }))
      : []
  }

  get howToProceed(): string {
    return localizeMessage(this.rawHowToProceed)
  }

  get problems(): Array<{ op: number | null; message: string }> {
    return this.rawProblems.map((problem) => ({ ...problem, message: localizeMessage(problem.message) }))
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
        { current: e.current, problems: e.problems, factoryUrl: e.factoryUrl },
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

function answerOf(text: string): unknown {
  const value = text ? JSON.parse(text) : {}
  if (value?.cut && typeof value.partial === 'string') {
    throw new ApiError(
      200,
      'reply_cut',
      'The server sent an incomplete reply.',
      'Reload and try again. If it keeps failing, ask an administrator to update rsc-brain.',
    )
  }
  return value
}

// Render only after every part of the same snapshot has arrived.
async function wholeReply(
  kind: 'map' | 'review',
  first: unknown,
  next: (offset: number, snapshot: string) => Promise<unknown>,
): Promise<unknown> {
  const field = `${kind}Chunk`
  const bad = () =>
    new ApiError(
      200,
      'bad_answer',
      `The ${kind} could not be loaded completely.`,
      `Reload the ${kind} and try again.`,
    )
  let value = first as Partial<Record<typeof field, Record<string, unknown>>>
  if (!value?.[field]) return first
  let offset = 0
  let snapshot: string | undefined
  let total: number | undefined
  const parts: string[] = []
  for (;;) {
    const p = value?.[field]
    if (
      !p ||
      typeof p.text !== 'string' ||
      p.text.length === 0 ||
      p.offset !== offset ||
      typeof p.snapshot !== 'string' ||
      !/^[a-f0-9]{64}$/.test(p.snapshot) ||
      !Number.isSafeInteger(p.total) ||
      (p.total as number) <= 0 ||
      (snapshot !== undefined && p.snapshot !== snapshot) ||
      (total !== undefined && p.total !== total)
    )
      throw bad()
    snapshot = p.snapshot
    total = p.total as number
    parts.push(p.text)
    offset += p.text.length
    if (offset > total || (p.next === null ? offset !== total : p.next !== offset || offset >= total))
      throw bad()
    if (p.next === null) break
    value = (await next(offset, snapshot)) as typeof value
  }
  try {
    const result = JSON.parse(parts.join(''))
    if (kind === 'review') {
      if (!result?.proposal || !Array.isArray(result.ops) || typeof result.fingerprint !== 'string')
        throw bad()
    } else if (
      typeof result?.intro !== 'string' ||
      !Array.isArray(result.groups) ||
      !Number.isSafeInteger(result.count)
    )
      throw bad()
    return result
  } catch {
    throw bad()
  }
}

export function createClient(o: {
  transport: Transport
  upload?: Upload
  onSignedOut: (signInAddress: string) => void
  here: () => string
  // A request refused because the server is under maintenance (an update or a restore), with the seconds to wait.
  onMaintenance?: (retryAfter: number | undefined) => void
}): Client {
  const refused = (err: ApiError) => {
    if (err.code === 'under_maintenance') o.onMaintenance?.(err.retryAfter)
    return err
  }
  const offline = () =>
    new ApiError(0, 'offline', 'rsc-brain could not be reached.', 'Check your connection and try again.')
  const client: Client = {
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
      } catch (e) {
        // The server closed the connection before taking the file, and its answer did not come through.
        if ((e as Error).message === 'refused')
          throw new ApiError(
            0,
            'upload_refused',
            'The server refused the upload; reload to see why.',
            'Reload the page: it shows whether this brain can still be imported into.',
          )
        throw offline()
      }
      const text = await res.text()
      if (res.status >= 200 && res.status < 300) return answerOf(text) as T
      const err = refused(errorOf(res.status, text))
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
        const err = refused(errorOf(res.status, await res.text()))
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
      if (res.status >= 200 && res.status < 300) {
        const value = answerOf(text)
        return (
          (op === 'proposalReview' || op === 'wikiMap') && c.query?.offset === undefined
            ? await wholeReply(op === 'wikiMap' ? 'map' : 'review', value, (offset, snapshot) =>
                client.call(op, { ...c, query: { ...c.query, offset, snapshot } }),
              )
            : value
        ) as T
      }
      const err = refused(errorOf(res.status, text))
      if (res.status === 401 && !('public' in def) && !c.quiet) o.onSignedOut(signInPath(o.here()))
      throw err
    },
  }
  return client
}

// What an upload's network error means (review of PR32): a server that refuses early (a brain not empty, another
// import running) answers and closes while the file is still going. When its answer arrived, it is the answer;
// otherwise "refused", or "offline" when the browser knows it is.
export function xhrFailure(
  x: { status: number; responseText: string },
  online: boolean,
): { status: number; text: () => Promise<string> } | Error {
  if (x.status > 0) {
    const t = x.responseText
    return { status: x.status, text: async () => t }
  }
  return new Error(online ? 'refused' : 'offline')
}
