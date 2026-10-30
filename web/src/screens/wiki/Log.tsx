// The log of a wiki (spec B6 «Wiki › Log», B2 «Registro»; T020). Who: any member. Job: see what changed in
// the wiki, when and by whom. Done when: the person found the change and opened its page. Newest first, by
// pages of 50 («Show more»); filtered on the server by kind of change and by page, the filters in the
// address.
import { useEffect, useState } from 'preact/hooks'
import type { ApiError } from '../../api/client.ts'
import { api } from '../../api/index.ts'
import { online } from '../../session.ts'
import { T } from '../../text.ts'
import { Button } from '../../ui/Button.tsx'
import { Empty, ErrorState, Skeleton } from '../../ui/states.tsx'
import { pageHref, useBrain, useFilters, WikiHead } from './common.tsx'
import type { Listing, LogLine } from './data.ts'

const KINDS = ['proposal', 'direct', 'revert', 'purge'] as const

export function WikiLog({ slug }: { slug: string }) {
  const { brain, gate } = useBrain(slug)
  const f = useFilters(['kind', 'page'] as const)
  const [pageText, setPageText] = useState(f.values.page)
  const [lines, setLines] = useState<LogLine[] | null>(null)
  const [total, setTotal] = useState(0)
  const [next, setNext] = useState<string | null>(null)
  const [error, setError] = useState<ApiError | null>(null)
  const [more, setMore] = useState(false)
  const [tries, setTries] = useState(0)
  const ask = (cursor?: string) =>
    api.call<Listing<LogLine>>('wikiLog', {
      path: { slug },
      query: { kind: f.values.kind || undefined, page: f.values.page || undefined, cursor, limit: 50 },
    })
  useEffect(() => {
    if (!brain) return
    let live = true
    setError(null)
    // New filters: what is shown no longer answers them; the skeleton shows until the new lines come.
    setLines(null)
    ask().then(
      (r) => {
        if (!live) return
        setLines(r.items)
        setTotal(r.total)
        setNext(r.next)
      },
      (e: ApiError) => live && setError(e),
    )
    return () => {
      live = false
    }
  }, [brain?.slug, f.values.kind, f.values.page, tries])
  useEffect(() => setPageText(f.values.page), [f.values.page])
  if (!brain) return gate
  const w = T.wiki
  const loadMore = async () => {
    if (!next) return
    setMore(true)
    try {
      const r = await ask(next)
      setLines([...(lines ?? []), ...r.items])
      setNext(r.next)
      setTotal(r.total)
    } catch (e) {
      setError(e as ApiError)
    } finally {
      setMore(false)
    }
  }
  return (
    <>
      <WikiHead title={w.logTitle} lead={w.logLead}>
        {lines ? <span class="tag">{w.lines(total)}</span> : null}
      </WikiHead>
      <search aria-label={w.filters}>
        <form
          class="filters"
          onSubmit={(e) => {
            e.preventDefault()
            f.set({ page: pageText.trim() })
          }}
        >
          <div class="field">
            <label for="log-kind">{w.kind}</label>
            <select
              id="log-kind"
              value={f.values.kind}
              onChange={(e) => f.set({ kind: (e.currentTarget as HTMLSelectElement).value })}
            >
              <option value="">{w.anyKind}</option>
              {KINDS.map((k) => (
                <option key={k} value={k}>
                  {w.logKinds[k]}
                </option>
              ))}
            </select>
          </div>
          <div class="field grow">
            <label for="log-page">{w.page}</label>
            <input
              id="log-page"
              type="search"
              class="mono"
              value={pageText}
              aria-describedby="log-page-hint"
              onInput={(e) => setPageText((e.currentTarget as HTMLInputElement).value)}
            />
            <span id="log-page-hint" class="hint">
              {w.pageHint}
            </span>
          </div>
          <p class="actions">
            <Button type="submit">{w.apply}</Button>
          </p>
        </form>
      </search>
      {error && !lines ? (
        <ErrorState error={error} onRetry={() => setTries(tries + 1)} />
      ) : !lines ? (
        <Skeleton rows={4} />
      ) : lines.length === 0 ? (
        f.active ? (
          <Empty title={w.noLogTitle} filtered onClear={f.clear} />
        ) : (
          <Empty title={w.noLogTitle}>
            <p>{w.noLogLead}</p>
          </Empty>
        )
      ) : (
        <>
          <ul class="list log" aria-label={w.changesList}>
            {lines.map((l) => (
              <li key={l.id}>
                <p class="list-title">{l.summary}</p>
                <p class="meta">
                  <span class="mono">{T.dateTime(l.at)}</span> · {w.by(l.actorName)}
                  {l.pages.length ? ' · ' : null}
                  {l.pages.map((p, i) => (
                    <span key={p}>
                      {i ? ', ' : null}
                      <a class="mono" href={pageHref(slug, p)}>
                        {p}
                      </a>
                    </span>
                  ))}
                </p>
              </li>
            ))}
          </ul>
          {error ? <ErrorState error={error} onRetry={() => void loadMore()} focus={false} /> : null}
          {next ? (
            <p class="actions">
              <Button
                pending={more}
                pendingLabel={w.loadingMore}
                blocked={online.value ? null : w.moreOffline}
                onClick={() => void loadMore()}
              >
                {w.more}
              </Button>
            </p>
          ) : null}
        </>
      )}
    </>
  )
}
