// The mode of the web: light, dark or high contrast. With no choice the web follows the system (dark when it
// asks for dark, high contrast when it asks for more contrast); the person can pick one in the account menu,
// remembered in this browser only. The key is the one earlier versions used for their light or dark choice, so
// that choice is kept. The mode in use is on <html data-theme>, set before the first frame by boot/mode.js;
// this module keeps it current afterwards.
import { signal } from '@preact/signals'

export type Mode = 'light' | 'dark' | 'contrast'
export type Choice = 'system' | Mode
export const MODE_KEY = 'rscb.theme'
export const CHOICES: Choice[] = ['system', 'light', 'dark', 'contrast']

type Store = { getItem(k: string): string | null; setItem(k: string, v: string): void }
type Media = (q: string) => { matches: boolean }

const browserStore = (): Store | null => {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage
  } catch {
    return null
  }
}

const browserMedia = (): Media | null => {
  const mm = (globalThis as { matchMedia?: Media }).matchMedia
  return typeof mm === 'function' ? mm.bind(globalThis) : null
}

// The stored choice; anything else (nothing, an unknown word, a blocked storage) is the system's.
export function readChoice(store: Store | null = browserStore()): Choice {
  try {
    const v = store?.getItem(MODE_KEY)
    return v === 'light' || v === 'dark' || v === 'contrast' || v === 'system' ? v : 'system'
  } catch {
    return 'system'
  }
}

// What the system asks for: more contrast first (one version, on white), then dark, else light.
export function systemMode(media: Media | null = browserMedia()): Mode {
  if (media?.('(prefers-contrast: more)').matches) return 'contrast'
  if (media?.('(prefers-color-scheme: dark)').matches) return 'dark'
  return 'light'
}

export const resolve = (c: Choice, media: Media | null = browserMedia()): Mode =>
  c === 'system' ? systemMode(media) : c

export const choice = signal<Choice>('system')
export const mode = signal<Mode>('light')

function show(c: Choice): void {
  choice.value = c
  mode.value = resolve(c)
  const root = document.documentElement
  root.dataset.theme = mode.value
  root.dataset.modeChoice = c
}

let listening = false
// The system changes its mind (a schedule, a setting): followed at once while the choice is the system's.
function follow(): void {
  if (listening || typeof matchMedia !== 'function') return
  listening = true
  for (const q of ['(prefers-color-scheme: dark)', '(prefers-contrast: more)'])
    matchMedia(q).addEventListener('change', () => {
      if (choice.value === 'system') show('system')
    })
}

// At start: the stored choice (boot/mode.js already painted it).
export function startMode(): void {
  show(readChoice())
  follow()
}

// The person's choice: shown at once, without a reload, and remembered.
export function chooseMode(c: Choice, store: Store | null = browserStore()): void {
  show(c)
  try {
    store?.setItem(MODE_KEY, c)
  } catch {
    // A blocked storage only means the choice is not remembered.
  }
}
