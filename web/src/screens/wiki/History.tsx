// The history of a wiki page (spec B6 «Wiki › Page», B2 «Historia»; T018). Who: any member reads it; a
// curator restores. Job: see who changed what and when, and compare any two revisions. Done when: the
// person sees the difference they looked for, or a curator restored a revision (a new one with the old
// content: nothing is deleted, CA18 of B2). The pair compared lives in the address (?compare=a,b).
import { useState } from 'preact/hooks'
import { useLocation } from 'preact-iso'
import type { ApiError } from '../../api/client.ts'
import { api } from '../../api/index.ts'
import {
  bodyDiff,
  changeLabel,
  type DiffLine,
  pickPair,
  type Segment,
  sourceKey,
  wordDiff,
} from '../../lib/wiki.ts'
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
  pageResource,
  type Reading,
  type RevisionSummary,
  wikiChanged,
} from './data.ts'

// «Revision 4 · status → stale by Ana»: what the change was, from the change itself.
const line = (r: RevisionSummary) =>
  T.wiki.revisionBy(
    r.revision,
    r.change ? changeLabel(r) : (T.wiki.revisionKinds[r.kind] ?? r.kind),
    r.authorName,
  )

function Why({ r }: { r: RevisionSummary }) {
  return r.reason ? <p class="why">{T.wiki.why(r.reason)}</p> : null
}

export function RecentHistory({ slug, address }: { slug: string; address: string }) {
  const r = pageResource(slug, address)
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
                  <Why r={x} />
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

export function Words({ segments, as = 'p' }: { segments: Segment[]; as?: 'p' | 'span' }) {
  const w = T.wiki
  const Tag = as
  return (
    <Tag class="diff">
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
    </Tag>
  )
}

// The body, line by line: a line mostly rewritten shows old and new whole; a few words changed, those.
export const BodyDiff = ({ a, b }: { a: string; b: string }) => <BodyLines lines={bodyDiff(a, b)} />

// Differences worked out already (a conflict works them out once, with the merge).
export function BodyLines({ lines }: { lines: DiffLine[] }) {
  const w = T.wiki
  return (
    <div class="diff body-diff">
      {lines.map((l, i) =>
        l.kind === 'changed' ? (
          <p key={i} class="diff-line changed">
            <Words segments={l.words} as="span" />
          </p>
        ) : l.kind === 'same' ? (
          <p key={i} class="diff-line">
            {l.text || '\u00a0'}
          </p>
        ) : l.kind === 'added' ? (
          <p key={i} class="diff-line">
            <ins class={l.text ? undefined : 'blank'}>
              <span class="sr-only">{w.added}:</span>
              {l.text || '\u00a0'}
            </ins>
          </p>
        ) : (
          <p key={i} class="diff-line">
            <del class={l.text ? undefined : 'blank'}>
              <span class="sr-only">{w.removed}:</span>
              {l.text || '\u00a0'}
            </del>
          </p>
        ),
      )}
    </div>
  )
}

// A list part (sources, links): what was added and what was removed.
export function ListDiff({ a, b }: { a: string[]; b: string[] }) {
  const w = T.wiki
  const gone = a.filter((x) => !b.includes(x))
  const come = b.filter((x) => !a.includes(x))
  return (
    <ul class="plain diff">
      {gone.map((x) => (
        <li key={`-${x}`}>
          <del>
            <span class="sr-only">{w.removed}:</span>
            {x}
          </del>
        </li>
      ))}
      {come.map((x) => (
        <li key={`+${x}`}>
          <ins>
            <span class="sr-only">{w.added}:</span>
            {x}
          </ins>
        </li>
      ))}
    </ul>
  )
}

const sourceText = (s: FullRevision['sources'][number]) =>
  'entryId' in s ? s.entryId : s.title ? `${s.title} (${s.url})` : s.url
const linkText = (l: { kind: string; to: string }) => `${T.wiki.kinds[l.kind] ?? l.kind} ${l.to}`

function Differences({ slug, address, a, b }: { slug: string; address: string; a: number; b: number }) {
  const r = compareResource(slug, address, a, b)
  const w = T.wiki
  const d = r.data.value
  const id = `diff-${a}-${b}`
  // Each part on its own: the words of title and summary, the status and type, the tags, the sources and
  // typed links as items added or removed, and the body by line.
  const parts = (x: FullRevision, y: FullRevision) => {
    const text = (
      [
        ['title', x.title, y.title],
        ['summary', x.summary, y.summary],
        ['status', w.statuses[x.status] ?? x.status, w.statuses[y.status] ?? y.status],
        ['type', w.types[x.type] ?? x.type, w.types[y.type] ?? y.type],
        ['tags', x.tags.join(', '), y.tags.join(', ')],
      ] as const
    ).filter(([, p, q]) => p !== q)
    const lists = (
      [
        [
          'sources',
          x.sources.map(sourceText),
          y.sources.map(sourceText),
          x.sources.map(sourceKey).join(),
          y.sources.map(sourceKey).join(),
        ],
        ['links', x.links.map(linkText), y.links.map(linkText), '', ''],
      ] as const
    ).filter(([, p, q, kp, kq]) => p.join('\n') !== q.join('\n') || kp !== kq)
    return [
      ...text.map(([part, p, q]) => (
        <div key={part} class="diff-part">
          <h3>{w.parts[part]}</h3>
          <Words segments={wordDiff(p, q)} />
        </div>
      )),
      ...lists.map(([part, p, q]) => (
        <div key={part} class="diff-part">
          <h3>{w.parts[part]}</h3>
          <ListDiff a={[...p]} b={[...q]} />
        </div>
      )),
      ...(x.body === y.body
        ? []
        : [
            <div key="body" class="diff-part">
              <h3>{w.parts.body}</h3>
              <BodyDiff a={x.body} b={y.body} />
            </div>,
          ]),
    ]
  }
  const shown = d ? parts(d.a, d.b) : null
  return (
    <section class="differences" aria-labelledby={id}>
      <h2 id={id} class="section-title">
        {w.changes(a, b)}
      </h2>
      {shown ? (
        shown.length === 0 ? (
          <p class="muted">{w.noChange}</p>
        ) : (
          shown
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
  const r = pageResource(slug, address)
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
                <Why r={x} />
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
