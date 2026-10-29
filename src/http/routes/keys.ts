import { MAX_SHORT_MINUTES, mintShortKey, revokeKey } from '../../domain/keys.ts'
import { compact, int, obj, oneOf, reqStr, str, strList } from '../input.ts'
import { type Route, route } from '../router.ts'
import { ctxOf } from './brains.ts'

export const keyRoutes: Route[] = [
  route('GET /v1/me', async (r) => {
    const w = r.who
    return {
      body: {
        account: { id: w.accountId, kind: w.kind, name: w.name, email: w.email, isAdmin: w.isAdmin },
        key: {
          id: w.credential.id,
          kind: w.credential.kind,
          perm: w.credential.perm,
          ref: w.credential.ref,
          agent: w.credential.agent,
        },
      },
    }
  }),
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
  route('DELETE /v1/keys/:id', async (r) => {
    await revokeKey(ctxOf(r), r.params.id as string)
    return { body: { revoked: r.params.id } }
  }),
]
