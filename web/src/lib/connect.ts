// «Connect your agent» (spec B6, B5 «Kit de conexión»): the text with the token filled in, for the one view
// that shows it, and the live check of each agent's tab. The check asks the server every 2 seconds (plan
// §3.5, «sin hueco»): the token made in that tab turns green on its first request (its lastUsedAt stops
// being null), and the standard sign-in turns green when a connected app that was not there when the check
// started makes its first request (not at the code exchange). A cheap poll, not the event stream: a key's
// first request (MCP initialize) writes nothing to a brain, so no event says it arrived. It never asks
// while the tab is hidden or offline, stops once green, and gives up after 10 minutes until asked again.
import { clientLabel } from './brains.ts'

export const CHECK_EVERY_MS = 2000
export const CHECK_STOP_MS = 10 * 60_000
export const TIPS_AFTER_MS = 60_000

export type KitBlock = { title: string; where: string; format: string; text: string }

// A copy of the blocks with the token where the kit has its placeholder. The kit itself is not changed:
// it is cached, and shown again without the token once this view is gone.
export function fillToken(blocks: readonly KitBlock[], placeholder: string, secret: string): KitBlock[] {
  return blocks.map((b) => ({ ...b, text: b.text.split(placeholder).join(secret) }))
}

type TokenSeen = { id: string; lastUsedAt: string | null; lastClient: string | null }
type AppSeen = { id: string; name: string; lastUsedAt: string; lastRequestAt: string | null }

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
  const a = known ? o.apps?.find((x) => !known.has(x.id) && x.lastRequestAt) : undefined
  if (a?.lastRequestAt) return { kind: 'connected', via: 'app', at: a.lastRequestAt, client: a.name }
  return { kind: 'waiting' }
}

// The check of one agent's tab: what it waits for, since when, and what it found.
export type AgentCheck = {
  kind: 'waiting' | 'connected' | 'stopped'
  tokenId: string | null
  // The apps there when this check started (from its first answer); null until then.
  knownApps: Set<string> | null
  since: number
  found?: Extract<Check, { kind: 'connected' }>
}

export const startCheck = (now: number, tokenId: string | null = null): AgentCheck => ({
  kind: 'waiting',
  tokenId,
  knownApps: null,
  since: now,
})

export const shouldPoll = (c: AgentCheck, env: { hidden: boolean; online: boolean }): boolean =>
  c.kind === 'waiting' && !env.hidden && env.online

export function afterPoll(
  c: AgentCheck,
  answer: { tokens?: readonly TokenSeen[] | undefined; apps: readonly AppSeen[] },
  now: number,
): AgentCheck {
  if (c.kind !== 'waiting') return c
  const knownApps = c.knownApps ?? new Set(answer.apps.map((a) => a.id))
  const found = checkOf({ tokenId: c.tokenId, knownApps, tokens: answer.tokens, apps: answer.apps })
  if (found.kind === 'connected') return { ...c, knownApps, kind: 'connected', found }
  if (now - c.since >= CHECK_STOP_MS) return { ...c, knownApps, kind: 'stopped' }
  return { ...c, knownApps }
}

export const tipsDue = (c: AgentCheck, now: number): boolean =>
  c.kind === 'waiting' && now - c.since >= TIPS_AFTER_MS
