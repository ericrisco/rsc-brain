// What the person may mean as they type: addresses of the wiki (the `[[` autocomplete, plan §3.5 G9 in its
// minimal form) and journal entries (a page's sources), in a list next to the field, walked with the arrow
// keys, picked with Enter or a click, closed with Esc. The field keeps the keyboard; the list says which
// option is active (aria-activedescendant). An answer that arrives after a newer question is dropped.
import type { ComponentChildren } from 'preact'
import { useEffect, useId, useState } from 'preact/hooks'
import { api } from '../../api/index.ts'
import { stepActive } from '../../lib/wiki.ts'
import { T } from '../../text.ts'

export type PageItem = { address: string; title: string; status: string }
export type EntryItem = { id: string; title: string; at: string }

// `first`: the first answer is chosen at once, so Enter takes it (the `[[` of the body, a source).
function useLookup<T>(load: (q: string) => Promise<T[]>, deps: unknown[], o: { first?: boolean } = {}) {
  const [query, setQuery] = useState<string | null>(null)
  const [items, setItems] = useState<T[]>([])
  const [active, setActive] = useState(-1)
  // The first answer chosen at once, not yet by the arrows.
  const [auto, setAuto] = useState(false)
  const id = useId()
  useEffect(() => {
    if (query === null) {
      setItems([])
      setActive(-1)
      return
    }
    let live = true
    const t = setTimeout(() => {
      load(query).then(
        (found) => {
          if (!live) return
          setItems(found)
          // Otherwise nothing is chosen until the arrows choose it (Enter keeps its meaning in the field).
          setActive(o.first && found.length ? 0 : -1)
          setAuto(Boolean(o.first && found.length))
        },
        () => live && setItems([]),
      )
    }, 120)
    return () => {
      live = false
      clearTimeout(t)
    }
  }, [query, ...deps])
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
    key(e: KeyboardEvent, pick: (p: T) => void): boolean {
      if (!open) return false
      if (e.key === 'Escape') {
        setQuery(null)
        return true
      }
      if (!items.length) return false
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        setActive(stepActive({ active, length: items.length, key: e.key, auto }))
        setAuto(false)
      } else if ((e.key === 'Enter' || e.key === 'Tab') && active >= 0) pick(items[active] as T)
      else return false
      return true
    },
  }
}

export type Lookup<T> = ReturnType<typeof useLookup<T>>

// `skip`: an address never offered (the page being edited cannot link to itself).
export function useSuggest(slug: string, skip?: string, o: { first?: boolean } = {}) {
  return useLookup<PageItem>(
    (q) =>
      api
        .call<{ items: PageItem[] }>('wikiPages', { path: { slug }, query: { q: q || undefined, limit: 8 } })
        .then((r) => r.items.filter((p) => p.address !== skip)),
    [slug, skip],
    o,
  )
}
export type Suggest = Lookup<PageItem>

// Journal entries of the brain by words of their title or text (GET /v1/search, entries only).
export function useEntries(slug: string) {
  return useLookup<EntryItem>(
    (q) =>
      api
        .call<{ items: { kind: string; id: string; title: string; at: string }[] }>('search', {
          query: { q: q || undefined, brains: slug, in: 'entries', limit: 8 },
        })
        .then((r) =>
          r.items.filter((h) => h.kind === 'entry').map((h) => ({ id: h.id, title: h.title, at: h.at })),
        ),
    [slug],
    { first: true },
  )
}

// The attributes of a field that suggests (a combobox with a list).
export const comboOf = <T,>(s: Lookup<T>) => ({
  role: 'combobox' as const,
  'aria-autocomplete': 'list' as const,
  'aria-expanded': s.open && s.items.length > 0,
  'aria-controls': s.listId,
  'aria-activedescendant': s.open && s.active >= 0 ? s.optionId(s.active) : undefined,
})

function Options<T>({
  s,
  label,
  none,
  keyOf,
  show,
  onPick,
  over,
}: {
  s: Lookup<T>
  label: string
  none: string
  keyOf: (x: T) => string
  show: (x: T) => ComponentChildren
  onPick: (x: T) => void
  over?: { top: number } | { bottom: number } | undefined
}) {
  if (!s.open) return null
  const at = over ? ('top' in over ? { top: `${over.top}px` } : { bottom: `${over.bottom}px` }) : undefined
  return (
    <div class={over ? 'suggest over' : 'suggest'} style={at}>
      {s.items.length ? (
        // The ARIA listbox of a combobox: the field keeps the keyboard and names the active option
        // (aria-activedescendant), so the options are not focusable themselves; a <select> cannot do this.
        // biome-ignore lint/a11y/noNoninteractiveElementToInteractiveRole: see above
        <ul role="listbox" id={s.listId} aria-label={label}>
          {s.items.map((p, i) => (
            // biome-ignore lint/a11y/useFocusableInteractive: an option of the listbox above; the field keeps the keyboard
            <li
              key={keyOf(p)}
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
              {show(p)}
            </li>
          ))}
        </ul>
      ) : (
        <p class="meta" id={s.listId}>
          {none}
        </p>
      )}
    </div>
  )
}

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
  return (
    <Options
      s={s}
      label={T.wiki.suggestions}
      none={T.wiki.noSuggestions}
      keyOf={(p) => p.address}
      onPick={onPick}
      over={over}
      show={(p) => (
        <>
          <span class="mono">{p.address}</span> <span class="meta">{p.title}</span>
          {p.status !== 'current' ? (
            <span class="tag warn">{T.wiki.statuses[p.status] ?? p.status}</span>
          ) : null}
        </>
      )}
    />
  )
}

export function EntryList({ s, onPick }: { s: Lookup<EntryItem>; onPick: (e: EntryItem) => void }) {
  return (
    <Options
      s={s}
      label={T.wiki.entrySuggestions}
      none={T.wiki.noEntries}
      keyOf={(e) => e.id}
      onPick={onPick}
      show={(e) => (
        <>
          <span>{e.title || e.id}</span> <span class="meta">{T.date(e.at)}</span>
        </>
      )}
    />
  )
}
