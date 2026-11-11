// The health of a wiki (spec B6 «Health», B2 «Salud de la wiki»; T038). Who: any member; curators and
// contributors (through an agent's proposal) fix. Job: find what is wrong in the wiki and get it fixed. Done
// when: each problem is open where it is fixed, or handed to an agent with an instruction that names the tools,
// the brain and each address; or the screen says «Nothing to fix». A reader cannot propose: they are told
// which curators to tell. The checks run on the server each time the screen opens (no AI).
import { useEffect, useRef, useState } from 'preact/hooks'
import { useFresh } from '../api/fresh.ts'
import { api } from '../api/index.ts'
import { resource } from '../api/resource.ts'
import {
  askAgent,
  HEALTH_SECTIONS,
  type Health,
  type HealthItem,
  type HealthLink,
  healthItems,
  type SectionId,
  totalProblems,
} from '../lib/health.ts'
import { pageHref, plainText } from '../lib/markdown.ts'
import { online } from '../session.ts'
import { T } from '../text.ts'
import { CopyButton } from '../ui/CopyButton.tsx'
import { Dialog } from '../ui/Dialog.tsx'
import { viewState } from '../ui/state.ts'
import { Empty, ErrorState, Skeleton } from '../ui/states.tsx'
import { curatorNames } from './journal/data.ts'
import { useBrain } from './wiki/common.tsx'
import { pageResource } from './wiki/data.ts'

const FIRST = 10

// Under the wiki's key: a change to the wiki (wiki.changed, from the live feed) asks for it again.
export const healthResource = (slug: string) =>
  resource<Health>(`brain:${slug}:wiki:health`, () => api.call<Health>('wikiHealth', { path: { slug } }))

// What a person may do about a problem: hand it to an agent (who proposes; contributors and curators), or tell
// a curator (readers, whose agents cannot propose).
function Act({ slug, can, text, label }: { slug: string; can: boolean; text: string; label: string }) {
  if (can) return <CopyButton text={text} label={label} />
  return <p class="muted small">{T.health.tellCuratorWho(curatorNames(slug))}</p>
}

function PageLink({ l }: { l: HealthLink }) {
  return (
    <span class="health-page">
      <a class="health-page-link" href={l.href}>
        {l.label}
      </a>
      {l.address ? <span class="mono meta"> {l.address}</span> : null}
    </span>
  )
}

// Two pages side by side: title, address, summary and the start of their text.
function Compare({
  slug,
  pair,
  onClose,
}: {
  slug: string
  pair: [string, string] | null
  onClose: () => void
}) {
  return (
    <Dialog open={pair !== null} title={T.health.compareTitle} onClose={onClose} class="wide-dialog">
      {pair ? (
        <div class="compare-pages">
          {pair.map((address) => (
            <ComparePage key={address} slug={slug} address={address} />
          ))}
        </div>
      ) : null}
    </Dialog>
  )
}

function ComparePage({ slug, address }: { slug: string; address: string }) {
  const r = pageResource(slug, address)
  const p = r.data.value?.page
  if (!p)
    return r.error.value ? (
      <ErrorState error={r.error.value} onRetry={() => void r.reload()} focus={false} />
    ) : (
      <Skeleton rows={2} />
    )
  const text = plainText(p.body)
  return (
    <section class="compare-page" aria-labelledby={`cmp-${address}`}>
      <h3 id={`cmp-${address}`}>{p.title}</h3>
      <p class="mono meta">{p.address}</p>
      {p.summary ? <p>{p.summary}</p> : null}
      <p class="muted small">{text.length > 900 ? `${text.slice(0, 900)}…` : text}</p>
      <a href={pageHref(slug, p.address)}>{T.health.openPage}</a>
    </section>
  )
}

function Section({
  slug,
  id,
  items,
  ask,
  can,
  onCompare,
}: {
  slug: string
  id: SectionId
  items: HealthItem[]
  ask: string
  can: boolean
  onCompare: (pair: [string, string], from: HTMLElement) => void
}) {
  const h = T.health
  const [all, setAll] = useState(false)
  const list = useRef<HTMLUListElement>(null)
  const grew = useRef(false)
  // «Show all»: the keyboard goes on to the first item it revealed.
  useEffect(() => {
    if (!all || !grew.current) return
    grew.current = false
    list.current?.querySelectorAll<HTMLElement>('li')[FIRST]?.querySelector<HTMLElement>('a')?.focus()
  }, [all])
  const shown = all ? items : items.slice(0, FIRST)
  return (
    <section class="health-section" aria-labelledby={`health-${id}`}>
      <div class="section-head">
        <h2 id={`health-${id}`} class="section-title">
          {h.sections[id]}
        </h2>
        <span class="count">{items.length}</span>
      </div>
      <p class="muted">{h.explain[id]}</p>
      <ul class="list compact health-items" ref={list}>
        {shown.map((it) => (
          <li key={it.key} class="health-item">
            <span class="health-links">
              {it.links.map((l) => (
                <PageLink key={l.href} l={l} />
              ))}
            </span>
            <span class="muted wrap">
              {it.text}
              {it.more ? (
                <>
                  {' '}
                  <a href={it.more.href}>{it.more.label}</a>
                </>
              ) : null}
            </span>
            {it.compare ? (
              <button
                type="button"
                class="button quiet health-compare"
                onClick={(e) =>
                  onCompare(
                    [it.links[0]?.address ?? '', it.links[1]?.address ?? ''],
                    e.currentTarget as HTMLElement,
                  )
                }
              >
                {h.compare}
              </button>
            ) : null}
          </li>
        ))}
      </ul>
      <div class="actions health-actions">
        {items.length > FIRST ? (
          <button
            type="button"
            class="button quiet"
            aria-expanded={all ? 'true' : 'false'}
            onClick={() => {
              grew.current = !all
              setAll(!all)
            }}
          >
            {all ? h.showLess : h.showAll(items.length)}
          </button>
        ) : null}
        <Act slug={slug} can={can} text={ask} label={h.ask} />
      </div>
    </section>
  )
}

export function HealthScreen({ slug }: { slug: string }) {
  const { brain, gate } = useBrain(slug)
  const r = healthResource(slug)
  useFresh(r)
  const [pair, setPair] = useState<[string, string] | null>(null)
  const back = useRef<HTMLElement | null>(null)
  if (!brain) return gate
  const h = T.health
  // Asking an agent means a proposal (brain_propose): contributors and curators of an active brain.
  const can = brain.status !== 'archived' && (brain.role === 'curator' || brain.role === 'contributor')
  const data = r.data.value
  const total = data ? totalProblems(data) : 0
  const state = viewState({
    loading: r.loading.value,
    data,
    error: r.error.value,
    online: online.value,
    isEmpty: (d) => totalProblems(d) === 0,
  })
  const items = data ? healthItems(slug, data) : null
  return (
    <>
      <div class="title-row start">
        <h1 class="title">{h.title}</h1>
        {total ? <span class="tag warn">{h.found(total)}</span> : null}
      </div>
      <p class="lead screen-lead">{h.lead}</p>
      {data?.maintenance.suggested ? (
        <div class="alert warn health-maintenance" role="note">
          <span class="kind">{T.kind.warning}</span>
          <span>{h.maintenance(data.maintenance.lastAt ? T.dateTime(data.maintenance.lastAt) : null)}</span>
          <span>
            <Act slug={slug} can={can} text={h.maintenanceAsk(slug)} label={h.copyMaintenance} />
          </span>
        </div>
      ) : null}
      {state === 'loading' ? (
        <Skeleton rows={4} />
      ) : state === 'error' || state === 'offline' || state === 'forbidden' ? (
        r.error.value ? (
          <ErrorState error={r.error.value} onRetry={() => void r.reload()} />
        ) : null
      ) : state === 'empty' ? (
        <Empty title={h.emptyTitle}>
          <p>{h.emptyLead}</p>
        </Empty>
      ) : items && data ? (
        <>
          {can ? (
            <div class="health-all">
              <CopyButton text={askAgent(slug, 'all', data)} label={h.askAll} />
              <span class="muted small">{h.askHow}</span>
            </div>
          ) : (
            <div class="health-all">
              <Act slug={slug} can={false} text="" label="" />
            </div>
          )}
          {HEALTH_SECTIONS.filter((s) => items[s.id].length > 0).map((s) => (
            <Section
              key={s.id}
              slug={slug}
              id={s.id}
              items={items[s.id]}
              ask={askAgent(slug, s.id, data)}
              can={can}
              onCompare={(p, from) => {
                back.current = from
                setPair(p)
              }}
            />
          ))}
          <Compare
            slug={slug}
            pair={pair}
            onClose={() => {
              setPair(null)
              const b = back.current
              back.current = null
              if (b?.isConnected) b.focus()
            }}
          />
        </>
      ) : null}
    </>
  )
}
