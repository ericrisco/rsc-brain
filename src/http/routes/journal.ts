import { invalid } from '../../core/errors.ts'
import {
  addCorrection,
  type EntryInput,
  getEntry,
  LIMITS,
  relayCorrection,
  saveEntry,
  suggestTopic,
  summarizeSession,
} from '../../domain/entries.ts'
import { limitOf, listEntries, listSessions, sessionView } from '../../domain/listing.ts'
import { endSession, openSession, openSessionsOfKey } from '../../domain/sessions.ts'
import { compact, day, flag, type Obj, obj, reqStr, str, strList, upTo } from '../input.ts'
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
  // Filters (spec B6 «Journal › Sessions», plan G12); dates are UTC days or ISO instants.
  route('GET /v1/brains/:slug/sessions', async (r) => {
    const uncompiled = r.query.get('uncompiled')
    if (uncompiled !== null && uncompiled !== '' && !['1', 'true', '0', 'false'].includes(uncompiled))
      throw invalid(
        '"uncompiled" is 1 or 0.',
        'Send uncompiled=1 for sessions with entries still to compile.',
      )
    const agents = r.query.get('agents')
    if (agents !== null && agents !== '' && !['1', 'true', '0', 'false'].includes(agents))
      throw invalid('"agents" is 1 or 0.', 'Send agents=1 for the sessions of agents and services only.')
    return {
      body: await listSessions(
        ctxOf(r),
        r.params.slug as string,
        compact({
          status: q(r.query.get('status')),
          client: q(r.query.get('client')),
          author: q(r.query.get('author')),
          ref: q(r.query.get('ref')),
          type: q(r.query.get('type')),
          from: day(r.query.get('from'), 'from'),
          ...upTo(day(r.query.get('to'), 'to'), r.query.get('to')),
          uncompiled: flag(uncompiled) || undefined,
          agents: flag(agents) || undefined,
          cursor: q(r.query.get('cursor')),
          limit: limitOf(r.query.get('limit')),
        }),
      ),
    }
  }),
  route('GET /v1/sessions/:id', async (r) => ({
    body: { session: await sessionView(ctxOf(r), r.params.id as string) },
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
  // A person's correction, from the web (spec B6 «Add a correction»); keys are refused (spec B1).
  route('POST /v1/brains/:slug/corrections', async (r) => {
    const b = obj(r.body)
    const receipt = await addCorrection(
      ctxOf(r),
      r.params.slug as string,
      compact({
        title: reqStr(b, 'title'),
        content: reqStr(b, 'content'),
        appliesTo: str(b, 'appliesTo'),
        page: str(b, 'page', { max: 200 }),
        entry: str(b, 'entry', { max: 40 }),
        requestKey: str(b, 'requestKey'),
      }),
    )
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
        about: q(r.query.get('about')),
        since: day(r.query.get('since'), 'since'),
        cursor: q(r.query.get('cursor')),
        limit: limitOf(r.query.get('limit')),
      }),
    ),
  })),
]
