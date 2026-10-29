// The second factor (spec B4): the standard 6-digit code of an authenticator app, every 30 seconds
// (RFC 6238 over RFC 4226, HMAC-SHA1), with one step of tolerance each way.
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto'

const STEP_S = 30
const DIGITS = 6
const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'

export function base32(buf: Buffer): string {
  let bits = 0
  let value = 0
  let out = ''
  for (const byte of buf) {
    value = (value << 8) | byte
    bits += 8
    while (bits >= 5) {
      out += ALPHABET[(value >>> (bits - 5)) & 31]
      bits -= 5
    }
  }
  if (bits > 0) out += ALPHABET[(value << (5 - bits)) & 31]
  return out
}

function unbase32(s: string): Buffer {
  let bits = 0
  let value = 0
  const out: number[] = []
  for (const ch of s.replace(/=+$/, '').toUpperCase()) {
    const i = ALPHABET.indexOf(ch)
    if (i < 0) continue
    value = (value << 5) | i
    bits += 5
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 255)
      bits -= 8
    }
  }
  return Buffer.from(out)
}

export const newTotpSecret = () => base32(randomBytes(20))

export function totpAt(secret: string, step: number): string {
  const counter = Buffer.alloc(8)
  counter.writeBigUInt64BE(BigInt(step))
  const h = createHmac('sha1', unbase32(secret)).update(counter).digest()
  const off = (h[h.length - 1] as number) & 15
  const n = (h.readUInt32BE(off) & 0x7fffffff) % 10 ** DIGITS
  return String(n).padStart(DIGITS, '0')
}

export const stepOf = (at: Date) => Math.floor(at.getTime() / 1000 / STEP_S)

// The step the code belongs to, or null. A step at or before `usedUpTo` is refused: a code works once.
export function checkTotp(secret: string, code: string, at: Date, usedUpTo: number | null): number | null {
  if (!/^\d{6}$/.test(code)) return null
  const now = stepOf(at)
  for (const step of [now, now - 1, now + 1]) {
    if (usedUpTo !== null && step <= usedUpTo) continue
    const want = Buffer.from(totpAt(secret, step))
    if (timingSafeEqual(want, Buffer.from(code))) return step
  }
  return null
}

export function otpauthUrl(secret: string, account: string, issuer: string): string {
  const label = encodeURIComponent(`${issuer}:${account}`)
  return `otpauth://totp/${label}?secret=${secret}&issuer=${encodeURIComponent(issuer)}&algorithm=SHA1&digits=6&period=30`
}
