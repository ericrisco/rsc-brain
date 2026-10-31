// The keyboard shortcuts of the web (spec B6 «Accesibilidad, teclado», CA20). Each names the visible
// control that does the same: a shortcut is a faster route, never the only one. The keymap is a small
// state machine, kept free of the DOM so it is tested on its own.
export type Shortcut = {
  id:
    | 'search'
    | 'help'
    | 'go-home'
    | 'go-overview'
    | 'go-wiki'
    | 'go-decisions'
    | 'go-log'
    | 'go-journal'
    | 'go-people'
    | 'go-proposals'
    | 'edit'
    | 'approve'
    | 'return'
  keys: string[]
  label: string
  // The visible control that does the same, as the person sees it.
  control: string
  // Only inside a brain.
  inBrain?: true
  // Only for whoever may invite people.
  invite?: true
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
    id: 'go-people',
    keys: ['g', 'p'],
    label: 'Go to People',
    control: '"People" in the header or the account menu',
    invite: true,
  },
  {
    id: 'go-overview',
    keys: ['g', 'o'],
    label: 'Go to the overview of this brain',
    control: '"Overview" in the side bar',
    inBrain: true,
  },
  {
    id: 'go-wiki',
    keys: ['g', 'w'],
    label: 'Go to the wiki of this brain',
    control: '"Wiki" in the side bar',
    inBrain: true,
  },
  {
    id: 'go-decisions',
    keys: ['g', 'd'],
    label: 'Go to the decisions of this brain',
    control: '"Decisions" in the side bar',
    inBrain: true,
  },
  {
    id: 'go-log',
    keys: ['g', 'l'],
    label: 'Go to the log of this brain’s wiki',
    control: '"Log" in the side bar',
    inBrain: true,
  },
  {
    id: 'go-journal',
    keys: ['g', 'j'],
    label: 'Go to the journal of this brain',
    control: '"Journal" in the side bar',
    inBrain: true,
  },
  {
    id: 'go-proposals',
    keys: ['g', 'r'],
    label: 'Go to the proposals to review in this brain',
    control: '"Proposals" in the side bar',
    inBrain: true,
  },
  {
    id: 'approve',
    keys: ['a'],
    label: 'Approve all of the proposal you are reading (curators)',
    control: 'The "Approve all" button of the proposal',
    inBrain: true,
  },
  {
    id: 'return',
    keys: ['r'],
    label: 'Return the proposal you are reading, with your comment (curators)',
    control: 'The "Return" button of the proposal',
    inBrain: true,
  },
  {
    id: 'edit',
    keys: ['e'],
    label: 'Edit the wiki page you are reading (curators)',
    control: '"Edit" above the page',
    inBrain: true,
  },
]

export type KeyLike = { key: string; metaKey: boolean; ctrlKey: boolean; altKey: boolean; typing: boolean }

const SEQUENCE_MS = 1500
const GO: Record<string, Shortcut['id']> = {
  h: 'go-home',
  o: 'go-overview',
  w: 'go-wiki',
  d: 'go-decisions',
  l: 'go-log',
  j: 'go-journal',
  p: 'go-people',
  r: 'go-proposals',
}

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
      if (k === 'e' && e.key === 'e') return 'edit'
      if (k === 'a' && e.key === 'a') return 'approve'
      if (k === 'r' && e.key === 'r') return 'return'
      return null
    },
  }
}
