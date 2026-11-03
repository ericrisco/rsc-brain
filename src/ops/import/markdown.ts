// Reading markdown files as an import does (spec B7 «Importar»): the header of fields (YAML) a file may start with,
// the first heading and paragraph, the links between files ([[x]], [[x|words]], [[x#part]], ![[x]] and relative
// [words](../y.md)), the address a file's path becomes, and a long text cut into pieces at its headings. Pure: no
// database, no disk.
import { redact, SECRET_MARK } from '../../privacy/redact.ts'

// Redacts what an import brings (pack rule 1) without touching what was already redacted: a text exported from
// another installation holds "[redacted secret]" marks, which a second pass would eat into ("password: [redacted
// secret] secret]"); the text between marks is redacted, the marks stay.
export const redactText = (text: string): string =>
  text
    .split(SECRET_MARK)
    .map((p) => redact(p).text)
    .join(SECRET_MARK)

export type Fields = Record<string, string | string[]>

// A value of the header: a JSON string or list (what the export writes), a [a, b] list, or plain text.
function headerValue(raw: string): string | string[] {
  const v = raw.trim()
  if (v.startsWith('"') || v.startsWith('[')) {
    try {
      const j = JSON.parse(v) as unknown
      if (typeof j === 'string') return j
      if (Array.isArray(j)) return j.filter((x) => typeof x === 'string' || typeof x === 'number').map(String)
    } catch {
      // Not JSON: YAML's own forms below.
    }
  }
  if (v.startsWith('[') && v.endsWith(']'))
    return v
      .slice(1, -1)
      .split(',')
      .map((x) => unquote(x.trim()))
      .filter(Boolean)
  return unquote(v)
}
const unquote = (v: string) => (/^(['"]).*\1$/.test(v) ? v.slice(1, -1) : v)

// The header of fields and the rest. Only what an import uses is read: `key: value`, `key: [a, b]` and a list of
// `- item` lines under `key:`; anything else in it is left out, never an error.
export function splitFrontmatter(text: string): { fields: Fields; body: string } {
  const t = text.replace(/^﻿/, '')
  const m = /^---[ \t]*\r?\n([\s\S]*?)\r?\n(?:---|\.\.\.)[ \t]*(?:\r?\n|$)/.exec(t)
  if (!m) return { fields: {}, body: t }
  const fields: Fields = {}
  let list: string | null = null
  for (const line of (m[1] ?? '').split(/\r?\n/)) {
    const item = /^\s*-\s+(.*)$/.exec(line)
    if (item && list) {
      const prev = fields[list]
      const v = headerValue(item[1] ?? '')
      fields[list] = [...(Array.isArray(prev) ? prev : []), ...(Array.isArray(v) ? v : [v])]
      continue
    }
    const kv = /^([A-Za-z][A-Za-z0-9_-]{0,60}):(.*)$/.exec(line)
    if (!kv) {
      list = null
      continue
    }
    const key = (kv[1] as string).toLowerCase()
    const rest = (kv[2] ?? '').trim()
    if (rest === '') {
      list = key
      fields[key] = []
    } else {
      list = null
      fields[key] = headerValue(rest)
    }
  }
  return { fields, body: t.slice(m[0].length) }
}

export const field = (f: Fields, ...keys: string[]): string | undefined => {
  for (const k of keys) {
    const v = f[k]
    if (typeof v === 'string' && v.trim()) return v.trim()
  }
  return undefined
}
export const list = (f: Fields, key: string): string[] => {
  const v = f[key]
  return Array.isArray(v) ? v : typeof v === 'string' && v.trim() ? [v] : []
}

// Text a person reads: links and emphasis as their words.
export function plainText(md: string): string {
  return md
    .replace(/!?\[\[([^\]|\n]+)\|([^\]\n]*)\]\]/g, '$2')
    .replace(/!?\[\[([^\]\n]+)\]\]/g, (_, t: string) => t.replace(/#.*$/, ''))
    .replace(/!?\[([^\]\n]*)\]\([^)\n]*\)/g, '$1')
    .replace(/[*_`~]+/g, '')
    .replace(/^\s{0,3}(?:>\s?|[-+*]\s+|\d+\.\s+)/gm, '')
    .replace(/\s+/g, ' ')
    .trim()
}

export const cut = (text: string, max: number): string => {
  if (text.length <= max) return text
  const at = text.lastIndexOf(' ', max - 1)
  return `${text.slice(0, at > max / 2 ? at : max - 1).trimEnd()}…`
}

export function firstHeading(body: string): string | undefined {
  const m = /^#\s+(.+?)\s*#*\s*$/m.exec(stripCode(body))
  return m ? plainText(m[1] as string) || undefined : undefined
}

// The first paragraph: lines of text before a blank line, past headings, tables, rules, fences and comments.
export function firstParagraph(body: string): string {
  const blocks = stripCode(body).split(/\r?\n\s*\r?\n/)
  for (const b of blocks) {
    const t = b.trim()
    if (!t || /^(#|\||---|\*\*\*|<!--|```|~~~)/.test(t)) continue
    const lines = t.split(/\r?\n/).filter((l) => !/^\s*#/.test(l))
    const text = plainText(lines.join('\n'))
    if (text) return text
  }
  return ''
}

// Code (fenced blocks and inline spans) blanked out, same length, so what is in it is never read as a link.
function stripCode(text: string): string {
  // biome-ignore lint/suspicious/noControlCharactersInRegex: the marks maskCode puts in.
  return maskCode(text).replace(/\u0001+/g, (m) => ' '.repeat(m.length))
}

// Marks every character inside code with \u0001 in a copy, so offsets stay the same: fenced blocks (``` or ~~~, until
// a fence as long) and inline spans (`code`, ``co`de``).
function maskCode(text: string): string {
  const hide = (s: string) => s.replace(/[^\n]/g, '\u0001')
  let fence: string | null = null
  return text
    .split('\n')
    .map((line) => {
      const f = /^\s{0,3}(`{3,}|~{3,})/.exec(line)
      if (fence) {
        const f1 = f?.[1]
        if (f1 && f1[0] === fence[0] && f1.length >= fence.length && line.trim() === f1) fence = null
        return hide(line)
      }
      if (f) {
        fence = f[1] as string
        return hide(line)
      }
      return line.replace(/(`+)(?:[^`]|[^`].*?[^`])\1(?!`)/g, hide)
    })
    .join('\n')
}

// The address of a page from its path (under wiki/ or the vault, without ".md"): each part in lower case, accents
// off, every run of other characters a "-". An empty part is "page".
export function addressOf(path: string): string {
  const parts = path
    .replace(/\.(md|markdown)$/i, '')
    .split('/')
    .map(
      (p) =>
        p
          .normalize('NFKD')
          .replace(/\p{M}/gu, '')
          .toLowerCase()
          .replace(/[^a-z0-9]+/g, '-')
          .replace(/^-+|-+$/g, '') || 'page',
    )
  let a = parts.join('/')
  if (a.length > 200) a = a.slice(0, 200).replace(/[-/]+$/, '')
  return a
}

export type LinkTarget = { kind: 'page'; address: string } | { kind: 'file'; path: string } | null

// Every link of a body, rewritten the way the wiki reads them: a link to a page becomes [[address]] (or
// [[address|words]]); a link to another file of the import (a note in raw/) is left as text and reported as a
// file; a link to nothing in the import is reported unresolved and never becomes a link ("[[" escaped). Links in
// code, and to the web, are left alone.
export function rewriteLinks(
  body: string,
  fromPath: string,
  resolve: (target: string, fromPath: string, relative: boolean) => LinkTarget,
): { body: string; files: string[]; unresolved: string[] } {
  const files: string[] = []
  const unresolved: string[] = []
  const mask = maskCode(body)
  const re =
    /(!?)\[\[([^\]|\n]{1,250})(?:\|([^\]\n]{0,250}))?\]\]|(!?)\[([^\]\n]{0,250})\]\(<?([^)\s>]{1,1000})>?\)/g
  let out = ''
  let last = 0
  for (const m of body.matchAll(re)) {
    const at = m.index ?? 0
    const whole = m[0]
    if (mask.slice(at, at + whole.length).includes('\u0001')) continue
    out += body.slice(last, at)
    last = at + whole.length
    if (m[2] !== undefined) {
      const target = (m[2] as string).trim()
      const words = m[3]?.trim()
      const t = resolve(target.replace(/#.*$/, ''), fromPath, false)
      if (t?.kind === 'page') {
        out +=
          words && words !== t.address
            ? `[[${t.address}|${words.replace(/\]\]/g, '] ]')}]]`
            : `[[${t.address}]]`
      } else {
        if (t?.kind === 'file') files.push(t.path)
        else unresolved.push(target)
        out += whole.replaceAll('[[', '\\[\\[')
      }
      continue
    }
    const href = m[6] as string
    const words = m[5] as string
    // The web, mail, an anchor on the same page: left as they are.
    if (/^[a-z][a-z0-9+.-]*:/i.test(href) || href.startsWith('#')) {
      out += whole
      continue
    }
    let target: string
    try {
      target = decodeURIComponent(href.replace(/#.*$/, ''))
    } catch {
      target = href.replace(/#.*$/, '')
    }
    const t = resolve(target, fromPath, true)
    if (t?.kind === 'page') out += `[[${t.address}|${words.replace(/\]\]/g, '] ]') || t.address}]]`
    else {
      if (t?.kind === 'file') files.push(t.path)
      else if (/\.(md|markdown)$/i.test(target)) unresolved.push(target)
      out += whole
    }
  }
  out += body.slice(last)
  return { body: out, files, unresolved }
}

// A long text in pieces of at most `max` characters: at its headings first, then at blank lines, then anywhere.
export function pieces(text: string, max: number): string[] {
  if (text.length <= max) return [text]
  const parts: string[] = []
  const push = (s: string) => {
    if (s.length <= max) {
      if (s.trim()) parts.push(s)
      return
    }
    for (let i = 0; i < s.length; i += max) parts.push(s.slice(i, i + max))
  }
  const sections = text.split(/(?=^#{1,3}\s)/m)
  let cur = ''
  for (const s of sections) {
    for (const para of s.length > max ? s.split(/(?<=\n\s*\n)/) : [s]) {
      if (cur.length + para.length > max) {
        push(cur)
        cur = ''
      }
      if (para.length > max) push(para)
      else cur += para
    }
  }
  push(cur)
  return parts
}

// The sections of a log or a decisions file: each "## heading" and what follows it, and what comes before the
// first one.
export function sections(body: string): { lead: string; items: Array<{ heading: string; text: string }> } {
  const chunks = body.split(/^(?=##\s)/m)
  const lead = chunks[0]?.startsWith('## ') ? '' : (chunks.shift() ?? '')
  const items = chunks.map((c) => {
    const nl = c.indexOf('\n')
    const heading = plainText((nl === -1 ? c : c.slice(0, nl)).replace(/^##\s+/, ''))
    return { heading, text: c.trim() }
  })
  return { lead: lead.trim(), items }
}
