import { createBrain, deleteBrain, getBrain, listBrains, setArchived } from '../../domain/brains.ts'
import type { Ctx } from '../../domain/context.ts'
import { compact, obj, reqStr, str } from '../input.ts'
import { type Req, type Route, route } from '../router.ts'

export const ctxOf = (r: Req): Ctx => ({ db: r.db, clock: r.clock, who: r.who })

export const brainRoutes: Route[] = [
  route('GET /v1/brains', async (r) => ({ body: { brains: await listBrains(ctxOf(r)) } })),
  route('POST /v1/brains', async (r) => {
    const b = obj(r.body)
    const input = {
      slug: reqStr(b, 'slug', 64),
      name: str(b, 'name', { max: 80 }) ?? '',
      description: str(b, 'description', { max: 2000 }),
      purpose: str(b, 'purpose', { max: 1000 }),
      firstCurator: str(b, 'firstCurator', { max: 200 }),
    }
    return { status: 201, body: { brain: await createBrain(ctxOf(r), compact(input)) } }
  }),
  route('GET /v1/brains/:slug', async (r) => ({
    body: { brain: await getBrain(ctxOf(r), r.params.slug as string) },
  })),
  route('POST /v1/brains/:slug/archive', async (r) => ({
    body: { brain: await setArchived(ctxOf(r), r.params.slug as string, true) },
  })),
  route('POST /v1/brains/:slug/unarchive', async (r) => ({
    body: { brain: await setArchived(ctxOf(r), r.params.slug as string, false) },
  })),
  route('DELETE /v1/brains/:slug', async (r) => {
    await deleteBrain(ctxOf(r), r.params.slug as string, str(obj(r.body), 'confirm') ?? '')
    return { body: { deleted: r.params.slug } }
  }),
]
