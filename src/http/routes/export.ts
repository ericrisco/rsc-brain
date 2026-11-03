// Exporting a brain (spec B7 «Exportar un cerebro»): a download prepared on disk, not an answer of the API, so the
// bound on answers does not apply. It writes its audit record and an event, so maintenance refuses it like a write.
import { exportBrain, exportQuery } from '../../ops/export/export.ts'
import { type Route, route } from '../router.ts'
import { ctxOf } from './brains.ts'

export const exportRoutes: Route[] = [
  {
    ...route('GET /v1/brains/:slug/export', async (r) => {
      const o = exportQuery(r.query.get('format'), r.query.get('includeForgotten'))
      return {
        body: null,
        download: await exportBrain(ctxOf(r), r.params.slug as string, o, {
          dir: r.exportDir,
          signal: r.signal,
        }),
      }
    }),
    maintenance: 'writes',
  },
]
