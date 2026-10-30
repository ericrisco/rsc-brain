// The keyboard shortcuts of the web (spec B6 «Accesibilidad, teclado», CA20). Each names the visible
// control that does the same: a shortcut is a faster route, never the only one. The keymap is a small
// state machine, kept free of the DOM so it is tested on its own.
export type Shortcut = {
  id: 'search' | 'help' | 'go-home' | 'go-overview'
  keys: string[]
  label: string
  // The visible control that does the same, as the person sees it.
  control: string
  // Only inside a brain.
  inBrain?: true
}

export const SHORTCUTS: Shortcut[] = [
  {
    id: 'search',
    keys: ['⌘ K', 'Ctrl K'],
    label: 'Search your brains',
    control: 'The "Search" button in the header',
  },
  { id: 'help', keys: ['?'], label: 'Show this list', control: '"Keyboard shortcuts" in the account menu' },
  { id: 'go-home', keys: ['g', 'h'], label: 'Go home', control: 'The brand at the top left' },
  {
    id: 'go-overview',
    keys: ['g', 'o'],
    label: 'Go to the overview of this brain',
    control: '"Overview" in the side bar',
    inBrain: true,
  },
]

export type KeyLike = { key: string; metaKey: boolean; ctrlKey: boolean; altKey: boolean; typing: boolean }

const SEQUENCE_MS = 1500
const GO: Record<string, Shortcut['id']> = { h: 'go-home', o: 'go-overview' }

export function createKeymap(now: () => number) {
  let leader: number | null = null
  return {
    handle(e: KeyLike): Shortcut['id'] | null {
      const k = e.key.length === 1 ? e.key.toLowerCase() : e.key
      if ((e.metaKey || e.ctrlKey) && !e.altKey && k === 'k') {
        leader = null
        return 'search'
      }
      if (e.typing || e.metaKey || e.ctrlKey || e.altKey) {
        leader = null
        return null
      }
      if (leader !== null && now() - leader <= SEQUENCE_MS && GO[k]) {
        leader = null
        return GO[k] ?? null
      }
      leader = k === 'g' ? now() : null
      if (e.key === '?') return 'help'
      return null
    },
  }
}
