// A documentation folder as a brain (spec B7 «Importar», plan §3.6, CA14): a 02-DOCS folder (wiki/, raw/, and its
// index, decisions and log) or an Obsidian vault (its notes, without those folders). This file only decides what
// becomes what, from the tree: the writing is write.ts's. What comes in:
//   - every markdown file of wiki/ (of the whole vault) is a page at the address of its path, made valid when it
//     is not (and said so); its type, status, tags, summary and sources come from its header when it has one, else
//     from its folder, name and first paragraph; its links to other pages become the wiki's own [[address]] links,
//     and its typed links (depends-on: [[…]], as the export writes them) typed links; a link to nothing in the
//     import is said and stays text; a link to a note of raw/ makes that note a source;
//   - every text file of raw/ is a note entry, with a reference to its path (cut in pieces when it is long);
//   - a decisions.md and a log.md are read as one entry per "## " section (decisions as decision entries), and the
//     index (index.md at the root or in wiki/) gives the map its introduction;
//   - binaries, files over 1 MB, pages too long for the wiki, files named like keys and secrets, hidden folders
//     and, in a 02-DOCS folder, everything outside wiki/ and raw/ are left out, each with why.
// Everything is redacted (pack rule 1) on the way.

import { LIMITS as ENTRY_LIMITS } from '../../domain/entries.ts'
import {
  isAddress,
  LINK_KINDS,
  type LinkKind,
  PAGE_STATUSES,
  PAGE_TYPES,
  type PageStatus,
  type PageType,
  WIKI_LIMITS,
} from '../../domain/wiki/model.ts'
import {
  addressOf,
  cut,
  type Fields,
  field,
  firstHeading,
  firstParagraph,
  type LinkTarget,
  list,
  pieces,
  plainText,
  redactText,
  rewriteLinks,
  sections,
  splitFrontmatter,
} from './markdown.ts'
import type { FileTree, Ignored, TreeFile } from './tree.ts'

export type PlannedSource = { url: string } | { file: string }
export type PlannedPage = {
  path: string
  address: string
  type: PageType
  status: PageStatus
  supersededBy: string | null
  title: string
  summary: string
  body: string
  tags: string[]
  sources: PlannedSource[]
  links: Array<{ kind: LinkKind; to: string }>
}
export type PlannedNote = {
  // The file it comes from: the sources of a page that links to it.
  path: string
  ref: string
  type: 'note' | 'decision'
  title: string
  content: string
  tags: string[]
}
export type DocsPlan = {
  pages: PlannedPage[]
  notes: PlannedNote[]
  mapIntro: string | null
  unresolved: Array<{ from: string; target: string }>
  ignored: Ignored[]
  renamed: Array<{ path: string; address: string }>
}

const MD = /\.(md|markdown)$/i
const BINARY_EXT =
  /\.(png|jpe?g|gif|webp|bmp|ico|tiff?|heic|pdf|zip|gz|tgz|bz2|xz|7z|rar|mp3|mp4|m4a|mov|avi|mkv|webm|wav|ogg|flac|woff2?|ttf|otf|eot|exe|dll|so|dylib|bin|dmg|iso|sqlite3?|db|psd|ai|sketch|fig|xlsx?|docx?|pptx?|key|numbers|pages)$/i
// Files that hold keys and secrets by their name: never read.
const SECRET_NAME =
  /(^|\/)(id_(rsa|dsa|ecdsa|ed25519)(\.pub)?|\.?env(\.[^/]*)?|\.netrc|\.npmrc|\.pgpass|credentials(\.json)?|secrets?\.(json|ya?ml|env|txt|toml))$|\.(pem|p12|pfx|totp|kdbx|jks|keystore|gpg|asc|ovpn)$/i
const SPECIAL = new Set(['index.md', 'log.md', 'decisions.md'])
const MAP_INTRO_MAX = 4000

const utf8 = new TextDecoder('utf-8', { fatal: true })
// Text, or null for a binary (a NUL, or not UTF-8).
export function textOf(buf: Buffer): string | null {
  if (buf.includes(0)) return null
  try {
    return utf8.decode(buf)
  } catch {
    return null
  }
}

const TYPE_WORDS: Record<string, PageType> = {
  concept: 'topic',
  note: 'topic',
  article: 'topic',
  person: 'entity',
  people: 'entity',
  org: 'entity',
  organization: 'entity',
  project: 'entity',
  profile: 'entity',
  adr: 'decision',
  howto: 'guide',
  'how-to': 'guide',
  runbook: 'guide',
  tutorial: 'guide',
  reference: 'source',
  index: 'overview',
  moc: 'overview',
  readme: 'overview',
}
const FOLDER_TYPES: Array<[RegExp, PageType]> = [
  [/^(decisions?|adrs?)$/, 'decision'],
  [/^(guides?|how-?to|runbooks?|tutorials?)$/, 'guide'],
  [/^(people|persons?|entities|entity|orgs?|companies|projects?)$/, 'entity'],
  [/^agents?$/, 'agent'],
  [/^(sources?|references?|research)$/, 'source'],
]

function typeOf(fm: Fields, path: string): PageType {
  const t = field(fm, 'type')?.toLowerCase()
  if (t && (PAGE_TYPES as readonly string[]).includes(t)) return t as PageType
  if (t && TYPE_WORDS[t]) return TYPE_WORDS[t] as PageType
  const parts = path.toLowerCase().split('/')
  const base = (parts.at(-1) ?? '').replace(MD, '')
  if (/^(index|readme|overview|moc)$/.test(base)) return 'overview'
  for (const p of parts.slice(0, -1).reverse())
    for (const [re, type] of FOLDER_TYPES) if (re.test(p)) return type
  return 'topic'
}

function tagsOf(fm: Fields, max: number, each: number): string[] {
  const out: string[] = []
  for (const t of list(fm, 'tags')) {
    const v = redactText(t.trim().replace(/^#/, '')).trim()
    if (v && v.length <= each && !out.includes(v)) out.push(v)
    if (out.length === max) break
  }
  return out
}

// The folder a 02-DOCS zip was made of ("02-DOCS/wiki/…"): when everything is in one folder, the tree starts there.
function unwrap(files: TreeFile[]): { files: TreeFile[]; prefix: string } {
  const tops = new Set(files.map((f) => (f.path.includes('/') ? (f.path.split('/')[0] as string) : '')))
  const only = [...tops][0]
  if (tops.size !== 1 || !only || only === 'wiki' || only === 'raw') return { files, prefix: '' }
  const prefix = `${only}/`
  return { files: files.map((f) => ({ ...f, path: f.path.slice(prefix.length) })), prefix }
}

export async function planDocs(tree: FileTree): Promise<DocsPlan> {
  const ignored: Ignored[] = [...tree.skipped]
  const said = new Set(ignored.map((i) => i.path))
  const leave = (path: string, why: Ignored['why']) => {
    if (said.has(path)) return
    said.add(path)
    ignored.push({ path, why })
  }
  // What a Mac adds to a zip it makes: never part of the folder.
  const { files } = unwrap(
    tree.files.filter(
      (f) => !f.path.startsWith('__MACOSX/') && !f.path.endsWith('/.DS_Store') && f.path !== '.DS_Store',
    ),
  )
  const docs = files.some((f) => f.path.startsWith('wiki/') || f.path.startsWith('raw/'))
  const wikiFiles: Array<{ f: TreeFile; rel: string }> = []
  const rawFiles: TreeFile[] = []
  const special: Array<{ f: TreeFile; name: string }> = []
  const others = new Set<string>()
  for (const f of files) {
    const parts = f.path.split('/')
    const hidden = parts.findIndex((p) => p.startsWith('.'))
    const name = (parts.at(-1) ?? '').toLowerCase()
    if (SECRET_NAME.test(f.path)) {
      leave(f.path, 'secret')
      continue
    }
    if (hidden !== -1) {
      leave(hidden === parts.length - 1 ? f.path : `${parts.slice(0, hidden + 1).join('/')}/`, 'hidden')
      continue
    }
    const top = parts.length > 1 ? (parts[0] as string) : ''
    if (docs && top !== 'wiki' && top !== 'raw') {
      if (top) leave(`${top}/`, 'outside')
      else if (SPECIAL.has(name)) special.push({ f, name })
      else leave(f.path, 'outside')
      continue
    }
    if (f.tooLarge) {
      leave(f.path, 'too_large')
      continue
    }
    if (top === 'raw') {
      rawFiles.push(f)
      continue
    }
    const rel = docs ? f.path.slice('wiki/'.length) : f.path
    if (!rel.includes('/') && SPECIAL.has(name)) special.push({ f, name })
    else if (MD.test(name) && (name === 'decisions.md' || name === 'log.md')) special.push({ f, name })
    else if (MD.test(name)) wikiFiles.push({ f, rel })
    else if (BINARY_EXT.test(name)) leave(f.path, 'binary')
    else others.add(f.path)
  }
  // Text that is not markdown in the wiki; a file whose name says text but holds bytes is binary.
  for (const path of others) {
    const f = files.find((x) => x.path === path) as TreeFile
    leave(path, textOf(await f.read()) === null ? 'binary' : 'not_markdown')
  }

  // The pages: read, with their header; too long for the wiki, left out.
  type Draft = { path: string; rel: string; fm: Fields; body: string }
  const drafts: Draft[] = []
  for (const { f, rel } of wikiFiles.sort((a, b) => (a.f.path < b.f.path ? -1 : 1))) {
    const text = textOf(await f.read())
    if (text === null) {
      leave(f.path, 'binary')
      continue
    }
    const { fields, body } = splitFrontmatter(text)
    if (body.length > WIKI_LIMITS.body) {
      leave(f.path, 'too_large')
      continue
    }
    drafts.push({ path: f.path, rel, fm: fields, body })
  }
  // Addresses: the header's when it is one and free, else the path's, made valid; two that meet get -2, -3…
  const taken = new Set<string>()
  const renamed: DocsPlan['renamed'] = []
  const addressByPath = new Map<string, string>()
  for (const d of drafts) {
    const asked = field(d.fm, 'address')
    const plainPath = d.rel.replace(MD, '')
    let a = asked && isAddress(asked) && !taken.has(asked) ? asked : addressOf(d.rel)
    if (taken.has(a)) {
      let n = 2
      while (taken.has(`${a.slice(0, 195)}-${n}`)) n += 1
      a = `${a.slice(0, 195)}-${n}`
    }
    taken.add(a)
    addressByPath.set(d.path, a)
    if (a !== plainPath) renamed.push({ path: d.path, address: a })
  }

  // How a link finds its page or file: by its path from the root of the folder (with or without ".md"), from wiki/,
  // relative to the file, by its address, by an alias of its header, or by its name when only one file has it.
  const key = (s: string) => s.normalize('NFC').toLowerCase().replace(/^\/+/, '').replace(MD, '')
  const pageKeys = new Map<string, string>()
  const names = new Map<string, string | null>()
  // A file's own path first: an address or an alias never takes the place of another file's path.
  for (const pass of [0, 1])
    for (const d of drafts) {
      const a = addressByPath.get(d.path) as string
      for (const k of pass === 0 ? [d.path, d.rel] : [a, ...list(d.fm, 'aliases')])
        if (!pageKeys.has(key(k))) pageKeys.set(key(k), a)
    }
  for (const d of drafts) {
    const a = addressByPath.get(d.path) as string
    const n = key(d.rel.split('/').at(-1) ?? '')
    names.set(n, names.has(n) ? null : a)
  }
  const fileKeys = new Map<string, string>()
  for (const f of files) {
    fileKeys.set(key(f.path), f.path)
    fileKeys.set(f.path.normalize('NFC').toLowerCase(), f.path)
  }
  const join = (from: string, target: string) => {
    const out = from.split('/').slice(0, -1)
    for (const p of target.split('/')) {
      if (p === '..') out.pop()
      else if (p !== '.' && p !== '') out.push(p)
    }
    return out.join('/')
  }
  const resolve = (target: string, from: string, relative: boolean): LinkTarget => {
    if (!target.trim()) return null
    const tries = relative
      ? [join(from, target)]
      : [target, join(from, target), docs ? `wiki/${target}` : target]
    for (const t of tries) {
      const a = pageKeys.get(key(t))
      if (a) return { kind: 'page', address: a }
    }
    if (!relative) {
      const byName = names.get(key(target.split('/').at(-1) ?? ''))
      if (byName && !target.includes('/')) return { kind: 'page', address: byName }
    }
    for (const t of tries) {
      const p = fileKeys.get(key(t)) ?? fileKeys.get(t.normalize('NFC').toLowerCase())
      if (p) return { kind: 'file', path: p }
    }
    return null
  }

  const unresolved: DocsPlan['unresolved'] = []
  const pages: PlannedPage[] = []
  for (const d of drafts) {
    const address = addressByPath.get(d.path) as string
    const fallback = d.rel.split('/').at(-1)?.replace(MD, '') ?? address
    const title =
      cut(
        redactText(plainText(field(d.fm, 'title') ?? firstHeading(d.body) ?? fallback)),
        WIKI_LIMITS.title,
      ) || address
    let body = d.body.replace(/^\s+/, '')
    // The export writes the title and the summary again at the top: not part of the body.
    const h = /^#\s+(.+)\r?\n/.exec(body)
    if (h && plainText(h[1] as string) === plainText(field(d.fm, 'title') ?? (h[1] as string)))
      body = body.slice(h[0].length).replace(/^\s+/, '')
    const given = field(d.fm, 'summary', 'description')
    const q = /^>\s?(.+)\r?\n/.exec(body)
    if (q && given && plainText(q[1] as string) === plainText(given))
      body = body.slice(q[0].length).replace(/^\s+/, '')
    const summary = cut(redactText(plainText(given ?? firstParagraph(body))), WIKI_LIMITS.summary)
    const rewritten = rewriteLinks(body, d.path, resolve)
    for (const t of rewritten.unresolved) unresolved.push({ from: address, target: t })
    const links: PlannedPage['links'] = []
    for (const kind of LINK_KINDS)
      for (const raw of list(d.fm, kind)) {
        const target = raw
          .replace(/^\[\[|\]\]$/g, '')
          .replace(/\|.*$/, '')
          .replace(/#.*$/, '')
          .trim()
        const t = resolve(target, d.path, false)
        if (
          t?.kind === 'page' &&
          t.address !== address &&
          !links.some((l) => l.kind === kind && l.to === t.address)
        )
          links.push({ kind, to: t.address })
        else if (t?.kind !== 'page') unresolved.push({ from: address, target })
      }
    const sources: PlannedSource[] = []
    for (const s of list(d.fm, 'sources')) {
      if (/^https?:\/\//i.test(s)) sources.push({ url: redactText(s).slice(0, WIKI_LIMITS.url) })
      else {
        const t = resolve(
          s
            .replace(/^\[\[|\]\]$/g, '')
            .replace(/\|.*$/, '')
            .replace(/#.*$/, ''),
          d.path,
          false,
        )
        if (t?.kind === 'file') sources.push({ file: t.path })
      }
    }
    for (const f of rewritten.files) sources.push({ file: f })
    const status = field(d.fm, 'status')?.toLowerCase()
    let st: PageStatus =
      status && (PAGE_STATUSES as readonly string[]).includes(status) ? (status as PageStatus) : 'current'
    let supersededBy: string | null = null
    if (st === 'superseded') {
      const by = field(d.fm, 'superseded-by', 'superseded_by')
      const t = by ? resolve(by.replace(/^\[\[|\]\]$/g, ''), d.path, false) : null
      if (t?.kind === 'page' && t.address !== address) supersededBy = t.address
      else st = 'current'
    }
    pages.push({
      path: d.path,
      address,
      type: typeOf(d.fm, d.rel),
      status: st,
      supersededBy,
      title,
      summary,
      body: redactText(rewritten.body),
      tags: tagsOf(d.fm, WIKI_LIMITS.tags, WIKI_LIMITS.tag),
      sources: dedupeSources(sources).slice(0, WIKI_LIMITS.sources),
      links: links.slice(0, WIKI_LIMITS.links),
    })
  }
  // A page still too long once its links are written as the wiki's: left out after all.
  for (const p of [...pages])
    if (p.body.length > WIKI_LIMITS.body) {
      pages.splice(pages.indexOf(p), 1)
      leave(p.path, 'too_large')
    }

  // The notes: every text file of raw/, and the sections of the decisions and logs.
  const notes: PlannedNote[] = []
  // The path it came from, the section of a log or decisions file, and the piece of a long text.
  const ref = (path: string, section?: number, part?: number) =>
    `import:${path}`.slice(0, ENTRY_LIMITS.ref - 16) +
    (section === undefined ? '' : `#${section}`) +
    (part === undefined ? '' : `.${part}`)
  const addNotes = (
    path: string,
    title: string,
    content: string,
    type: PlannedNote['type'],
    tags: string[],
    section?: number,
  ) => {
    const parts = pieces(redactText(content), ENTRY_LIMITS.content)
    const t = cut(redactText(title), ENTRY_LIMITS.title - 20) || path
    parts.forEach((c, i) => {
      notes.push({
        path,
        ref: ref(path, section, parts.length > 1 ? i + 1 : undefined),
        type,
        title: parts.length > 1 ? `${t} (part ${i + 1} of ${parts.length})` : t,
        content: c,
        tags,
      })
    })
  }
  for (const f of rawFiles.sort((a, b) => (a.path < b.path ? -1 : 1))) {
    if (BINARY_EXT.test(f.path)) {
      leave(f.path, 'binary')
      continue
    }
    const text = textOf(await f.read())
    if (text === null) {
      leave(f.path, 'binary')
      continue
    }
    const { fields, body } = MD.test(f.path) ? splitFrontmatter(text) : { fields: {}, body: text }
    if (!body.trim()) continue
    const title = plainText(
      field(fields, 'title') ??
        (MD.test(f.path) ? firstHeading(body) : undefined) ??
        (f.path.split('/').at(-1) as string),
    )
    addNotes(f.path, title, body, 'note', tagsOf(fields, ENTRY_LIMITS.tags, ENTRY_LIMITS.tag))
  }
  let mapIntro: string | null = null
  for (const { f, name } of special.sort(
    (a, b) => a.f.path.split('/').length - b.f.path.split('/').length || (a.f.path < b.f.path ? -1 : 1),
  )) {
    const text = textOf(await f.read())
    if (text === null) {
      leave(f.path, 'binary')
      continue
    }
    const { body } = splitFrontmatter(text)
    if (name === 'index.md') {
      if (mapIntro !== null) continue
      const lead =
        body
          .replace(/^\s*#\s+[^\n]*\n/, '')
          .split(/^##\s/m)[0]
          ?.trim() ?? ''
      const intro = redactText(rewriteLinks(lead, f.path, resolve).body)
      mapIntro = intro.length <= MAP_INTRO_MAX ? intro : cut(intro, MAP_INTRO_MAX)
      if (!mapIntro) mapIntro = null
      continue
    }
    const type = name === 'decisions.md' ? 'decision' : 'note'
    const s = sections(body)
    const label = plainText(firstHeading(body) ?? f.path)
    if (s.lead.replace(/^#\s+[^\n]*\n?/, '').trim()) addNotes(f.path, label, s.lead, 'note', [], 0)
    s.items.forEach((it, i) => {
      addNotes(f.path, it.heading || `${label} ${i + 1}`, it.text, type, [], i + 1)
    })
  }
  return {
    pages,
    notes,
    mapIntro,
    unresolved: dedupe(unresolved),
    ignored: ignored.sort((a, b) => (a.path < b.path ? -1 : 1)),
    renamed,
  }
}

function dedupe<T>(xs: T[]): T[] {
  const seen = new Set<string>()
  return xs.filter((x) => {
    const k = JSON.stringify(x)
    if (seen.has(k)) return false
    seen.add(k)
    return true
  })
}
const dedupeSources = (xs: PlannedSource[]) => dedupe(xs)
