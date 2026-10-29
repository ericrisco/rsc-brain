// Signing in (spec B4 «Entrar»): email and password, plus the code when the person has a second factor;
// a brake after five failures in a row; signing out here or everywhere; resetting a password with a
// single-use link; turning the second factor on and off.
import { checkPassword, dummyHash, hashPassword, verifyPassword } from '../auth/password.ts'
import { hashSecret, newSecret } from '../auth/secrets.ts'
import { checkTotp, newTotpSecret, otpauthUrl, stepOf } from '../auth/totp.ts'
import { seal, unseal } from '../auth/vault.ts'
import type { Clock } from '../core/clock.ts'
import { AppError, invalid, notFound, unauthorized } from '../core/errors.ts'
import type { Db, Row } from '../db/db.ts'
import { audit } from './audit.ts'
import type { Ctx } from './context.ts'
import { type ConnFacts, installation, requireSecure } from './installation.ts'
import { mintWebSession } from './keys.ts'
import { webOnly } from './wiki/review.ts'

export const BRAKE = { after: 5, firstS: 60, maxS: 3600 }
export const RESET_MINUTES = 60

const wrong = () =>
  unauthorized(
    'bad_credentials',
    'The email or the password is not right.',
    'Check them, or reset your password.',
  )

// The wait after the n-th failure in a row: none before five, then 1 minute doubling up to 1 hour.
export function brakeSeconds(failures: number): number {
  if (failures < BRAKE.after) return 0
  return Math.min(BRAKE.maxS, BRAKE.firstS * 2 ** (failures - BRAKE.after))
}

function braked(until: Date, now: Date): AppError {
  const s = Math.max(1, Math.ceil((until.getTime() - now.getTime()) / 1000))
  const err = new AppError(
    429,
    'too_many_attempts',
    `Too many failed sign-ins in a row. Try again in ${s} seconds (at ${until.toISOString().slice(11, 19)} UTC).`,
    'Wait, then try again; or reset your password.',
  )
  err.headers = { 'retry-after': String(s) }
  err.extra = { retryAfter: s }
  return err
}

async function failed(db: Db, id: string, now: Date, why: string, conn: ConnFacts): Promise<void> {
  const r = await db.one<{ n: number }>(
    'UPDATE accounts SET failed_logins = failed_logins + 1 WHERE id = $1 RETURNING failed_logins AS n',
    [id],
  )
  const wait = brakeSeconds(Number(r?.n))
  if (wait > 0) {
    await db.query('UPDATE accounts SET locked_until = $2 WHERE id = $1', [
      id,
      new Date(now.getTime() + wait * 1000),
    ])
  }
  await audit(db, {
    at: now,
    actorId: id,
    credentialId: null,
    action: 'auth.failed',
    outcome: 'denied',
    detail: `${why} from ${conn.ip}`,
  })
}

export type SignedIn = {
  session: string
  account: { id: string; name: string; email: string; isAdmin: boolean }
}

export async function signIn(
  db: Db,
  clock: Clock,
  conn: ConnFacts,
  secret: string | undefined,
  input: { email: unknown; password: unknown; code?: unknown },
): Promise<SignedIn> {
  requireSecure(conn)
  const email = typeof input.email === 'string' ? input.email.trim().toLowerCase() : ''
  const password = typeof input.password === 'string' ? input.password : ''
  if (!email || !password || password.length > 200) throw wrong()
  const now = clock()
  const a = await db.one<Row>(
    "SELECT * FROM accounts WHERE email = $1 AND kind = 'person' AND status = 'active'",
    [email],
  )
  if (!a?.password_hash) {
    // Same work as a real check, so a missing account takes as long as a wrong password.
    await verifyPassword(password, await dummyHash())
    await audit(db, {
      at: now,
      actorId: null,
      credentialId: null,
      action: 'auth.failed',
      outcome: 'denied',
      detail: `unknown account from ${conn.ip}`,
    })
    throw wrong()
  }
  const id = String(a.id)
  if (a.locked_until != null && (a.locked_until as Date).getTime() > now.getTime())
    throw braked(a.locked_until as Date, now)
  if (!(await verifyPassword(password, String(a.password_hash)))) {
    await failed(db, id, now, 'wrong password', conn)
    const after = await db.one<Row>('SELECT locked_until FROM accounts WHERE id = $1', [id])
    if (after?.locked_until != null && (after.locked_until as Date).getTime() > now.getTime())
      throw braked(after.locked_until as Date, now)
    throw wrong()
  }
  if (a.totp_secret != null) {
    const code = typeof input.code === 'string' ? input.code.trim() : ''
    if (!code) {
      throw unauthorized(
        'code_required',
        'This account asks for the code of its authenticator app.',
        'Send "code" with the 6 digits.',
      )
    }
    const step = checkTotp(
      unseal(secret, String(a.totp_secret)),
      code,
      now,
      a.totp_last_step == null ? null : Number(a.totp_last_step),
    )
    // Only one sign-in can use a step: the update wins for one of two racing requests.
    const used =
      step !== null &&
      (await db.one(
        'UPDATE accounts SET totp_last_step = $2 WHERE id = $1 AND (totp_last_step IS NULL OR totp_last_step < $2) RETURNING id',
        [id, step],
      ))
    if (!used) {
      await failed(db, id, now, 'wrong code', conn)
      throw unauthorized(
        'bad_code',
        'The code is not right, or was already used.',
        'Wait for the next code and try again.',
      )
    }
  }
  await db.query('UPDATE accounts SET failed_logins = 0, locked_until = NULL WHERE id = $1', [id])
  const s = await mintWebSession(db, clock, { accountId: id })
  await audit(db, {
    at: now,
    actorId: id,
    credentialId: s.id,
    action: 'auth.signin',
    outcome: 'ok',
    detail: `from ${conn.ip}`,
  })
  return {
    session: s.secret,
    account: { id, name: String(a.name), email, isAdmin: Boolean(a.is_admin) },
  }
}

export async function signOut(ctx: Ctx, everywhere: boolean): Promise<number> {
  webOnly(ctx)
  const now = ctx.clock()
  const r = everywhere
    ? await ctx.db.query(
        "UPDATE credentials SET revoked_at = $2 WHERE account_id = $1 AND kind = 'web' AND revoked_at IS NULL AND expires_at > $2 RETURNING id",
        [ctx.who.accountId, now],
      )
    : await ctx.db.query(
        'UPDATE credentials SET revoked_at = $2 WHERE id = $1 AND revoked_at IS NULL RETURNING id',
        [ctx.who.credential.id, now],
      )
  await audit(ctx.db, {
    at: now,
    actorId: ctx.who.accountId,
    credentialId: ctx.who.credential.id,
    action: everywhere ? 'auth.signout_everywhere' : 'auth.signout',
    outcome: 'ok',
    detail: `${r.length} session(s)`,
  })
  return r.length
}

async function newReset(db: Db, accountId: string, by: string | null, now: Date): Promise<string> {
  const token = newSecret()
  await db.query(
    'INSERT INTO password_resets (token_hash, account_id, created_by, created_at, expires_at) VALUES ($1, $2, $3, $4, $5)',
    [hashSecret(token), accountId, by, now, new Date(now.getTime() + RESET_MINUTES * 60_000)],
  )
  return token
}

export async function resetLink(db: Db, token: string): Promise<string> {
  const base = (await installation(db)).publicUrl ?? ''
  return `${base}/reset#token=${token}`
}

// Someone asks to reset a password. The answer is the same whether the account exists or not; the link
// goes by email (B4 PR12), or the administration makes one by hand.
export async function requestReset(
  db: Db,
  clock: Clock,
  conn: ConnFacts,
  email: unknown,
  send?: (to: string, link: string) => Promise<void>,
): Promise<void> {
  const e = typeof email === 'string' ? email.trim().toLowerCase() : ''
  const now = clock()
  const a = e
    ? await db.one<Row>(
        "SELECT id FROM accounts WHERE email = $1 AND kind = 'person' AND status = 'active'",
        [e],
      )
    : undefined
  await audit(db, {
    at: now,
    actorId: a ? String(a.id) : null,
    credentialId: null,
    action: 'auth.reset_requested',
    outcome: 'ok',
    detail: `from ${conn.ip}`,
  })
  if (!a || !send) return
  const token = await newReset(db, String(a.id), null, now)
  await send(e, await resetLink(db, token))
}

// The administration makes a reset link to copy by hand (no mail, or mail failing).
export async function adminResetLink(
  ctx: Ctx,
  accountId: string,
): Promise<{ link: string; expiresAt: string }> {
  webOnly(ctx)
  if (!ctx.who.isAdmin)
    throw new AppError(
      403,
      'forbidden',
      'Only the administration makes reset links.',
      'Ask the administration.',
    )
  const a = await ctx.db.one("SELECT id FROM accounts WHERE id = $1 AND kind = 'person'", [accountId])
  if (!a) throw notFound('account')
  const now = ctx.clock()
  const token = await newReset(ctx.db, accountId, ctx.who.accountId, now)
  await audit(ctx.db, {
    at: now,
    actorId: ctx.who.accountId,
    credentialId: ctx.who.credential.id,
    action: 'auth.reset_link',
    target: accountId,
    outcome: 'ok',
  })
  return {
    link: await resetLink(ctx.db, token),
    expiresAt: new Date(now.getTime() + RESET_MINUTES * 60_000).toISOString(),
  }
}

const badLink = () =>
  new AppError(
    400,
    'link_invalid',
    'This reset link is not valid: it expired, was already used, or is wrong.',
    'Ask for a new one.',
  )

// A new password from a reset link: the link works once, and every web session of the person ends.
export async function confirmReset(
  db: Db,
  clock: Clock,
  conn: ConnFacts,
  input: { token: unknown; password: unknown },
) {
  requireSecure(conn)
  const token = typeof input.token === 'string' ? input.token : ''
  const password = checkPassword(input.password)
  const hash = await hashPassword(password)
  const now = clock()
  await db.tx(async (tx) => {
    const r = await tx.one<Row>(
      'UPDATE password_resets SET used_at = $2 WHERE token_hash = $1 AND used_at IS NULL AND expires_at > $2 RETURNING account_id',
      [hashSecret(token), now],
    )
    if (!r) throw badLink()
    const id = String(r.account_id)
    await tx.query(
      'UPDATE accounts SET password_hash = $2, failed_logins = 0, locked_until = NULL WHERE id = $1',
      [id, hash],
    )
    await tx.query(
      "UPDATE credentials SET revoked_at = $2 WHERE account_id = $1 AND kind = 'web' AND revoked_at IS NULL",
      [id, now],
    )
    await audit(tx, {
      at: now,
      actorId: id,
      credentialId: null,
      action: 'auth.password_reset',
      outcome: 'ok',
      detail: `from ${conn.ip}`,
    })
  })
}

// Second factor: start (a secret to scan), confirm with a first code, turn off with a current code.
export async function startTotp(ctx: Ctx, secret: string | undefined) {
  webOnly(ctx)
  const s = newTotpSecret()
  await ctx.db.query('UPDATE accounts SET totp_pending = $2 WHERE id = $1', [
    ctx.who.accountId,
    seal(secret, s),
  ])
  const name = (await installation(ctx.db)).name || 'RSC Brain'
  return { secret: s, otpauthUrl: otpauthUrl(s, ctx.who.email ?? ctx.who.name, name) }
}

export async function confirmTotp(ctx: Ctx, secret: string | undefined, code: unknown) {
  webOnly(ctx)
  const a = await ctx.db.one<Row>('SELECT totp_pending FROM accounts WHERE id = $1', [ctx.who.accountId])
  if (!a?.totp_pending) throw invalid('There is no second factor being set up.', 'Start it first.')
  const step = checkTotp(unseal(secret, String(a.totp_pending)), String(code ?? ''), ctx.clock(), null)
  if (step === null) throw invalid('The code is not right.', 'Type the 6 digits your app shows now.')
  await ctx.db.query(
    'UPDATE accounts SET totp_secret = totp_pending, totp_pending = NULL, totp_last_step = $2 WHERE id = $1',
    [ctx.who.accountId, step],
  )
  await audit(ctx.db, {
    at: ctx.clock(),
    actorId: ctx.who.accountId,
    credentialId: ctx.who.credential.id,
    action: 'auth.totp_on',
    outcome: 'ok',
  })
  return { enabled: true }
}

export async function disableTotp(ctx: Ctx, secret: string | undefined, code: unknown) {
  webOnly(ctx)
  const a = await ctx.db.one<Row>('SELECT totp_secret, totp_last_step FROM accounts WHERE id = $1', [
    ctx.who.accountId,
  ])
  if (!a?.totp_secret) return { enabled: false }
  const step = checkTotp(
    unseal(secret, String(a.totp_secret)),
    String(code ?? ''),
    ctx.clock(),
    a.totp_last_step == null ? null : Number(a.totp_last_step),
  )
  if (step === null) throw invalid('The code is not right.', 'Type the 6 digits your app shows now.')
  await ctx.db.query('UPDATE accounts SET totp_secret = NULL, totp_last_step = NULL WHERE id = $1', [
    ctx.who.accountId,
  ])
  await audit(ctx.db, {
    at: ctx.clock(),
    actorId: ctx.who.accountId,
    credentialId: ctx.who.credential.id,
    action: 'auth.totp_off',
    outcome: 'ok',
  })
  return { enabled: false }
}

// The administration removes a person's second factor (a lost phone); audited.
export async function adminResetTotp(ctx: Ctx, accountId: string) {
  webOnly(ctx)
  if (!ctx.who.isAdmin)
    throw new AppError(403, 'forbidden', 'Only the administration does this.', 'Ask the administration.')
  const r = await ctx.db.one(
    'UPDATE accounts SET totp_secret = NULL, totp_pending = NULL, totp_last_step = NULL WHERE id = $1 RETURNING id',
    [accountId],
  )
  if (!r) throw notFound('account')
  await audit(ctx.db, {
    at: ctx.clock(),
    actorId: ctx.who.accountId,
    credentialId: ctx.who.credential.id,
    action: 'auth.totp_reset',
    target: accountId,
    outcome: 'ok',
  })
  return { enabled: false }
}

export const stepNow = (clock: Clock) => stepOf(clock())
