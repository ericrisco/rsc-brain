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
    `Too many failed attempts in a row. Try again in ${s} seconds (at ${until.toISOString().slice(11, 19)} UTC).`,
    'Wait, then try again; or reset your password.',
  )
  err.headers = { 'retry-after': String(s) }
  err.extra = { retryAfter: s }
  return err
}

// Counts one attempt for this email before anything is checked, in one statement: attempts sent at
// once each take their turn, and once the count reaches five the email waits. Returns the wait if the
// email is already waiting (nothing is counted then). Unknown emails are counted the same way.
async function attempt(db: Db, email: string, now: Date): Promise<Date | null> {
  const r = await db.one<{ failures: number; locked_until: Date | null }>(
    `INSERT INTO login_brakes (email, failures, locked_until) VALUES ($1, 1, NULL)
     ON CONFLICT (email) DO UPDATE
       SET failures = login_brakes.failures + 1,
           locked_until = CASE WHEN login_brakes.failures + 1 >= $3
             THEN $2::timestamptz + make_interval(secs => least($4, $5 * 2 ^ (login_brakes.failures + 1 - $3)))
             ELSE NULL END
       WHERE login_brakes.locked_until IS NULL OR login_brakes.locked_until <= $2
     RETURNING failures, locked_until`,
    [email, now, BRAKE.after, BRAKE.maxS, BRAKE.firstS],
  )
  if (r) return null
  const held = await db.one<{ locked_until: Date }>(
    'SELECT locked_until FROM login_brakes WHERE email = $1',
    [email],
  )
  return held?.locked_until ?? null
}

// After a refusal: if this attempt was the one that started the wait, say so with the time.
async function refuse(db: Db, email: string, now: Date, plain: AppError): Promise<AppError> {
  const r = await db.one<{ locked_until: Date | null }>(
    'SELECT locked_until FROM login_brakes WHERE email = $1',
    [email],
  )
  return r?.locked_until && r.locked_until.getTime() > now.getTime() ? braked(r.locked_until, now) : plain
}

const clearBrake = (db: Db, email: string) => db.query('DELETE FROM login_brakes WHERE email = $1', [email])

// The attempt was not a failure (a right password asked for its code): it gives its turn back.
const giveBack = (db: Db, email: string) =>
  db.query(
    `UPDATE login_brakes SET failures = failures - 1,
       locked_until = CASE WHEN failures - 1 >= $2 THEN locked_until ELSE NULL END
     WHERE email = $1 AND failures > 0`,
    [email, BRAKE.after],
  )

// A code typed from the profile (replace or turn off the second factor) takes its turn at the same
// brake as signing in, so a stolen session cannot guess codes without end.
async function profileCode(
  ctx: Ctx,
  secret: string | undefined,
  sealed: string,
  code: unknown,
  last: unknown,
) {
  const key = ctx.who.email ?? `account:${ctx.who.accountId}`
  const now = ctx.clock()
  const waiting = await attempt(ctx.db, key, now)
  if (waiting) throw braked(waiting, now)
  const step = checkTotp(
    openSeed(secret, sealed),
    String(code ?? ''),
    now,
    last == null ? null : Number(last),
  )
  if (step === null) {
    throw await refuse(
      ctx.db,
      key,
      now,
      invalid('The code is not right.', 'Type the 6 digits your current app shows now.'),
    )
  }
  await clearBrake(ctx.db, key)
  return step
}

async function failedAudit(db: Db, id: string | null, now: Date, why: string, conn: ConnFacts) {
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
  if (!email || email.length > 320 || !password || password.length > 200) throw wrong()
  const now = clock()
  const waiting = await attempt(db, email, now)
  if (waiting) throw braked(waiting, now)
  const a = await db.one<Row>(
    "SELECT * FROM accounts WHERE email = $1 AND kind = 'person' AND status = 'active'",
    [email],
  )
  if (!a?.password_hash) {
    // Same work as a real check, so a missing account takes as long as a wrong password.
    await verifyPassword(password, await dummyHash())
    await failedAudit(db, null, now, 'unknown account', conn)
    throw await refuse(db, email, now, wrong())
  }
  const id = String(a.id)
  if (!(await verifyPassword(password, String(a.password_hash)))) {
    await failedAudit(db, id, now, 'wrong password', conn)
    throw await refuse(db, email, now, wrong())
  }
  if (a.totp_secret != null) {
    const code = typeof input.code === 'string' ? input.code.trim() : ''
    if (!code) {
      // A right password is not a failure: its turn is given back. Wrong passwords still count, so
      // this does not become a free way to guess them.
      await giveBack(db, email)
      throw unauthorized(
        'code_required',
        'This account asks for the code of its authenticator app.',
        'Send "code" with the 6 digits.',
      )
    }
    const step = checkTotp(
      openSeed(secret, String(a.totp_secret)),
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
      await failedAudit(db, id, now, 'wrong code', conn)
      throw await refuse(
        db,
        email,
        now,
        unauthorized(
          'bad_code',
          'The code is not right, or was already used.',
          'Wait for the next code and try again.',
        ),
      )
    }
  }
  await clearBrake(db, email)
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

// A seed sealed with another installation secret cannot be read: say so, not "internal error".
function openSeed(secret: string | undefined, sealed: string): string {
  try {
    return unseal(secret, sealed)
  } catch (err) {
    if (err instanceof AppError) throw err
    throw new AppError(
      409,
      'installation_secret_changed',
      'The second factor of this account cannot be checked: the installation secret changed.',
      'Ask the administration to put back the previous RSC_BRAIN_SECRET, or to reset your second factor.',
    )
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

export async function newReset(db: Db, accountId: string, by: string | null, now: Date): Promise<string> {
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
  // In the background, so the answer takes as long for an email with an account as for one without;
  // at most three links an hour, so nobody fills a mailbox with them.
  const id = String(a.id)
  void (async () => {
    // Requests for one account take turns, so requests sent at once cannot pass the cap together.
    const token = await db.tx(async (tx) => {
      await tx.query("SELECT pg_advisory_xact_lock(hashtext('rsc-brain reset ' || $1))", [id])
      const recent = await tx.one<{ n: number }>(
        "SELECT count(*)::int AS n FROM password_resets WHERE account_id = $1 AND created_by IS NULL AND created_at > $2::timestamptz - interval '1 hour'",
        [id, now],
      )
      if ((recent?.n ?? 0) >= RESETS_PER_HOUR) return null
      return newReset(tx, id, null, now)
    })
    if (token) await send(e, await resetLink(db, token))
  })().catch(() => {})
}

export const RESETS_PER_HOUR = 3

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

// Whether a reset link still works, before the person types a new password (spec B6 «Reset»). It does
// not spend the link and names no account: the answer is the same for every link that works.
export async function lookReset(db: Db, clock: Clock, token: unknown): Promise<{ valid: true }> {
  if (typeof token !== 'string' || !token) throw badLink()
  const r = await db.one<Row>(
    'SELECT 1 FROM password_resets WHERE token_hash = $1 AND used_at IS NULL AND expires_at > $2',
    [hashSecret(token), clock()],
  )
  if (!r) throw badLink()
  return { valid: true }
}

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
    const acc = await tx.one<Row>('UPDATE accounts SET password_hash = $2 WHERE id = $1 RETURNING email', [
      id,
      hash,
    ])
    // A new password lifts the brake on its email.
    if (acc?.email) await clearBrake(tx, String(acc.email))
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
// With a second factor already on, replacing it needs its current code: a stolen session must not be
// enough to bind another authenticator.
export async function startTotp(ctx: Ctx, secret: string | undefined, code?: unknown) {
  webOnly(ctx)
  const cur = await ctx.db.one<Row>('SELECT totp_secret, totp_last_step FROM accounts WHERE id = $1', [
    ctx.who.accountId,
  ])
  if (cur?.totp_secret) {
    const step = await profileCode(ctx, secret, String(cur.totp_secret), code, cur.totp_last_step)
    await ctx.db.query('UPDATE accounts SET totp_last_step = $2 WHERE id = $1', [ctx.who.accountId, step])
  }
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
  const step = checkTotp(openSeed(secret, String(a.totp_pending)), String(code ?? ''), ctx.clock(), null)
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
  await profileCode(ctx, secret, String(a.totp_secret), code, a.totp_last_step)
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
