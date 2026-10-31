// The proposals inbox (spec B6 «Proposals: la bandeja», CA17; T026). Who: any member reads; a curator of an
// active brain decides. Job: see what agents propose for the wiki, by status, and open one to decide.
// Done when: the person opened the one to decide, or knows nothing waits. The pending ones first (the
// old ones marked «old», in words), then a tab per status with its count; a reader reads it all and is
// told whom to ask for the curator role. It comes by pages and follows the live feed of the brain.
import { useMemo } from 'preact/hooks'
import { useLocation } from 'preact-iso'
import { useFresh } from '../../api/fresh.ts'
import { api } from '../../api/index.ts'
import { useLive } from '../../live/follow.ts'
import { T } from '../../text.ts'
import { Empty, ErrorState, Skeleton } from '../../ui/states.tsx'
import { curatorNames, membersResource } from '../journal/data.ts'
import { More, usePages } from '../journal/Lists.tsx'
import { useBrain, WikiHead } from '../wiki/common.tsx'
import {
  type InboxItem,
  type InboxPage,
  inboxHref,
  inboxResource,
  orderOf,
  PAGE_SIZE,
  proposalHref,
  STATUSES,
  type Status,
} from './data.ts'

// Who proposed, in words: «Claude Code of Eric», or the account alone.
export const proposer = (p: { agent: string | null; authorName: string }) =>
  T.proposals.byline(p.agent, p.authorName || '—')

// The status of a proposal, and who decided it when (never colour alone).
export function DecidedLine({
  p,
}: {
  p: { status: string; decidedByName: string | null; decidedAt: string | null }
}) {
  const w = T.proposals
  if (!p.decidedByName || !p.decidedAt) return null
  return <>{w.decidedBy(w.statuses[p.status] ?? p.status, p.decidedByName, `on ${T.date(p.decidedAt)}`)}</>
}

// Why a person cannot decide here, and whom to ask (spec B6 «Sin permiso»).
export function ReadOnlyLine({ brain, slug }: { brain: { name: string; status: string }; slug: string }) {
  membersResource(slug)
  return (
    <p class="muted small" data-state="read-only">
      {brain.status === 'archived'
        ? T.proposals.archived
        : T.proposals.readOnly(brain.name, curatorNames(slug))}
    </p>
  )
}

function Line({ slug, p }: { slug: string; p: InboxItem }) {
  const w = T.proposals
  return (
    <li>
      <p class="list-title">
        <a href={proposalHref(slug, p.id)}>{p.title}</a>
        {p.old ? (
          <>
            {' '}
            <span class="tag warn" title={w.oldTitle}>
              {w.old}
            </span>
          </>
        ) : null}
      </p>
      <p class="meta">
        {[w.changes(p.opCount), w.from(proposer(p)), w.sent(T.date(p.createdAt))].join(' · ')}
      </p>
      {p.decidedByName ? (
        <p class="meta">
          <DecidedLine p={p} />
        </p>
      ) : null}
      {p.comment ? <p class="summary">“{p.comment}”</p> : null}
    </li>
  )
}

export function ProposalsInbox({ slug }: { slug: string }) {
  const { brain, gate } = useBrain(slug)
  const { query } = useLocation()
  const status = (STATUSES as readonly string[]).includes(query.status ?? '')
    ? (query.status as Status)
    : 'pending'
  const r = inboxResource(slug, status)
  useFresh(r)
  useLive(slug)
  const d = r.data.value
  const first = useMemo(() => d, [d])
  const p = usePages<InboxItem>(
    first,
    (next) =>
      api.call<InboxPage>('proposals', {
        path: { slug },
        query: { status, limit: PAGE_SIZE, cursor: next, order: orderOf(status) },
      }),
    (x) => x.id,
  )
  // The counts of every tab come with the first page of any of them; the pending tab's is kept fresh.
  const counts = d?.counts ?? inboxResource(slug, 'pending').data.value?.counts
  if (!brain) return gate
  const w = T.proposals
  const curator = brain.role === 'curator' && brain.status !== 'archived'
  const label = w.statuses[status] ?? status
  return (
    <>
      <WikiHead title={w.title} lead={w.lead} />
      <nav class="tabs" aria-label={w.nav}>
        {STATUSES.map((s) => (
          <a key={s} href={inboxHref(slug, s)} aria-current={s === status ? 'page' : undefined}>
            {w.statuses[s]}
            {counts?.[s] ? (
              <>
                {' '}
                <span class="tag tab-count">{counts[s]}</span>
              </>
            ) : null}
          </a>
        ))}
      </nav>
      {curator ? null : <ReadOnlyLine brain={brain} slug={slug} />}
      {!p.first ? (
        r.error.value ? (
          <ErrorState error={r.error.value} onRetry={() => void r.reload()} />
        ) : (
          <Skeleton rows={4} />
        )
      ) : p.items.length === 0 ? (
        status === 'pending' ? (
          <Empty title={w.noneTitle}>
            <p>{w.noneLead}</p>
          </Empty>
        ) : (
          <Empty title={w.noneIn(label)}>
            <p>
              <a href={inboxHref(slug)}>{w.showPending}</a>
            </p>
          </Empty>
        )
      ) : (
        <>
          <p class="meta">{w.count(p.first.total)}</p>
          <ul class="list" aria-label={w.list(label)}>
            {p.items.map((x) => (
              <Line key={x.id} slug={slug} p={x} />
            ))}
          </ul>
          <More p={p} />
        </>
      )}
    </>
  )
}
