import { invalid } from '../../core/errors.ts'
import {
  editEntry,
  forgetEntry,
  pinEntry,
  purgeEntry,
  recoverEntry,
  scheduleEntry,
} from '../../domain/curation.ts'
import { around, limitOf, listView, type View } from '../../domain/listing.ts'
import { conflicts, relate } from '../../domain/relations.ts'
import { type Include, search } from '../../domain/search.ts'
import { CONTEXT, startContext } from '../../domain/startup.ts'
import { compact, int, type Obj, obj, reqStr, str, strList } from '../input.ts'
import { type Route, route } from '../router.ts'
import { ctxOf } from './brains.ts'

const q = (v: string | null) => (v === null || v === '' ? undefined : v)

// A date field that may be null to clear it.
function nullableDate(b: Obj, key: string): string | null | undefined {
  if (!(key in b)) return undefined
  if (b[key] === null) return null
  return str(b, key, { max: 40 })
}

const INCLUDES: Include[] = ['forgotten', 'superseded', 'expired']

export const recallRoutes: Route[] = [
  route('PATCH /v1/entries/:id', async (r) => {
    const b = obj(r.body)
    const entry = await editEntry(
      ctxOf(r),
      r.params.id as string,
      compact({
        baseRevision: int(b, 'baseRevision', { required: true, min: 1 }) as number,
        type: str(b, 'type', { max: 40 }),
        title: str(b, 'title'),
        content: str(b, 'content'),
        appliesTo: b.appliesTo === null ? null : str(b, 'appliesTo'),
        tags: strList(b, 'tags'),
        refs: strList(b, 'refs'),
      }),
    )
    return { body: { entry } }
  }),
  route('POST /v1/entries/:id/forget', async (r) => ({
    body: { entry: await forgetEntry(ctxOf(r), r.params.id as string, reqStr(obj(r.body), 'reason')) },
  })),
  route('POST /v1/entries/:id/recover', async (r) => ({
    body: { entry: await recoverEntry(ctxOf(r), r.params.id as string) },
  })),
  route('POST /v1/entries/:id/pin', async (r) => ({
    body: { entry: await pinEntry(ctxOf(r), r.params.id as string, true) },
  })),
  route('POST /v1/entries/:id/unpin', async (r) => ({
    body: { entry: await pinEntry(ctxOf(r), r.params.id as string, false) },
  })),
  route('POST /v1/entries/:id/schedule', async (r) => {
    const b = obj(r.body)
    const s = compact({
      reviewAfter: nullableDate(b, 'reviewAfter'),
      expiresAt: nullableDate(b, 'expiresAt'),
    })
    return { body: { entry: await scheduleEntry(ctxOf(r), r.params.id as string, s) } }
  }),
  route('POST /v1/entries/:id/purge', async (r) => ({
    body: await purgeEntry(ctxOf(r), r.params.id as string, reqStr(obj(r.body), 'reason')),
  })),
  route('GET /v1/entries/:id/around', async (r) => {
    const n = r.query.get('n') ? Number(r.query.get('n')) : 5
    if (!Number.isInteger(n) || n < 1 || n > 50)
      throw invalid('"n" must be between 1 and 50.', 'Ask for fewer.')
    return { body: await around(ctxOf(r), r.params.id as string, n) }
  }),
  route('POST /v1/brains/:slug/relations', async (r) => {
    const b = obj(r.body)
    const rel = await relate(ctxOf(r), r.params.slug as string, {
      from: reqStr(b, 'from', 40),
      to: reqStr(b, 'to', 40),
      kind: reqStr(b, 'kind', 40),
      ...compact({ reason: str(b, 'reason') }),
    })
    return { status: 201, body: { relation: rel } }
  }),
  route('GET /v1/brains/:slug/conflicts', async (r) => ({
    body: { conflicts: await conflicts(ctxOf(r), r.params.slug as string) },
  })),
  ...(['forgotten', 'to-review', 'uncompiled'] as View[]).map((view) =>
    route(`GET /v1/brains/:slug/${view}`, async (r) => ({
      body: await listView(ctxOf(r), r.params.slug as string, view, { limit: limitOf(r.query.get('limit')) }),
    })),
  ),
  route('GET /v1/search', async (r) => {
    const include = (q(r.query.get('include'))?.split(',') ?? []).map((s) => s.trim())
    const bad = include.find((i) => !(INCLUDES as string[]).includes(i))
    if (bad) throw invalid(`Unknown "include" value "${bad}".`, `Use any of: ${INCLUDES.join(', ')}.`)
    const brains = q(r.query.get('brains'))
    const offset = r.query.get('offset') ? Number(r.query.get('offset')) : 0
    if (!Number.isInteger(offset) || offset < 0)
      throw invalid('"offset" must be 0 or more.', 'Use the "next" value.')
    const limit = r.query.get('limit') ? Number(r.query.get('limit')) : 10
    if (!Number.isInteger(limit) || limit < 1 || limit > 50)
      throw invalid('"limit" must be between 1 and 50.', 'Ask for fewer.')
    return {
      body: await search(
        ctxOf(r),
        compact({
          q: r.query.get('q') ?? '',
          brains: brains && brains !== 'all' ? brains.split(',').map((s) => s.trim()) : undefined,
          include: include as Include[],
          type: q(r.query.get('type')),
          limit,
          offset,
        }),
      ),
    }
  }),
  route('GET /v1/brains/:slug/context', async (r) => {
    const max = r.query.get('max') ? Number(r.query.get('max')) : CONTEXT.default
    if (!Number.isSafeInteger(max))
      throw invalid('"max" must be a whole number of characters.', `Use ${CONTEXT.min} to ${CONTEXT.max}.`)
    return {
      body: await startContext(
        ctxOf(r),
        r.params.slug as string,
        compact({
          task: q(r.query.get('task')),
          agent: q(r.query.get('agent')),
          max,
          ref: q(r.query.get('ref')),
        }),
      ),
    }
  }),
]
