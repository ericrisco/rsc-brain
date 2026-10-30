// Checks an answer against the description of v1 (OpenAPI 3.1, as openapi() generates it): the status must
// be the documented one, a refusal must be the error envelope, and every required field must be there
// with its type. Extra fields are allowed (v1 may grow), as programs reading it must allow.
type S = Record<string, unknown>

function resolve(doc: S, s: S): S {
  const ref = s.$ref
  if (typeof ref !== 'string') return s
  const name = ref.replace('#/components/schemas/', '')
  return ((doc.components as S).schemas as Record<string, S>)[name] as S
}

const typeOf = (v: unknown) =>
  v === null ? 'null' : Array.isArray(v) ? 'array' : Number.isInteger(v) ? 'integer' : typeof v

function check(doc: S, schema: S, v: unknown, at: string, out: string[]): void {
  const s = resolve(doc, schema)
  const types = s.type === undefined ? [] : Array.isArray(s.type) ? (s.type as string[]) : [s.type as string]
  const t = typeOf(v)
  if (types.length && !types.includes(t) && !(t === 'integer' && types.includes('number'))) {
    out.push(`${at || 'body'}: ${t}, the description says ${types.join(' or ')}`)
    return
  }
  if (Array.isArray(s.enum) && !s.enum.includes(v))
    out.push(`${at}: ${JSON.stringify(v)} is not one of ${s.enum.join(', ')}`)
  if (t === 'object' && s.properties) {
    const o = v as Record<string, unknown>
    for (const k of (s.required as string[] | undefined) ?? [])
      if (!(k in o)) out.push(`${at || 'body'}: "${k}" is missing`)
    for (const [k, p] of Object.entries(s.properties as Record<string, S>))
      if (k in o) check(doc, p, o[k], at ? `${at}.${k}` : k, out)
  }
  if (t === 'array' && s.items) {
    for (const [i, x] of (v as unknown[]).entries()) check(doc, s.items as S, x, `${at}[${i}]`, out)
  }
}

// The problems of an answer, or [] when it fits the description of `method path`.
export function validate(doc: S, method: string, path: string, status: number, body: unknown): string[] {
  const paths = doc.paths as Record<string, Record<string, S>>
  // A literal path wins over a template ("/v1/invitations/look" over "/v1/invitations/{id}"), and the
  // template must have the method.
  const fits = (p: string) =>
    new RegExp(`^${p.replace(/\{address\}/g, '.+').replace(/\{\w+\}/g, '[^/]+')}$`).test(path) &&
    paths[p]?.[method.toLowerCase()] !== undefined
  const template = paths[path]?.[method.toLowerCase()]
    ? path
    : Object.keys(paths)
        .filter(fits)
        .sort((a, b) => (a.match(/\{/g)?.length ?? 0) - (b.match(/\{/g)?.length ?? 0))[0]
  const op = template ? paths[template]?.[method.toLowerCase()] : undefined
  if (!op) return [`the description has no ${method} ${path}`]
  const responses = op.responses as Record<string, S>
  const ok = Object.keys(responses).find((k) => k !== 'default')
  const out: string[] = []
  if (status >= 200 && status < 300) {
    if (String(status) !== ok) return [`${method} ${path}: answered ${status}, the description says ${ok}`]
    const content = (responses[ok] as S).content as Record<string, S> | undefined
    const schema = content?.['application/json']?.schema as S | undefined
    if (schema) check(doc, schema, body, '', out)
  } else {
    const content = (responses.default as S).content as Record<string, S>
    check(doc, content['application/json']?.schema as S, body, '', out)
  }
  return out
}
