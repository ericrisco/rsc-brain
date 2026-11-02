// The readable export (spec B7 «Exportar», plan §3.5): a folder shaped like 02-DOCS that a vault opens.
//   wiki/<address>.md        one page a file: a header (type, status, tags, summary, sources, typed links) and its
//                            body, its mentions as links to the pages they lead to
//   raw/journal/<yyyy>/<mm>/<yyyy-mm-dd>-<session>.md   one note a session, one section an entry, anchored ^<entry>
//   index.md · decisions.md · log.md · README.md
// The pages are the graph's (retired ones are not in it): a link between two wiki files is an edge of the graph
// and every edge is a link (CA11). Purged entries never come; forgotten ones only when a curator asks.

import type { Zip } from '../../core/zip.ts'
import type { Db, Row } from '../../db/db.ts'
import type { Brain } from '../../domain/context.ts'
import { LINK_KINDS } from '../../domain/wiki/model.ts'
import { rowsOf } from './rows.ts'
import {
  anchorOf,
  bodyWithLinks,
  frontmatter,
  journalFile,
  journalText,
  link,
  linkAddress,
  oneLine,
  pageFile,
  plain,
} from './vault.ts'

export type ExportOptions = { brain: Brain; includeForgotten: boolean; at: Date; release: string }

type PageMeta = {
  id: string
  address: string
  title: string
  type: string
  status: string
  summary: string
  createdAt: Date
}
type Source = {
  entry: string | null
  url: string | null
  title: string | null
  ok: boolean
  note: string | null
}

const iso = (v: unknown) => (v instanceof Date ? v.toISOString() : v == null ? null : String(v))
const minute = (v: unknown) => `${(iso(v) ?? '').slice(0, 16).replace('T', ' ')} UTC`
const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`

export async function writeReadable(db: Db, zip: Zip, o: ExportOptions): Promise<void> {
  const brainId = o.brain.id
  const shown = (state: unknown) => state === 'active' || (o.includeForgotten && state === 'forgotten')

  // What every page needs to know of the others: small (no bodies).
  const metas = (
    await db.query(
      `SELECT id, address, title, type, status, summary, created_at FROM pages
        WHERE brain_id = $1 ORDER BY address COLLATE "C", id`,
      [brainId],
    )
  ).map(
    (r): PageMeta => ({
      id: String(r.id),
      address: String(r.address),
      title: String(r.title),
      type: String(r.type),
      status: String(r.status),
      summary: String(r.summary),
      createdAt: r.created_at as Date,
    }),
  )
  const owners = new Map(
    (await db.query('SELECT address, page_id FROM page_addresses WHERE brain_id = $1', [brainId])).map(
      (r) => [String(r.address), String(r.page_id)],
    ),
  )
  const pages = metas.filter((p) => p.status !== 'retired')
  const fileOf = new Map(pages.map((p) => [p.id, pageFile(p, owners.get(p.address) === p.id)]))
  const byId = new Map(pages.map((p) => [p.id, p]))
  // The exported page an address leads to (any address it ever had).
  const pageAt = (address: string) => {
    const id = owners.get(address)
    return id !== undefined && fileOf.has(id) ? id : null
  }

  const links = new Map<string, { kind: string; to: string | null; address: string | null }[]>()
  for (const r of await db.query(
    'SELECT from_page, kind, to_page, to_address FROM page_links WHERE brain_id = $1',
    [brainId],
  )) {
    const list = links.get(String(r.from_page)) ?? []
    list.push({
      kind: String(r.kind),
      to: r.to_page == null ? null : String(r.to_page),
      address: r.to_address == null ? null : String(r.to_address),
    })
    links.set(String(r.from_page), list)
  }

  const sources = new Map<string, Source[]>()
  for (const r of await db.query(
    `SELECT s.page_id, s.entry_id, s.url, s.title, e.state, e.title AS entry_title, e.session_id, se.opened_at
       FROM page_sources s JOIN pages p ON p.id = s.page_id
       LEFT JOIN entries e ON e.id = s.entry_id LEFT JOIN sessions se ON se.id = e.session_id
      WHERE p.brain_id = $1 ORDER BY s.entry_id NULLS LAST, s.url`,
    [brainId],
  )) {
    const list = sources.get(String(r.page_id)) ?? []
    if (r.entry_id == null)
      list.push({
        entry: null,
        url: String(r.url),
        title: r.title == null ? null : String(r.title),
        ok: true,
        note: null,
      })
    else {
      const ok = shown(r.state) && r.session_id != null
      list.push({
        entry: ok ? String(r.entry_id) : null,
        url: null,
        title: ok ? String(r.entry_title) : null,
        ok,
        note: ok
          ? `${journalFile(String(r.session_id), r.opened_at as Date)}#^${anchorOf(String(r.entry_id))}`
          : null,
      })
    }
    sources.set(String(r.page_id), list)
  }

  // The pages, by pieces.
  for await (const r of rowsOf(
    db,
    `SELECT id, address, type, title, summary, body, tags, status, superseded_by, revision, created_at, updated_at
       FROM pages WHERE brain_id = $1 AND status <> 'retired' ORDER BY address COLLATE "C", id`,
    [brainId],
  )) {
    await zip.file(`${fileOf.get(String(r.id))}.md`, pageText(r))
  }

  function pageText(r: Row): string {
    const id = String(r.id)
    const own = links.get(id) ?? []
    // The mentions the wiki counts for this page (its links table), leading to another exported page.
    const mentioned = new Map<string, string>()
    for (const l of own)
      if (l.kind === 'mentions' && l.address !== null) {
        const to = pageAt(l.address)
        if (to !== null && to !== id) mentioned.set(l.address, to)
      }
    const linked = new Set<string>()
    const body = bodyWithLinks(String(r.body), (address) => {
      const to = mentioned.get(address)
      if (to === undefined) return null
      linked.add(to)
      return fileOf.get(to) as string
    })
    // Typed links, by kind, to exported pages; and mentions the body does not carry as written (none, unless
    // the body and its links disagree): both go at the end, so every edge of the graph is a link here.
    const typed = new Map<string, string[]>()
    for (const l of own) {
      if (l.kind === 'mentions' || l.to === null || !fileOf.has(l.to)) continue
      const list = typed.get(l.kind) ?? []
      if (!list.includes(l.to)) list.push(l.to)
      typed.set(l.kind, list)
    }
    const extra = [...new Set(mentioned.values())].filter((to) => !linked.has(to))
    if (extra.length) typed.set('mentions', extra)
    const srcs = sources.get(id) ?? []
    const left = srcs.filter((s) => !s.ok).length
    const superseded = r.superseded_by == null ? null : byId.get(String(r.superseded_by))?.address
    const head = frontmatter([
      ['title', String(r.title)],
      ['address', String(r.address)],
      ['type', String(r.type)],
      ['status', String(r.status)],
      ['tags', r.tags as string[]],
      ['summary', String(r.summary)],
      ['superseded-by', superseded ?? null],
      ['sources', srcs.flatMap((s) => (s.note ? [`[[${s.note}]]`] : s.url ? [s.url] : []))],
      ...LINK_KINDS.map((k): [string, unknown] => [
        k,
        (typed.get(k) ?? []).map((to) => `[[${fileOf.get(to)}]]`),
      ]),
      ['revision', Number(r.revision)],
      ['created', iso(r.created_at)],
      ['updated', iso(r.updated_at)],
    ])
    const parts = [head, `# ${plain(oneLine(String(r.title)))}\n`]
    if (String(r.summary).trim()) parts.push(`> ${plain(oneLine(String(r.summary)))}\n`)
    if (String(r.body).trim()) parts.push(`${body.trimEnd()}\n`)
    if (typed.size) {
      const lines = ['## Links', '']
      for (const [kind, tos] of typed)
        for (const to of tos) lines.push(`- ${kind}: ${link(fileOf.get(to) as string, byId.get(to)?.title)}`)
      parts.push(`${lines.join('\n')}\n`)
    }
    if (srcs.length) {
      const lines = ['## Sources', '']
      for (const s of srcs) {
        if (s.note) lines.push(`- ${link(s.note, s.title ?? undefined)}`)
        else if (s.url)
          lines.push(`- [${plain(oneLine(s.title ?? s.url)).replace(/[[\]]/g, '')}](<${linkAddress(s.url)}>)`)
      }
      if (left)
        lines.push(
          `- ${left === 1 ? '1 source is' : `${left} sources are`} not in this export (forgotten or purged).`,
        )
      parts.push(`${lines.join('\n')}\n`)
    }
    return parts.join('\n')
  }

  // The journal: one note a session, written as its entries arrive.
  let open: Awaited<ReturnType<Zip['open']>> | null = null
  let session: string | null = null
  let notes = 0
  let entries = 0
  for await (const e of rowsOf(
    db,
    `SELECT e.id, e.session_id, e.type, e.topic, e.title, e.content, e.applies_to, e.tags, e.refs, e.state,
            e.pinned, e.created_at, e.client, a.name AS author, ob.name AS on_behalf,
            s.opened_at, s.closed_at, s.status AS s_status, s.purpose, s.ref, s.client AS s_client, sa.name AS s_who
       FROM entries e JOIN sessions s ON s.id = e.session_id JOIN accounts a ON a.id = e.author_id
       LEFT JOIN accounts ob ON ob.id = e.on_behalf_id JOIN accounts sa ON sa.id = s.account_id
      WHERE e.brain_id = $1 AND (e.state = 'active' OR ($2 AND e.state = 'forgotten'))
      ORDER BY s.opened_at, s.id, e.created_at, e.id`,
    [brainId, o.includeForgotten],
  )) {
    if (e.session_id !== session) {
      if (open) await open.close()
      session = String(e.session_id)
      open = await zip.open(`${journalFile(session, e.opened_at as Date)}.md`)
      notes += 1
      await open.write(
        `${frontmatter([
          ['session', session],
          ['opened', iso(e.opened_at)],
          ['closed', iso(e.closed_at)],
          ['status', String(e.s_status)],
          ['by', String(e.s_who)],
          ['client', e.s_client == null ? null : String(e.s_client)],
          ['ref', e.ref == null ? null : String(e.ref)],
          ['purpose', String(e.purpose)],
        ])}\n# ${journalText(oneLine(String(e.purpose) || `Session of ${minute(e.opened_at)}`))}\n`,
      )
    }
    entries += 1
    const who = `${oneLine(String(e.author))}${e.on_behalf == null ? '' : ` for ${oneLine(String(e.on_behalf))}`}`
    const meta = [
      String(e.type),
      minute(e.created_at),
      who,
      e.client == null ? null : oneLine(String(e.client)),
    ]
      .filter(Boolean)
      .join(' · ')
    const facts = [
      e.topic == null ? null : `- topic: ${e.topic}`,
      (e.tags as string[]).length ? `- tags: ${(e.tags as string[]).map(oneLine).join(', ')}` : null,
      e.applies_to == null ? null : `- applies to: ${oneLine(String(e.applies_to))}`,
      (e.refs as string[]).length ? `- refs: ${(e.refs as string[]).map(oneLine).join(', ')}` : null,
      e.pinned ? '- pinned: true' : null,
      e.state === 'forgotten' ? '- forgotten: true' : null,
    ].filter((x): x is string => x !== null)
    await (open as NonNullable<typeof open>).write(
      `\n## ${journalText(oneLine(String(e.title)))}\n\n*${journalText(meta)}* ^${anchorOf(String(e.id))}\n\n${journalText(
        String(e.content).trimEnd(),
      )}\n${facts.length ? `\n${journalText(facts.join('\n'))}\n` : ''}`,
    )
  }
  if (open) await open.close()

  // The map, the decisions and the log.
  const intro = await db.one('SELECT map_intro FROM wiki_settings WHERE brain_id = $1', [brainId])
  const index = [`# ${plain(oneLine(o.brain.name))}`, '']
  if (o.brain.purpose.trim()) index.push(plain(o.brain.purpose.trim()), '')
  if (intro && String(intro.map_intro).trim()) index.push(plain(String(intro.map_intro).trim()), '')
  const groups = new Map<string, PageMeta[]>()
  for (const p of [...pages].sort((a, b) => (a.type < b.type ? -1 : a.type > b.type ? 1 : 0))) {
    const key = `${p.type} · ${p.address.split('/')[0]}`
    groups.set(key, [...(groups.get(key) ?? []), p])
  }
  if (!pages.length) index.push('No pages yet.')
  for (const [key, list] of groups) {
    index.push(`## ${key}`, '')
    for (const p of list) {
      const status = p.status === 'current' ? '' : ` (${p.status})`
      const summary = p.summary.trim() ? ` — ${plain(oneLine(p.summary))}` : ''
      index.push(`- ${link(fileOf.get(p.id) as string, p.title)}${status}${summary}`)
    }
    index.push('')
  }
  await zip.file('index.md', `${index.join('\n').trimEnd()}\n`)

  const decisions = pages
    .filter((p) => p.type === 'decision')
    .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime() || (a.id < b.id ? 1 : -1))
  await zip.file(
    'decisions.md',
    `${[
      '# Decisions',
      '',
      ...(decisions.length
        ? decisions.map(
            (p) =>
              `- ${link(fileOf.get(p.id) as string, p.title)}${p.status === 'current' ? '' : ` (${p.status})`} — ${minute(p.createdAt)}${p.summary.trim() ? ` — ${plain(oneLine(p.summary))}` : ''}`,
          )
        : ['No decisions yet.']),
    ].join('\n')}\n`,
  )

  const log = await zip.open('log.md')
  await log.write('# Log\n\nWhat changed in the wiki, newest first.\n')
  let lines = 0
  for await (const l of rowsOf(
    db,
    `SELECT l.at, l.kind, l.summary, l.pages, coalesce(l.reason, pr.reason) AS why, a.name AS actor
       FROM wiki_log l LEFT JOIN accounts a ON a.id = l.actor_id LEFT JOIN proposals pr ON pr.id = l.proposal_id
      WHERE l.brain_id = $1 ORDER BY l.at DESC, l.id DESC`,
    [brainId],
  )) {
    lines += 1
    const touched = ((l.pages as string[]) ?? []).map((a) => {
      const to = pageAt(a)
      return to === null ? plain(a) : link(fileOf.get(to) as string, a)
    })
    const why =
      l.why == null || l.kind === 'purge' || !String(l.why).trim()
        ? ''
        : ` Why: ${plain(oneLine(String(l.why)))}`
    await log.write(
      `\n- ${minute(l.at)} · ${l.kind} · ${plain(oneLine(String(l.actor ?? '')))}: ${plain(oneLine(String(l.summary)))}${touched.length ? ` (${touched.join(', ')})` : ''}.${why}`,
    )
  }
  await log.write(lines ? '\n' : '\nNothing yet.\n')
  await log.close()

  await zip.file(
    'README.md',
    `${[
      `# ${plain(oneLine(o.brain.name))}`,
      '',
      `An export of the rsc-brain brain "${o.brain.slug}", made ${minute(o.at)} by rsc-brain ${o.release}. Open this folder as a vault in a markdown editor that reads [[wiki links]]: every link opens its page.`.replace(
        '[[wiki links]]',
        '\\[\\[wiki links]]',
      ),
      '',
      '## What is here',
      '',
      `- \`wiki/\`: the wiki, one page a file at its address (${plural(pages.length, 'page', 'pages')}). Each file starts with a header: type, status, tags, summary, sources and typed links (related, depends-on, contradicts, supersedes, part-of, example-of). Retired pages are not here.`,
      `- \`raw/journal/\`: the journal, one note a session in folders by year and month (${plural(notes, 'note', 'notes')}, ${plural(entries, 'entry', 'entries')}). Each entry is a section with a block anchor (^id); the sources of a page link to it.`,
      '- `index.md`: the map of the wiki, by type and area.',
      '- `decisions.md`: the decisions, newest first.',
      '- `log.md`: what changed in the wiki and why, newest first.',
      '',
      o.includeForgotten
        ? 'Forgotten entries are included, each marked "forgotten: true". Purged entries are never exported.'
        : 'Forgotten and purged entries are not exported.',
      '',
      'This export is for reading. To move a brain to another installation with its history, use the faithful export.',
    ].join('\n')}\n`,
  )
}
