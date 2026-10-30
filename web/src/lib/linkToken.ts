// The token of an invitation or reset link, read from "#token=" and taken out of the address at once
// (never in the server's logs, never in the history). Kept in memory for the visit, so a screen that
// mounts again still has it; a link pasted again in the same tab (hashchange) is read anew.
import { useEffect, useState } from 'preact/hooks'
import { tokenFromHash } from './nav.ts'

const memory = new Map<string, string>()

function take(kind: string): string | null {
  const t = tokenFromHash(location.hash)
  if (t) {
    memory.set(kind, t)
    history.replaceState(history.state, '', location.pathname)
  }
  return memory.get(kind) ?? null
}

export function useLinkToken(kind: 'invite' | 'reset'): {
  token: string | null
  // Changes each time a link arrives, so a screen can start over with it.
  visit: number
  // The link was used: a screen that mounts again no longer finds it (this one keeps its last step).
  spend(): void
  // The link is abandoned: it is no longer held, and the screen starts without one.
  forget(): void
} {
  const [held, setHeld] = useState(() => ({ token: take(kind), visit: 0 }))
  useEffect(() => {
    const onHash = () => {
      if (!tokenFromHash(location.hash)) return
      const t = take(kind)
      setHeld((h) => ({ token: t, visit: h.visit + 1 }))
    }
    window.addEventListener('hashchange', onHash)
    return () => window.removeEventListener('hashchange', onHash)
  }, [])
  return {
    token: held.token,
    visit: held.visit,
    spend: () => memory.delete(kind),
    forget: () => {
      memory.delete(kind)
      setHeld((h) => ({ token: null, visit: h.visit + 1 }))
    },
  }
}
