// Checks a tool call's arguments against the tool's own inputSchema, so what tools/list promises is what
// the server enforces. A small reader of the JSON Schema subset src/mcp/tools.ts uses: object, string,
// integer, number, boolean, array, enum, const, required, additionalProperties:false, bounds, pattern and
// oneOf told apart by a constant (the "op" of a wiki operation). Everything it finds comes back at once.
type Json = Record<string, unknown>

const isObject = (v: unknown): v is Json => typeof v === 'object' && v !== null && !Array.isArray(v)
const list = (xs: unknown[]) => xs.map(String).join(', ')

function describeType(s: Json): string {
  switch (s.type) {
    case 'string':
      return 'text'
    case 'integer':
      return 'a whole number'
    case 'number':
      return 'a number'
    case 'boolean':
      return 'true or false'
    case 'array':
      return 'a list'
    default:
      return 'an object'
  }
}

function typeOk(s: Json, v: unknown): boolean {
  switch (s.type) {
    case 'string':
      return typeof v === 'string'
    case 'integer':
      return typeof v === 'number' && Number.isInteger(v)
    case 'number':
      return typeof v === 'number' && Number.isFinite(v)
    case 'boolean':
      return typeof v === 'boolean'
    case 'array':
      return Array.isArray(v)
    case 'object':
      return isObject(v)
    default:
      return true
  }
}

// The property that tells the branches of a oneOf apart: one every branch fixes to a constant.
function discriminator(branches: Json[]): string | null {
  const first = branches[0]?.properties
  if (!isObject(first)) return null
  for (const key of Object.keys(first)) {
    if (
      branches.every(
        (b) => isObject(b.properties) && isObject(b.properties[key]) && 'const' in b.properties[key],
      )
    )
      return key
  }
  return null
}

function check(s: Json, v: unknown, at: string, out: string[]): void {
  if (Array.isArray(s.oneOf)) {
    const branches = s.oneOf as Json[]
    const key = discriminator(branches)
    if (key !== null && isObject(v)) {
      const names = branches.map((b) => ((b.properties as Json)[key] as Json).const)
      const chosen = v[key]
      if (chosen === undefined || chosen === null) {
        out.push(`"${at}.${key}" is missing: one of ${list(names)}.`)
        return
      }
      const hit = branches.find((b) => ((b.properties as Json)[key] as Json).const === chosen)
      if (!hit) {
        out.push(`"${at}.${key}" must be one of: ${list(names)}.`)
        return
      }
      check(hit, v, at, out)
      return
    }
    // No discriminator: it must fit exactly one branch.
    const fits = branches.filter((b) => {
      const p: string[] = []
      check(b, v, at, p)
      return p.length === 0
    })
    if (fits.length !== 1) out.push(`"${at}" does not match any of the shapes it may have.`)
    return
  }
  if ('const' in s) {
    if (v !== s.const) out.push(`"${at}" must be ${JSON.stringify(s.const)}.`)
    return
  }
  if (typeof s.type === 'string' && !typeOk(s, v)) {
    out.push(`"${at}" must be ${describeType(s)}.`)
    return
  }
  if (Array.isArray(s.enum) && !s.enum.includes(v)) {
    out.push(`"${at}" must be one of: ${list(s.enum)}.`)
    return
  }
  if (typeof v === 'string') {
    if (typeof s.maxLength === 'number' && v.length > s.maxLength)
      out.push(`"${at}" is longer than ${s.maxLength} characters.`)
    if (typeof s.minLength === 'number' && v.length < s.minLength)
      out.push(`"${at}" is shorter than ${s.minLength} characters.`)
    if (typeof s.pattern === 'string' && !new RegExp(s.pattern).test(v))
      out.push(`"${at}" is not in the form it needs (${s.pattern}).`)
  }
  if (typeof v === 'number') {
    if (typeof s.minimum === 'number' && v < s.minimum) out.push(`"${at}" must be at least ${s.minimum}.`)
    if (typeof s.maximum === 'number' && v > s.maximum) out.push(`"${at}" must be at most ${s.maximum}.`)
  }
  if (Array.isArray(v)) {
    if (typeof s.minItems === 'number' && v.length < s.minItems)
      out.push(`"${at}" needs at least ${s.minItems} item${s.minItems === 1 ? '' : 's'}.`)
    if (typeof s.maxItems === 'number' && v.length > s.maxItems)
      out.push(`"${at}" has at most ${s.maxItems} items.`)
    if (isObject(s.items)) {
      const items = s.items
      v.forEach((x, i) => {
        check(items, x, `${at}[${i}]`, out)
      })
    }
  }
  if (isObject(v) && isObject(s.properties)) {
    const props = s.properties
    const prefix = at ? `${at}.` : ''
    for (const r of (s.required as string[] | undefined) ?? []) {
      if (v[r] === undefined || v[r] === null) out.push(`"${prefix}${r}" is required.`)
    }
    if (s.additionalProperties === false) {
      for (const k of Object.keys(v)) {
        if (!(k in props))
          out.push(`Unknown field "${prefix}${k}"; the fields are: ${list(Object.keys(props))}.`)
      }
    }
    for (const [k, def] of Object.entries(props)) {
      const x = v[k]
      // An optional field sent as null is left out.
      if (x === undefined || x === null) continue
      if (isObject(def)) check(def, x, `${prefix}${k}`, out)
    }
  }
}

// The problems with these arguments, each a sentence naming the field; empty when they fit the schema.
export function validateArgs(schema: Json, args: Json): string[] {
  const out: string[] = []
  check(schema, args, '', out)
  return out
}
