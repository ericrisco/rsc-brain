// The rest of the administration in the fixture API (B6 PR25b): the installation's settings (name, limit
// per key, the address of RSC Factory) saved field by field on what was read; mail with a write-only
// password, a test mail and its failures; meaning search with a provider's key that is never given back and
// processing that moves on each read; the audit, paged, and its download with the same rows; the health of
// the service; the logo. In the server's own words, and checked against the description like the rest.
import { createHash } from 'node:crypto'
import { imageInfo } from '../../../src/core/images.ts'
import { csvCell } from '../../../src/domain/auditlog.ts'

export type Answer = {
  status: number
  body: unknown
  headers?: Record<string, string>
  // Bytes or text sent as they are (the logo, the CSV of the audit).
  raw?: Buffer | string
}
type Who = { id: string; name: string; email: string; isAdmin: boolean } | null
export type AdminScen = {
  name: string
  factoryUrl: string | null
  mail: boolean
  accounts: Array<{ id: string; name: string; email: string }>
  brains: Array<{ slug: string }>
  // The states forced on the scenario's screens.
  states: ReadonlyMap<string, string>
}
export type AdminCtx = {
  s: AdminScen
  params: Record<string, string>
  query: URLSearchParams
  body: Record<string, unknown>
  who: Who
  web: boolean
}

type MailLine = { at: string; to: string; kind: string; status: string; error: string | null }
type Row = {
  id: string
  at: string
  actor: { id: string; name: string | null } | null
  key: string | null
  action: string
  brain: string | null
  target: string | null
  outcome: string
  detail: string
}
type Fx = {
  rateLimit: number
  mail: {
    host: string
    port: number
    secure: boolean
    user: string | null
    password: boolean
    version: number
    from: { name: string; address: string }
  } | null
  log: MailLine[]
  meaning: {
    enabled: boolean
    provider: string | null
    acceptedAt: string | null
    done: number
    total: number
    offReason?: string | null
  }
  openai: { last4: string } | null
  ollama: { url: string } | null
  logo: { bytes: Buffer; type: string; sha: string; at: string } | null
  audit: Row[]
  started: string
}

const err = (status: number, code: string, message: string, howToProceed: string): Answer => ({
  status,
  body: { error: { code, message, howToProceed } },
})
const ADMIN_ONLY = err(
  403,
  'forbidden',
  'Only the administration of this installation does this.',
  'Ask an administrator.',
)
const CSRF = err(
  403,
  'csrf',
  'This request lacks the header of the rsc-brain web.',
  'Use the rsc-brain web to do this.',
)
const invalid = (message: string, how: string) => err(400, 'invalid_request', message, how)
const changed = (moved: string[], current: unknown): Answer => ({
  status: 409,
  body: {
    error: {
      code: 'settings_changed',
      message: `Someone changed ${moved.join(', ')} since you read ${moved.length === 1 ? 'it' : 'them'}.`,
      howToProceed: 'Read the current values in "current", then save your change again on top of them.',
      current,
    },
  },
})

const WARNING =
  'The text of entries and pages will be sent to this provider to compute its meaning. What is sent cannot be taken back.'
const MIN = 60
const MAX = 10_000
const LOCAL = new Set(['localhost', '127.0.0.1', '[::1]'])
const SAFE_URL = /^https?:\/\/[a-z0-9.-]+(:\d{1,5})?(\/[A-Za-z0-9._~/-]*)?$/
const ACTIONS = [
  'member.add',
  'member.role',
  'invitation.create',
  'invitation.resend',
  'key.main.create',
  'key.revoke',
  'settings.update',
  'account.update',
  'audit.export',
  'brain.archive',
]

function seedAudit(s: AdminScen): Row[] {
  const people = s.accounts.length ? s.accounts : [{ id: 'acc_eric', name: 'Eric', email: '' }]
  const brains = s.brains.length ? s.brains.map((b) => b.slug) : ['growth']
  // Hourly from 10:30 UTC on 29 October back: line 11 is at 23:30 UTC on the 28th (00:30 in Madrid).
  const start = Date.parse('2026-10-29T10:30:00.000Z')
  // A few pages only in the «much-data» state of the audit (230 lines); otherwise 60, one page.
  const n = s.states.get('admin-audit') === 'much-data' ? 230 : 60
  return Array.from({ length: n }, (_, i) => {
    const who = people[i % people.length] as { id: string; name: string }
    const action = ACTIONS[i % ACTIONS.length] as string
    return {
      id: String(1000 + n - i),
      at: new Date(start - i * 3_600_000).toISOString(),
      actor: { id: who.id, name: who.name },
      key: `crd_web${i % 3}`,
      action,
      brain:
        action.startsWith('member.') || action === 'brain.archive'
          ? (brains[i % brains.length] as string)
          : null,
      target: i === 7 ? '=HYPERLINK("http://evil.example")' : `t_${i}`,
      outcome: i % 17 === 0 ? 'denied' : 'ok',
      detail: i % 13 === 5 ? '+1 from a formula' : `line ${i}`,
    }
  })
}

const fxs = new WeakMap<AdminScen, Fx>()
export function fxOf(s: AdminScen): Fx {
  let f = fxs.get(s)
  if (!f) {
    f = {
      rateLimit: 600,
      mail: s.mail
        ? {
            host: 'smtp.example.test',
            port: 587,
            secure: false,
            user: 'brain',
            password: true,
            version: 1,
            from: { name: '', address: 'brain@example.test' },
          }
        : null,
      log: [
        {
          at: '2026-10-29T09:12:00.000Z',
          to: 'carla@example.test',
          kind: 'invitation',
          status: 'failed',
          error: 'timeout',
        },
        {
          at: '2026-10-29T08:40:00.000Z',
          to: 'dan@example.test',
          kind: 'invitation',
          status: 'skipped',
          error: 'mail is not set up',
        },
        {
          at: '2026-10-29T09:00:00.000Z',
          to: 'ana@example.test',
          kind: 'proposal',
          status: 'sent',
          error: null,
        },
      ],
      meaning: { enabled: false, provider: null, acceptedAt: null, done: 0, total: 0 },
      openai: null,
      ollama: null,
      logo: null,
      audit: seedAudit(s),
      started: '2026-10-29T08:00:00.000Z',
    }
    fxs.set(s, f)
  }
  return f
}

// Another administrator changes something meanwhile (a conflict of a save).
export function adminBehind(s: AdminScen, change: Record<string, unknown>): void {
  const f = fxOf(s)
  if (typeof change.rateLimit === 'number') f.rateLimit = change.rateLimit
  if (typeof change.name === 'string') s.name = change.name
  if (change.factoryUrl !== undefined) s.factoryUrl = (change.factoryUrl as string | null) ?? null
  if (typeof change.mailHost === 'string' && f.mail) f.mail.host = change.mailHost
}

const settingsView = (s: AdminScen) => {
  const f = fxOf(s)
  return {
    name: s.name,
    publicUrl: 'http://127.0.0.1',
    curatorsInvite: false,
    rateLimit: f.rateLimit,
    rateLimitDefault: 600,
    rateLimitMin: MIN,
    rateLimitMax: MAX,
    factoryUrl: s.factoryUrl,
  }
}

function factoryOf(v: unknown): string | null | Answer {
  if (v === null) return null
  const how = 'Give the address of RSC Factory, such as https://factory.example.com, or null for none.'
  if (typeof v !== 'string' || !v.trim()) return invalid('"factoryUrl" is the address of RSC Factory.', how)
  const raw = v.trim()
  let u: URL
  try {
    u = new URL(raw)
  } catch {
    return invalid('"factoryUrl" is not an address.', how)
  }
  const local = u.protocol === 'http:' && LOCAL.has(u.hostname)
  if (
    (u.protocol !== 'https:' && !local) ||
    u.username ||
    u.password ||
    raw.includes('?') ||
    raw.includes('#')
  )
    return invalid(
      '"factoryUrl" must be an https address (or http on this machine), without credentials, query or fragment.',
      how,
    )
  const out = u.toString().replace(/\/+$/, '')
  if (!SAFE_URL.test(out))
    return invalid('"factoryUrl" may only hold letters, digits and . - _ ~ / : in its host and path.', how)
  return out
}

const baseProblem = (v: unknown, fields: string[]) =>
  v !== undefined &&
  (v === null || typeof v !== 'object' || Array.isArray(v) || Object.keys(v).some((k) => !fields.includes(k)))

function mailBase(f: Fx) {
  const m = f.mail
  return {
    configured: m !== null,
    host: m?.host ?? null,
    port: m?.port ?? null,
    secure: m?.secure ?? null,
    user: m?.user ?? null,
    fromName: m?.from.name ?? null,
    fromAddress: m?.from.address ?? null,
    hasPassword: Boolean(m?.password),
    passwordVersion: m?.version ?? 0,
  }
}
function mailView(f: Fx) {
  const b = mailBase(f)
  return {
    configured: f.mail !== null,
    settings: f.mail
      ? {
          host: f.mail.host,
          port: f.mail.port,
          secure: f.mail.secure,
          user: f.mail.user,
          hasPassword: b.hasPassword,

          from: f.mail.from,
        }
      : null,
    base: b,
    recent: f.log.slice(0, 50),
    failures: f.log.filter((l) => l.status !== 'sent').slice(0, 20),
  }
}

function meaningView(s: AdminScen) {
  const f = fxOf(s)
  const m = f.meaning
  return {
    enabled: m.enabled,
    provider: m.provider,
    model:
      m.provider === 'openai'
        ? 'text-embedding-3-small@256'
        : m.provider === 'ollama'
          ? 'nomic-embed-text'
          : null,
    acceptedBy: m.enabled ? 'acc_eric' : null,
    acceptedAt: m.acceptedAt,
    available: [...(f.openai ? ['openai'] : []), ...(f.ollama ? ['ollama'] : [])],
    providers: [
      {
        name: 'openai',
        label: 'OpenAI',
        needs: 'key',
        source: f.openai ? 'settings' : null,
        last4: f.openai?.last4 ?? null,
        url: null,
        urlHidden: false,
        unreadable: false,
        model: f.openai ? 'text-embedding-3-small@256' : null,
      },
      {
        name: 'ollama',
        label: 'Ollama',
        needs: 'url',
        source: f.ollama ? 'settings' : null,
        last4: null,
        url: f.ollama?.url ?? null,
        urlHidden: false,
        unreadable: false,
        model: f.ollama ? 'nomic-embed-text' : null,
      },
    ],
    offReason: m.enabled ? null : (m.offReason ?? null),
    warning: WARNING,
    progress: m.enabled ? { done: m.done, total: m.total } : null,
  }
}

function logoRef(f: Fx) {
  return f.logo ? { url: `/v1/branding/logo?v=${f.logo.sha.slice(0, 12)}`, updatedAt: f.logo.at } : null
}

function auditRows(c: AdminCtx): Row[] | Answer {
  const f = fxOf(c.s)
  const q = c.query
  const time = (k: string) => {
    const v = q.get(k)
    if (!v) return null
    const t = Date.parse(v)
    return Number.isNaN(t) ? Number.NaN : t
  }
  const from = time('from')
  const to = time('to')
  if (Number.isNaN(from) || Number.isNaN(to))
    return invalid('"from" is a date or time.', 'Such as 2026-10-29 or 2026-10-29T10:00:00Z.')
  const action = q.get('action')
  return f.audit.filter(
    (r) =>
      (!action || (action.endsWith('.') ? r.action.startsWith(action) : r.action === action)) &&
      (!q.get('actor') || r.actor?.id === q.get('actor')) &&
      (!q.get('brain') || r.brain === q.get('brain')) &&
      (!q.get('outcome') || r.outcome === q.get('outcome')) &&
      (from === null || Date.parse(r.at) >= from) &&
      (to === null || Date.parse(r.at) < to) &&
      (!q.get('upTo') || Number(r.id) <= Number(q.get('upTo'))),
  )
}

const audited = (c: AdminCtx, action: string, detail: string) => {
  const f = fxOf(c.s)
  const top = Number(f.audit[0]?.id ?? 1000) + 1
  f.audit.unshift({
    id: String(top),
    at: new Date().toISOString(),
    actor: c.who ? { id: c.who.id, name: c.who.name } : null,
    key: 'crd_web0',
    action,
    brain: null,
    target: 'installation',
    outcome: 'ok',
    detail,
  })
}

type Op = { screen?: string; run: (c: AdminCtx) => Answer }
const admin =
  (run: (c: AdminCtx) => Answer, o: { write?: boolean } = {}) =>
  (c: AdminCtx): Answer => {
    if (o.write && !c.web) return CSRF
    if (!c.who?.isAdmin) return ADMIN_ONLY
    return run(c)
  }

export const ADMIN_OPS: Record<string, Op> = {
  'GET /v1/admin/settings': {
    screen: 'admin-settings',
    run: admin(({ s }) => ({ status: 200, body: settingsView(s) })),
  },
  'PUT /v1/admin/settings': {
    screen: 'admin-settings',
    run: admin(
      (c) => {
        const { s, body: b } = c
        const f = fxOf(s)
        const fields = ['name', 'curatorsInvite', 'rateLimit', 'factoryUrl']
        if (baseProblem(b.base, fields))
          return invalid(
            `"base" holds what each field was when you read it: ${fields.join(', ')}.`,
            'Send the values you read, or leave "base" out.',
          )
        const lim = b.rateLimit
        if (
          lim !== undefined &&
          (typeof lim !== 'number' || !Number.isInteger(lim) || lim < MIN || lim > MAX)
        )
          return invalid(
            `"rateLimit" is the requests per minute of each key: a whole number from ${MIN} to ${MAX}.`,
            'Fix "rateLimit" (the default is 600).',
          )
        let name: string | undefined
        if (b.name !== undefined) {
          name = typeof b.name === 'string' ? b.name.trim() : ''
          if (!name || name.length > 80)
            return invalid('The installation name has 1 to 80 characters.', 'Shorten it.')
        }
        let factory: string | null | undefined
        if (b.factoryUrl !== undefined) {
          const got = factoryOf(b.factoryUrl)
          if (got !== null && typeof got === 'object') return got
          factory = got
        }
        const now = settingsView(s) as Record<string, unknown>
        const base = (b.base ?? null) as Record<string, unknown> | null
        if (base) {
          const moved = Object.keys(base).filter((k) => now[k] !== base[k])
          if (moved.length) return changed(moved, now)
        }
        const next: Record<string, unknown> = {}
        if (name !== undefined && name !== s.name) next.name = name
        if (lim !== undefined && lim !== f.rateLimit) next.rateLimit = lim
        if (factory !== undefined && factory !== s.factoryUrl) next.factoryUrl = factory
        if (!Object.keys(next).length)
          return { status: 200, body: { ...now, ...(base ? { unchanged: true } : {}) } }
        if (next.name !== undefined) s.name = next.name as string
        if (next.rateLimit !== undefined) f.rateLimit = next.rateLimit as number
        if (next.factoryUrl !== undefined) s.factoryUrl = next.factoryUrl as string | null
        audited(c, 'settings.update', JSON.stringify(next))
        return { status: 200, body: settingsView(s) }
      },
      { write: true },
    ),
  },
  'GET /v1/admin/mail': {
    screen: 'admin-email',
    // Empty: mail never set up, so nothing has failed either.
    run: admin(({ s }) =>
      s.states.get('admin-email') === 'empty'
        ? {
            status: 200,
            body: { ...mailView(fxOf(s)), configured: false, settings: null, recent: [], failures: [] },
          }
        : { status: 200, body: mailView(fxOf(s)) },
    ),
  },
  'PUT /v1/admin/mail': {
    screen: 'admin-email',
    run: admin(
      (c) => {
        const f = fxOf(c.s)
        const b = c.body
        const fields = [
          'configured',
          'host',
          'port',
          'secure',
          'user',
          'fromName',
          'fromAddress',
          'hasPassword',
          'passwordVersion',
        ]
        if (baseProblem(b.base, fields))
          return invalid('"base" is the "base" of GET /v1/admin/mail.', 'Send it as you read it.')
        const host = typeof b.host === 'string' ? b.host.trim() : ''
        if (!host || /[\s/]/.test(host))
          return invalid('"host" is the name of the mail server.', 'Such as smtp.example.com.')
        const port = b.port ?? 587
        if (typeof port !== 'number' || !Number.isInteger(port) || port < 1 || port > 65535)
          return invalid('"port" is a number from 1 to 65535.', 'Usually 587, or 465 with "secure".')
        const from = typeof b.fromAddress === 'string' ? b.fromAddress.trim() : ''
        if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(from))
          return invalid('"fromAddress" is the email mail is sent from.', 'Such as brain@example.com.')
        const was = mailBase(f) as Record<string, unknown>
        const base = (b.base ?? null) as Record<string, unknown> | null
        if (base) {
          const moved = Object.keys(base).filter((k) => was[k] !== base[k])
          if (moved.length) return changed(moved, mailView(f))
        }
        const typed = typeof b.password === 'string' && b.password !== ''
        const keep = b.password === undefined || (!typed && !f.mail?.password)
        const user = typeof b.user === 'string' && b.user ? b.user : null
        if (
          keep &&
          f.mail?.password &&
          (f.mail.host !== host || f.mail.port !== port || f.mail.user !== user)
        )
          return invalid(
            'The mail password belongs to the server, port and user it was set for.',
            'Type the password again for the new server (or remove it, if the new one needs none).',
          )
        const version = f.mail?.version ?? 0
        const next = {
          host,
          port,
          secure: b.secure === true,
          user,
          password: keep ? Boolean(f.mail?.password) : typed,
          version: keep ? version : version + 1,
          from: { name: typeof b.fromName === 'string' ? b.fromName.trim() : '', address: from },
        }
        const before = f.mail
        f.mail = next
        if (before && keep && JSON.stringify(mailBase(f)) === JSON.stringify(was))
          return { status: 200, body: { ...mailView(f), ...(base ? { unchanged: true } : {}) } }
        c.s.mail = true
        audited(c, 'settings.mail', `${host}:${port} from ${from}`)
        return { status: 200, body: mailView(f) }
      },
      { write: true },
    ),
  },
  'DELETE /v1/admin/mail': {
    screen: 'admin-email',
    run: admin(
      (c) => {
        const f = fxOf(c.s)
        f.mail = null
        c.s.mail = false
        audited(c, 'settings.mail', 'removed')
        return { status: 200, body: mailView(f) }
      },
      { write: true },
    ),
  },
  'POST /v1/admin/mail/test': {
    screen: 'admin-email',
    run: admin(
      (c) => {
        const f = fxOf(c.s)
        if (!f.mail)
          return err(409, 'mail_not_set_up', 'Mail is not set up.', 'Save the mail settings first.')
        const to = typeof c.body.to === 'string' && c.body.to ? c.body.to : (c.who?.email ?? '')
        const down = f.mail.host.startsWith('down.')
        const error = down ? 'server not found' : null
        f.log.unshift({
          at: new Date().toISOString(),
          to,
          kind: 'test',
          status: down ? 'failed' : 'sent',
          error,
        })
        return { status: 200, body: { sent: !down, error } }
      },
      { write: true },
    ),
  },
  'GET /v1/admin/meaning': {
    screen: 'admin-meaning',
    run: admin(({ s }) => {
      const m = fxOf(s).meaning
      // Processing moves on a quarter at each read, as the server's loop would between two looks.
      if (m.enabled && m.done < m.total) m.done = Math.min(m.total, m.done + Math.ceil(m.total / 4))
      return { status: 200, body: meaningView(s) }
    }),
  },
  'PUT /v1/admin/meaning': {
    screen: 'admin-meaning',
    run: admin(
      (c) => {
        const f = fxOf(c.s)
        const p = String(c.body.provider ?? '')
        const has = (p === 'openai' && f.openai) || (p === 'ollama' && f.ollama)
        if (!has)
          return invalid(
            `The provider "${p}" is not configured in this installation.`,
            'Set a key or address in Admin › Meaning search (or RSC_BRAIN_OPENAI_KEY or RSC_BRAIN_OLLAMA_URL for the server), then try again.',
          )
        if (c.body.accept !== true) {
          return {
            status: 400,
            body: {
              error: {
                code: 'invalid_request',
                message: 'Meaning search stays off until the warning is accepted.',
                howToProceed: 'Read the warning and send "accept": true.',
                current: { warning: WARNING },
              },
            },
          }
        }
        f.meaning = { enabled: true, provider: p, acceptedAt: new Date().toISOString(), done: 0, total: 3400 }
        audited(c, 'meaning.enable', `${p}; warning accepted`)
        return { status: 200, body: meaningView(c.s) }
      },
      { write: true },
    ),
  },
  'DELETE /v1/admin/meaning': {
    screen: 'admin-meaning',
    run: admin(
      (c) => {
        fxOf(c.s).meaning.enabled = false
        fxOf(c.s).meaning.offReason = null
        audited(c, 'meaning.disable', '')
        return { status: 200, body: meaningView(c.s) }
      },
      { write: true },
    ),
  },
  'PUT /v1/admin/meaning/providers/{name}': {
    screen: 'admin-meaning',
    run: admin(
      (c) => {
        const f = fxOf(c.s)
        const name = c.params.name
        if (name === 'openai') {
          const key = c.body.key
          if (typeof key !== 'string' || key.length < 20 || key.length > 300 || /\s/.test(key))
            return invalid(
              '"key" is the API key of the provider, as it gave it.',
              'Paste the whole key, without spaces.',
            )
          f.openai = { last4: key.slice(-4) }
        } else if (name === 'ollama') {
          const url = typeof c.body.url === 'string' ? c.body.url.trim().replace(/\/+$/, '') : ''
          if (!/^https?:\/\/[^\s/?#@]+(\/[^\s?#]*)?$/.test(url))
            return invalid(
              '"url" is the address of the provider, such as http://localhost:11434.',
              'Give a plain http or https address.',
            )
          f.ollama = { url }
        } else
          return err(
            404,
            'not_found',
            'No meaning provider with that id is available to you.',
            'Check the meaning provider id.',
          )
        // A new destination for the provider in use: off, and the warning to accept again.
        if (f.meaning.enabled && f.meaning.provider === name) {
          f.meaning = {
            ...f.meaning,
            enabled: false,
            acceptedAt: null,
            offReason: `Turned off: the key or address of ${name} changed in the administration. Accept the warning again to turn it on.`,
          }
          audited(c, 'meaning.disable', `${name}: its key or address changed`)
        }
        audited(c, 'meaning.provider', `${name}: set`)
        return { status: 200, body: meaningView(c.s) }
      },
      { write: true },
    ),
  },
  'DELETE /v1/admin/meaning/providers/{name}': {
    screen: 'admin-meaning',
    run: admin(
      (c) => {
        const f = fxOf(c.s)
        const name = c.params.name
        if (name !== 'openai' && name !== 'ollama')
          return err(
            404,
            'not_found',
            'No meaning provider with that id is available to you.',
            'Check the meaning provider id.',
          )
        if (f.meaning.enabled && f.meaning.provider === name)
          return err(
            409,
            'provider_in_use',
            `Meaning search is on with ${name}: without its ${name === 'openai' ? 'key' : 'address'} it would stop.`,
            'Turn meaning search off first, or set a new one in its place.',
          )
        if (name === 'openai') f.openai = null
        else f.ollama = null
        audited(c, 'meaning.provider', `${name}: removed`)
        return { status: 200, body: meaningView(c.s) }
      },
      { write: true },
    ),
  },
  'GET /v1/admin/audit': {
    screen: 'admin-audit',
    run: admin((c) => {
      const rows = auditRows(c)
      if (!Array.isArray(rows)) return rows
      const before = c.query.get('before')
      const from = before ? rows.filter((r) => Number(r.id) < Number(before)) : rows
      const page = from.slice(0, 100)
      return {
        status: 200,
        body: {
          items: page,
          next: from.length > 100 ? (page.at(-1)?.id ?? null) : null,
          upTo: fxOf(c.s).audit[0]?.id ?? '0',
        },
      }
    }),
  },
  'GET /v1/admin/audit/export': {
    run: admin((c) => {
      const rows = auditRows(c)
      if (!Array.isArray(rows)) return rows
      const head = 'id,at,actor_id,actor_name,key,action,brain,target,outcome,detail'
      const lines = rows.map((r) =>
        [
          r.id,
          r.at,
          r.actor?.id ?? '',
          r.actor?.name ?? '',
          r.key,
          r.action,
          r.brain,
          r.target,
          r.outcome,
          r.detail,
        ]
          .map((v) => csvCell(v))
          .join(','),
      )
      audited(c, 'audit.export', `${rows.length} row(s)`)
      return {
        status: 200,
        body: null,
        raw: `${[head, ...lines].join('\r\n')}\r\n`,
        headers: {
          'content-type': 'text/csv; charset=utf-8',
          'content-disposition': `attachment; filename="brain-audit-${new Date().toISOString().slice(0, 10)}.csv"`,
          'x-audit-truncated': 'false',
        },
      }
    }),
  },
  'GET /v1/admin/system': {
    screen: 'admin-system',
    run: admin(({ s }) => {
      const f = fxOf(s)
      const failed = f.log.find((l) => l.status === 'failed')
      return {
        status: 200,
        body: {
          version: '0.1.0',
          startedAt: f.started,
          database: { ok: true, migration: '0020_branding_factory_keys' },
          meaning: {
            enabled: f.meaning.enabled,
            provider: f.meaning.enabled ? f.meaning.provider : null,
            progress: f.meaning.enabled ? { done: f.meaning.done, total: f.meaning.total } : null,
          },
          streams: { open: 2, max: 200 },
          mail: { configured: f.mail !== null, lastFailureAt: failed?.at ?? null },
        },
      }
    }),
  },
  'PUT /v1/admin/branding/logo': {
    run: admin(
      (c) => {
        const f = fxOf(c.s)
        const type = c.body.contentType
        const data = c.body.data
        if (typeof type !== 'string' || typeof data !== 'string' || !data)
          return invalid(
            'Send "contentType" and the image in "data", as base64.',
            'Such as {"contentType": "image/png", "data": "iVBOR…"}.',
          )
        const bytes = Buffer.from(data, 'base64')
        if (bytes.length > 2 * 1024 * 1024)
          return err(
            413,
            'image_too_large',
            'The logo is larger than 2 MB.',
            'Use a smaller image; a logo needs a few kilobytes.',
          )
        const how = 'Use a PNG, JPEG or WebP of at most 2 MB and 4096 pixels a side.'
        if (!['image/png', 'image/jpeg', 'image/webp'].includes(type))
          return err(
            422,
            'invalid_image',
            `A logo is a PNG, JPEG or WebP image, not "${type}". SVG is not accepted: it can carry scripts.`,
            how,
          )
        const info = imageInfo(bytes)
        if (!info) return err(422, 'invalid_image', 'This file is not a PNG, JPEG or WebP image.', how)
        if (info.type !== type)
          return err(422, 'invalid_image', `This file is a ${info.type}, not the ${type} it says.`, how)
        if (info.width > 4096 || info.height > 4096)
          return err(
            422,
            'invalid_image',
            `The logo is ${info.width} × ${info.height} pixels; at most 4096 a side.`,
            how,
          )
        f.logo = {
          bytes,
          type,
          sha: createHash('sha256').update(bytes).digest('hex'),
          at: new Date().toISOString(),
        }
        audited(c, 'branding.logo', `${type}, ${info.width} × ${info.height}`)
        return { status: 200, body: { logo: logoRef(f) } }
      },
      { write: true },
    ),
  },
  'DELETE /v1/admin/branding/logo': {
    run: admin(
      (c) => {
        fxOf(c.s).logo = null
        audited(c, 'branding.logo', 'removed')
        return { status: 200, body: { logo: null } }
      },
      { write: true },
    ),
  },
}

export const ADMIN_PRIVATE = Object.keys(ADMIN_OPS)

// G1 and G2 as the fixture answers them once a logo is set.
export const brandingLogo = (s: AdminScen) => logoRef(fxOf(s))
export function logoAnswer(s: AdminScen): Answer | null {
  const l = fxOf(s).logo
  if (!l) return null
  return {
    status: 200,
    body: null,
    raw: l.bytes,
    headers: {
      'content-type': l.type,
      'x-content-type-options': 'nosniff',
      'content-security-policy': "default-src 'none'; sandbox",
      etag: `"${l.sha}"`,
      'cache-control': 'no-cache',
    },
  }
}
