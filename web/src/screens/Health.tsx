// The health of a wiki (spec B6 «Health», B2 «Salud de la wiki»; T038). Who: any member; curators fix.
// Job: find what is wrong in the wiki and get it fixed. Done when: each problem is open where it is fixed,
// or handed to an agent with an instruction that names the tools and the brain; or the screen says
// «Nothing to fix». The checks run on the server each time the screen opens (no AI).
import { useEffect, useRef, useState } from 'preact/hooks'
import { useFresh } from '../api/fresh.ts'
import { api } from '../api/index.ts'
import { resource } from '../api/resource.ts'
import {
  askAgent,
  HEALTH_SECTIONS,
  type Health,
  type HealthItem,
  healthItems,
  type SectionId,
  totalProblems,
} from '../lib/health.ts'
import { online } from '../session.ts'
import { T } from '../text.ts'
import { CopyButton } from '../ui/CopyButton.tsx'
import { viewState } from '../ui/state.ts'
import { Empty, ErrorState, Skeleton } from '../ui/states.tsx'
import { useBrain } from './wiki/common.tsx'

const FIRST = 10

// Under the wiki's key: a change to the wiki (wiki.changed, from the live feed) asks for it again.
export const healthResource = (slug: string) =>
  resource<Health>(`brain:${slug}:wiki:health`, () => api.call<Health>('wikiHealth', { path: { slug } }))

function Section({ slug, id, items }: { slug: string; id: SectionId; items: HealthItem[] }) {
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
            {it.links.map((l, i) => (
              <span key={l.href}>
                {i > 0 ? <span class="muted"> · </span> : null}
                <a class="mono wrap" href={l.href}>
                  {l.label}
                </a>
              </span>
            ))}{' '}
            <span class="muted wrap">{it.text}</span>
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
        <CopyButton text={askAgent(slug, id, items.length)} label={h.ask} />
      </div>
    </section>
  )
}

export function HealthScreen({ slug }: { slug: string }) {
  const { brain, gate } = useBrain(slug)
  const r = healthResource(slug)
  useFresh(r)
  if (!brain) return gate
  const h = T.health
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
          <span>{h.maintenance(data.maintenance.approvalsSince)}</span>
          <span>
            <CopyButton text={h.maintenanceAsk(slug)} label={h.copyMaintenance} />
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
      ) : items ? (
        <>
          <div class="health-all">
            <CopyButton text={askAgent(slug, 'all', total)} label={h.askAll} />
            <span class="muted small">{h.askHow}</span>
          </div>
          {HEALTH_SECTIONS.filter((s) => items[s.id].length > 0).map((s) => (
            <Section key={s.id} slug={slug} id={s.id} items={items[s.id]} />
          ))}
        </>
      ) : null}
    </>
  )
}
