// The logic of the rest of the administration (spec B6 «Admin»: Email, Meaning search, Limits, Audit,
// Backups & system, Branding; PR25b), out of the screens so it is tested on its own. Who may do what is the
// server's (B4); this decides what a save sends, what a field says before anything is sent, and how the
// audit's filters become the same rows on screen and in the download.
import { SAFE_URL } from './activity.ts'

export type InstallationRead = {
  name: string
  publicUrl: string | null
  curatorsInvite: boolean
  rateLimit: number
  rateLimitDefault: number
  rateLimitMin: number
  rateLimitMax: number
  factoryUrl: string | null
}
type InstallationEdit = Partial<{ name: string; rateLimit: number; factoryUrl: string | null }>
export type InstallationBody = Record<string, unknown> & { base: Record<string, unknown> }

// What a save of one part sends (per-field compare-and-set, like a brain's settings): in "base", what each
// field the part shows was when read, and beside it only the fields that changed. Nothing changed still
// goes, so the server says whether someone changed them since.
export function installationSave(read: InstallationRead, edit: InstallationEdit): InstallationBody {
  const out: InstallationBody = { base: {} }
  if (edit.name !== undefined) {
    out.base.name = read.name
    if (edit.name.trim() !== read.name) out.name = edit.name.trim()
  }
  if (edit.rateLimit !== undefined) {
    out.base.rateLimit = read.rateLimit
    if (edit.rateLimit !== read.rateLimit) out.rateLimit = edit.rateLimit
  }
  if (edit.factoryUrl !== undefined) {
    out.base.factoryUrl = read.factoryUrl
    const next = edit.factoryUrl?.trim() ? edit.factoryUrl.trim().replace(/\/+$/, '') : null
    if (next !== read.factoryUrl) out.factoryUrl = next
  }
  return out
}

const num = (s: string) => (/^-?\d+$/.test(s.trim()) ? Number(s.trim()) : Number.NaN)
const thousands = (n: number) => n.toLocaleString('en')

export function rateProblem(text: string, min: number, max: number): string | null {
  const v = num(text)
  if (Number.isInteger(v) && v >= min && v <= max) return null
  return `A whole number from ${thousands(min)} to ${thousands(max)}.`
}

const LOCAL = new Set(['localhost', '127.0.0.1', '[::1]'])

// The same rules as the server (src/domain/installation.ts factoryUrlOf); empty is none.
export function factoryProblem(text: string): string | null {
  const raw = text.trim()
  if (!raw) return null
  const how = 'Use an https address, such as https://factory.example.com (http only on this machine).'
  let u: URL
  try {
    u = new URL(raw)
  } catch {
    return how
  }
  const local = u.protocol === 'http:' && LOCAL.has(u.hostname)
  if (
    (u.protocol !== 'https:' && !local) ||
    u.username ||
    u.password ||
    raw.includes('?') ||
    raw.includes('#')
  )
    return how
  const out = u.toString().replace(/\/+$/, '')
  if (!SAFE_URL.test(out) || out.length > 300)
    return 'Only letters, digits and . - _ ~ / : in its host and path.'
  return null
}

export type MailForm = {
  host: string
  port: string
  secure: boolean
  user: string
  fromName: string
  fromAddress: string
}
// What the server compares a save with, as GET /v1/admin/mail gives it.
export type MailBase = {
  configured: boolean
  host: string | null
  port: number | null
  secure: boolean | null
  user: string | null
  fromName: string | null
  fromAddress: string | null
  hasPassword: boolean
  passwordLast4: string | null
}
// The password field: keep the one set, type a new one, or remove it.
export type PasswordChoice = { mode: 'keep' | 'replace' | 'remove'; value: string }

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

export function mailProblems(
  f: Pick<MailForm, 'host' | 'port' | 'fromAddress'>,
): Partial<Record<string, string>> {
  const out: Partial<Record<string, string>> = {}
  const host = f.host.trim()
  if (!host || host.length > 253 || /[\s/]/.test(host))
    out.host = 'The name of the mail server, such as smtp.example.com.'
  const port = num(f.port)
  if (!Number.isInteger(port) || port < 1 || port > 65535)
    out.port = 'A number from 1 to 65535: usually 587, or 465.'
  if (!EMAIL.test(f.fromAddress.trim()))
    out.fromAddress = 'The email mail is sent from, such as brain@example.com.'
  return out
}

export function mailSave(base: MailBase, f: MailForm, pw: PasswordChoice): Record<string, unknown> {
  return {
    base,
    host: f.host.trim(),
    port: num(f.port),
    secure: f.secure,
    user: f.user.trim() || null,
    fromName: f.fromName.trim(),
    fromAddress: f.fromAddress.trim(),
    ...(pw.mode === 'replace' ? { password: pw.value } : pw.mode === 'remove' ? { password: '' } : {}),
  }
}

export const LOGO_TYPES = ['image/png', 'image/jpeg', 'image/webp'] as const
export const LOGO_MAX_BYTES = 2 * 1024 * 1024

export function logoProblem(file: { type: string; size: number }): string | null {
  if (file.type === 'image/svg+xml')
    return 'SVG is not accepted: it can carry scripts. Export the logo as PNG or WebP.'
  if (!(LOGO_TYPES as readonly string[]).includes(file.type)) return 'Choose a PNG, JPEG or WebP image.'
  if (file.size > LOGO_MAX_BYTES) return 'The logo is larger than 2 MB; a logo needs a few kilobytes.'
  return null
}

export type AuditFilters = {
  actor: string
  action: string
  brain: string
  outcome: string
  from: string // YYYY-MM-DD, a local day
  to: string // YYYY-MM-DD, included
}
export type AuditQuery = Partial<Record<'actor' | 'action' | 'brain' | 'outcome' | 'from' | 'to', string>>

const dayStart = (ymd: string, plus = 0): string | undefined => {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(ymd)
  if (!m) return undefined
  return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]) + plus).toISOString()
}

// The filters as the server reads them: dates are whole days where the person is ("to" includes its day).
export function auditQuery(f: AuditFilters): AuditQuery {
  const q: AuditQuery = {}
  const put = (k: keyof AuditQuery, v: string | undefined) => {
    if (v?.trim()) q[k] = v.trim()
  }
  put('actor', f.actor)
  put('action', f.action)
  put('brain', f.brain)
  put('outcome', f.outcome)
  put('from', dayStart(f.from))
  put('to', dayStart(f.to, 1))
  return q
}

// The download asks for exactly the rows of the view: the same filters, all pages (never a page cursor).
export function auditExportHref(q: AuditQuery & { before?: string }): string {
  const p = new URLSearchParams()
  for (const k of ['actor', 'action', 'brain', 'outcome', 'from', 'to'] as const) {
    const v = q[k]
    if (v) p.set(k, v)
  }
  const s = p.toString()
  return `/v1/admin/audit/export${s ? `?${s}` : ''}`
}

export function secretLabel(set: boolean, last4: string | null): string {
  if (!set) return 'Not set'
  return last4 ? `Set, ends in …${last4}` : 'Set'
}

export function progressLabel(p: { done: number; total: number }): string {
  if (p.total === 0) return 'Nothing to process yet'
  if (p.done >= p.total) return `All ${thousands(p.total)} texts processed`
  return `${thousands(p.done)} of ${thousands(p.total)} texts processed (${Math.floor((p.done / p.total) * 100)}%)`
}
