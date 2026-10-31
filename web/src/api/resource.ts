// Data a screen shows, shared by key and kept as signals (plan §3.2): a screen reads `data`, `error`,
// `loading` and `stale`; a mutation calls invalidate(prefix) and every resource under that key reloads.
// An error keeps the last good data, so a failed refresh never blanks a screen.
import { type Signal, signal } from '@preact/signals'
import { ApiError } from './client.ts'

export type Resource<T> = {
  key: string
  data: Signal<T | undefined>
  error: Signal<ApiError | undefined>
  loading: Signal<boolean>
  stale: Signal<boolean>
  reload(): Promise<void>
  // Settles when the load in flight (if any) is done.
  settled(): Promise<void>
}

const cache = new Map<string, Resource<unknown>>()

// Resources made and not yet looked at by a screen: their first load is the fresh one.
const unseen = new WeakSet<Resource<unknown>>()

// Whether a screen showing `r` should ask for it again: not the first screen to look at a resource just
// made (its own load is fresh, however fast it came back), and not while a load is on its way.
export function wantsFresh(r: Resource<unknown>): boolean {
  if (unseen.has(r)) {
    unseen.delete(r)
    return false
  }
  return !r.loading.value
}

const asApiError = (e: unknown) =>
  e instanceof ApiError
    ? e
    : new ApiError(0, 'internal', 'Something went wrong in the web.', 'Reload the page and try again.')

export function resource<T>(key: string, loader: () => Promise<T>): Resource<T> {
  const found = cache.get(key)
  if (found) return found as Resource<T>
  let inFlight: Promise<void> = Promise.resolve()
  const r: Resource<T> = {
    key,
    data: signal<T | undefined>(undefined),
    error: signal<ApiError | undefined>(undefined),
    loading: signal(false),
    stale: signal(false),
    reload() {
      r.loading.value = true
      inFlight = loader().then(
        (d) => {
          r.data.value = d
          r.error.value = undefined
          r.stale.value = false
          r.loading.value = false
        },
        (e: unknown) => {
          r.error.value = asApiError(e)
          r.loading.value = false
        },
      )
      return inFlight
    },
    settled: () => inFlight,
  }
  cache.set(key, r as Resource<unknown>)
  unseen.add(r as Resource<unknown>)
  void r.reload()
  return r
}

// Marks every resource whose key starts with `prefix` as stale and reloads it.
export function invalidate(prefix: string): void {
  for (const [k, r] of cache) {
    if (!k.startsWith(prefix)) continue
    r.stale.value = true
    void r.reload()
  }
}

// What an event of the live feed (B5) makes stale, by its kind.
const BY_EVENT: Array<[RegExp, (brain: string) => string[]]> = [
  [/^proposal\./, (b) => [`brain:${b}:proposals`, `brain:${b}:overview`, 'brains']],
  // A page that changed may be one an open proposal edits: its review shows the new base at once.
  [/^wiki\./, (b) => [`brain:${b}:wiki`, `brain:${b}:proposals:review`, `brain:${b}:overview`, 'brains']],
  [/^(entry|session)\./, (b) => [`brain:${b}:journal`, `brain:${b}:overview`]],
]

export function invalidateByEvent(kind: string, brain: string): void {
  for (const [re, prefixes] of BY_EVENT) if (re.test(kind)) for (const p of prefixes(brain)) invalidate(p)
}

export function forget(prefix: string): void {
  for (const k of [...cache.keys()]) if (k.startsWith(prefix)) cache.delete(k)
}

export function resetResources(): void {
  cache.clear()
}
