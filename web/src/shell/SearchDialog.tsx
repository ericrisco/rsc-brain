// ⌘K / Ctrl K, or the Search button (spec B6 «Search», T039): searches the brain on screen or all the
// person's brains (GET /v1/search, B3), and says why each result is there. Filters sit at the side, in a
// panel on a phone. With nothing found it offers to remove the filters or to search every brain. The arrows
// move between results, Enter opens one, Esc goes back with the keyboard where it was.
import { useEffect, useLayoutEffect, useRef, useState } from 'preact/hooks'
import type { ApiError } from '../api/client.ts'
import { api } from '../api/index.ts'
import { pageHref } from '../lib/markdown.ts'
import {
  activeFilters,
  noResults,
  type SearchForm,
  searchParams,
  snippetParts,
  typesFor,
} from '../lib/search.ts'
import { brainsResource } from '../screens/Home.tsx'
import { entryHref } from '../screens/journal/common.tsx'
import { online } from '../session.ts'
import { T } from '../text.ts'
import { Button } from '../ui/Button.tsx'
import { Dialog } from '../ui/Dialog.tsx'
import { ErrorState } from '../ui/states.tsx'
import { searchOpen } from './keys.ts'

type Hit = {
  kind: string
  id: string
  address?: string
  brain: string
  type: string
  state: string
  title: string
  snippet: string
  why: string
  reason: string
  at: string
}

type Filters = Pick<SearchForm, 'what' | 'type' | 'from'>
// How long the field rests before the search runs by itself, in ms.
const TYPING_PAUSE = 150
const NONE: Filters = { what: '', type: '', from: '' }

const hrefOf = (h: Hit) =>
  h.kind === 'page' && h.address
    ? pageHref(h.brain, h.address)
    : h.kind === 'entry'
      ? entryHref(h.brain, h.id)
      : null

export function SearchDialog({ brain }: { brain: { slug: string; name: string } | null }) {
  const s = T.search
  const [q, setQ] = useState('')
  const [scope, setScope] = useState<'brain' | 'all'>(brain ? 'brain' : 'all')
  const [filters, setFilters] = useState<Filters>(NONE)
  const [panel, setPanel] = useState(false)
  const [asked, setAsked] = useState('')
  const [hits, setHits] = useState<Hit[] | null>(null)
  const [next, setNext] = useState<number | null>(null)
  // The server omits meaning when this request searched by words alone, including exact phrases.
  const [meaning, setMeaning] = useState<string | null>(null)
  const [error, setError] = useState<ApiError | null>(null)
  const [pending, setPending] = useState(false)
  const opener = useRef<HTMLElement | null>(null)
  const list = useRef<HTMLUListElement>(null)
  const input = useRef<HTMLInputElement>(null)
  const grown = useRef<number | null>(null)
  // The search the results on screen answer (more results page this one, never the field as it is now).
  const shown = useRef<SearchForm | null>(null)
  // Each request is numbered: only the answer to the latest lands.
  const seq = useRef(0)
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const open = searchOpen.value
  const here = brain?.slug ?? null

  const clear = () => {
    seq.current += 1
    shown.current = null
    clearTimeout(timer.current)
    setHits(null)
    setNext(null)
    setMeaning(null)
    setAsked('')
    setError(null)
    setPending(false)
  }

  // Opened: where the keyboard was, and the brain on screen as the place to search; results asked under
  // another place are dropped. Closed: the keyboard goes back there, unless a result was opened (the new
  // screen places it).
  useLayoutEffect(() => {
    if (open) {
      opener.current = document.activeElement instanceof HTMLElement ? document.activeElement : null
      const place = here ? 'brain' : 'all'
      setScope(place)
      const was = shown.current
      // Restore a completed search only when its answer still matches the field and the opening scope.
      if (was?.q !== q.trim() || was.scope !== place || was.brain !== here) {
        setQ('')
        clear()
      }
      setPending(false)
      return () => {
        clearTimeout(timer.current)
        seq.current += 1
      }
    }
    const back = opener.current
    opener.current = null
    if (back?.isConnected && (document.activeElement === document.body || document.activeElement === null))
      back.focus()
  }, [open, here])

  const ask = async (form: SearchForm, offset = 0) => {
    const mine = ++seq.current
    setPending(true)
    setError(null)
    try {
      const r = await api.call<{ items: Hit[]; next: number | null; meaning?: string }>('search', {
        query: searchParams(form, offset),
      })
      if (mine !== seq.current) return
      if (offset) {
        grown.current = hits?.length ?? 0
        setHits([...(hits ?? []), ...r.items])
      } else setHits(r.items)
      shown.current = form
      setMeaning(r.meaning ?? null)
      setNext(r.next)
      setAsked(form.q)
    } catch (e) {
      if (mine === seq.current) setError(e as ApiError)
    } finally {
      if (mine === seq.current) setPending(false)
    }
  }

  // The words in the field, where the dialog says, with the filters shown.
  const run = (value = q, place = scope, criteria = filters) => {
    clearTimeout(timer.current)
    const text = value.trim()
    if (text && searchOpen.value && online.value)
      void ask({ q: text, scope: place, brain: here, ...criteria })
  }

  const edit = (value: string) => {
    setQ(value)
    if (!value.trim()) {
      clear()
      return
    }
    // Keep the visible results available for paging, but discard answers still on their way.
    seq.current += 1
    setPending(false)
    setError(null)
    clearTimeout(timer.current)
    timer.current = setTimeout(() => run(value), TYPING_PAUSE)
  }

  // More results of the search on screen.
  const more = () => {
    const form = shown.current
    if (form && next !== null) void ask(form, next)
  }

  // More results: the keyboard goes to the first new one.
  useEffect(() => {
    const at = grown.current
    if (at === null) return
    grown.current = null
    list.current?.querySelectorAll<HTMLElement>('a.rt')[at]?.focus()
  }, [hits])

  // Changing the scope or filters submits the words in the field, even before the first answer.
  const change = (o: { scope?: 'brain' | 'all'; filters?: Filters }) => {
    const place = o.scope ?? scope
    let criteria = o.filters ?? filters
    if (o.scope) setScope(place)
    if (o.filters) {
      if (!typesFor(criteria.what).includes(criteria.type)) criteria = { ...criteria, type: '' }
      setFilters(criteria)
    }
    clear()
    run(q, place, criteria)
  }

  // Up and down move between the field and the results.
  const move = (e: KeyboardEvent) => {
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return
    const links = [...(list.current?.querySelectorAll<HTMLElement>('a.rt') ?? [])]
    if (!links.length) return
    const at = links.indexOf(document.activeElement as HTMLElement)
    e.preventDefault()
    if (e.key === 'ArrowDown') links[Math.min(at + 1, links.length - 1)]?.focus()
    else if (at <= 0) input.current?.focus()
    else links[at - 1]?.focus()
  }

  // In no brain yet: nothing to search, and the dialog says so instead of offering a search that can
  // only come back empty.
  const none = open && brainsResource().data.value?.brains.length === 0
  const nFilters = activeFilters(filters)
  const help = hits?.length === 0 ? noResults({ filtered: nFilters > 0, scope, inBrain: Boolean(brain) }) : []
  const set = (k: keyof Filters) => (e: Event) =>
    change({ filters: { ...filters, [k]: (e.currentTarget as HTMLInputElement | HTMLSelectElement).value } })
  return (
    <Dialog open={open} title={s.title} onClose={() => (searchOpen.value = false)} class="search-dialog">
      {none ? (
        <div class="state" data-state="empty">
          <h3>{s.nothingTitle}</h3>
          <p class="how">{s.nothingLead}</p>
        </div>
      ) : (
        <div class={`search-layout${panel ? ' panel-open' : ''}`}>
          <search class="search-main">
            <form
              class="form"
              onSubmit={(e) => {
                e.preventDefault()
                run()
              }}
            >
              <div class="field">
                <label for="search-q">{s.label}</label>
                <div class="input-row">
                  <input
                    id="search-q"
                    ref={input}
                    type="search"
                    value={q}
                    autoFocus
                    autocomplete="off"
                    placeholder={s.placeholder}
                    aria-describedby="search-hint"
                    onInput={(e) => edit(e.currentTarget.value)}
                    onKeyDown={(e) => {
                      // Esc goes back (spec B6 «Search»), even with text in the field, which a search field
                      // would otherwise only clear.
                      if (e.key === 'Escape') {
                        e.preventDefault()
                        searchOpen.value = false
                      } else move(e)
                    }}
                  />
                  {/* Never held while a search is on its way: new words replace it (the latest answer wins). */}
                  <Button
                    type="submit"
                    kind="primary"
                    aria-busy={pending ? 'true' : undefined}
                    blocked={online.value ? null : T.states.writeOffline}
                  >
                    {s.submit}
                  </Button>
                </div>
                <span id="search-hint" class="hint">
                  {s.hint}
                </span>
              </div>
              {brain ? (
                <fieldset class="scope">
                  <legend>{s.scope}</legend>
                  <label>
                    <input
                      type="radio"
                      name="search-scope"
                      checked={scope === 'brain'}
                      onChange={() => change({ scope: 'brain' })}
                    />{' '}
                    {s.scopeBrain(brain.name)}
                  </label>
                  <label>
                    <input
                      type="radio"
                      name="search-scope"
                      checked={scope === 'all'}
                      onChange={() => change({ scope: 'all' })}
                    />{' '}
                    {s.scopeAll}
                  </label>
                </fieldset>
              ) : null}
              <button
                type="button"
                class="button secondary only-narrow filters-toggle"
                aria-expanded={panel ? 'true' : 'false'}
                aria-controls="search-filters"
                onClick={() => setPanel(!panel)}
              >
                {panel ? s.hideFilters : s.filtersOn(nFilters)}
              </button>
            </form>
          </search>
          <aside class="search-filters" id="search-filters" aria-label={s.filters}>
            <h3 class="section-title search-filters-title">{s.filters}</h3>
            <div class="field">
              <label for="search-what">{s.what}</label>
              <select id="search-what" value={filters.what} onChange={set('what')}>
                <option value="">{s.whatAll}</option>
                <option value="pages">{s.whatPages}</option>
                <option value="entries">{s.whatEntries}</option>
              </select>
            </div>
            <div class="field">
              <label for="search-type">{s.type}</label>
              <select id="search-type" value={filters.type} onChange={set('type')}>
                <option value="">{s.anyType}</option>
                {typesFor(filters.what).map((t) => (
                  <option key={t} value={t}>
                    {T.journal.types[t] ?? T.wiki.types[t] ?? t}
                  </option>
                ))}
              </select>
            </div>
            <div class="field">
              <label for="search-from">{s.from}</label>
              <input id="search-from" type="date" value={filters.from} onChange={set('from')} />
            </div>
            {nFilters ? (
              <button type="button" class="button quiet" onClick={() => change({ filters: NONE })}>
                {T.states.clearFilters}
              </button>
            ) : null}
          </aside>
          <div class="search-results">
            {error ? <ErrorState error={error} onRetry={() => run()} /> : null}
            {hits && !error ? (
              <section aria-live="polite" aria-label={s.results(hits.length, next !== null)}>
                {hits.length ? <p class="meta">{s.results(hits.length, next !== null)}</p> : null}
                {meaning === null ? <p class="hint meaning-hint">{s.wordsOnlyHint}</p> : null}
                {hits.length ? null : (
                  <div class="state" data-state="filtered-empty">
                    <h3>{s.none(asked)}</h3>
                    <p class="how">{s.noneHow}</p>
                    {help.includes('clear') ? <p>{s.noneFiltered}</p> : null}
                    {help.includes('all') && brain ? <p>{s.noneHere(brain.name)}</p> : null}
                    {help.length ? (
                      <div class="actions">
                        {help.includes('clear') ? (
                          <Button onClick={() => change({ filters: NONE })}>{s.clearFilters}</Button>
                        ) : null}
                        {help.includes('all') ? (
                          <Button onClick={() => change({ scope: 'all' })}>{s.searchAll}</Button>
                        ) : null}
                      </div>
                    ) : null}
                  </div>
                )}
                {hits.length ? (
                  <ul class="results" aria-label="Results" ref={list} onKeyDown={move}>
                    {hits.map((h, i) => {
                      const href = hrefOf(h)
                      const close = () => (searchOpen.value = false)
                      return (
                        <li key={`${h.kind}:${h.id}:${i}`}>
                          <span class="meta">
                            {s.kind[h.kind] ?? h.kind} · <span class="mono">{h.brain}</span> ·{' '}
                            {T.dateTime(h.at)}
                          </span>
                          {href ? (
                            <a class="rt" href={href} onClick={close}>
                              {h.title || h.id}
                            </a>
                          ) : (
                            <span class="rt">{h.title}</span>
                          )}
                          <span class="snippet">
                            {snippetParts(h.snippet).map((p, k) =>
                              p.mark ? <mark key={k}>{p.text}</mark> : <span key={k}>{p.text}</span>,
                            )}
                          </span>
                          <span class="why">
                            <span class="sr-only">{s.why}: </span>
                            <span class={`tag why-${h.why}`}>{h.reason}</span>
                            {s.states[h.state] ? <span class="tag warn">{s.states[h.state]}</span> : null}
                          </span>
                        </li>
                      )
                    })}
                  </ul>
                ) : null}
                {next !== null && hits.length ? (
                  <Button pending={pending} pendingLabel="…" onClick={more}>
                    {s.more}
                  </Button>
                ) : null}
              </section>
            ) : null}
          </div>
        </div>
      )}
    </Dialog>
  )
}
