// Dark by default (DESIGN.md); light is the person's choice, remembered in this browser only.
import { signal } from '@preact/signals'

export type Theme = 'dark' | 'light'
const KEY = 'rscb.theme'

function stored(): Theme {
  try {
    return localStorage.getItem(KEY) === 'light' ? 'light' : 'dark'
  } catch {
    return 'dark'
  }
}

export const theme = signal<Theme>(typeof document === 'undefined' ? 'dark' : stored())

export function applyTheme(t: Theme): void {
  theme.value = t
  document.documentElement.dataset.theme = t
  try {
    localStorage.setItem(KEY, t)
  } catch {
    // A blocked storage only means the choice is not remembered.
  }
}
