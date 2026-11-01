// Meaning search for the administration (spec B3): see it, turn it on with a provider and the warning
// accepted, turn it off. Web only.
import {
  disableMeaning,
  enableMeaning,
  getMeaning,
  removeProvider,
  setProvider,
} from '../../domain/meaning.ts'
import { obj, reqStr } from '../input.ts'
import { type Route, route } from '../router.ts'
import { ctxOf } from './brains.ts'

export const meaningRoutes: Route[] = [
  route('GET /v1/admin/meaning', async (r) => ({ body: await getMeaning(ctxOf(r)) })),
  route('PUT /v1/admin/meaning', async (r) => {
    const b = obj(r.body)
    return {
      body: await enableMeaning(ctxOf(r), { provider: reqStr(b, 'provider', 40), accept: b.accept === true }),
    }
  }),
  route('DELETE /v1/admin/meaning', async (r) => ({ body: await disableMeaning(ctxOf(r)) })),
  // The key (or address) of one provider, set from the web; never given back.
  route('PUT /v1/admin/meaning/providers/:name', async (r) => {
    const b = obj(r.body)
    return { body: await setProvider(ctxOf(r), r.params.name as string, { key: b.key, url: b.url }) }
  }),
  route('DELETE /v1/admin/meaning/providers/:name', async (r) => ({
    body: await removeProvider(ctxOf(r), r.params.name as string),
  })),
]
