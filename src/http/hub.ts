// The live feed of events (spec B5 «Flujo de eventos»): one poller per process reads the new rows of
// the events table and hands each brain's rows to the streams that follow it. One poller, not one per
// stream: the cost stays the same however many programs follow.
//
// Order. An id is given when a row is written, but the row becomes visible when its transaction
// commits, so id 41 can appear after id 42 (a long save, a lock wait). The poller therefore numbers
// events itself, in the order it sees them (`seq`, domain/events.ts sequenceEvents), and delivers by
// that number: a write that commits late gets a later number and is delivered then, never skipped,
// and a rolled-back write holds nothing back. An event reaches its streams within about pollMs (CA12).
//
// One installation is one process: one poller numbers. Several processes would each need their own
// cursor over `seq`, and only one of them may number.

import { AppError } from '../core/errors.ts'
import { failureFields, type Log } from '../core/log.ts'
import type { Db } from '../db/db.ts'
import { type EventRow, eventsAfter, lastSeq, sequenceEvents } from '../domain/events.ts'

export type EventTimings = {
  pollMs: number // how often the poller reads new events
  heartbeatMs: number // a comment on every stream, so proxies keep it open
  recheckMs: number // how often a stream checks its key and role again (B4 CA30)
  perKey: number // open streams one key may hold
  total: number // open streams the installation holds
  bufferBytes: number // what a stream may have waiting for a client that does not read
}

export const EVENT_TIMINGS: EventTimings = {
  pollMs: 250,
  heartbeatMs: 15_000,
  recheckMs: 2_000,
  // Each open stream costs a check of its key every 2 s; one installation serves a team, not a crowd.
  perKey: 5,
  total: 200,
  bufferBytes: 1_000_000,
}

const BATCH = 500

export type Subscription = {
  // The last number the feed had handed out when this subscription began: a stream that resumes
  // replays up to here from the table, and the feed brings what comes after.
  from: number
  stop(): void
}

export type EventHub = {
  // A place for one more stream of this key, or a refusal; the function gives the place back.
  admit(keyId: string): () => void
  // How many streams are open now, and how many the installation serves (Admin › Backups & system).
  streams(): { open: number; max: number }
  subscribe(brainId: string, push: (rows: EventRow[]) => void): Promise<Subscription>
}

type Sub = { brainId: string; push: (rows: EventRow[]) => void }

export function eventHub(db: Db, t: EventTimings, log: Log): EventHub {
  const subs = new Set<Sub>()
  let cursor = 0
  let timer: ReturnType<typeof setInterval> | null = null
  let starting: Promise<void> | null = null
  let busy = false

  // Numbering runs one round at a time, never two at once (see sequenceEvents).
  let lane: Promise<unknown> = Promise.resolve()
  function serial<T>(f: () => Promise<T>): Promise<T> {
    const run = lane.then(f)
    lane = run.catch(() => {})
    return run
  }
  async function numberAll(): Promise<void> {
    let given: number
    do given = (await sequenceEvents(db, BATCH)).length
    while (given === BATCH)
  }

  async function poll(): Promise<void> {
    if (busy || subs.size === 0) return
    busy = true
    try {
      const rows = await serial(async () => {
        await numberAll()
        const got = await eventsAfter(db, cursor, BATCH)
        cursor = got.at(-1)?.seq ?? cursor
        return got
      })
      if (rows.length === 0) return
      const byBrain = new Map<string, EventRow[]>()
      for (const row of rows) byBrain.set(row.brainId, [...(byBrain.get(row.brainId) ?? []), row])
      for (const sub of subs) {
        const mine = byBrain.get(sub.brainId)
        if (mine) sub.push(mine)
      }
    } catch (err) {
      log.warn('events_failed', failureFields(err))
    } finally {
      busy = false
    }
  }

  function start(): Promise<void> {
    starting ??= (async () => {
      // A feed that starts (again) begins at the newest event: what came before is replayed on request.
      // What was written while nobody followed is numbered first, so it counts as before.
      await serial(async () => {
        await numberAll()
        cursor = await lastSeq(db)
      })
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

  const open = new Map<string, number>()
  let openTotal = 0
  return {
    streams: () => ({ open: openTotal, max: t.total }),
    admit(keyId) {
      if ((open.get(keyId) ?? 0) >= t.perKey) {
        throw new AppError(
          429,
          'too_many_streams',
          `This key already holds ${t.perKey} open event streams.`,
          'Close one you no longer read; one stream per brain is enough.',
        )
      }
      if (openTotal >= t.total) {
        throw new AppError(
          503,
          'busy',
          'The installation holds as many event streams as it serves.',
          'Try again in a minute, or follow with the lists for now.',
        )
      }
      open.set(keyId, (open.get(keyId) ?? 0) + 1)
      openTotal++
      let given = false
      return () => {
        if (given) return
        given = true
        openTotal--
        const n = (open.get(keyId) ?? 1) - 1
        if (n > 0) open.set(keyId, n)
        else open.delete(keyId)
      }
    },
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
