// Addresses of the wiki as the person types (the `[[` autocomplete, plan §3.5 G9 in its minimal form): a
// list under the field, walked with the arrow keys, picked with Enter or a click, closed with Esc. The
// field keeps the keyboard; the list says which option is active (aria-activedescendant).
import { useEffect, useId, useState } from 'preact/hooks'
import { api } from '../../api/index.ts'
import { T } from '../../text.ts'

export type PageItem = { address: string; title: string; status: string }

// `skip`: an address never offered (the page being edited cannot link to itself).
export function useSuggest(slug: string, skip?: string) {
  const [query, setQuery] = useState<string | null>(null)
  const [items, setItems] = useState<PageItem[]>([])
  const [active, setActive] = useState(-1)
  const id = useId()
  useEffect(() => {
    if (query === null) {
      setItems([])
      setActive(-1)
      return
    }
    let live = true
    const t = setTimeout(() => {
      api
        .call<{ items: PageItem[] }>('wikiPages', {
          path: { slug },
          query: { q: query || undefined, limit: 8 },
        })
        .then(
          (r) => {
            if (!live) return
            setItems(r.items.filter((p) => p.address !== skip))
            // Nothing is chosen until the arrows choose it (Enter keeps its meaning in the field).
            setActive(-1)
          },
          () => live && setItems([]),
        )
    }, 120)
    return () => {
      live = false
      clearTimeout(t)
    }
  }, [query, slug, skip])
  const open = query !== null
  return {
    open,
    items,
    active,
    listId: `${id}-list`,
    optionId: (i: number) => `${id}-opt-${i}`,
    ask: (q: string | null) => setQuery(q),
    close: () => setQuery(null),
    // The keys the field gives the list; true when one was used.
    key(e: KeyboardEvent, pick: (p: PageItem) => void): boolean {
      if (!open) return false
      if (e.key === 'Escape') {
        setQuery(null)
        return true
      }
      if (!items.length) return false
      if (e.key === 'ArrowDown') setActive((active + 1) % items.length)
      else if (e.key === 'ArrowUp') setActive((active - 1 + items.length) % items.length)
      else if ((e.key === 'Enter' || e.key === 'Tab') && active >= 0) pick(items[active] as PageItem)
      else return false
      return true
    },
  }
}

export type Suggest = ReturnType<typeof useSuggest>

// The attributes of a field that suggests addresses (a combobox with a list).
export const comboOf = (s: Suggest) => ({
  role: 'combobox' as const,
  'aria-autocomplete': 'list' as const,
  'aria-expanded': s.open && s.items.length > 0,
  'aria-controls': s.listId,
  'aria-activedescendant': s.open && s.active >= 0 ? s.optionId(s.active) : undefined,
})

export function SuggestList({
  s,
  onPick,
  over,
}: {
  s: Suggest
  onPick: (p: PageItem) => void
  // Shown over the field at this place (a long text field), instead of under it.
  over?: { top: number } | { bottom: number }
}) {
  if (!s.open) return null
  const at = over ? ('top' in over ? { top: `${over.top}px` } : { bottom: `${over.bottom}px` }) : undefined
  return (
    <div class={over ? 'suggest over' : 'suggest'} style={at}>
      {s.items.length ? (
        // The ARIA listbox of a combobox: the field keeps the keyboard and names the active option
        // (aria-activedescendant), so the options are not focusable themselves; a <select> cannot do this.
        // biome-ignore lint/a11y/noNoninteractiveElementToInteractiveRole: see above
        <ul role="listbox" id={s.listId} aria-label={T.wiki.suggestions}>
          {s.items.map((p, i) => (
            // biome-ignore lint/a11y/useFocusableInteractive: an option of the listbox above; the field keeps the keyboard
            <li
              key={p.address}
              id={s.optionId(i)}
              // biome-ignore lint/a11y/noNoninteractiveElementToInteractiveRole: an option of the listbox above
              role="option"
              aria-selected={i === s.active ? 'true' : 'false'}
              // The field keeps the keyboard: a press picks without leaving it.
              onMouseDown={(e) => {
                e.preventDefault()
                onPick(p)
              }}
            >
              <span class="mono">{p.address}</span> <span class="meta">{p.title}</span>
              {p.status !== 'current' ? (
                <span class="tag warn">{T.wiki.statuses[p.status] ?? p.status}</span>
              ) : null}
            </li>
          ))}
        </ul>
      ) : (
        <p class="meta" id={s.listId}>
          {T.wiki.noSuggestions}
        </p>
      )}
    </div>
  )
}
