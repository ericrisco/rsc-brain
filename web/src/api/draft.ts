// What a person typed survives a failed send or a reload (spec B6 «Estados»: lo escrito se conserva).
// Kept in the session storage of the tab, never for a password, a code or a token (plan §3.2).
export type DraftStore = {
  getItem(k: string): string | null
  setItem(k: string, v: string): void
  removeItem(k: string): void
}

const SECRET = /password|code|token|secret/i

export function draft(key: string, store: DraftStore) {
  if (SECRET.test(key)) throw new Error(`a draft never holds a secret (${key})`)
  const k = `rscb.draft.${key}`
  const safely = (f: () => void) => {
    try {
      f()
    } catch {
      // Storage can be full or blocked (private windows); the draft is a convenience.
    }
  }
  return {
    get(): string {
      try {
        return store.getItem(k) ?? ''
      } catch {
        return ''
      }
    },
    set(v: string) {
      safely(() => (v ? store.setItem(k, v) : store.removeItem(k)))
    },
    clear() {
      safely(() => store.removeItem(k))
    },
  }
}

// Every draft of the tab goes when its session does (signing out, or a session that ended): what one
// person typed is never shown to whoever signs in next on the same tab.
export function clearDrafts(
  store: DraftStore & { readonly length: number; key(i: number): string | null },
): void {
  try {
    const keys: string[] = []
    for (let i = 0; i < store.length; i++) {
      const k = store.key(i)
      if (k?.startsWith('rscb.draft.')) keys.push(k)
    }
    for (const k of keys) store.removeItem(k)
  } catch {
    // Storage blocked: there is nothing kept to clear.
  }
}
