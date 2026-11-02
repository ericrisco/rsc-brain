// The service's log (spec B7 «Salud y registros», CA17; plan §3.11). One JSON line per event, with a closed
// list of events and a closed list of fields, each of which can only hold what it is for: numbers, an HTTP
// method, a route as its template (never the real path, never a query), a code, a source file, a reference.
// So no line can carry the content of entries or pages, searched text, keys, passwords or authorization
// headers, whatever the caller passes: a field outside the list does not compile, and anything else throws.

export const LOG_EVENTS = [
  // The server is up (with its port), and stopping.
  'listening',
  'stopping',
  // One answered request: method, route template, status, milliseconds.
  'request',
  // A failure nobody expected: the reference given to the client, the error's code and where it happened.
  'internal_error',
  // An event stream that failed after its headers; the live feed that could not read events.
  'stream_error',
  'events_failed',
  // Stored secrets sealed again in the current format at start.
  'resealed',
  // A background sweep that failed (closing idle sessions, folding the trail, reminders, meaning).
  'sweep_failed',
  // A refusal during maintenance: the audit is not written then, so it is said here (action, account, brain).
  'access_denied',
  // The daily copy: made (milliseconds, how many old copies were removed), or failed (its code).
  'backup_done',
  'backup_failed',
  // A copy kept whole whose folder could not be flushed or whose status could not be saved (its code).
  'backup_kept_with_warning',
  // RSC_BRAIN_LOCAL_ONLY at start: whether the container's gateway was found (code gateway / no_gateway).
  'local_only',
] as const
export type LogEvent = (typeof LOG_EVENTS)[number]

export type LogFields = {
  status?: number | undefined
  ms?: number | undefined
  method?: string | undefined
  route?: string | undefined
  code?: string | undefined
  count?: number | undefined
  file?: string | undefined
  ref?: string | undefined
  port?: number | undefined
  action?: string | undefined
  outcome?: string | undefined
  account?: string | undefined
  brain?: string | undefined
}

const whole = (min: number, max: number) => (v: unknown) =>
  typeof v === 'number' && Number.isInteger(v) && v >= min && v <= max
const text = (re: RegExp) => (v: unknown) => typeof v === 'string' && re.test(v)

// What each field may hold. A route is a template: slashes, lowercase words, `:name` and `*name` parts.
const CHECKS: Record<keyof LogFields, (v: unknown) => boolean> = {
  status: whole(100, 599),
  ms: whole(0, 86_400_000),
  count: whole(0, Number.MAX_SAFE_INTEGER),
  port: whole(0, 65_535),
  method: text(/^[A-Z]{3,7}$/),
  route: text(/^(\/[a-z0-9._-]*|\/[:*][a-zA-Z]+)+$/),
  code: text(/^[A-Za-z0-9_.-]{1,64}$/),
  file: text(/^src\/[a-z0-9/_.-]+\.ts(:\d+)?$/),
  ref: text(/^[a-z0-9]{1,16}$/),
  // A refusal: what was asked (`brain.read`), how it ended, and the ids of who and where (never names).
  action: text(/^[a-z][a-z_]*(\.[a-z_]+)*$/),
  outcome: text(/^(ok|denied)$/),
  account: text(/^acc_[0-9a-f]{12}$/),
  brain: text(/^brn_[0-9a-f]{12}$/),
}
export const LOG_FIELDS = Object.keys(CHECKS) as Array<keyof LogFields>

export type Log = {
  info(event: LogEvent, fields?: LogFields): void
  warn(event: LogEvent, fields?: LogFields): void
  error(event: LogEvent, fields?: LogFields): void
}

export function makeLog(write: (line: string) => void, clock: () => Date = () => new Date()): Log {
  const line = (level: 'info' | 'warn' | 'error', event: LogEvent, fields: LogFields = {}) => {
    if (!LOG_EVENTS.includes(event)) throw new Error(`"${String(event)}" is not a log event.`)
    const out: Record<string, unknown> = { at: clock().toISOString(), level, event }
    for (const [k, v] of Object.entries(fields)) {
      if (!Object.hasOwn(CHECKS, k)) throw new Error(`"${k}" is not a log field.`)
      if (v === undefined) continue
      if (!CHECKS[k as keyof LogFields](v)) throw new Error(`The log field "${k}" cannot hold that value.`)
      out[k] = v
    }
    write(JSON.stringify(out))
  }
  return {
    info: (e, f) => line('info', e, f),
    warn: (e, f) => line('warn', e, f),
    error: (e, f) => line('error', e, f),
  }
}

// The log of `serve`: standard output, where a container's logs are read.
export const stdoutLog: Log = makeLog((l) => process.stdout.write(`${l}\n`))
// Tests that do not look at the log.
export const silentLog: Log = { info: () => {}, warn: () => {}, error: () => {} }

// What an unexpected failure may say in the log: the error's code (a PostgreSQL SQLSTATE, a system code) or
// its class, and the first place in this product's source where it happened. Never its message.
export function failureFields(err: unknown): Pick<LogFields, 'code' | 'file'> {
  const e = err as { code?: unknown; name?: unknown; stack?: unknown } | null
  const rawCode = typeof e?.code === 'string' ? e.code : typeof e?.name === 'string' ? e.name : 'unknown'
  const code = /^[A-Za-z0-9_.-]{1,64}$/.test(rawCode) ? rawCode : 'unknown'
  // Only the frames of the stack ("    at …" lines) after its first line, `${name}: ${message}`, which is cut
  // off whole: a message may quote anything, even text shaped like a frame.
  const first = err0(e)
  let stack = typeof e?.stack === 'string' ? e.stack : ''
  if (first.head && stack.startsWith(first.head)) stack = stack.slice(first.head.length)
  else stack = stack.split('\n').slice(1).join('\n')
  const frames = stack.split('\n').filter((l) => /^\s+at\s/.test(l))
  let frame: RegExpExecArray | null = null
  for (const l of frames) {
    frame = /(src\/[a-z0-9/_.-]+\.ts):(\d+)/.exec(l)
    if (frame) break
  }
  return { code, ...(frame ? { file: `${frame[1]}:${frame[2]}` } : {}) }
}

// The first line a stack starts with: "Name: message" (just "Name" without a message).
function err0(e: { name?: unknown; message?: unknown } | null): { head: string | null } {
  if (typeof e?.name !== 'string') return { head: null }
  const m = typeof e.message === 'string' ? e.message : ''
  return { head: m ? `${e.name}: ${m}` : e.name }
}
