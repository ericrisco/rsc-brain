// Entries about a page (review of PR23, from Health «N newer entries about it»). Who: any member. Job: read
// what the journal says about a page since it last changed, to fix the page by hand. Done when: the person
// has read them, or opened the page. The same rule as a stale page: the entry's topic is the address, or its
// text names the address as a word (GET …/entries?about=&since=).
import { useState } from 'preact/hooks'
import { useLocation } from 'preact-iso'
import type { ApiError } from '../../api/client.ts'
import { useFresh } from '../../api/fresh.ts'
import { api } from '../../api/index.ts'
import { resource } from '../../api/resource.ts'
import { isAddress, pageHref } from '../../lib/markdown.ts'
import { T } from '../../text.ts'
import { Button } from '../../ui/Button.tsx'
import { Empty, ErrorState, Skeleton } from '../../ui/states.tsx'
import { useBrain } from '../wiki/common.tsx'
import { EntryLine, JournalNav } from './common.tsx'
import type { EntryListed, Listing } from './data.ts'

const PAGE = 50

const aboutResource = (slug: string, address: string, since: string) =>
  resource(`brain:${slug}:journal:about:${address}:${since}`, () =>
    api.call<Listing<EntryListed>>('entries', {
      path: { slug },
      query: { about: address, ...(since ? { since } : {}), limit: PAGE },
    }),
  )

export function JournalAbout({ slug }: { slug: string }) {
  const { brain, gate } = useBrain(slug)
  const { query } = useLocation()
  const address = query.address ?? ''
  const since = query.since && !Number.isNaN(Date.parse(query.since)) ? query.since : ''
  const ok = isAddress(address)
  const [more, setMore] = useState<EntryListed[]>([])
  const [next, setNext] = useState<string | null | undefined>(undefined)
  const [pending, setPending] = useState(false)
  const [moreError, setMoreError] = useState<ApiError | null>(null)
  const r = aboutResource(slug, ok ? address : '-', since)
  useFresh(r)
  if (!brain) return gate
  const j = T.journal
  if (!ok)
    return (
      <>
        <h1 class="title">{j.aboutBad}</h1>
        <JournalNav brain={brain} />
      </>
    )
  const first = r.data.value
  const items = first ? [...first.items, ...more] : []
  const nextPage = next === undefined ? first?.next : next
  const loadMore = async () => {
    if (!nextPage) return
    setPending(true)
    setMoreError(null)
    try {
      const page = await api.call<Listing<EntryListed>>('entries', {
        path: { slug },
        query: { about: address, ...(since ? { since } : {}), cursor: nextPage, limit: PAGE },
      })
      setMore((m) => [...m, ...page.items])
      setNext(page.next)
    } catch (e) {
      setMoreError(e as ApiError)
    } finally {
      setPending(false)
    }
  }
  return (
    <>
      <div class="title-row start">
        <h1 class="title">{j.aboutTitle(address)}</h1>
      </div>
      <JournalNav brain={brain} />
      <p class="lead screen-lead">
        {since ? j.aboutLead(T.dateTime(since)) : j.aboutLeadAll}{' '}
        <a href={pageHref(slug, address)}>{j.aboutOpen}</a>
      </p>
      {!first ? (
        r.error.value ? (
          <ErrorState error={r.error.value} onRetry={() => void r.reload()} />
        ) : (
          <Skeleton rows={3} />
        )
      ) : items.length === 0 ? (
        <Empty title={j.aboutNone} />
      ) : (
        <>
          <ul class="list" aria-label={j.aboutTitle(address)}>
            {items.map((e) => (
              <li key={e.id}>
                <EntryLine slug={slug} e={e} />
              </li>
            ))}
          </ul>
          {moreError ? <ErrorState error={moreError} onRetry={() => void loadMore()} focus={false} /> : null}
          {nextPage ? (
            <Button pending={pending} pendingLabel="…" onClick={() => void loadMore()}>
              {j.showMore}
            </Button>
          ) : null}
        </>
      )}
    </>
  )
}
