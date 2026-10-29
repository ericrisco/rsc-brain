// GET /v1/brains/:slug/events (spec B5 «Flujo de eventos»): the events of a brain as Server-Sent Events.
// Each one is a "data:" line with the event as JSON and its id in "id:", so a client that reconnects
// sends Last-Event-ID (or ?lastEventId=) and gets what it missed, in order, from the last 24 hours. A
// gap longer than that is said with a "gap" event (CA20). Who sees what follows pack rule 7. The key
// and the role are checked again every 2 seconds: a revoked key or a changed role closes the stream
// with a "closed" event (B4 CA30). A comment every 15 seconds keeps proxies from closing it.
import { bearer, resolveKey, roleIn } from '../../auth/principal.ts'
import { AppError, invalid } from '../../core/errors.ts'
import { inBrain } from '../../domain/context.ts'
import { type EventRow, eventsOfBrain, missedBefore, type Viewer, visibleTo } from '../../domain/events.ts'
import { type Req, type Route, route, type StreamOut } from '../router.ts'
import { ctxOf } from './brains.ts'

export { EVENT_TIMINGS } from '../hub.ts'

export const REPLAY_HOURS = 24
const REPLAY_BATCH = 500

// The event as a program sees it: identifiers and labels, never a body.
export function eventOf(e: EventRow) {
  return {
    id: String(e.id),
    at: e.at.toISOString(),
    brain: e.brain,
    kind: e.kind,
    who: e.accountId ? { id: e.accountId, name: e.accountName ?? '' } : null,
    key: e.credentialId ? { id: e.credentialId, ref: e.ref } : null,
    target: e.targetId || e.label ? { id: e.targetId, label: e.label } : null,
    query: e.query,
  }
}

const frame = (o: { id?: string; event?: string; data: unknown }) =>
  `${o.id ? `id: ${o.id}\n` : ''}${o.event ? `event: ${o.event}\n` : ''}data: ${JSON.stringify(o.data)}\n\n`

function lastIdOf(r: Req): number | undefined {
  const given = r.headers['last-event-id'] ?? r.query.get('lastEventId') ?? undefined
  if (given === undefined || given === '') return undefined
  const v = String(given)
  if (!/^\d{1,15}$/.test(v)) {
    throw invalid(
      'Last-Event-ID is the id of the last event received, a whole number.',
      'Send back the "id" of the last event you got, or leave it out to follow from now.',
    )
  }
  return Number(v)
}

const CLOSED: Record<string, string> = {
  role_changed: 'Your role in this brain changed, or you left it.',
}

async function follow(
  r: Req,
  out: StreamOut,
  brain: { id: string; slug: string },
  role: string,
  release: () => void,
) {
  const t = r.timings
  const who = r.who
  const viewer: Viewer = {
    curator: role === 'curator',
    accountId: who.accountId,
    credentialId: who.credential.id,
    short: who.credential.kind === 'short',
  }
  const after = lastIdOf(r)
  let lastSent = after ?? 0
  let replaying = true
  const queue: EventRow[] = []
  const send = (rows: EventRow[]) => {
    for (const e of rows) {
      if (e.id <= lastSent) continue
      lastSent = e.id
      if (visibleTo(viewer, e)) out.write(frame({ id: String(e.id), data: eventOf(e) }))
    }
  }
  const sub = await r.hub.subscribe(brain.id, (rows) => {
    if (replaying) queue.push(...rows)
    else send(rows)
  })
  const timers: Array<ReturnType<typeof setInterval>> = []
  let done: () => void = () => {}
  const over = new Promise<void>((resolve) => {
    done = resolve
  })
  let finished = false
  const close = (reason?: string, message?: string) => {
    if (finished) return
    finished = true
    release()
    if (reason) out.write(frame({ event: 'closed', data: { reason, message } }))
    for (const x of timers) clearInterval(x)
    sub.stop()
    out.end()
    done()
  }
  out.onClose(() => close())
  try {
    out.write(': following\n\n')
    if (after !== undefined) {
      const since = new Date(r.clock().getTime() - REPLAY_HOURS * 3_600_000)
      if (await missedBefore(r.db, brain.id, after, since, viewer)) {
        out.write(
          frame({
            event: 'gap',
            data: {
              kind: 'gap',
              brain: brain.slug,
              at: r.clock().toISOString(),
              since: since.toISOString(),
              message: `You missed events from more than ${REPLAY_HOURS} hours ago, which are not kept for resuming. Catch up with the lists (for example the pending proposals and recent sessions), then follow from here.`,
            },
          }),
        )
      }
      // Missed events, oldest first, up to where the live feed takes over.
      for (;;) {
        const rows = await eventsOfBrain(r.db, brain.id, lastSent, sub.from, since, REPLAY_BATCH)
        send(rows)
        if (rows.length < REPLAY_BATCH || out.closed()) break
      }
    } else lastSent = Math.max(lastSent, sub.from)
    replaying = false
    send(queue.splice(0))
  } catch (err) {
    close()
    throw err
  }
  // The client may have left during the replay: then nothing more starts.
  if (finished || out.closed()) {
    close()
    return
  }
  timers.push(setInterval(() => out.write(': ping\n\n'), t.heartbeatMs))
  // The key and the role, checked again: a revocation or a role change ends the stream.
  const secret = bearer(r.headers.authorization) ?? r.cookie
  const channel = bearer(r.headers.authorization) ? 'bearer' : 'cookie'
  let checking = false
  timers.push(
    setInterval(() => {
      if (checking || out.closed()) return
      checking = true
      void (async () => {
        try {
          const now = await resolveKey(r.db, secret, r.clock(), channel)
          if ((await roleIn(r.db, now, brain.id)) !== role) close('role_changed', CLOSED.role_changed)
        } catch (err) {
          if (err instanceof AppError) close(err.code, `${err.message} ${err.howToProceed}`)
          else close('internal', 'The stream stopped on an error; reconnect with the last event id.')
        } finally {
          checking = false
        }
      })()
    }, t.recheckMs),
  )
  await over
}

export const eventRoutes: Route[] = [
  route('GET /v1/brains/:slug/events', async (r) => {
    // Refusals (no such brain, a malformed id) come as ordinary answers, before the stream starts.
    const { brain, role } = await inBrain(ctxOf(r), { slug: r.params.slug as string })
    lastIdOf(r)
    const release = r.hub.admit(r.who.credential.id)
    return {
      body: null,
      stream: async (out) => {
        try {
          await follow(r, out, brain, role, release)
        } finally {
          release()
        }
      },
    }
  }),
]
