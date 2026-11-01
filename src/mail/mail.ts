// Outgoing mail (spec B4 «Avisos por email»): invitations, reset links, a token about to end, new
// proposals. Sending never blocks what caused it: a failure is logged and shown to the administration.
// The log keeps who, what kind, when and how it ended, never the content (it carries single-use links).
import nodemailer from 'nodemailer'
import { seal, unseal } from '../auth/vault.ts'
import type { Clock } from '../core/clock.ts'
import type { Db } from '../db/db.ts'
import { redact } from '../privacy/redact.ts'

// An image that travels inside the mail and is shown by its content id (cid:), never fetched from an address.
export type Inline = { filename: string; content: Buffer; contentType: string; cid: string }
export type Message = { to: string; subject: string; text: string; html?: string; attachments?: Inline[] }
export type Sender = { name: string; address: string }

// What actually delivers a message. The server builds an SMTP one from the settings; tests pass their own.
export type Transport = { send(m: Message & { from: Sender }): Promise<void> }

export type MailSettings = {
  host: string
  port: number
  secure: boolean
  user: string | null
  password: string | null // sealed
  // Its last 4 characters, to name it without showing it (settings saved before PR25b have none).
  passwordLast4?: string | null
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
        ...(m.html ? { html: m.html } : {}),
        ...(m.attachments?.length ? { attachments: m.attachments } : {}),
      })
    },
  }
}

export const LOGO_CID = 'logo@rsc-brain'

const esc = (t: string) =>
  t
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')

// Every mail carries the name and logo of the installation (spec B6 CA18, plan G15): the text as it is, and
// beside it the same text in HTML under the logo, attached inline. Nothing in it is fetched from an address,
// so opening a mail tells no server that it was read. Links are http(s) only, written from escaped text.
export async function branded(db: Db, m: Message): Promise<Message> {
  const r = await db.one<{ name: string; logo: Buffer | null; logo_type: string | null }>(
    'SELECT name, logo, logo_type FROM installation WHERE id = 1',
  )
  const name = r?.name?.trim() || 'rsc-brain'
  const logo: Inline | null =
    r?.logo && r.logo_type
      ? {
          filename: `logo.${r.logo_type.split('/')[1] ?? 'png'}`,
          content: r.logo,
          contentType: r.logo_type,
          cid: LOGO_CID,
        }
      : null
  const body = esc(m.text).replace(/https?:\/\/[^\s<>"]+/g, (u) => `<a href="${u}">${u}</a>`)
  const html = [
    '<!doctype html><html><body style="margin:0;padding:24px;font-family:system-ui,sans-serif;color:#1b1d22;background:#ffffff">',
    '<p style="margin:0 0 20px;font-size:18px;font-weight:600">',
    logo
      ? `<img src="cid:${LOGO_CID}" alt="" height="32" style="height:32px;width:auto;vertical-align:middle;margin-right:10px">`
      : '',
    `${esc(name)}</p>`,
    `<div style="white-space:pre-wrap;font-size:15px;line-height:1.5">${body}</div>`,
    '</body></html>',
  ].join('')
  return { ...m, html, attachments: logo ? [logo] : [] }
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
    await t.send({ ...(await branded(db, m)), from: s.from })
    await log('sent')
    return { sent: true, error: null }
  } catch (err) {
    // What a mail server says can quote what it was given: stored with secrets taken out.
    const why = redact(err instanceof Error ? err.message : String(err)).text
    await log('failed', why)
    return { sent: false, error: why }
  }
}

export async function mailConfigured(db: Db): Promise<boolean> {
  return (await mailSettings(db)) !== null
}
