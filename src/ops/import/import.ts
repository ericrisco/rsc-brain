// Importing into a brain (spec B7 «Importar», plan §3.6, C17): a documentation folder (02-DOCS or an Obsidian vault)
// or a faithful export of another installation, into a brain with nothing in it yet. Its curators do it, in the
// web; the administration, from the command line once it has joined the brain and made itself its curator (pack
// rule 3). It comes in whole or not at all (one transaction); a brain with pages, entries or proposals refuses it
// and keeps what it has (CA19). It leaves one line in the wiki's log ("imported by X from F"), the brain's
// imported_at, an audit line and an event (the brain's first steps hear it), and a report: what came in, what
// was left out and why, which links led nowhere and which names were made into addresses.
import { AppError } from '../../core/errors.ts'
import { newId } from '../../core/ids.ts'
import { UnzipError } from '../../core/unzip.ts'
import type { Db } from '../../db/db.ts'
import { allow, type Ctx, inBrain, ok } from '../../domain/context.ts'
import { emit } from '../../domain/events.ts'
import { inWeb } from '../../domain/guards.ts'
import { redact } from '../../privacy/redact.ts'
import { planDocs } from './docs.ts'
import { type FaithfulPlan, isFaithful, planFaithful, writeFaithful } from './faithful.ts'
import type { FileTree, Ignored } from './tree.ts'
import { writeDocs } from './write.ts'

// The most of each list a report holds (its totals say how many there were): the answer of the API stays small.
export const REPORT_LIST_MAX = 500

export type ImportReport = {
  kind: 'docs' | 'faithful'
  pages: number
  entries: number
  links: number
  // missing: no such page; left_out: it points to a file that was left out (review of PR32).
  unresolved: Array<{ from: string; target: string; why: 'missing' | 'left_out' }>
  ignored: Ignored[]
  renamed: Array<{ path: string; address: string }>
  // Files that were not UTF-8, read as Windows-1252 (review of PR32).
  recoded: string[]
  totals: { unresolved: number; ignored: number; renamed: number; recoded: number }
  // A faithful import: how many people were found here by their email, and how many came in as authors.
  people?: { matched: number; authors: number }
}

export const notEmpty = () =>
  new AppError(
    409,
    'brain_not_empty',
    'This brain already has pages, entries or proposals; an import goes only into an empty brain. Nothing was changed.',
    'Create a new brain and import into it.',
  )

// One import at a time in this process (review of PR32): its zip is held in memory (up to 50 MB) and read whole, so a
// second waits instead of doubling that; it also keeps two imports off one brain. Mutable for the tests only.
export const IMPORT_STATE = { running: 0 }
export const importBusy = () =>
  new AppError(
    409,
    'import_busy',
    'Another import is running. Try again in a minute.',
    'Wait a minute and import again.',
  )
// The turn of an import: taken before its body is read, given back once its answer is sent (or the client left).
export function takeImportTurn(): () => void {
  if (IMPORT_STATE.running >= 1) throw importBusy()
  IMPORT_STATE.running += 1
  let given = false
  return () => {
    if (given) return
    given = true
    IMPORT_STATE.running -= 1
  }
}

// What the reader refuses, said as the API says it.
export function archiveError(err: unknown): unknown {
  if (!(err instanceof UnzipError)) return err
  return err.code === 'archive_too_large'
    ? new AppError(
        413,
        'archive_too_large',
        err.message,
        'Import a smaller folder: at most 200 MB of files and 20 000 files.',
      )
    : new AppError(
        422,
        'invalid_archive',
        err.message,
        'Make the zip again from the folder (with no links in it) and import it.',
      )
}

// The name the import is recorded with: a file or folder name, redacted, on one line, at most 200 characters.
export const fromName = (from: string) =>
  redact(from.replace(/\s+/g, ' ').trim()).text.slice(0, 200) || 'an unnamed folder'

async function hasContent(db: Db, brainId: string): Promise<boolean> {
  const r = await db.one(
    `SELECT EXISTS (SELECT 1 FROM pages WHERE brain_id = $1) OR EXISTS (SELECT 1 FROM entries WHERE brain_id = $1)
         OR EXISTS (SELECT 1 FROM proposals WHERE brain_id = $1) AS full`,
    [brainId],
  )
  return Boolean(r?.full)
}

// Who may import here, and whether the brain is still empty: asked before anything of the file is read.
export async function mayImport(ctx: Ctx, slug: string): Promise<void> {
  inWeb(ctx, 'Importing into a brain')
  const { brain, role } = await inBrain(ctx, { slug })
  await allow(ctx, 'brain.import', { role, brainStatus: brain.status }, brain.id)
  if (await hasContent(ctx.db, brain.id)) throw notEmpty()
}

const capped = <T>(xs: T[]) => xs.slice(0, REPORT_LIST_MAX)

export async function importTree(
  ctx: Ctx,
  slug: string,
  tree: FileTree,
  o: { from: string },
): Promise<ImportReport> {
  await mayImport(ctx, slug)
  const from = fromName(o.from)
  let faithful: FaithfulPlan | null = null
  let docs: Awaited<ReturnType<typeof planDocs>> | null = null
  try {
    if (await isFaithful(tree)) faithful = await planFaithful(tree)
    else docs = await planDocs(tree)
  } catch (err) {
    throw archiveError(err)
  }
  // What the writing finds wrong in the file (a reference outside it, a row the schema refuses) is the file's.
  return ctx.db
    .tx(async (db) => {
      const c = { ...ctx, db }
      // The brain row held until the end: a second import, or an archive, waits for this one.
      const { brain, role } = await inBrain(c, { slug }, 'update')
      await allow(c, 'brain.import', { role, brainStatus: brain.status }, brain.id)
      if (await hasContent(db, brain.id)) throw notEmpty()
      const now = ctx.clock()
      let report: ImportReport
      let addresses: string[]
      if (faithful) {
        const done = await writeFaithful(db, c, brain.id, faithful, { from, now })
        addresses = done.addresses
        report = {
          kind: 'faithful',
          pages: done.pages,
          entries: done.entries,
          links: done.links,
          unresolved: [],
          ignored: [],
          renamed: capped(done.renamed),
          recoded: [],
          totals: { unresolved: 0, ignored: 0, renamed: done.renamed.length, recoded: 0 },
          people: done.people,
        }
      } else {
        const plan = docs as NonNullable<typeof docs>
        const done = await writeDocs(db, c, brain.id, plan, { from, now })
        addresses = done.addresses
        report = {
          kind: 'docs',
          pages: done.pages,
          entries: done.entries,
          links: done.links,
          unresolved: capped(plan.unresolved).map((u) => ({ ...u, why: u.why ?? 'missing' })),
          ignored: capped(plan.ignored),
          renamed: capped(plan.renamed),
          recoded: capped(plan.recoded),
          totals: {
            unresolved: plan.unresolved.length,
            ignored: plan.ignored.length,
            renamed: plan.renamed.length,
            recoded: plan.recoded.length,
          },
        }
      }
      await db.query(
        `INSERT INTO wiki_log (id, brain_id, at, actor_id, kind, summary, pages) VALUES ($1, $2, $3, $4, 'import', $5, $6)`,
        [
          newId('wlg'),
          brain.id,
          now,
          ctx.who.accountId,
          redact(`Imported by ${ctx.who.name} from ${from}`).text.slice(0, 500),
          addresses,
        ],
      )
      await db.query(
        'UPDATE brains SET imported_at = $2, imported_from = $3, updated_at = $2 WHERE id = $1',
        [brain.id, now, from],
      )
      await ok(
        c,
        'brain.import',
        brain.id,
        undefined,
        JSON.stringify({ kind: report.kind, from, pages: report.pages, entries: report.entries }),
      )
      await emit(db, c, { brainId: brain.id, kind: 'brain.imported', label: report.kind })
      return report
    })
    .catch((err: unknown) => {
      throw archiveError(err)
    })
}
