// Outgoing mail (spec B4 «Avisos por email»): invitations, reset links, a token about to end, new
// proposals. Sending never blocks what caused it: a failure is logged and shown to the administration.
// The log keeps who, what kind, when and how it ended, never the content (it carries single-use links).
import nodemailer from 'nodemailer'
import { seal, unseal } from '../auth/vault.ts'
import type { Clock } from '../core/clock.ts'
import type { Db } from '../db/db.ts'

export type Message = { to: string; subject: string; text: string }
export type Sender = { name: string; address: string }

// What actually delivers a message. The server builds an SMTP one from the settings; tests pass their own.
export type Transport = { send(m: Message & { from: Sender }): Promise<void> }

export type MailSettings = {
  host: string
  port: number
  secure: boolean
  user: string | null
  password: string | null // sealed
  from: Sender
}

// What the domain needs to send: the installation secret (to open the password) and, in tests, a
// transport that replaces SMTP.
export type Outbox = { secret: string | undefined; transport?: (s: MailSettings) => Transport }

export type MailKind = 'invitation' | 'reset' | 'token_expiry' | 'proposal' | 'notice' | 'test'

export async function mailSettings(db: Db): Promise<MailSettings | null> {
  const r = await db.one<{ mail: MailSettings | null }>('SELECT mail FROM installation WHERE id = 1')
  return r?.mail ?? null
}

export async function storeMail(db: Db, s: MailSettings | null): Promise<void> {
  await db.query('UPDATE installation SET mail = $1 WHERE id = 1', [s ? JSON.stringify(s) : null])
}

export const sealPassword = (secret: string | undefined, password: string) => seal(secret, password)

function smtp(s: MailSettings, secret: string | undefined): Transport {
  const t = nodemailer.createTransport({
    host: s.host,
    port: s.port,
    secure: s.secure,
    ...(s.user ? { auth: { user: s.user, pass: s.password ? unseal(secret, s.password) : '' } } : {}),
    connectionTimeout: 10_000,
    greetingTimeout: 10_000,
    socketTimeout: 20_000,
  })
  return {
    async send(m) {
      // Addresses go as objects, never as text to parse: nothing in a name can add a recipient.
      await t.sendMail({
        from: { name: m.from.name, address: m.from.address },
        to: { name: '', address: m.to },
        subject: m.subject,
        text: m.text,
      })
    },
  }
}

// Sends one message, or says why it did not. Never throws.
export async function send(
  db: Db,
  clock: Clock,
  outbox: Outbox | undefined,
  kind: MailKind,
  m: Message,
): Promise<{ sent: boolean; error: string | null }> {
  const s = await mailSettings(db)
  const log = (status: 'sent' | 'failed' | 'skipped', error = '') =>
    db.query('INSERT INTO mail_log (at, to_addr, kind, status, error) VALUES ($1, $2, $3, $4, $5)', [
      clock(),
      m.to,
      kind,
      status,
      error.slice(0, 500),
    ])
  if (!s) {
    await log('skipped', 'mail is not set up')
    return { sent: false, error: 'Mail is not set up.' }
  }
  try {
    const t = outbox?.transport ? outbox.transport(s) : smtp(s, outbox?.secret)
    await t.send({ ...m, from: s.from })
    await log('sent')
    return { sent: true, error: null }
  } catch (err) {
    const why = err instanceof Error ? err.message : String(err)
    await log('failed', why)
    return { sent: false, error: why }
  }
}

export async function mailConfigured(db: Db): Promise<boolean> {
  return (await mailSettings(db)) !== null
}
