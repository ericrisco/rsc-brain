// Reading request bodies and query strings with a clear message for each mistake.
import { invalid } from '../core/errors.ts'

export type Obj = Record<string, unknown>

export function obj(body: unknown): Obj {
  if (body === undefined || body === null) return {}
  if (typeof body !== 'object' || Array.isArray(body)) {
    throw invalid('The request body must be a JSON object.', 'Send a JSON object such as {"name": "…"}.')
  }
  return body as Obj
}

export function str(o: Obj, key: string, opt: { required?: boolean; max?: number } = {}): string | undefined {
  const v = o[key]
  if (v === undefined || v === null) {
    if (opt.required) throw invalid(`"${key}" is required.`, `Add "${key}" to the request.`)
    return undefined
  }
  if (typeof v !== 'string') throw invalid(`"${key}" must be a string.`, `Send "${key}" as text.`)
  if (opt.max !== undefined && v.length > opt.max) {
    throw invalid(`"${key}" is longer than ${opt.max} characters.`, `Shorten "${key}".`)
  }
  return v
}

export function reqStr(o: Obj, key: string, max?: number): string {
  return str(o, key, max === undefined ? { required: true } : { required: true, max }) as string
}

export function strList(
  o: Obj,
  key: string,
  opt: { maxItems?: number; maxLen?: number } = {},
): string[] | undefined {
  const v = o[key]
  if (v === undefined || v === null) return undefined
  if (!Array.isArray(v) || v.some((x) => typeof x !== 'string')) {
    throw invalid(`"${key}" must be a list of strings.`, `Send "${key}" as ["…", "…"].`)
  }
  if (opt.maxItems !== undefined && v.length > opt.maxItems) {
    throw invalid(`"${key}" has more than ${opt.maxItems} items.`, `Send at most ${opt.maxItems}.`)
  }
  const maxLen = opt.maxLen
  if (maxLen !== undefined && v.some((x) => (x as string).length > maxLen)) {
    throw invalid(`An item of "${key}" is longer than ${opt.maxLen} characters.`, 'Shorten it.')
  }
  return v as string[]
}

export function int(
  o: Obj,
  key: string,
  opt: { required?: boolean; min?: number; max?: number } = {},
): number | undefined {
  const v = o[key]
  if (v === undefined || v === null) {
    if (opt.required) throw invalid(`"${key}" is required.`, `Add "${key}" to the request.`)
    return undefined
  }
  if (typeof v !== 'number' || !Number.isInteger(v))
    throw invalid(`"${key}" must be a whole number.`, `Fix "${key}".`)
  if ((opt.min !== undefined && v < opt.min) || (opt.max !== undefined && v > opt.max)) {
    throw invalid(`"${key}" must be between ${opt.min} and ${opt.max}.`, `Fix "${key}".`)
  }
  return v
}

export function bool(o: Obj, key: string): boolean | undefined {
  const v = o[key]
  if (v === undefined || v === null) return undefined
  if (typeof v !== 'boolean') throw invalid(`"${key}" must be true or false.`, `Fix "${key}".`)
  return v
}

export function oneOf<T extends string>(
  o: Obj,
  key: string,
  values: readonly T[],
  required = false,
): T | undefined {
  const v = str(o, key, { required })
  if (v === undefined) return undefined
  if (!(values as readonly string[]).includes(v)) {
    throw invalid(`"${key}" must be one of: ${values.join(', ')}.`, `Use one of those values for "${key}".`)
  }
  return v as T
}

// Drops the keys whose value is undefined, so optional fields stay absent (exactOptionalPropertyTypes).
export type Compact<T> = { [K in keyof T as undefined extends T[K] ? never : K]: T[K] } & {
  [K in keyof T as undefined extends T[K] ? K : never]?: Exclude<T[K], undefined>
}
export function compact<T extends object>(o: T): Compact<T> {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as Compact<T>
}

// "to" a day includes the whole day: up to the next midnight, not included.
export const upTo = (d: Date | undefined, v: string | null) =>
  d === undefined ? {} : v?.length === 10 ? { before: new Date(d.getTime() + 86_400_000) } : { to: d }

export const flag = (v: string | null) => v === '1' || v === 'true'

// A date filter (UTC): a day ("2026-10-29") or a full ISO instant, between years 1 and 9999. A day
// that does not exist ("2026-02-31") is refused, not rolled over.
const DAY = /^(\d{4})-(\d{2})-(\d{2})(T([01]\d|2[0-3]):[0-5]\d(:[0-5]\d(\.\d{1,3})?)?(Z|[+-]\d{2}:\d{2}))?$/
export function day(v: string | null, field: string): Date | undefined {
  if (v === null || v === '') return undefined
  const m = DAY.exec(v)
  const d = new Date(v)
  const [y, mo, da] = [Number(m?.[1]), Number(m?.[2]), Number(m?.[3])]
  // The real year: 29 February exists only in leap years.
  const real = new Date(Date.UTC(2000, 0, 1))
  real.setUTCFullYear(y, mo - 1, da)
  if (
    !m ||
    Number.isNaN(d.getTime()) ||
    y < 1 ||
    real.getUTCMonth() !== mo - 1 ||
    real.getUTCDate() !== da ||
    d.getUTCFullYear() < 1 ||
    d.getUTCFullYear() > 9999
  )
    throw invalid(`"${field}" is not a date.`, 'Send a day like 2026-10-29, or an ISO instant.')
  return d
}
