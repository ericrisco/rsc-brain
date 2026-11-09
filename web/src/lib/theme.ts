// The theme: dark until the person chooses one in the account menu (spec amendment 2026-11-09, CA11: dark is
// the style, whatever the system prefers); then the choice is remembered in this browser only.
import { signal } from '@preact/signals'

export type Theme = 'dark' | 'light'
const KEY = 'rscb.theme'

function chosen(): Theme | null {
  try {
    const v = localStorage.getItem(KEY)
    return v === 'light' || v === 'dark' ? v : null
  } catch {
    return null
  }
}

export const theme = signal<Theme>(typeof document === 'undefined' ? 'dark' : (chosen() ?? 'dark'))

function show(t: Theme): void {
  theme.value = t
  document.documentElement.dataset.theme = t
}

// At start: the remembered choice, or dark.
export function startTheme(): void {
  show(chosen() ?? 'dark')
}

// The person's choice: shown and remembered.
export function applyTheme(t: Theme): void {
  show(t)
  try {
    localStorage.setItem(KEY, t)
  } catch {
    // A blocked storage only means the choice is not remembered.
  }
}
