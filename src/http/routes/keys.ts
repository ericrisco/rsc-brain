import { checkAccess } from '../../domain/access.ts'
import { MAX_SHORT_MINUTES, mintShortKey, revokeKey } from '../../domain/keys.ts'
import { whoAmI } from '../../domain/overview.ts'
import { compact, int, obj, oneOf, reqStr, str, strList } from '../input.ts'
import { type Route, route } from '../router.ts'
import { ctxOf } from './brains.ts'

export const keyRoutes: Route[] = [
  route('GET /v1/me', async (r) => ({ body: await whoAmI(ctxOf(r)) })),
  route('POST /v1/keys/short', async (r) => {
    const b = obj(r.body)
    const req = {
      writeBrain: reqStr(b, 'writeBrain', 64),
      readBrains: strList(b, 'readBrains', { maxItems: 20, maxLen: 64 }),
      perm: oneOf(b, 'perm', ['read', 'write'] as const),
      ref: reqStr(b, 'ref', 200),
      agent: str(b, 'agent', { max: 80 }),
      onBehalf: str(b, 'onBehalf', { max: 200 }),
      ttlMinutes: int(b, 'ttlMinutes', { required: true, min: 1, max: MAX_SHORT_MINUTES }) as number,
      name: str(b, 'name', { max: 80 }),
    }
    const k = await mintShortKey(ctxOf(r), compact(req))
    return { status: 201, body: { key: { id: k.id, secret: k.secret, expiresAt: k.expiresAt } } }
  }),
  // What a person may read in the brains of a service (plan rsc-factory-brain §3.1, spec C21).
  route('POST /v1/access', async (r) => {
    const b = obj(r.body)
    return { body: await checkAccess(ctxOf(r), { person: b.person, brains: b.brains }) }
  }),
  route('DELETE /v1/keys/:id', async (r) => {
    await revokeKey(ctxOf(r), r.params.id as string)
    return { body: { revoked: r.params.id } }
  }),
]
