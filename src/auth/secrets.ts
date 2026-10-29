// Keys are random, shown once and stored only as their SHA-256. The prefix lets people (and the
// redaction of B1) recognise a key of this product.
import { createHash, randomBytes } from 'node:crypto'

export const KEY_PREFIX = 'rscb_'
export const KEY_SHAPE = /rscb_[A-Za-z0-9_-]{43}/

export function newSecret(): string {
  return `${KEY_PREFIX}${randomBytes(32).toString('base64url')}`
}

export function hashSecret(secret: string): string {
  return createHash('sha256').update(secret).digest('hex')
}
