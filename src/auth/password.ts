// Passwords (spec B4): at least 12 characters, kept only as a slow scrypt hash with its own salt, and
// compared in constant time. The stored form says its parameters, so they can grow later.
import { randomBytes, scrypt, timingSafeEqual } from 'node:crypto'
import { invalid } from '../core/errors.ts'

export const PASSWORD = { min: 12, max: 200 }
const N = 2 ** 15
const R = 8
const P = 1
const LEN = 32

function derive(password: string, salt: Buffer, n: number, r: number, p: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scrypt(password.normalize('NFKC'), salt, LEN, { N: n, r, p, maxmem: 128 * n * r * 2 }, (err, key) =>
      err ? reject(err) : resolve(key),
    )
  })
}

export function checkPassword(password: unknown): string {
  if (typeof password !== 'string' || password.length < PASSWORD.min || password.length > PASSWORD.max) {
    throw invalid(
      `A password has ${PASSWORD.min} to ${PASSWORD.max} characters.`,
      'Choose a longer one; a few unrelated words make a good password.',
    )
  }
  return password
}

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16)
  const key = await derive(password, salt, N, R, P)
  return `scrypt$${N}$${R}$${P}$${salt.toString('base64url')}$${key.toString('base64url')}`
}

// A hash to compare against when the account does not exist, so a wrong email takes as long as a
// wrong password.
let dummy: string | null = null
export async function dummyHash(): Promise<string> {
  dummy ??= await hashPassword('not-a-real-password-for-timing')
  return dummy
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const [kind, n, r, p, salt, key] = stored.split('$')
  if (kind !== 'scrypt' || !salt || !key) return false
  const want = Buffer.from(key, 'base64url')
  const got = await derive(password, Buffer.from(salt, 'base64url'), Number(n), Number(r), Number(p))
  return got.length === want.length && timingSafeEqual(got, want)
}
