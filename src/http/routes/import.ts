// Importing into a brain (spec B7 «Importar», plan §3.6): a curator in the web sends a .zip of up to 50 MB as the
// body. Who may not, or a brain that is not empty, is refused before any of the body is read; the report comes
// back whole (its lists are capped, their totals say how many there were).
import { invalid } from '../../core/errors.ts'
import { archiveError, importTree, mayImport, takeImportTurn } from '../../ops/import/import.ts'
import { treeFromZip } from '../../ops/import/tree.ts'
import { type Route, route } from '../router.ts'
import { ctxOf } from './brains.ts'

// The most a zip sent to the web may weigh (spec B7: up to 50 MB).
export const IMPORT_MAX_BODY = 50 * 1024 * 1024

export const importRoutes: Route[] = [
  {
    ...route('POST /v1/brains/:slug/import', async (r) => {
      const name = r.query.get('name') ?? 'upload.zip'
      if (!name.trim() || name.length > 200)
        throw invalid('"name" is the name of the zip, at most 200 characters.', 'Send name=<the file name>.')
      if (!Buffer.isBuffer(r.body) || r.body.length === 0)
        throw invalid('The body is the zip to import.', 'Send the .zip file as the body of the request.')
      let tree: ReturnType<typeof treeFromZip>
      try {
        tree = treeFromZip(r.body)
      } catch (err) {
        throw archiveError(err)
      }
      return { body: { report: await importTree(ctxOf(r), r.params.slug as string, tree, { from: name }) } }
    }),
    raw: true,
    maxBody: IMPORT_MAX_BODY,
    // Who may, into an empty brain, and one at a time: all before any of the body is read (no second 50 MB body
    // waits in memory). The turn is given back when the request ends, however it ends.
    before: async (r) => {
      await mayImport(ctxOf(r), r.params.slug as string)
      const release = takeImportTurn()
      if (r.signal.aborted) release()
      else r.signal.addEventListener('abort', release, { once: true })
    },
  },
]
