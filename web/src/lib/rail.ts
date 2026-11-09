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

// A tablet (768–1099px): the open rail covers the screen there, so it opens for the moment only, and is
// never read from nor saved to the remembered choice (review R2).
export const TABLET = '(min-width: 768px) and (max-width: 1099px)'
export const isTablet = (): boolean => {
  // Read from globalThis: this module is also loaded by the node tests, where there is no window.
  const mm = (globalThis as { matchMedia?: (q: string) => { matches: boolean } }).matchMedia
  return typeof mm === 'function' && mm(TABLET).matches
}

type Where = { tablet?: boolean }

// At start: the remembered choice, folded when there is none (always folded on a tablet).
export function startRail(store: Store | null = browserStore(), where: Where = { tablet: isTablet() }): void {
  rail.value = where.tablet ? 'folded' : readRail(store)
}

// The person's choice: shown, and remembered unless on a tablet.
export function setRail(
  r: Rail,
  store: Store | null = browserStore(),
  where: Where = { tablet: isTablet() },
): void {
  rail.value = r
  if (where.tablet) return
  try {
    store?.setItem(RAIL_KEY, r)
  } catch {
    // A blocked storage only means the choice is not remembered.
  }
}

export function toggleRail(
  store: Store | null = browserStore(),
  where: Where = { tablet: isTablet() },
): void {
  setRail(rail.value === 'open' ? 'folded' : 'open', store, where)
}

// Folded for the moment, the remembered choice untouched (a tablet's rail closing).
export function foldRail(): void {
  rail.value = 'folded'
}
