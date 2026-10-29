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
