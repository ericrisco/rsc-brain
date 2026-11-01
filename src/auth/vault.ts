// Secrets the server must read back (the second-factor seed, the mail password) are sealed with a key
// derived from the installation secret (RSC_BRAIN_SECRET), AES-256-GCM. Without that secret they
// cannot be stored, and the refusal says so.
import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from 'node:crypto'
import { AppError } from '../core/errors.ts'

const keys = new Map<string, Buffer>()
function keyOf(secret: string): Buffer {
  let k = keys.get(secret)
  if (!k) {
    k = scryptSync(secret, 'rsc-brain vault v1', 32)
    keys.set(secret, k)
  }
  return k
}

export const noVault = () =>
  new AppError(
    409,
    'no_installation_secret',
    'This installation has no secret to keep this safely (RSC_BRAIN_SECRET is not set).',
    'Set RSC_BRAIN_SECRET for the server (a long random value; the installer writes one), then try again.',
  )

// What a sealed value is for. Each value is bound to its purpose (v2: the purpose is authenticated data), so a
// value copied into another column (a mail password into the key of a meaning provider) does not open there.
export type Purpose = 'mail.password' | 'meaning.openai' | 'account.totp'

export function seal(secret: string | undefined, text: string, purpose: Purpose): string {
  if (!secret) throw noVault()
  const iv = randomBytes(12)
  const c = createCipheriv('aes-256-gcm', keyOf(secret), iv)
  c.setAAD(Buffer.from(`rsc-brain:${purpose}`, 'utf8'))
  const body = Buffer.concat([c.update(text, 'utf8'), c.final()])
  return `v2.${iv.toString('base64url')}.${c.getAuthTag().toString('base64url')}.${body.toString('base64url')}`
}

// v1 (before purposes) still opens, for any purpose: seeds and passwords stored then keep working, and are
// sealed as v2 the next time they are written.
export function unseal(secret: string | undefined, sealed: string, purpose: Purpose): string {
  if (!secret) throw noVault()
  const [v, iv, tag, body] = sealed.split('.')
  if ((v !== 'v1' && v !== 'v2') || !iv || !tag || body === undefined) throw new Error('Not a sealed value.')
  const d = createDecipheriv('aes-256-gcm', keyOf(secret), Buffer.from(iv, 'base64url'))
  if (v === 'v2') d.setAAD(Buffer.from(`rsc-brain:${purpose}`, 'utf8'))
  d.setAuthTag(Buffer.from(tag, 'base64url'))
  return Buffer.concat([d.update(Buffer.from(body, 'base64url')), d.final()]).toString('utf8')
}
