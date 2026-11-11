// The optional extensions search can use (spec v0.6 «Búsqueda»): pg_search ranks by BM25 and pgvector compares
// meaning with its operator. Neither is required: without them search works as before. Migrations never create
// them (the app's role is not a superuser); an administrator does, and rsc-brain uses what it finds. The BM25
// indexes are made here, after every migration, whenever pg_search is there and they are not: an extension
// added later is used from the next start.
import type { Db } from './db.ts'

export type SearchFeatures = { bm25: boolean; vector: boolean }

// What each table is ranked by: its title, and the rest of its words, each read three ways (plain, as Spanish
// and as English word forms, all without accents), as the text search of PostgreSQL reads them.
const FORMS = [
  ['', ''],
  ['_es', ", 'stemmer=spanish'"],
  ['_en', ", 'stemmer=english'"],
] as const
// The text is one expression per table (migration 0026); a query names it exactly as the index does.
export const BM25_TEXT = {
  pages: { title: 'title', text: 'public.brain_page_text(address, summary, body, tags)' },
  entries: { title: 'title', text: 'public.brain_entry_text(topic, content, tags)' },
} as const
export type Bm25Table = keyof typeof BM25_TEXT

const fields = (t: Bm25Table): string[] =>
  FORMS.flatMap(([suffix, stem]) => [
    `(${BM25_TEXT[t].title}::pdb.simple('alias=title${suffix}', 'ascii_folding=true'${stem}))`,
    `(${BM25_TEXT[t].text}::pdb.simple('alias=text${suffix}', 'ascii_folding=true'${stem}))`,
  ])

// The fields a query reads, by alias: the title ones weigh `titleBoost` times the others.
export const BM25_FIELDS = FORMS.flatMap(([suffix]) => [
  { part: 'title' as const, alias: `title${suffix}` },
  { part: 'text' as const, alias: `text${suffix}` },
])

const installed = async (db: Db): Promise<Set<string>> =>
  new Set(
    (
      await db.query<{ extname: string }>(
        "SELECT extname FROM pg_extension WHERE extname IN ('pg_search', 'vector')",
      )
    ).map((r) => r.extname),
  )

// Makes the BM25 index of each table when pg_search is installed and the index is not there yet. Safe to run
// at any time: with nothing to do it only reads the catalogue.
export async function ensureSearchIndexes(db: Db): Promise<string[]> {
  if (!(await installed(db)).has('pg_search')) return []
  const made: string[] = []
  for (const t of Object.keys(BM25_TEXT) as Bm25Table[]) {
    const name = `${t}_bm25`
    const there = await db.one<{ table: string | null; index: string | null }>(
      'SELECT to_regclass($1)::text AS table, to_regclass($2)::text AS index',
      [t, name],
    )
    if (!there?.table || there.index) continue
    await db.query(`CREATE INDEX ${name} ON ${t} USING bm25 (id, ${fields(t).join(', ')})`)
    made.push(name)
  }
  return made
}

const known = new WeakMap<object, Promise<SearchFeatures>>()
const forced = new WeakMap<object, Partial<SearchFeatures>>()

async function detect(db: Db): Promise<SearchFeatures> {
  const ext = await installed(db)
  const idx = await db.one<{ p: string | null; e: string | null }>(
    "SELECT to_regclass('pages_bm25')::text AS p, to_regclass('entries_bm25')::text AS e",
  )
  return { bm25: ext.has('pg_search') && Boolean(idx?.p && idx?.e), vector: ext.has('vector') }
}

// What this database offers, found once per pool (at start and on the first search) and kept.
export async function searchFeatures(db: Db): Promise<SearchFeatures> {
  let f = known.get(db)
  if (!f) {
    f = detect(db).catch(() => ({ bm25: false, vector: false }))
    known.set(db, f)
  }
  const found = await f
  const off = forced.get(db)
  return { bm25: found.bm25 && off?.bm25 !== false, vector: found.vector && off?.vector !== false }
}

// Something failed with what was found (an index dropped since): look again next time.
export function forgetSearchFeatures(db: Db): void {
  known.delete(db)
}

// Turns a feature off for one pool whatever is installed: how the tests try a database with pg_search but
// without pgvector, which this release of pg_search cannot be installed without.
export function limitSearchFeatures(db: Db, off: Partial<SearchFeatures>): void {
  forced.set(db, off)
}
