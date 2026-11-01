// One-time things a screen says after an action elsewhere, kept for the session only.
import { signal } from '@preact/signals'

// Set when an administrator took away their own rights in the administration (after the server agreed):
// the administration closes once with why, then reads as any other refusal. Gone at sign-out.
export const leftAdmin = signal(false)

// After a rights change in the administration: only my own removal, once the server agreed, sets the flag.
export function rightsChanged(c: { ok: boolean; self: boolean; body: Record<string, boolean> }): void {
  if (c.ok && c.self && c.body.isAdmin === false) leftAdmin.value = true
}

// Read once: true the first time after my own removal, then false until it happens again.
export function takeLeftAdmin(): boolean {
  const was = leftAdmin.value
  leftAdmin.value = false
  return was
}
