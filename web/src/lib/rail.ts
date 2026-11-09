// The rail at the left of every signed-in screen (plan canvas-ui D3): folded to its icons (56px) until the
// person opens it to show their names (220px); the choice is remembered in this browser only, like the
// theme. The frame reads the signal as data-rail, which sets its width.
import { signal } from '@preact/signals'

export type Rail = 'folded' | 'open'
export const RAIL_KEY = 'rscb.rail'

type Store = { getItem(k: string): string | null; setItem(k: string, v: string): void }

function browserStore(): Store | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage
  } catch {
    return null
  }
}

export function readRail(store: Store | null): Rail {
  try {
    return store?.getItem(RAIL_KEY) === 'open' ? 'open' : 'folded'
  } catch {
    return 'folded'
  }
}

export const rail = signal<Rail>('folded')

// At start: the remembered choice, folded when there is none.
export function startRail(store: Store | null = browserStore()): void {
  rail.value = readRail(store)
}

// The person's choice: shown and remembered.
export function setRail(r: Rail, store: Store | null = browserStore()): void {
  rail.value = r
  try {
    store?.setItem(RAIL_KEY, r)
  } catch {
    // A blocked storage only means the choice is not remembered.
  }
}

export function toggleRail(store: Store | null = browserStore()): void {
  setRail(rail.value === 'open' ? 'folded' : 'open', store)
}
