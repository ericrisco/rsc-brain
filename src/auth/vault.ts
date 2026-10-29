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

export function seal(secret: string | undefined, text: string): string {
  if (!secret) throw noVault()
  const iv = randomBytes(12)
  const c = createCipheriv('aes-256-gcm', keyOf(secret), iv)
  const body = Buffer.concat([c.update(text, 'utf8'), c.final()])
  return `v1.${iv.toString('base64url')}.${c.getAuthTag().toString('base64url')}.${body.toString('base64url')}`
}

export function unseal(secret: string | undefined, sealed: string): string {
  if (!secret) throw noVault()
  const [v, iv, tag, body] = sealed.split('.')
  if (v !== 'v1' || !iv || !tag || body === undefined) throw new Error('Not a sealed value.')
  const d = createDecipheriv('aes-256-gcm', keyOf(secret), Buffer.from(iv, 'base64url'))
  d.setAuthTag(Buffer.from(tag, 'base64url'))
  return Buffer.concat([d.update(Buffer.from(body, 'base64url')), d.final()]).toString('utf8')
}
