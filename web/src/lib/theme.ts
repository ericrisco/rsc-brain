// The theme follows the system (prefers-color-scheme) until the person chooses one in the account menu;
// then the choice is remembered in this browser only and the system no longer changes it. Dark when the
// system says nothing (DESIGN.md).
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

const systemQuery = () =>
  typeof matchMedia === 'function' ? matchMedia('(prefers-color-scheme: light)') : null

const system = (): Theme => (systemQuery()?.matches ? 'light' : 'dark')

export const theme = signal<Theme>(typeof document === 'undefined' ? 'dark' : (chosen() ?? system()))

function show(t: Theme): void {
  theme.value = t
  document.documentElement.dataset.theme = t
}

// At start: the remembered choice, or the system's, which is then followed while nothing is chosen.
export function startTheme(): void {
  show(chosen() ?? system())
  systemQuery()?.addEventListener('change', () => {
    if (!chosen()) show(system())
  })
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
