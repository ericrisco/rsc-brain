import {
  type EntryInput,
  getEntry,
  LIMITS,
  relayCorrection,
  saveEntry,
  suggestTopic,
  summarizeSession,
} from '../../domain/entries.ts'
import { limitOf, listEntries, listSessions } from '../../domain/listing.ts'
import { endSession, openSession, openSessionsOfKey } from '../../domain/sessions.ts'
import { compact, type Obj, obj, reqStr, str, strList } from '../input.ts'
import { type Route, route } from '../router.ts'
import { ctxOf } from './brains.ts'

// The fields of an entry as the API takes them. Length limits are checked by the domain with clearer
// messages; here only the shapes.
function entryFields(b: Obj) {
  return compact({
    title: reqStr(b, 'title'),
    content: reqStr(b, 'content'),
    appliesTo: str(b, 'appliesTo'),
    tags: strList(b, 'tags'),
    refs: strList(b, 'refs'),
    reviewAfter: str(b, 'reviewAfter', { max: 40 }),
    expiresAt: str(b, 'expiresAt', { max: 40 }),
    sessionId: str(b, 'sessionId', { max: 40 }),
    requestKey: str(b, 'requestKey'),
  })
}

const q = (v: string | null) => (v === null || v === '' ? undefined : v)

export const journalRoutes: Route[] = [
  route('POST /v1/brains/:slug/sessions', async (r) => {
    const b = obj(r.body)
    const s = await openSession(
      ctxOf(r),
      r.params.slug as string,
      compact({ purpose: str(b, 'purpose'), ref: str(b, 'ref'), forKey: str(b, 'forKey', { max: 40 }) }),
    )
    return { status: 201, body: { session: s } }
  }),
  route('GET /v1/brains/:slug/sessions', async (r) => ({
    body: await listSessions(
      ctxOf(r),
      r.params.slug as string,
      compact({ cursor: q(r.query.get('cursor')), limit: limitOf(r.query.get('limit')) }),
    ),
  })),
  // API only, not a tool: the reminder at the end of an agent's session asks it (spec B5 «El kit de
  // conexión»). An agent knows its own sessions; a program outside the agent does not.
  route('GET /v1/me/sessions', async (r) => ({ body: { items: await openSessionsOfKey(ctxOf(r)) } })),
  route('POST /v1/sessions/:id/summary', async (r) => {
    const b = obj(r.body)
    const receipt = await summarizeSession(
      ctxOf(r),
      r.params.id as string,
      compact({ title: str(b, 'title'), content: reqStr(b, 'content'), requestKey: str(b, 'requestKey') }),
    )
    return { status: 201, body: { receipt } }
  }),
  route('POST /v1/sessions/:id/end', async (r) => ({
    body: { session: await endSession(ctxOf(r), r.params.id as string) },
  })),
  route('POST /v1/brains/:slug/entries', async (r) => {
    const b = obj(r.body)
    const input: EntryInput = {
      type: reqStr(b, 'type', 40),
      ...entryFields(b),
      ...compact({ topic: str(b, 'topic') }),
    }
    return { status: 201, body: { receipt: await saveEntry(ctxOf(r), r.params.slug as string, input) } }
  }),
  route('POST /v1/brains/:slug/corrections/relay', async (r) => {
    const b = obj(r.body)
    const receipt = await relayCorrection(ctxOf(r), r.params.slug as string, {
      onBehalf: reqStr(b, 'onBehalf', 200),
      ...entryFields(b),
    })
    return { status: 201, body: { receipt } }
  }),
  route('POST /v1/brains/:slug/topics/suggest', async (r) => ({
    body: await suggestTopic(ctxOf(r), r.params.slug as string, reqStr(obj(r.body), 'title', LIMITS.title)),
  })),
  route('GET /v1/entries/:id', async (r) => ({
    body: await getEntry(ctxOf(r), r.params.id as string, { history: r.query.get('history') === '1' }),
  })),
  route('GET /v1/brains/:slug/entries', async (r) => ({
    body: await listEntries(
      ctxOf(r),
      r.params.slug as string,
      compact({
        ref: q(r.query.get('ref')),
        type: q(r.query.get('type')),
        sessionId: q(r.query.get('session')),
        cursor: q(r.query.get('cursor')),
        limit: limitOf(r.query.get('limit')),
      }),
    ),
  })),
]
