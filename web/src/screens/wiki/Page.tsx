// A wiki page (spec B6 «Wiki › Page», CA4; T017–T019). Who: any member reads; a curator edits. Job: read
// what the brain knows on a subject and check where it comes from. Done when: the person read it and
// opened its sources without leaving it. Its type and status are words, not colours; a superseded page
// leads to its replacement; each source opens in a panel beside the page (the address only gains
// ?source=, the page stays in place, Esc returns the keyboard to the source). Links from and to it come
// grouped by kind; a link to a page still to write says so. «Who read this» is for curators only (pack
// rule 7). The body is markdown rendered with raw HTML off (lib/markdown.ts): the one place the web
// writes HTML it did not build itself.
import { useEffect } from 'preact/hooks'
import { useLocation } from 'preact-iso'
import { useFresh } from '../../api/fresh.ts'
import { renderMarkdown } from '../../lib/markdown.ts'
import { groupLinks, groupReaders } from '../../lib/wiki.ts'
import { online } from '../../session.ts'
import { T } from '../../text.ts'
import { Dialog } from '../../ui/Dialog.tsx'
import { viewState } from '../../ui/state.ts'
import { ErrorState, Skeleton } from '../../ui/states.tsx'
import type { BrainOne } from '../Brain.tsx'
import { correctHref, entryHref } from '../journal/common.tsx'
import { isCurator, mapHref, pageHref, Said, StatusTag, TypeTag, useBrain } from './common.tsx'
import { entryResource, type LinkView, pageResource, type Reading, readersResource } from './data.ts'
import { PageEdit, UnsavedEdit, wikiNotice } from './Edit.tsx'
import { History, RecentHistory } from './History.tsx'

function NoPage({ slug, address }: { slug: string; address: string }) {
  return (
    <>
      <h1 class="title">{T.wiki.noPageTitle(address)}</h1>
      <p class="lead">{T.wiki.noPageLead}</p>
      <p class="actions">
        <a class="button" href={mapHref(slug)}>
          {T.wiki.backToMap}
        </a>
      </p>
    </>
  )
}

function Notice({ slug, reading }: { slug: string; reading: Reading }) {
  const w = T.wiki
  const { page } = reading
  if (page.status === 'superseded') {
    const by =
      /superseded by "([^"]+)"/.exec(reading.notice ?? '')?.[1] ??
      reading.links.in.find((l) => l.kind === 'supersedes')?.address
    return (
      <p class="alert warn" role="note">
        <span class="kind">{w.statuses.superseded}</span>
        {by ? (
          <span>
            {w.supersededBy} <a href={pageHref(slug, by)}>{by}</a>.
          </span>
        ) : (
          <span>{w.superseded}</span>
        )}
      </p>
    )
  }
  const long = w.statusLong[page.status]
  if (!long) return null
  return (
    <p class="alert warn" role="note">
      <span class="kind">{w.statuses[page.status]}</span>
      <span>{long}</span>
    </p>
  )
}

function LinkItem({ slug, l, label }: { slug: string; l: LinkView; label?: string }) {
  const state = T.wiki.linkState[l.state]
  return (
    <li class={l.state === 'ok' ? undefined : `link-${l.state}`}>
      <a href={pageHref(slug, l.address)}>{label ?? l.title ?? l.address}</a>
      {l.title && !label ? <span class="meta mono"> {l.address}</span> : null}
      {state ? <span class="tag warn">{state}</span> : null}
    </li>
  )
}

function LinkGroups({
  slug,
  title,
  links,
  none,
  names,
}: {
  slug: string
  title: string
  links: LinkView[]
  none: string
  names: Record<string, string>
}) {
  const id = `links-${title.replace(/\W+/g, '-').toLowerCase()}`
  return (
    // A group inside the Links region, named by its heading; not a form, so not a fieldset.
    // biome-ignore lint/a11y/useSemanticElements: see above
    <div role="group" aria-labelledby={id} class="link-groups">
      <h3 id={id} class="aside-sub">
        {title}
      </h3>
      {links.length === 0 ? (
        <p class="muted small">{none}</p>
      ) : (
        groupLinks(links).map((g) => (
          <div key={g.kind} class="link-kind">
            <h4>{names[g.kind] ?? g.kind}</h4>
            <ul class="plain">
              {g.items.map((l) => (
                <LinkItem key={`${l.kind}:${l.address}`} slug={slug} l={l} />
              ))}
            </ul>
          </div>
        ))
      )}
    </div>
  )
}

function Sources({ slug, reading, curator }: { slug: string; reading: Reading; curator: boolean }) {
  const w = T.wiki
  const { path, url, route } = useLocation()
  const open = (id: string) => {
    const q = new URLSearchParams(url.split('?')[1] ?? '')
    q.set('source', id)
    // Opening a source adds a step to the history, which closing it takes back (Back then leaves the page,
    // as the person expects; it never just reopens the panel).
    opened = true
    route(`${path}?${q.toString()}`)
  }
  return (
    <section class="aside-block" aria-labelledby="sources-title">
      <h2 id="sources-title" class="section-title">
        {w.sources}
      </h2>
      {reading.sources.length === 0 ? (
        <p class="muted small">{w.noSources}</p>
      ) : (
        <ul class="plain sources">
          {reading.sources.map((s) =>
            'entryId' in s ? (
              <li key={s.entryId}>
                {s.state === 'active' ? (
                  <button
                    type="button"
                    class="linkish"
                    data-source={s.entryId}
                    onClick={() => open(s.entryId)}
                  >
                    {s.title ?? s.entryId}
                  </button>
                ) : (
                  <span>
                    {s.state === 'forgotten' && curator ? (
                      <a href={entryHref(slug, s.entryId)} class="mono">
                        {s.entryId}
                      </a>
                    ) : (
                      <span class="mono">{s.entryId}</span>
                    )}{' '}
                    <span class="tag warn">
                      {s.state === 'forgotten' ? w.sourceForgotten : w.sourcePurged}
                    </span>
                  </span>
                )}
              </li>
            ) : (
              <li key={s.url}>
                <a href={s.url} target="_blank" rel="noopener noreferrer">
                  {s.title ?? s.url}
                </a>
              </li>
            ),
          )}
        </ul>
      )}
    </section>
  )
}

// Whether the open source panel was opened from this page (a step in the history to take back on close),
// or came with the address (a link or a reload: closing replaces the address instead).
let opened = false

// The entry a source points at, beside the page (a modal side panel: the page stays where it was).
function SourcePanel({ slug, id, onClose }: { slug: string; id: string; onClose: () => void }) {
  // Gone by any way (Back too): the step it added is taken back already.
  useEffect(
    () => () => {
      opened = false
    },
    [],
  )
  const r = entryResource(id)
  const e = r.data.value?.entry
  const w = T.wiki
  return (
    <Dialog
      open
      title={e?.title ?? w.sourceTitle}
      onClose={onClose}
      class="sheet side"
      closeLabel={w.closePanel}
    >
      {e ? (
        <article class="source-entry">
          <p class="meta">
            {w.entryFrom(e.type, T.date(e.createdAt))} · <span class="mono">{e.id}</span>
          </p>
          <p class="entry-text">{e.content}</p>
          <p>
            <a href={entryHref(slug, e.id)}>{w.openInJournal}</a>
          </p>
          {e.tags.length ? (
            <p class="meta">
              {e.tags.map((t) => (
                <span key={t} class="tag">
                  {t}
                </span>
              ))}
            </p>
          ) : null}
        </article>
      ) : r.error.value ? (
        <ErrorState error={r.error.value} onRetry={() => void r.reload()} />
      ) : (
        <Skeleton rows={2} label={w.sourceLoading} />
      )}
    </Dialog>
  )
}

function Readers({ slug, address }: { slug: string; address: string }) {
  const r = readersResource(slug, address)
  const w = T.wiki
  const d = r.data.value
  return (
    <section class="aside-block" aria-labelledby="readers-title">
      <h2 id="readers-title" class="section-title">
        {w.readers}
      </h2>
      <p class="muted small">{w.readersLead}</p>
      {d ? (
        d.items.length === 0 && !d.older ? (
          <p class="muted small">{w.noReaders}</p>
        ) : (
          <ul class="plain readers">
            {groupReaders(d.items).map((x) => (
              <li key={x.key}>
                <span>{x.name}</span>
                {x.via ? <span class="meta"> {w.viaClient(x.via)}</span> : null}
                <span class="meta">
                  {' '}
                  · {w.readTimes(x.count)} · {w.lastRead(T.dateTime(x.last))}
                </span>
              </li>
            ))}
            {d.older ? <li class="meta">{w.older(d.older.reads + d.older.contexts)}</li> : null}
          </ul>
        )
      ) : r.error.value ? (
        <ErrorState error={r.error.value} onRetry={() => void r.reload()} focus={false} />
      ) : (
        <Skeleton rows={1} />
      )}
    </section>
  )
}

function Tabs({
  slug,
  address,
  view,
  curator,
}: {
  slug: string
  address: string
  view: string
  curator: boolean
}) {
  const base = pageHref(slug, address)
  const w = T.wiki
  const items = [
    { v: 'read', href: base, label: w.read },
    { v: 'history', href: `${base}?view=history`, label: w.history },
    ...(curator ? [{ v: 'edit', href: `${base}?view=edit`, label: w.edit }] : []),
  ]
  return (
    <nav class="tabs" aria-label={w.view}>
      {items.map((i) => (
        <a key={i.v} href={i.href} data-view={i.v} aria-current={view === i.v ? 'page' : undefined}>
          {i.label}
        </a>
      ))}
    </nav>
  )
}

function Head({ slug, reading, view }: { slug: string; reading: Reading; view: string }) {
  const { page } = reading
  const area = page.address.split('/')[0] ?? ''
  // Each view names itself (the tab of the browser says it too).
  const title =
    view === 'edit'
      ? T.wiki.editTitle(page.title)
      : view === 'history'
        ? T.wiki.historyTitle(page.title)
        : page.title
  return (
    <>
      <nav class="crumbs" aria-label={T.wiki.crumbs}>
        <a href={mapHref(slug)}>{T.wiki.map}</a>
        <span aria-hidden="true"> / </span>
        <span class="mono">{area}</span>
      </nav>
      <h1 class="title">{title}</h1>
      <p class="page-meta meta">
        <TypeTag type={page.type} /> <StatusTag status={page.status} />{' '}
        <span class="mono">{page.address}</span> <span>{T.wiki.revision(page.revision)}</span>{' '}
        <span>{T.wiki.updated(T.date(page.updatedAt))}</span>
      </p>
    </>
  )
}

function ReadView({ slug, brain, reading }: { slug: string; brain: BrainOne; reading: Reading }) {
  const { page } = reading
  const { path, query, route } = useLocation()
  const w = T.wiki
  const html = renderMarkdown(page.body, { slug, links: reading.links.out })
  const source = query.source
  return (
    <div class="wiki-page">
      <article class="page-main">
        <Notice slug={slug} reading={reading} />
        {page.summary ? <p class="lead">{page.summary}</p> : null}
        {/* The one HTML the web did not build itself: markdown rendered with raw HTML off and links checked
            (lib/markdown.ts, plan risk 5). */}
        <div class="prose" dangerouslySetInnerHTML={{ __html: html }} />
        {page.tags.length ? (
          <p class="meta tags">
            {page.tags.map((t) => (
              <span key={t} class="tag">
                {t}
              </span>
            ))}
          </p>
        ) : null}
      </article>
      <aside class="page-aside" aria-label={w.aside}>
        <Sources slug={slug} reading={reading} curator={brain.role === 'curator'} />
        <section class="aside-block" aria-labelledby="links-title">
          <h2 id="links-title" class="section-title">
            {w.links}
          </h2>
          <LinkGroups
            slug={slug}
            title={w.linksOut}
            links={reading.links.out}
            none={w.noLinksOut}
            names={w.kinds}
          />
          <LinkGroups
            slug={slug}
            title={w.linksIn}
            links={reading.links.in}
            none={w.noLinksIn}
            names={w.kindsIn}
          />
        </section>
        {['contributor', 'curator'].includes(brain.role) && brain.status !== 'archived' ? (
          <section class="aside-block" aria-labelledby="wrong-title">
            <h2 id="wrong-title" class="section-title">
              {w.wrongTitle}
            </h2>
            <p class="muted small">{w.wrongLead}</p>
            <p>
              <a class="button secondary" href={correctHref(slug, { page: page.address })}>
                {w.addCorrection}
              </a>
            </p>
          </section>
        ) : null}
        <RecentHistory slug={slug} address={page.address} />
        {isCurator(brain) ? <Readers slug={slug} address={page.address} /> : null}
      </aside>
      {source ? (
        <SourcePanel
          key={source}
          slug={slug}
          id={source}
          onClose={() => {
            if (opened) {
              opened = false
              history.back()
            } else {
              const q = new URLSearchParams(query)
              q.delete('source')
              const qs = q.toString()
              route(qs ? `${path}?${qs}` : path, true)
            }
            // The keyboard goes back to the source that opened the panel.
            requestAnimationFrame(() =>
              document.querySelector<HTMLElement>(`[data-source="${CSS.escape(source)}"]`)?.focus(),
            )
          }}
        />
      ) : null}
    </div>
  )
}

// The screen a page's address is shown on: the same one when an old address led to its new one, so what
// the person was doing there (typing in its editor) is not taken down by the move.
export const sameScreen = new Map<string, string>()
export const screenKey = (slug: string, address: string) =>
  sameScreen.get(`${slug}/${address}`) ?? `${slug}/${address}`

export function WikiPage({ slug, address }: { slug: string; address: string }) {
  const { brain, gate } = useBrain(slug)
  const r = pageResource(slug, address)
  useFresh(r)
  const { path, query, route } = useLocation()
  const reading = r.data.value
  // An old address leads here: the address bar shows where the page lives now.
  const moved = reading && reading.page.address !== address ? reading.page.address : null
  useEffect(() => {
    if (moved && reading) {
      const qs = new URLSearchParams(query).toString()
      const at = pageHref(slug, moved)
      // The page is known already: under its new address it shows at once, and an editor being typed in
      // stays as it is (it is not taken down while the page loads again).
      const there = pageResource(slug, moved)
      if (!there.data.value) there.data.value = reading
      sameScreen.set(`${slug}/${moved}`, sameScreen.get(`${slug}/${address}`) ?? `${slug}/${address}`)
      // The old address keeps working; the page says it moved.
      if (wikiNotice.value?.path !== at) wikiNotice.value = { path: at, text: T.wiki.movedFrom(address) }
      route(`${at}${qs ? `?${qs}` : ''}`, true)
    }
  }, [moved])
  if (!brain) return gate
  const state = viewState({
    loading: r.loading.value,
    data: reading,
    error: r.error.value,
    online: online.value,
  })
  if (state === 'loading') return <Skeleton rows={5} />
  if (!reading) {
    const e = r.error.value
    if (e?.code === 'page_not_found') return <NoPage slug={slug} address={address} />
    return e ? <ErrorState error={e} onRetry={() => void r.reload()} /> : null
  }
  const curator = isCurator(brain)
  const view = query.view === 'history' || query.view === 'edit' ? query.view : 'read'
  return (
    <>
      <Head slug={slug} reading={reading} view={view} />
      <Tabs slug={slug} address={reading.page.address} view={view} curator={curator} />
      <Said text={wikiNotice.value?.path === path ? wikiNotice.value.text : null} />
      {curator && view !== 'edit' ? <UnsavedEdit slug={slug} reading={reading} /> : null}
      {view === 'history' ? (
        <History slug={slug} brain={brain} reading={reading} />
      ) : view === 'edit' ? (
        <PageEdit slug={slug} brain={brain} reading={reading} />
      ) : (
        <ReadView slug={slug} brain={brain} reading={reading} />
      )}
    </>
  )
}
