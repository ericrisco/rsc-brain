// Which shortcut dialogs are open, shared by the header buttons and the keyboard.
import { signal } from '@preact/signals'

export const helpOpen = signal(false)
export const searchOpen = signal(false)

// Typing in a field: single-letter shortcuts stay out of the way.
export function isTyping(t: EventTarget | null): boolean {
  if (!(t instanceof HTMLElement)) return false
  return t.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(t.tagName)
}
