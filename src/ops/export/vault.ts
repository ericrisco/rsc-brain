// How the readable export writes markdown a vault opens (spec B7 «Exportar», CA11, CA12): where each page and
// each journal note goes, how a link is written so it opens its file (the path from the root of the vault,
// which never depends on what else is there), and how text that only looks like a link stays text. Pure: the
// export (readable.ts) brings the data.
import { isAddress } from '../../domain/wiki/model.ts'

// Ids are "<kind>_<hex>": anything else (a copy restored from elsewhere) is made safe for a file name.
const safeId = (id: string) => id.replace(/[^A-Za-z0-9_-]/g, '-')

// The file of a page, without ".md": its address under wiki/. A page that shares its address with the page the
// address leads to now (it was merged into it) gets its id after the address: "--" never occurs in an address.
export function pageFile(p: { id: string; address: string }, ownsAddress: boolean): string {
  if (isAddress(p.address) && ownsAddress) return `wiki/${p.address}`
  return `wiki/${isAddress(p.address) ? `${p.address}--` : ''}${safeId(p.id)}`
}

// The note of a session, without ".md": one per session, in folders by year and month of when it opened (UTC).
export function journalFile(sessionId: string, openedAt: Date): string {
  const day = openedAt.toISOString().slice(0, 10)
  return `raw/journal/${day.slice(0, 4)}/${day.slice(5, 7)}/${day}-${safeId(sessionId)}`
}

// The block of an entry in its note: letters, digits and dashes only, as a vault requires.
export const anchorOf = (entryId: string) => entryId.replace(/[^A-Za-z0-9-]/g, '-')

// Text written into a note never becomes a link by accident: "[[" is escaped, so it shows as written.
export const plain = (text: string) => text.replaceAll('[[', '\\[\\[')

// Text people and agents wrote into the journal (review of PR31): never a block anchor of its own (a line that
// ends "^word" would answer a link to another entry), never something that loads from elsewhere when the note
// is opened (an image or an embed: it shows as text, its address as a plain link).
export const journalText = (text: string) =>
  plain(text)
    .replace(/(^|\s)\^([A-Za-z0-9-]+)(\s*)$/gm, '$1\\^$2$3')
    .replace(/!\[/g, '\\![')
    // Every "<" that opens a tag or a comment (an image, an input of type image, a style, "<!--"): no HTML at all.
    .replace(/<(?=[A-Za-z!/?])/g, '&lt;')

// An address inside a markdown link "(<…>)": what would end it early (a space, "<", ">") is percent-encoded.
export const linkAddress = (url: string) => url.replace(/[\s<>]/g, (c) => encodeURIComponent(c))

// One line: a heading or a field never runs onto the next line.
export const oneLine = (text: string) => text.replace(/\s+/g, ' ').trim()

// A link to a file of the vault, with the words it shows (none: the file's name).
export function link(file: string, words?: string): string {
  const w = words === undefined ? '' : oneLine(words).replaceAll(']]', '] ]').replaceAll('|', '/')
  return w ? `[[${file}|${w}]]` : `[[${file}]]`
}

// The body of a page with its mentions as links: a mention ([[address]] or [[address|words]], as the wiki reads
// them) that leads to an exported page other than this one becomes a link to that page's file, keeping its words
// (or the address it was written with); every other "[[" stays text.
export function bodyWithLinks(body: string, target: (address: string) => string | null): string {
  const kept: string[] = []
  const marked = body.replace(
    /\[\[([^\]|\n]{1,250})(?:\|([^\]\n]{0,250}))?\]\]/g,
    (whole, a: string, words: string | undefined) => {
      const address = a.trim()
      const file = isAddress(address) ? target(address) : null
      if (!file) return whole
      kept.push(link(file, words === undefined || words.trim() === '' ? address : words))
      // A NUL cannot be in stored text (PostgreSQL refuses it): a safe mark for the link until the rest is escaped.
      return `\u0000${kept.length - 1}\u0000`
    },
  )
  // biome-ignore lint/suspicious/noControlCharactersInRegex: the NUL marks put in above.
  return plain(marked).replace(/\u0000(\d+)\u0000/g, (_, i: string) => kept[Number(i)] as string)
}

// A header of fields (YAML), each value written as a JSON string or list, which YAML reads as it is.
export function frontmatter(fields: Array<[string, unknown]>): string {
  const lines = fields
    .filter(([, v]) => v !== undefined && v !== null && !(Array.isArray(v) && v.length === 0))
    .map(([k, v]) => `${k}: ${JSON.stringify(v)}`)
  return `---\n${lines.join('\n')}\n---\n`
}
