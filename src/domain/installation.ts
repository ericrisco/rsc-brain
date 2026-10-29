// The installation (spec B4 «Asistente de primera vez»): its name and public address, whether the
// first-time setup is done, and the epoch every key belongs to. Until the setup is done every request
// leads to it; once done, the setup is no longer reachable.
import { checkPassword, hashPassword } from '../auth/password.ts'
import type { Clock } from '../core/clock.ts'
import { AppError, invalid } from '../core/errors.ts'
import type { Db } from '../db/db.ts'
import { createAccount } from './accounts.ts'
import { audit } from './audit.ts'
import { mintMainKey, mintWebSession } from './keys.ts'

export type ConnFacts = { encrypted: boolean; local: boolean; ip: string; userAgent: string }

export async function setupDone(db: Db): Promise<boolean> {
  const r = await db.one<{ done: boolean }>(
    'SELECT setup_done_at IS NOT NULL AS done FROM installation WHERE id = 1',
  )
  return Boolean(r?.done)
}

export async function installation(
  db: Db,
): Promise<{ name: string; publicUrl: string | null; curatorsInvite: boolean }> {
  const r = await db.one('SELECT name, public_url, curators_invite FROM installation WHERE id = 1')
  return {
    name: String(r?.name ?? ''),
    publicUrl: r?.public_url == null ? null : String(r.public_url),
    curatorsInvite: Boolean(r?.curators_invite),
  }
}

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]', '::1'])

// A public address that is neither local nor https: passwords would travel in clear (CA2).
export function insecureWarning(publicUrl: string | undefined | null): string | null {
  if (!publicUrl) return null
  let u: URL
  try {
    u = new URL(publicUrl)
  } catch {
    return null
  }
  if (u.protocol === 'https:' || LOCAL_HOSTS.has(u.hostname)) return null
  return (
    'This address is not local and not encrypted: passwords would travel in clear over the network. ' +
    'Give Brain a domain with HTTPS, open it on its local address (http://localhost), or reach it through a tunnel.'
  )
}

// Passwords and sessions only over an encrypted connection, or from this machine (spec B4 «Bordes»).
export function requireSecure(conn: ConnFacts): void {
  if (conn.encrypted || conn.local) return
  throw new AppError(
    403,
    'insecure_connection',
    'This connection is not encrypted, so Brain does not accept a password over it.',
    'Open Brain over HTTPS (a domain with a certificate, or a tunnel), or on its local address from the same machine.',
  )
}

function publicUrlOf(v: unknown): string {
  if (typeof v !== 'string' || v.length > 300)
    throw invalid(
      '"publicUrl" is the address people open.',
      'Give an address such as https://brain.example.com.',
    )
  let u: URL
  try {
    u = new URL(v.trim())
  } catch {
    throw invalid('"publicUrl" is not an address.', 'Give an address such as https://brain.example.com.')
  }
  if ((u.protocol !== 'https:' && u.protocol !== 'http:') || u.hash || u.search || u.username || u.password) {
    throw invalid(
      '"publicUrl" must be a plain http or https address.',
      'Give an address such as https://brain.example.com.',
    )
  }
  // Checked after normalising: percent-encoding can make the stored form longer than what was typed.
  const out = u.toString().replace(/\/+$/, '')
  if (out.length > 300) {
    throw invalid(
      '"publicUrl" is longer than 300 characters.',
      'Give the address people open, without a long path.',
    )
  }
  return out
}

const text = (v: unknown, field: string): string => {
  if (typeof v !== 'string') throw invalid(`"${field}" is text.`, `Give the ${field}.`)
  return v
}

function nameOf(v: unknown): string {
  const n = typeof v === 'string' ? v.trim() : ''
  if (!n || n.length > 80)
    throw invalid('The installation needs a name of 1 to 80 characters.', 'For example "Risco Brain".')
  return n
}

export type SetupInput = {
  name: unknown
  publicUrl: unknown
  admin: { name: unknown; email: unknown; password: unknown }
}

const setupGone = () =>
  new AppError(404, 'setup_done', 'This installation is already set up.', 'Sign in instead.')

// Runs once, as one transaction: the installation row is locked, so two setups at once make one admin.
// `also`: more to do in the same transaction (companion mode creates Factory's service account), so a
// failure there leaves nothing set up and the setup can be run again.
async function setUp<T>(
  db: Db,
  clock: Clock,
  input: SetupInput,
  o: { by: 'web' | 'companion'; ip?: string },
  also?: (tx: Db) => Promise<T>,
): Promise<{ adminId: string; publicUrl: string; warning: string | null; more: T | undefined }> {
  const adminName = text(input.admin?.name, 'admin name')
  const adminEmail = text(input.admin?.email, 'admin email')
  const name = nameOf(input.name)
  const publicUrl = publicUrlOf(input.publicUrl)
  const password = checkPassword(input.admin?.password)
  const hash = await hashPassword(password)
  return db.tx(async (tx) => {
    const row = await tx.one('SELECT setup_done_at FROM installation WHERE id = 1 FOR UPDATE')
    if (row?.setup_done_at != null) throw setupGone()
    const adminId = await createAccount(tx, clock, {
      kind: 'person',
      name: adminName,
      email: adminEmail,
      isAdmin: true,
      canCreateBrains: true,
      canInvite: true,
    })
    await tx.query('UPDATE accounts SET password_hash = $2 WHERE id = $1', [adminId, hash])
    const now = clock()
    await tx.query('UPDATE installation SET name = $1, public_url = $2, setup_done_at = $3 WHERE id = 1', [
      name,
      publicUrl,
      now,
    ])
    await audit(tx, {
      at: now,
      actorId: adminId,
      credentialId: null,
      action: 'installation.setup',
      outcome: 'ok',
      detail: `${o.by}${o.ip ? ` from ${o.ip}` : ''}: ${name} at ${publicUrl}`,
    })
    const more = also ? await also(tx) : undefined
    return { adminId, publicUrl, warning: insecureWarning(publicUrl), more }
  })
}

export async function setupState(db: Db, conn: ConnFacts, publicUrl?: string) {
  if (await setupDone(db)) throw setupGone()
  return {
    done: false,
    connection: { encrypted: conn.encrypted, local: conn.local },
    warning: insecureWarning(publicUrl),
  }
}

// The first-time setup from the web (CA1): it takes a password, so it needs a safe connection (CA2).
export async function runSetup(db: Db, clock: Clock, conn: ConnFacts, input: SetupInput) {
  requireSecure(conn)
  const out = await setUp(db, clock, input, { by: 'web', ip: conn.ip })
  const session = await mintWebSession(db, clock, { accountId: out.adminId })
  return { ...out, session: session.secret }
}

// Companion mode (CA24): the installer of Factory prepares Brain with what it already asked, and
// Factory gets its service account. The main key is returned once, to the installer.
export async function companionSetup(
  db: Db,
  clock: Clock,
  input: SetupInput & { serviceName?: string },
): Promise<{ adminId: string; serviceId: string; serviceKey: string }> {
  const { adminId, more } = await setUp(db, clock, input, { by: 'companion' }, async (tx) => {
    const serviceId = await createAccount(tx, clock, {
      kind: 'service',
      name: input.serviceName?.trim() || 'RSC Factory',
      canCreateBrains: true,
      canInvite: true,
    })
    const key = await mintMainKey(tx, clock, { accountId: serviceId, name: 'main' })
    return { serviceId, serviceKey: key.secret }
  })
  if (!more) throw new Error('companion setup made no service account')
  return { adminId, ...more }
}

// Restoring a copy (B7) calls this: every key, session and connection made before stops working.
export async function bumpKeyEpoch(db: Db): Promise<number> {
  const r = await db.one<{ e: number }>(
    'UPDATE installation SET key_epoch = key_epoch + 1 WHERE id = 1 RETURNING key_epoch AS e',
  )
  return Number(r?.e)
}
