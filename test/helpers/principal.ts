// Who a web session or a key is, as the server works it out, for tests that call the domain directly.
import { type Principal, resolveKey } from '../../src/auth/principal.ts'
import type { World } from './world.ts'

export const principalOfSession = (w: World, session: string): Promise<Principal> =>
  resolveKey(w.db, session, w.clock(), 'cookie', { userAgent: 'test' })

export const principalOfKey = (w: World, key: string): Promise<Principal> =>
  resolveKey(w.db, key, w.clock(), 'bearer', { userAgent: 'test' })
