// The bar across the top of every signed-in screen, on the frame's ground with the rail (no line between
// them): where the person is (the brain and its section), and the search. On a phone the rail is that bar.
import { useLocation } from 'preact-iso'
import { T } from '../text.ts'
import { Icon } from '../ui/icons.tsx'
import { searchOpen } from './keys.ts'
import type { BrainNav } from './Rail.tsx'

type Crumb = { label: string; href?: string }

// The section a path is in, by the names of the rail.
function sectionOf(path: string, base: string): string | null {
  const s = T.shell
  const rest = path.slice(base.length)
  if (rest === '' || rest === '/') return s.overview
  if (rest.startsWith('/proposals')) return s.proposals
  if (rest.startsWith('/review-later')) return s.reviewLater
  if (rest === '/wiki/decisions') return s.decisions
  if (rest === '/wiki/log') return s.log
  if (rest.startsWith('/wiki/graph')) return s.graph
  if (rest.startsWith('/wiki') || rest.startsWith('/pages/')) return s.wiki
  if (rest.startsWith('/journal')) return s.journal
  if (rest.startsWith('/activity')) return s.activity
  if (rest.startsWith('/health')) return s.health
  if (rest.startsWith('/settings')) return s.settings
  return null
}

// Where the person is. Only what the screen already shows by name: a brain that cannot be read gives none
// (it reads like one that does not exist).
export function whereOf(path: string, brain: BrainNav | null): Crumb[] {
  const s = T.shell
  if (brain) {
    const base = `/b/${encodeURIComponent(brain.slug)}`
    const section = sectionOf(path, base)
    return section
      ? [{ label: brain.name, href: base }, { label: section }]
      : [{ label: brain.name, href: base }]
  }
  if (path === '/') return [{ label: s.allBrains }]
  if (path === '/people') return [{ label: s.people }]
  if (path.startsWith('/admin')) return [{ label: s.admin }]
  if (path === '/profile') return [{ label: s.profile }]
  if (path === '/connect') return [{ label: s.connect }]
  return []
}

export function TopBar({ brain }: { brain: BrainNav | null }) {
  const { path } = useLocation()
  const where = whereOf(path, brain)
  return (
    <div class="topbar">
      <nav class="where" aria-label={T.shell.whereYouAre}>
        <ol>
          {where.map((c, k) => (
            <li key={k}>
              {c.href && k < where.length - 1 ? (
                <a href={c.href}>{c.label}</a>
              ) : (
                <span aria-current={k === where.length - 1 ? 'location' : undefined}>{c.label}</span>
              )}
            </li>
          ))}
        </ol>
      </nav>
      <button
        type="button"
        class="topbar-search"
        onClick={() => (searchOpen.value = true)}
        aria-keyshortcuts="Meta+K Control+K"
      >
        <Icon name="search" size={16} />
        <span class="topbar-search-label">{T.shell.searchHint}</span>
        <kbd>⌘K</kbd>
      </button>
    </div>
  )
}
