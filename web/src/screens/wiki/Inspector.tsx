// The inspector of the graph (spec B6 «Graph», plan canvas-ui D9): what the person picked, a page (its
// summary, status, links and the way to it) or a group (its pages by type and the groups it links with). The
// same panel serves the graph and the list. Over the canvas it is a panel at the right; on a narrow screen
// it rises from the bottom.
import { useEffect, useLayoutEffect, useRef, useState } from 'preact/hooks'
import { keyOf, linksOf, type Model } from '../../graph/model.ts'
import { T } from '../../text.ts'
import { ErrorState } from '../../ui/states.tsx'
import { pageHref, StatusTag, TypeTag } from './common.tsx'
import { peekResource } from './data.ts'

export type Target = { kind: 'page'; address: string } | { kind: 'group'; prefix: string }

// What a group is called: its address, or, for the pages gathered at a level, "Other pages in eng (60)".
export const groupName = (it: { prefix: string; count: number; loose?: true }, n = it.count) =>
  it.loose ? T.graph.otherPagesCount(it.prefix, n) : it.prefix

// What the person picked: a page (its summary, status, links and the way to it) or a group (its pages by
// type and the groups it links with). The same panel serves the graph and the list; on a wide screen it is
// always there, so opening it never moves the picture; on a narrow one it rises from the bottom.
export function Inspector({
  slug,
  model,
  target,
  inGraph,
  onClose,
  onFocus,
  onShow,
  onOpenGroup,
  onGroupList,
}: {
  slug: string
  model: Model | null
  target: Target | null
  inGraph: boolean
  onClose: () => void
  onFocus: (address: string, hops: 1 | 2) => void
  onShow: (key: string) => void
  onOpenGroup: (prefix: string, loose?: boolean) => void
  onGroupList: (prefix: string, loose?: boolean) => void
}) {
  const g = T.graph
  const heading = useRef<HTMLHeadingElement>(null)
  const key = target ? keyOf(target) : ''
  // On a narrow screen the sheet opens as a peek (the picture stays in view) and grows on asking.
  const [sheet, setSheet] = useState<'peek' | 'full'>('peek')
  useEffect(() => setSheet('peek'), [key])
  // Opened from a button of the list, the keyboard follows it here before anything else can happen; from the
  // canvas it stays there.
  useLayoutEffect(() => {
    if (key && !inGraph && heading.current && !(document.activeElement instanceof HTMLCanvasElement))
      heading.current.focus()
  }, [key])
  if (!target)
    return (
      <aside class="graph-inspector empty" aria-labelledby="inspector-name">
        <p class="section-title" id="inspector-name">
          {g.inspector}
        </p>
        <p class="meta">{g.inspectorEmpty}</p>
      </aside>
    )
  const at = model?.index.get(key) ?? -1
  return (
    <aside class="graph-inspector" data-sheet={sheet} aria-labelledby="inspector-name inspector-title">
      <div class="inspector-head">
        <p class="section-title" id="inspector-name">
          {g.inspector}
        </p>
        <button
          type="button"
          class="button quiet sheet-toggle"
          aria-expanded={sheet === 'full' ? 'true' : 'false'}
          onClick={() => setSheet(sheet === 'full' ? 'peek' : 'full')}
        >
          {sheet === 'full' ? g.less : g.more}
        </button>
        <button type="button" class="button quiet" onClick={onClose}>
          {g.closeInspector}
        </button>
      </div>
      {target.kind === 'page' ? (
        <PagePeek
          slug={slug}
          address={target.address}
          model={model}
          at={at}
          headingRef={heading}
          onFocus={onFocus}
          onShow={onShow}
        />
      ) : (
        <GroupPeek
          prefix={target.prefix}
          model={model}
          at={at}
          headingRef={heading}
          onOpenGroup={onOpenGroup}
          onGroupList={onGroupList}
          onShow={onShow}
        />
      )}
    </aside>
  )
}

function PagePeek({
  slug,
  address,
  model,
  at,
  headingRef,
  onFocus,
  onShow,
}: {
  slug: string
  address: string
  model: Model | null
  at: number
  headingRef: preact.RefObject<HTMLHeadingElement>
  onFocus: (address: string, hops: 1 | 2) => void
  onShow: (key: string) => void
}) {
  const g = T.graph
  const r = peekResource(slug, address)
  const reading = r.data.value
  const item = at >= 0 ? model?.items[at] : undefined
  const page = reading?.page
  const title = page?.title ?? (item?.kind === 'page' ? item.title : address)
  const status = page?.status ?? (item?.kind === 'page' ? item.status : '')
  const type = page?.type ?? (item?.kind === 'page' ? item.type : '')
  // Focus needs links: a page alone has nothing around it.
  const linked =
    at >= 0 && model
      ? (model.degree[at] as number) > 0
      : reading
        ? reading.links.in.length > 0 || reading.links.out.some((l) => l.state !== 'broken')
        : true
  const drawable = status !== 'retired' && linked
  const shownHere = (a: string) => model?.index.has(`p:${a}`) ?? false
  // "Caching → mentions → Research overview": who links to whom, by what.
  const links = (
    list: NonNullable<typeof reading>['links']['out'],
    out: boolean,
    heading: string,
    id: string,
  ) => (
    <div class="aside-block">
      <h3 class="aside-sub" id={id}>
        {heading}
      </h3>
      {list.length ? (
        <ul class="plain inspector-links" aria-labelledby={id}>
          {list.map((l) => {
            const other =
              l.state === 'broken' ? (
                <span>
                  <span class="mono">{l.address}</span> <span class="meta">{g.noPage}</span>
                </span>
              ) : (
                <a href={pageHref(slug, l.address)}>{l.title ?? l.address}</a>
              )
            const kind = (
              <span class="meta">
                {' '}
                {g.arrow} {g.linkKinds[l.kind] ?? l.kind} {g.arrow}{' '}
              </span>
            )
            return (
              <li key={`${l.kind}:${l.address}`}>
                {out ? (
                  <>
                    <span>{title}</span>
                    {kind}
                    {other}
                  </>
                ) : (
                  <>
                    {other}
                    {kind}
                    <span>{title}</span>
                  </>
                )}
                {l.state !== 'ok' && l.state !== 'broken' ? (
                  <>
                    {' '}
                    <StatusTag status={l.state} />
                  </>
                ) : null}
                {shownHere(l.address) && l.state !== 'broken' ? (
                  <>
                    {' '}
                    <button
                      type="button"
                      class="button quiet small"
                      aria-label={g.inspectName(l.title ?? l.address)}
                      onClick={() => onShow(`p:${l.address}`)}
                    >
                      {g.inspect}
                    </button>
                  </>
                ) : null}
              </li>
            )
          })}
        </ul>
      ) : (
        <p class="meta">{g.noLinks}</p>
      )}
    </div>
  )
  return (
    <>
      <h2 id="inspector-title" class="inspector-title" tabIndex={-1} ref={headingRef}>
        {title}
      </h2>
      <p class="meta mono">{address}</p>
      <p class="tags">
        {type ? <TypeTag type={type} /> : null} {status ? <StatusTag status={status} /> : null}
      </p>
      {reading ? (
        page?.summary ? (
          <p class="summary">{page.summary}</p>
        ) : null
      ) : r.error.value ? (
        <ErrorState error={r.error.value} onRetry={() => void r.reload()} focus={false} />
      ) : (
        <p class="meta">{g.summaryLoading}</p>
      )}
      <div class="inspector-actions">
        <a class="button" href={pageHref(slug, address)}>
          {g.openPage}
        </a>
        {drawable ? (
          <>
            <button type="button" class="button" onClick={() => onFocus(address, 1)}>
              {g.focus1}
            </button>
            <button type="button" class="button" onClick={() => onFocus(address, 2)}>
              {g.focus2}
            </button>
          </>
        ) : null}
      </div>
      {!linked && status !== 'retired' ? <p class="meta">{g.noFocusAlone}</p> : null}
      {reading ? (
        <>
          {links(reading.links.out, true, g.linksOut, 'inspector-out')}
          {links(reading.links.in, false, g.linksIn, 'inspector-in')}
        </>
      ) : null}
    </>
  )
}

function GroupPeek({
  prefix,
  model,
  at,
  headingRef,
  onOpenGroup,
  onGroupList,
  onShow,
}: {
  prefix: string
  model: Model | null
  at: number
  headingRef: preact.RefObject<HTMLHeadingElement>
  onOpenGroup: (prefix: string, loose?: boolean) => void
  onGroupList: (prefix: string, loose?: boolean) => void
  onShow: (key: string) => void
}) {
  const g = T.graph
  const item = at >= 0 ? model?.items[at] : undefined
  const group = item?.kind === 'group' ? item : null
  const loose = group?.loose === true
  const lines =
    model && at >= 0 ? linksOf(model, at).filter((l) => model.items[l.index]?.kind === 'group') : []
  return (
    <>
      <h2
        id="inspector-title"
        class={`inspector-title${loose ? '' : ' mono'}`}
        tabIndex={-1}
        ref={headingRef}
      >
        {group ? groupName(group) : prefix}
      </h2>
      {group ? (
        <p class="meta">{loose ? g.otherPagesNote(prefix, group.count) : g.groupPages(group.count)}</p>
      ) : null}
      <div class="inspector-actions">
        <button type="button" class="button" onClick={() => onOpenGroup(prefix, loose)}>
          {g.openGroup}
        </button>
        <button type="button" class="button quiet" onClick={() => onGroupList(prefix, loose)}>
          {g.groupInList}
        </button>
      </div>
      {group ? (
        <div class="aside-block">
          <h3 class="aside-sub">{g.typesIn}</h3>
          <ul class="plain">
            {Object.entries(group.types).map(([t, n]) => (
              <li key={t}>
                {T.wiki.typesPlural[t] ?? t}: {n}
              </li>
            ))}
          </ul>
        </div>
      ) : null}
      {lines.length ? (
        <div class="aside-block">
          <h3 class="aside-sub">{g.linksWithGroups}</h3>
          <ul class="plain">
            {lines.map((l) => {
              const other = model?.items[l.index]
              if (other?.kind !== 'group') return null
              return (
                <li key={other.prefix}>
                  <button
                    type="button"
                    class="button quiet small"
                    aria-label={g.inspectName(groupName(other))}
                    onClick={() => onShow(`g:${other.prefix}`)}
                  >
                    {groupName(other)}
                  </button>{' '}
                  <span class="meta">{g.linksCount(l.count)}</span>
                </li>
              )
            })}
          </ul>
        </div>
      ) : null}
    </>
  )
}
