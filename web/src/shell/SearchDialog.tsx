// ⌘K / Ctrl K, or the Search button: searches every brain the person can read (GET /v1/search, B3) and
// shows what matched and where. Opening a result arrives with the wiki and journal screens (PR19, PR20).
import { useState } from 'preact/hooks'
import type { ApiError } from '../api/client.ts'
import { api } from '../api/index.ts'
import { online } from '../session.ts'
import { T } from '../text.ts'
import { Button } from '../ui/Button.tsx'
import { Dialog } from '../ui/Dialog.tsx'
import { ErrorState } from '../ui/states.tsx'
import { searchOpen } from './keys.ts'

type Hit = { kind: string; id: string; brain: string; title: string; snippet: string; at: string }

export function SearchDialog() {
  const [q, setQ] = useState('')
  const [asked, setAsked] = useState('')
  const [hits, setHits] = useState<Hit[] | null>(null)
  const [error, setError] = useState<ApiError | null>(null)
  const [pending, setPending] = useState(false)
  const run = async () => {
    const text = q.trim()
    if (!text || pending) return
    setPending(true)
    setError(null)
    try {
      const r = await api.call<{ items: Hit[] }>('search', { query: { q: text, limit: 20 } })
      setHits(r.items)
      setAsked(text)
    } catch (e) {
      setError(e as ApiError)
    } finally {
      setPending(false)
    }
  }
  return (
    <Dialog open={searchOpen.value} title={T.search.title} onClose={() => (searchOpen.value = false)}>
      <search>
        <form
          class="form"
          onSubmit={(e) => {
            e.preventDefault()
            void run()
          }}
        >
          <div class="field">
            <label for="search-q">{T.search.label}</label>
            <div class="input-row">
              <input
                id="search-q"
                type="search"
                value={q}
                autoFocus
                autocomplete="off"
                placeholder={T.search.placeholder}
                onInput={(e) => setQ((e.currentTarget as HTMLInputElement).value)}
                onKeyDown={(e) => {
                  // Esc goes back (spec B6 «Search»), even with text in the field, which a search field
                  // would otherwise only clear.
                  if (e.key === 'Escape') {
                    e.preventDefault()
                    searchOpen.value = false
                  }
                }}
              />
              <Button
                type="submit"
                kind="primary"
                pending={pending}
                pendingLabel="…"
                blocked={online.value ? null : T.states.writeOffline}
              >
                {T.search.submit}
              </Button>
            </div>
          </div>
        </form>
      </search>
      {error ? <ErrorState error={error} onRetry={() => void run()} /> : null}
      {hits && !error ? (
        <section aria-live="polite">
          {hits.length ? (
            <p class="meta">
              {T.search.results(hits.length)}. {T.search.hint}
            </p>
          ) : null}
          {hits.length === 0 ? (
            <div class="state" data-state="filtered-empty">
              <h2>{T.search.none(asked)}</h2>
              <p class="how">{T.search.noneHow}</p>
            </div>
          ) : (
            <ul class="results">
              {hits.map((h) => (
                <li key={`${h.kind}:${h.id}`}>
                  <span class="meta">
                    {T.search.kind[h.kind] ?? h.kind} · <span class="mono">{h.brain}</span> ·{' '}
                    {T.dateTime(h.at)}
                  </span>
                  <span class="rt">{h.title}</span>
                  <span class="snippet">{h.snippet}</span>
                </li>
              ))}
            </ul>
          )}
        </section>
      ) : null}
    </Dialog>
  )
}
