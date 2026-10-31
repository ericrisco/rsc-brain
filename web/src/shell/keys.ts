// Which shortcut dialogs are open, shared by the header buttons and the keyboard.
import { signal } from '@preact/signals'

export const helpOpen = signal(false)
export const searchOpen = signal(false)

// Typing in a field: single-letter shortcuts stay out of the way. A checkbox or a radio takes no text,
// so there a letter is a shortcut (a curator ticks changes, then presses `a` or `r`).
export function isTyping(t: EventTarget | null): boolean {
  if (!(t instanceof HTMLElement)) return false
  if (t instanceof HTMLInputElement && ['checkbox', 'radio', 'button', 'submit', 'reset'].includes(t.type))
    return false
  return t.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(t.tagName)
}
