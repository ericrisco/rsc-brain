// What is never stored (spec B1 «Privacidad», pack rule 1): text the client marks as private, and
// anything shaped like a secret. Applied to every text the server keeps, before anything else looks
// at it (duplicates and request keys compare the redacted text). The original is never kept.
import { KEY_SHAPE } from '../auth/secrets.ts'

export const PRIVATE_MARK = '[private removed]'
export const SECRET_MARK = '[redacted secret]'

type Rule = { name: string; re: RegExp; replace?: string }

// Shapes of real credentials. Each one is narrow enough not to eat ordinary hashes or ids: the
// tests keep a corpus of things that must survive (git SHAs, UUIDs, sha256, base64 ids).
const RULES: Rule[] = [
  {
    name: 'private-key',
    re: /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z0-9 ]*PRIVATE KEY-----|$)/g,
  },
  { name: 'anthropic', re: /\bsk-ant-[A-Za-z0-9_-]{20,}/g },
  { name: 'openai', re: /\bsk-(?:proj-|svcacct-|admin-)?[A-Za-z0-9_-]{20,}/g },
  { name: 'github', re: /\bgh[pousr]_[A-Za-z0-9]{36,}\b/g },
  { name: 'github-pat', re: /\bgithub_pat_[A-Za-z0-9_]{50,}/g },
  { name: 'gitlab', re: /\bglpat-[A-Za-z0-9_-]{20,}/g },
  { name: 'slack', re: /\bxox[abposr]-[A-Za-z0-9-]{10,}/g },
  { name: 'aws-access-key', re: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g },
  { name: 'google', re: /\bAIza[0-9A-Za-z_-]{35}\b/g },
  { name: 'stripe', re: /\b[rs]k_(?:live|test)_[0-9A-Za-z]{16,}/g },
  { name: 'replicate', re: /\br8_[A-Za-z0-9]{30,}/g },
  { name: 'huggingface', re: /\bhf_[A-Za-z0-9]{30,}/g },
  { name: 'npm', re: /\bnpm_[A-Za-z0-9]{36}\b/g },
  { name: 'sendgrid', re: /\bSG\.[A-Za-z0-9_-]{22}\.[A-Za-z0-9_-]{43}\b/g },
  { name: 'telegram-bot', re: /\b\d{8,10}:AA[A-Za-z0-9_-]{33}\b/g },
  { name: 'jwt', re: /\beyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g },
  { name: 'rsc-brain', re: new RegExp(KEY_SHAPE.source, 'g') },
  // user:password@ inside an address keeps the address and loses the password.
  {
    name: 'url-credentials',
    re: /\b([a-z][a-z0-9+.-]*:\/\/[^\s:@/]+):([^\s@/]+)@/gi,
    replace: `$1:${SECRET_MARK}@`,
  },
  // Authorization headers and "key = value" assignments keep their name and lose their value.
  {
    name: 'authorization',
    re: /(\bauthorization\s*[:=]\s*(?:bearer|basic|token)\s+)[A-Za-z0-9._~+/=-]{8,}/gi,
    replace: `$1${SECRET_MARK}`,
  },
  {
    name: 'assignment',
    re: /(\b(?:api[_-]?key|secret[_-]?key|client[_-]?secret|access[_-]?token|auth[_-]?token|password|passwd)\b\s*[:=]\s*)(["']?)[^\s"']{8,}\2/gi,
    replace: `$1${SECRET_MARK}`,
  },
]

export type Redacted = { text: string; redactions: number }

function removePrivate(text: string): { text: string; count: number } {
  let count = 0
  let out = text.replace(/<private>[\s\S]*?<\/private>/gi, () => {
    count += 1
    return PRIVATE_MARK
  })
  // An opening mark without its closing one hides everything after it: safer than keeping it.
  const open = out.search(/<private>/i)
  if (open !== -1) {
    out = `${out.slice(0, open)}${PRIVATE_MARK}`
    count += 1
  }
  return { text: out, count }
}

export function redact(text: string, extra: RegExp[] = []): Redacted {
  const p = removePrivate(text)
  let out = p.text
  let redactions = p.count
  const rules: Rule[] = [...RULES, ...extra.map((re, i) => ({ name: `extra-${i}`, re }))]
  for (const rule of rules) {
    out = out.replace(rule.re, (...args: unknown[]) => {
      redactions += 1
      if (!rule.replace) return SECRET_MARK
      // Expand $1/$2 against this match's groups.
      return rule.replace.replace(/\$(\d)/g, (_, n: string) => String(args[Number(n)] ?? ''))
    })
  }
  return { text: out, redactions }
}

// Redacts several fields at once and adds up the count.
export function redactAll<T extends Record<string, string | string[] | null | undefined>>(
  fields: T,
): { fields: T; redactions: number } {
  let redactions = 0
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(fields)) {
    if (v == null) out[k] = v
    else if (Array.isArray(v)) {
      out[k] = v.map((s) => {
        const r = redact(s)
        redactions += r.redactions
        return r.text
      })
    } else {
      const r = redact(v)
      redactions += r.redactions
      out[k] = r.text
    }
  }
  return { fields: out as T, redactions }
}

// The form two texts are compared in for duplicates: same letters, any case, any spacing.
export function normalize(text: string): string {
  return text.normalize('NFKC').toLowerCase().replace(/\s+/g, ' ').trim()
}
