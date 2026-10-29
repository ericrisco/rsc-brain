// The live feed of events (spec B5 «Flujo de eventos»): one poller per process reads the new rows of
// the events table and hands each brain's rows to the streams that follow it. One poller, not one per
// stream: the cost stays the same however many programs follow, and the ids of every brain come from
// one sequence, so a missing id is noticed.
//
// Order. Ids are given when a row is written but become visible when its transaction commits, so id 41
// can appear after id 42. The poller delivers in id order and, at a missing id, waits up to `holeMs`
// for it (a write still committing); after that the id is taken as never coming (a rolled-back write).
// With the defaults an event reaches its streams within pollMs + holeMs < 2 s (CA12).
import type { Db } from '../db/db.ts'
import { type EventRow, eventsAfter, lastEventId } from '../domain/events.ts'

export type EventTimings = {
  pollMs: number // how often the poller reads new events
  holeMs: number // how long it waits for a missing id before moving past it
  heartbeatMs: number // a comment on every stream, so proxies keep it open
  recheckMs: number // how often a stream checks its key and role again (B4 CA30)
}

export const EVENT_TIMINGS: EventTimings = {
  pollMs: 250,
  holeMs: 1000,
  heartbeatMs: 15_000,
  recheckMs: 2_000,
}

const BATCH = 500

export type Subscription = {
  // The last id the feed had handed out when this subscription began: a stream that resumes replays
  // up to here from the table, and the feed brings what comes after.
  from: number
  stop(): void
}

export type EventHub = {
  subscribe(brainId: string, push: (rows: EventRow[]) => void): Promise<Subscription>
}

type Sub = { brainId: string; push: (rows: EventRow[]) => void }

export function eventHub(db: Db, t: EventTimings, log: (line: string) => void): EventHub {
  const subs = new Set<Sub>()
  let cursor = 0
  let timer: ReturnType<typeof setInterval> | null = null
  let starting: Promise<void> | null = null
  let holeSince: number | null = null
  let busy = false

  async function poll(): Promise<void> {
    if (busy || subs.size === 0) return
    busy = true
    try {
      const rows = await eventsAfter(db, cursor, BATCH)
      const ready: EventRow[] = []
      for (const row of rows) {
        if (row.id !== cursor + 1) {
          holeSince ??= Date.now()
          if (Date.now() - holeSince < t.holeMs) break
        }
        ready.push(row)
        cursor = row.id
        holeSince = null
      }
      if (ready.length === 0) return
      const byBrain = new Map<string, EventRow[]>()
      for (const row of ready) byBrain.set(row.brainId, [...(byBrain.get(row.brainId) ?? []), row])
      for (const sub of subs) {
        const mine = byBrain.get(sub.brainId)
        if (mine) sub.push(mine)
      }
    } catch (err) {
      log(`events: ${err instanceof Error ? err.message : String(err)}`)
    } finally {
      busy = false
    }
  }

  function start(): Promise<void> {
    starting ??= (async () => {
      // A feed that starts (again) begins at the newest event: what came before is replayed on request.
      cursor = await lastEventId(db)
      holeSince = null
      timer = setInterval(() => void poll(), t.pollMs)
      timer.unref()
      // Everyone left while it started.
      if (subs.size === 0) {
        clearInterval(timer)
        timer = null
        starting = null
      }
    })()
    return starting
  }

  return {
    async subscribe(brainId, push) {
      const sub: Sub = { brainId, push }
      subs.add(sub)
      try {
        await start()
      } catch (err) {
        subs.delete(sub)
        starting = null
        throw err
      }
      return {
        from: cursor,
        stop() {
          subs.delete(sub)
          if (subs.size === 0 && timer) {
            clearInterval(timer)
            timer = null
            starting = null
          }
        },
      }
    },
  }
}
