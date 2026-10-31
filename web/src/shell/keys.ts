// Which shortcut dialogs are open, shared by the header buttons and the keyboard.
import { signal } from '@preact/signals'

export const helpOpen = signal(false)
export const searchOpen = signal(false)

// Typing in a field: single-letter shortcuts stay out of the way. A control marked data-letter-keys takes
// no text and lets them through (the checkboxes of a proposal's changes: tick, then `a` or `r`).
export function isTyping(t: EventTarget | null): boolean {
  if (!(t instanceof HTMLElement)) return false
  if (t.hasAttribute('data-letter-keys')) return false
  return t.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(t.tagName)
}
