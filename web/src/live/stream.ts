// The live module (plan §3.3, spec B6 «Activity», CA8): follows the events of a brain and keeps what a screen
// shows of them. One stream at a time. When the connection drops, it says «reconnecting» and opens again on
// its own, waiting a little longer each time, from the last event it got: the server replays what came
// after (B5, up to 24 hours) and says so when it cannot ("gap"). «closed» (a role changed, a key revoked)
// stops it and says why; it opens again only when asked. Paused, the list stays still and what arrives
// waits, counted, until resumed. A hidden tab lets the stream go and catches up once shown.
//
// Kept free of the DOM (the browser's EventSource and document are handed in), so it is tested on its own.
import { batch, signal } from '@preact/signals'

export type LiveEvent = {
  id: string
  at: string
  brain: string
  kind: string
  who: { id: string; name: string } | null
  key: { id: string; ref: string | null } | null
  target: { id: string | null; label: string | null } | null
  query: string | null
  client: string | null
}

export type SourceLike = {
  onopen: (() => void) | null
  onmessage: ((m: { data: string; lastEventId: string }) => void) | null
  onerror: (() => void) | null
  addEventListener(type: 'gap' | 'closed', f: (m: { data: string }) => void): void
  close(): void
}

export type LiveDeps = {
  open: (url: string) => SourceLike
  doc: {
    readonly hidden: boolean
    addEventListener(type: 'visibilitychange', f: () => void): void
    removeEventListener(type: 'visibilitychange', f: () => void): void
  }
}

// connecting: opening; live: open; reconnecting: dropped, opening again soon; idle: the tab is hidden;
// closed: the server ended it (see `closed`).
export type LiveState = 'connecting' | 'live' | 'reconnecting' | 'idle' | 'closed'

// How long to wait before opening again after each drop in a row.
export const RECONNECT_MS = [1_000, 2_000, 5_000, 10_000, 15_000] as const
// The events a screen keeps; older ones leave the list (the journal keeps everything).
export const KEEP = 500

export type Stream = {
  // Newest first.
  events: { readonly value: LiveEvent[] }
  // Arrived while paused, newest first.
  waiting: { readonly value: LiveEvent[] }
  state: { readonly value: LiveState }
  paused: { readonly value: boolean }
  // What the server said was missed and cannot be replayed; null when nothing was.
  gap: { readonly value: string | null }
  // Why the server ended the stream; null while it has not.
  closed: { readonly value: string | null }
  pause(): void
  resume(): void
  retry(): void
  stop(): void
}

const message = (data: string): string | null => {
  try {
    const m = (JSON.parse(data) as { message?: unknown }).message
    return typeof m === 'string' && m ? m : null
  } catch {
    return null
  }
}

function eventOf(data: string): LiveEvent | null {
  try {
    const e = JSON.parse(data) as Partial<LiveEvent>
    if (typeof e.id !== 'string' || !/^\d+$/.test(e.id) || typeof e.kind !== 'string') return null
    return {
      id: e.id,
      at: typeof e.at === 'string' ? e.at : '',
      brain: typeof e.brain === 'string' ? e.brain : '',
      kind: e.kind,
      who: e.who ?? null,
      key: e.key ?? null,
      target: e.target ?? null,
      query: typeof e.query === 'string' ? e.query : null,
      client: typeof e.client === 'string' ? e.client : null,
    }
  } catch {
    return null
  }
}

// `history`: start with what happened in the last 24 hours (what the server keeps for resuming).
// `onEvent`: each new event, paused or not (a screen refreshes what it changed).
export function follow(
  slug: string,
  deps: LiveDeps,
  o: {
    history?: boolean
    keep?: number
    onEvent?: (e: LiveEvent) => void
    onGap?: () => void
    onClosed?: () => void
  } = {},
): Stream {
  const keep = o.keep ?? KEEP
  const events = signal<LiveEvent[]>([])
  const waiting = signal<LiveEvent[]>([])
  const state = signal<LiveState>('connecting')
  const paused = signal(false)
  const gap = signal<string | null>(null)
  const closed = signal<string | null>(null)
  // The id of the newest event received: the stream opens again from there.
  let last = o.history ? '0' : ''
  let source: SourceLike | null = null
  let timer: ReturnType<typeof setTimeout> | undefined
  let drops = 0
  let stopped = false
  const base = `/v1/brains/${encodeURIComponent(slug)}/events`

  const letGo = () => {
    if (source) {
      source.onopen = null
      source.onmessage = null
      source.onerror = null
      source.close()
    }
    source = null
    if (timer !== undefined) clearTimeout(timer)
    timer = undefined
  }

  const open = () => {
    if (stopped || source) return
    if (deps.doc.hidden) {
      state.value = 'idle'
      return
    }
    // Opened from nothing (the last 24 hours): a "gap" only says older events exist.
    const fromStart = last === '0'
    const s = deps.open(last ? `${base}?lastEventId=${encodeURIComponent(last)}` : base)
    source = s
    if (state.value !== 'reconnecting') state.value = 'connecting'
    s.onopen = () => {
      drops = 0
      state.value = 'live'
    }
    s.onmessage = (m) => {
      const e = eventOf(m.data)
      if (!e || (last && Number(e.id) <= Number(last))) return
      last = e.id
      if (state.value !== 'live') {
        drops = 0
        state.value = 'live'
      }
      if (paused.value) waiting.value = [e, ...waiting.value].slice(0, keep)
      else events.value = [e, ...events.value].slice(0, keep)
      o.onEvent?.(e)
    }
    s.onerror = () => {
      letGo()
      if (deps.doc.hidden) {
        state.value = 'idle'
        return
      }
      state.value = 'reconnecting'
      const wait = RECONNECT_MS[Math.min(drops, RECONNECT_MS.length - 1)] as number
      drops += 1
      timer = setTimeout(() => {
        timer = undefined
        open()
      }, wait)
    }
    s.addEventListener('gap', (m) => {
      if (fromStart) return
      gap.value = message(m.data) ?? 'Some events were missed.'
      o.onGap?.()
    })
    s.addEventListener('closed', (m) => {
      letGo()
      batch(() => {
        state.value = 'closed'
        closed.value = message(m.data) ?? 'The live feed of this brain ended.'
      })
      o.onClosed?.()
    })
  }

  const seen = () => {
    if (stopped) return
    if (deps.doc.hidden) {
      if (state.value === 'closed') return
      letGo()
      state.value = 'idle'
    } else if (state.value === 'idle') open()
  }
  deps.doc.addEventListener('visibilitychange', seen)
  open()

  return {
    events,
    waiting,
    state,
    paused,
    gap,
    closed,
    pause: () => {
      paused.value = true
    },
    resume: () => {
      batch(() => {
        events.value = [...waiting.value, ...events.value].slice(0, keep)
        waiting.value = []
        paused.value = false
      })
    },
    retry: () => {
      letGo()
      closed.value = null
      drops = 0
      state.value = 'connecting'
      open()
    },
    stop: () => {
      stopped = true
      deps.doc.removeEventListener('visibilitychange', seen)
      letGo()
    },
  }
}
