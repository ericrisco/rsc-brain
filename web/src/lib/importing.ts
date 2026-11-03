// Settings › Import (spec B7 «Importar»): what the screen checks before a zip goes up, and the words of the report.
import { T } from '../text.ts'
import { sizeLabel } from './exporting.ts'

// What the server takes from the web (src/http/routes/import.ts).
export const IMPORT_MAX_BYTES = 50 * 1024 * 1024

export type ImportWhy = 'binary' | 'too_large' | 'not_markdown' | 'hidden' | 'secret' | 'outside' | 'link'
export type ImportReport = {
  kind: 'docs' | 'faithful'
  pages: number
  entries: number
  links: number
  unresolved: Array<{ from: string; target: string; why: 'missing' | 'left_out' }>
  ignored: Array<{ path: string; why: ImportWhy }>
  renamed: Array<{ path: string; address: string }>
  recoded: string[]
  totals: { unresolved: number; ignored: number; renamed: number; recoded: number }
  people?: { matched: number; authors: number }
}

// Why a file cannot go up, said before it does (null: it can).
export function fileProblem(f: { name: string; size: number }): string | null {
  const I = T.settings.import
  if (!/\.zip$/i.test(f.name)) return I.notZip
  if (f.size === 0) return I.emptyFile
  if (f.size > IMPORT_MAX_BYTES) return I.tooBig(sizeLabel(f.size))
  return null
}

export const importAsk = (slug: string, name: string) => ({ path: { slug }, query: { name } })

const count = (n: number, one: string, many: string) =>
  n === 0 ? `no ${many}` : `${n} ${n === 1 ? one : many}`

export function importDone(
  r: Pick<ImportReport, 'kind' | 'pages' | 'entries' | 'links'>,
  file: string,
): string {
  return `Imported ${count(r.pages, 'page', 'pages')}, ${count(r.entries, 'entry', 'entries')} and ${count(r.links, 'link', 'links')} from ${file}.`
}

export function whyText(why: ImportWhy): string {
  return T.settings.import.why[why] ?? 'left out'
}
