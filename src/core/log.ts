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
  const frame = typeof e?.stack === 'string' ? /(src\/[a-z0-9/_.-]+\.ts):(\d+)/.exec(e.stack) : null
  return { code, ...(frame ? { file: `${frame[1]}:${frame[2]}` } : {}) }
}
