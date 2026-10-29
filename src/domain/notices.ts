// Notices (spec B4): what a person sees in the web, and gets by mail when mail is set up. Today: an
// administration added a service account to a brain they curate, the administration joined it, and a
// token of theirs ends within a week.
import type { Clock } from '../core/clock.ts'
import type { Db } from '../db/db.ts'
import { type MailKind, mailConfigured, type Outbox, send } from '../mail/mail.ts'
import type { Ctx } from './context.ts'
import { installation } from './installation.ts'

export const EXPIRY_NOTICE_DAYS = 7

export async function notify(
  db: Db,
  clock: Clock,
  outbox: Outbox | undefined,
  to: string[],
  n: { kind: string; brainId: string | null; text: string; subject: string; mailKind?: MailKind },
): Promise<void> {
  const now = clock()
  for (const id of new Set(to)) {
    const a = await db.one<{ email: string | null; status: string }>(
      'SELECT email, status FROM accounts WHERE id = $1',
      [id],
    )
    if (a?.status !== 'active') continue
    await db.query('INSERT INTO notices (account_id, at, kind, brain_id, text) VALUES ($1, $2, $3, $4, $5)', [
      id,
      now,
      n.kind,
      n.brainId,
      n.text.slice(0, 500),
    ])
    if (a.email) {
      const base = (await installation(db)).publicUrl ?? ''
      await send(db, clock, outbox, n.mailKind ?? 'notice', {
        to: a.email,
        subject: n.subject,
        text: `${n.text}\n\nOpen Brain to see it: ${base}/\n`,
      })
    }
  }
}

export async function curatorsOf(db: Db, brainId: string): Promise<string[]> {
  const rows = await db.query(
    `SELECT m.account_id FROM memberships m JOIN accounts a ON a.id = m.account_id
      WHERE m.brain_id = $1 AND m.role = 'curator' AND a.status = 'active'`,
    [brainId],
  )
  return rows.map((r) => String(r.account_id))
}

// What the web shows a person: tokens ending within a week (with the way to make another), then the
// latest notices.
export async function myNotices(ctx: Ctx) {
  const now = ctx.clock()
  const soon = new Date(now.getTime() + EXPIRY_NOTICE_DAYS * 86_400_000)
  const tokens = await ctx.db.query(
    `SELECT id, name, last4, expires_at FROM credentials
      WHERE account_id = $1 AND kind = 'token' AND revoked_at IS NULL AND expires_at > $2 AND expires_at <= $3
      ORDER BY expires_at`,
    [ctx.who.accountId, now, soon],
  )
  const rows = await ctx.db.query(
    `SELECT n.id, n.at, n.kind, n.text, n.read_at, b.slug FROM notices n LEFT JOIN brains b ON b.id = n.brain_id
      WHERE n.account_id = $1 ORDER BY n.at DESC, n.id DESC LIMIT 50`,
    [ctx.who.accountId],
  )
  return {
    expiringTokens: tokens.map((t) => ({
      id: String(t.id),
      name: String(t.name),
      last4: String(t.last4),
      expiresAt: (t.expires_at as Date).toISOString(),
      message: `Your token "${t.name}" ends on ${(t.expires_at as Date).toISOString().slice(0, 10)}.`,
      action: { label: 'Create a new token', method: 'POST', path: '/v1/me/tokens' },
    })),
    notices: rows.map((r) => ({
      id: String(r.id),
      at: (r.at as Date).toISOString(),
      kind: String(r.kind),
      brain: r.slug == null ? null : String(r.slug),
      text: String(r.text),
      read: r.read_at != null,
    })),
  }
}

export async function markNoticesRead(ctx: Ctx): Promise<number> {
  const r = await ctx.db.query(
    'UPDATE notices SET read_at = $2 WHERE account_id = $1 AND read_at IS NULL RETURNING id',
    [ctx.who.accountId, ctx.clock()],
  )
  return r.length
}

// Once a week before the end, a mail for each token about to end (once per token).
export async function remindExpiringTokens(
  db: Db,
  clock: Clock,
  outbox: Outbox | undefined,
): Promise<number> {
  // Without mail nothing is marked, so the mail still goes once mail is set up.
  if (!(await mailConfigured(db))) return 0
  const now = clock()
  const soon = new Date(now.getTime() + EXPIRY_NOTICE_DAYS * 86_400_000)
  const rows = await db.query(
    `UPDATE credentials c SET expiry_noticed_at = $1
       FROM accounts a
      WHERE a.id = c.account_id AND a.status = 'active' AND a.email IS NOT NULL
        AND c.kind = 'token' AND c.revoked_at IS NULL AND c.expiry_noticed_at IS NULL
        AND c.expires_at > $1 AND c.expires_at <= $2
      RETURNING c.id, c.name, c.expires_at, a.email`,
    [now, soon],
  )
  const base = (await installation(db)).publicUrl ?? ''
  for (const r of rows) {
    const sent = await send(db, clock, outbox, 'token_expiry', {
      to: String(r.email),
      subject: `Your Brain token "${r.name}" ends soon`,
      text: [
        `Your token "${r.name}" ends on ${(r.expires_at as Date).toISOString().slice(0, 10)}.`,
        'Agents that use it will stop working then.',
        '',
        `Create a new one in your profile: ${base}/profile/tokens`,
      ].join('\n'),
    })
    // A send that failed is tried again on the next round.
    if (!sent.sent) await db.query('UPDATE credentials SET expiry_noticed_at = NULL WHERE id = $1', [r.id])
  }
  return rows.length
}
