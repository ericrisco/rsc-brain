// The history of a wiki page (spec B6 «Wiki › Page», B2 «Historia»; T018). Who: any member reads it; a
// curator restores. Job: see who changed what and when, and compare any two revisions. Done when: the
// person sees the difference they looked for, or a curator restored a revision (a new one with the old
// content: nothing is deleted, CA18 of B2). The pair compared lives in the address (?compare=a,b).
import { useState } from 'preact/hooks'
import { useLocation } from 'preact-iso'
import type { ApiError } from '../../api/client.ts'
import { api } from '../../api/index.ts'
import { pickPair, type Segment, wordDiff } from '../../lib/wiki.ts'
import { T } from '../../text.ts'
import { Button } from '../../ui/Button.tsx'
import { Dialog } from '../../ui/Dialog.tsx'
import { ErrorState, FormAlert, Skeleton } from '../../ui/states.tsx'
import type { BrainOne } from '../Brain.tsx'
import { blockedNow, isCurator, pageHref, Said } from './common.tsx'
import {
  type Changed,
  compareResource,
  type FullRevision,
  historyResource,
  type Reading,
  type RevisionSummary,
  wikiChanged,
} from './data.ts'

const line = (r: RevisionSummary) =>
  T.wiki.revisionBy(r.revision, T.wiki.revisionKinds[r.kind] ?? r.kind, r.authorName)

export function RecentHistory({ slug, address }: { slug: string; address: string }) {
  const r = historyResource(slug, address)
  const w = T.wiki
  const list = r.data.value?.history
  return (
    <section class="aside-block" aria-labelledby="recent-title">
      <h2 id="recent-title" class="section-title">
        {w.recent}
      </h2>
      {list ? (
        <>
          <ul class="plain">
            {[...list]
              .reverse()
              .slice(0, 3)
              .map((x) => (
                <li key={x.revision}>
                  <span>{line(x)}</span> <span class="meta">{T.date(x.createdAt)}</span>
                </li>
              ))}
          </ul>
          <p class="small">
            <a href={`${pageHref(slug, address)}?view=history`}>{w.allHistory(list.length)}</a>
          </p>
        </>
      ) : r.error.value ? (
        <ErrorState error={r.error.value} onRetry={() => void r.reload()} focus={false} />
      ) : (
        <Skeleton rows={1} />
      )}
    </section>
  )
}

function Words({ segments }: { segments: Segment[] }) {
  const w = T.wiki
  return (
    <p class="diff">
      {segments.map((s, i) =>
        s.kind === 'added' ? (
          <ins key={i}>
            <span class="sr-only">{w.added}:</span>
            {s.text}
          </ins>
        ) : s.kind === 'removed' ? (
          <del key={i}>
            <span class="sr-only">{w.removed}:</span>
            {s.text}
          </del>
        ) : (
          <span key={i}>{s.text}</span>
        ),
      )}
    </p>
  )
}

function Differences({ slug, address, a, b }: { slug: string; address: string; a: number; b: number }) {
  const r = compareResource(slug, address, a, b)
  const w = T.wiki
  const d = r.data.value
  const id = `diff-${a}-${b}`
  const parts = (x: FullRevision, y: FullRevision) =>
    (
      [
        ['title', x.title, y.title],
        ['summary', x.summary, y.summary],
        ['status', w.statuses[x.status] ?? x.status, w.statuses[y.status] ?? y.status],
        ['tags', x.tags.join(', '), y.tags.join(', ')],
        ['body', x.body, y.body],
      ] as const
    ).filter(([, p, q]) => p !== q)
  return (
    <section class="differences" aria-labelledby={id}>
      <h2 id={id} class="section-title">
        {w.changes(a, b)}
      </h2>
      {d ? (
        parts(d.a, d.b).length === 0 ? (
          <p class="muted">{w.noChange}</p>
        ) : (
          parts(d.a, d.b).map(([part, p, q]) => (
            <div key={part} class="diff-part">
              <h3>{w.parts[part]}</h3>
              <Words segments={wordDiff(p, q)} />
            </div>
          ))
        )
      ) : r.error.value ? (
        <ErrorState error={r.error.value} onRetry={() => void r.reload()} focus={false} />
      ) : (
        <Skeleton rows={2} />
      )}
    </section>
  )
}

function Compare({ list, pair }: { list: RevisionSummary[]; pair: [number, number] }) {
  const { path, query, route } = useLocation()
  const [a, setA] = useState(pair[0])
  const [b, setB] = useState(pair[1])
  const w = T.wiki
  const options = [...list].reverse()
  return (
    <form
      class="filters compare"
      aria-label={w.compare}
      onSubmit={(e) => {
        e.preventDefault()
        const q = new URLSearchParams(query)
        q.set('compare', `${Math.min(a, b)},${Math.max(a, b)}`)
        route(`${path}?${q.toString()}`, true)
      }}
    >
      <div class="field">
        <label for="cmp-a">{w.from}</label>
        <select
          id="cmp-a"
          value={String(a)}
          onChange={(e) => setA(Number((e.currentTarget as HTMLSelectElement).value))}
        >
          {options.map((x) => (
            <option key={x.revision} value={String(x.revision)}>
              {w.revision(x.revision)}
            </option>
          ))}
        </select>
      </div>
      <div class="field">
        <label for="cmp-b">{w.to}</label>
        <select
          id="cmp-b"
          value={String(b)}
          onChange={(e) => setB(Number((e.currentTarget as HTMLSelectElement).value))}
        >
          {options.map((x) => (
            <option key={x.revision} value={String(x.revision)}>
              {w.revision(x.revision)}
            </option>
          ))}
        </select>
      </div>
      <p class="actions">
        <Button type="submit">{w.show}</Button>
      </p>
    </form>
  )
}

function Restore({
  slug,
  address,
  n,
  onClose,
  onDone,
}: {
  slug: string
  address: string
  n: number
  onClose: () => void
  onDone: (said: string) => void
}) {
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<ApiError | null>(null)
  const w = T.wiki
  const run = async () => {
    setPending(true)
    setError(null)
    try {
      const out = await api.call<Changed>('wikiChange', {
        path: { slug },
        body: { op: 'revert', address, toRevision: n, reason: `Restored revision ${n} from the web.` },
      })
      wikiChanged(slug)
      onDone(w.restored(n, out.revised.at(-1)?.revision ?? n))
    } catch (e) {
      setError(e as ApiError)
      setPending(false)
    }
  }
  return (
    <Dialog open title={w.restoreTitle(n)} onClose={onClose} closeLabel={w.cancel}>
      <p>{w.restoreLead}</p>
      <FormAlert error={error} />
      <p class="actions">
        <Button
          kind="primary"
          pending={pending}
          pendingLabel={w.restoring}
          blocked={blockedNow(false)}
          onClick={() => void run()}
        >
          {w.restore(n)}
        </Button>
      </p>
    </Dialog>
  )
}

export function History({ slug, brain, reading }: { slug: string; brain: BrainOne; reading: Reading }) {
  const address = reading.page.address
  const r = historyResource(slug, address)
  const { query } = useLocation()
  const [asking, setAsking] = useState<number | null>(null)
  const [said, setSaid] = useState<string | null>(null)
  const w = T.wiki
  const list = r.data.value?.history
  const curator = isCurator(brain)
  if (!list) {
    return r.error.value ? (
      <ErrorState error={r.error.value} onRetry={() => void r.reload()} />
    ) : (
      <Skeleton rows={4} />
    )
  }
  const latest = list.at(-1)?.revision ?? 1
  const pair = pickPair(query.compare, latest)
  return (
    <div class="history">
      <Said text={said} />
      <section aria-labelledby="revisions-title">
        <h2 id="revisions-title" class="section-title" tabIndex={-1}>
          {w.revisions}
        </h2>
        <ul class="list">
          {[...list].reverse().map((x) => (
            <li key={x.revision} class="with-actions">
              <div>
                <p class="list-title">
                  {line(x)} {x.revision === latest ? <span class="tag">{w.current}</span> : null}
                </p>
                <p class="meta">
                  {T.dateTime(x.createdAt)}
                  {x.address !== address ? <span class="mono"> · {x.address}</span> : null}
                </p>
              </div>
              {curator && x.revision !== latest ? (
                <p class="actions">
                  <Button kind="quiet" blocked={blockedNow(false)} onClick={() => setAsking(x.revision)}>
                    {w.restore(x.revision)}
                  </Button>
                </p>
              ) : null}
            </li>
          ))}
        </ul>
      </section>
      <section aria-labelledby="compare-title" class="compare-block">
        <h2 id="compare-title" class="section-title">
          {w.compare}
        </h2>
        {pair ? (
          <>
            <Compare key={`${pair[0]},${pair[1]}`} list={list} pair={pair} />
            <Differences slug={slug} address={address} a={pair[0]} b={pair[1]} />
          </>
        ) : (
          <p class="muted">{w.onlyOne}</p>
        )}
      </section>
      {asking !== null ? (
        <Restore
          slug={slug}
          address={address}
          n={asking}
          onClose={() => setAsking(null)}
          onDone={(text) => {
            setAsking(null)
            setSaid(text)
            // The dialog is gone: the keyboard goes to the list it changed.
            requestAnimationFrame(() => document.getElementById('revisions-title')?.focus())
          }}
        />
      ) : null}
    </div>
  )
}
