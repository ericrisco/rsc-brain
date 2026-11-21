// How the graph looks: plain until the person turns the hologram on with the graph's tools; then the choice
// is remembered in this browser only (as the theme is, lib/theme.ts).
import { signal } from '@preact/signals'
import type { Look } from '../graph/render.ts'

const KEY = 'rscb.graphLook'

function chosen(): Look {
  try {
    return localStorage.getItem(KEY) === 'holo' ? 'holo' : 'plain'
  } catch {
    return 'plain'
  }
}

export const graphLook = signal<Look>(typeof document === 'undefined' ? 'plain' : chosen())

// The person's choice: shown and remembered.
export function setGraphLook(l: Look): void {
  graphLook.value = l
  try {
    localStorage.setItem(KEY, l)
  } catch {
    // A blocked storage only means the choice is not remembered.
  }
}
