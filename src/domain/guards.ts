// Who may manage people and keys (spec B4): managing happens in the web, with a person's session; an
// agent's key never invites, changes roles or creates keys.
import { AppError } from '../core/errors.ts'
import type { Ctx } from './context.ts'

export function inWeb(ctx: Ctx, what = 'This'): void {
  if (ctx.who.credential.kind !== 'web') {
    throw new AppError(
      403,
      'web_only',
      `${what} is done in the rsc-brain web, signed in as a person.`,
      'Open the rsc-brain web. Keys of agents and programs cannot manage people or keys.',
    )
  }
}

export function adminOnly(ctx: Ctx): void {
  inWeb(ctx)
  if (!(ctx.who.isAdmin && ctx.who.kind === 'person')) {
    throw new AppError(
      403,
      'forbidden',
      'Only the administration of this installation does this.',
      'Ask an administrator.',
    )
  }
}

export const EMAIL = /^[^\s@<>()",;:\\[\]]+@[^\s@<>()",;:\\[\]]+\.[^\s@<>()",;:\\[\]]+$/

// An email as people type it: trimmed, lowercased, and plain (no display name, no comment, no list),
// so nothing in it can turn into another recipient.
export function emailOf(v: unknown): string | null {
  if (typeof v !== 'string') return null
  const e = v.trim().toLowerCase()
  return e.length <= 320 && EMAIL.test(e) ? e : null
}
