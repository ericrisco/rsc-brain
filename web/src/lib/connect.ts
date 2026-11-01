// «Connect your agent» (spec B6, B5 «Kit de conexión»): the configuration with the token filled in, for
// the one view that shows it, and the live check. The check asks the server every 2 seconds (plan §3.5,
// «sin hueco»): the token made on this page turns green on its first request (its lastUsedAt stops being
// null), and the standard sign-in turns green when a connected app appears that was not there when the
// page opened. A cheap poll, not the event stream: a key's first request (MCP initialize) writes nothing
// to a brain, so no event says it arrived.
import { clientLabel } from './brains.ts'

export const CHECK_EVERY_MS = 2000

export type KitBlock = { title: string; where: string; format: string; text: string }

// A copy of the blocks with the token where the kit has its placeholder. The kit itself is not changed:
// it is cached, and shown again without the token once this view is gone.
export function fillToken(blocks: readonly KitBlock[], placeholder: string, secret: string): KitBlock[] {
  return blocks.map((b) => ({ ...b, text: b.text.split(placeholder).join(secret) }))
}

type TokenSeen = { id: string; lastUsedAt: string | null; lastClient: string | null }
type AppSeen = { id: string; name: string; lastUsedAt: string }

export type Check =
  | { kind: 'waiting' }
  | { kind: 'connected'; via: 'token' | 'app'; at: string; client: string | null }

// What to ask the server for: the apps always (the first answer says which were there before), and the
// tokens once one was made on this page.
export function toAsk(o: {
  tokenId: string | null
  knownApps: Set<string> | null
}): Array<'tokens' | 'apps'> {
  return o.tokenId ? ['tokens', 'apps'] : ['apps']
}

export function checkOf(o: {
  tokenId: string | null
  knownApps: Set<string> | null
  tokens?: readonly TokenSeen[] | undefined
  apps?: readonly AppSeen[] | undefined
}): Check {
  const t = o.tokenId ? o.tokens?.find((x) => x.id === o.tokenId && x.lastUsedAt) : undefined
  if (t?.lastUsedAt)
    return { kind: 'connected', via: 'token', at: t.lastUsedAt, client: clientLabel(t.lastClient) }
  const known = o.knownApps
  const a = known ? o.apps?.find((x) => !known.has(x.id)) : undefined
  if (a) return { kind: 'connected', via: 'app', at: a.lastUsedAt, client: a.name }
  return { kind: 'waiting' }
}
