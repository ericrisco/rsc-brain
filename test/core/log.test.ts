// The service's log (spec B7 «Salud y registros», CA17; plan §3.11): one JSON line per event, with a closed
// list of fields that can hold no content — never entries, pages, searched text, keys, passwords or
// authorization headers. A field outside the list does not compile, and throws if forced.
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { failureFields, LOG_EVENTS, LOG_FIELDS, type LogFields, makeLog } from '../../src/core/log.ts'

const at = new Date('2026-11-01T10:00:00.000Z')
function capture() {
  const lines: string[] = []
  const log = makeLog(
    (line) => lines.push(line),
    () => at,
  )
  return { log, lines, json: () => lines.map((l) => JSON.parse(l) as Record<string, unknown>) }
}

describe('the log', () => {
  it('writes one JSON line per event: when, level, event and the fields given', () => {
    const c = capture()
    c.log.info('request', { method: 'GET', route: '/v1/brains/:slug/entries', status: 200, ms: 12 })
    c.log.warn('sweep_failed', { code: '57P01' })
    c.log.error('internal_error', { ref: 'k3x9a1', code: 'TypeError', file: 'src/domain/entries.ts:88' })
    assert.equal(c.lines.length, 3)
    for (const l of c.lines) assert.ok(!l.includes('\n'))
    assert.deepEqual(c.json(), [
      {
        at: at.toISOString(),
        level: 'info',
        event: 'request',
        method: 'GET',
        route: '/v1/brains/:slug/entries',
        status: 200,
        ms: 12,
      },
      { at: at.toISOString(), level: 'warn', event: 'sweep_failed', code: '57P01' },
      {
        at: at.toISOString(),
        level: 'error',
        event: 'internal_error',
        ref: 'k3x9a1',
        code: 'TypeError',
        file: 'src/domain/entries.ts:88',
      },
    ])
  })

  it('the list of fields is closed: one outside it does not compile and throws', () => {
    const c = capture()
    assert.deepEqual(
      [...LOG_FIELDS].sort(),
      ['code', 'count', 'file', 'method', 'ms', 'port', 'ref', 'route', 'status'].sort(),
    )
    for (const field of [
      'message',
      'query',
      'content',
      'authorization',
      'email',
      'password',
      'path',
      'stack',
    ]) {
      assert.throws(() => c.log.info('request', { [field]: 'x' } as LogFields), /not a log field/, field)
    }
    // @ts-expect-error a field outside the list does not compile
    assert.throws(() => c.log.info('request', { query: 'what someone searched' }))
    assert.equal(c.lines.length, 0, 'nothing was written')
  })

  it('so are the events', () => {
    const c = capture()
    assert.ok(LOG_EVENTS.includes('request') && LOG_EVENTS.includes('listening'))
    // @ts-expect-error an event outside the list does not compile
    assert.throws(() => c.log.info('saved: our secret plan', {}), /not a log event/)
    assert.equal(c.lines.length, 0)
  })

  it('each field holds only what it is for: numbers, a template, a code, a source file', () => {
    const c = capture()
    const bad: Array<Record<string, unknown>> = [
      { status: '200' },
      { status: 99 },
      { status: 600 },
      { ms: -1 },
      { ms: '5' },
      { count: 1.5 },
      { port: 70_000 },
      { method: 'GET /v1' },
      { method: 'get' },
      { route: '/v1/search?q=our secret plan' },
      { route: '/v1/brains/our secret plan' },
      { route: 'v1/brains' },
      { code: 'duplicate key value (title)=(our secret plan)' },
      { code: '' },
      { code: 'x'.repeat(65) },
      { file: '/Users/eric/our secret plan.md' },
      { file: 'src/a.ts:12 extra' },
      { ref: 'Bearer rscb_abc' },
    ]
    for (const fields of bad) {
      assert.throws(() => c.log.info('request', fields as LogFields), /log field/, JSON.stringify(fields))
    }
    assert.equal(c.lines.length, 0)
    c.log.info('request', { route: '/v1/brains/:slug/pages/*address', method: 'PATCH', status: 503, ms: 0 })
    c.log.info('listening', { port: 8090 })
    c.log.info('resealed', { count: 3 })
    c.log.error('internal_error', { code: '23505', file: 'src/http/routes/oauth.ts:17', ref: 'abc123' })
    assert.equal(c.lines.length, 4)
  })

  it('a field left undefined is left out', () => {
    const c = capture()
    c.log.info('request', { route: undefined, status: 404, ms: 1 })
    assert.deepEqual(Object.keys(c.json()[0] ?? {}), ['at', 'level', 'event', 'status', 'ms'])
  })

  it('a failure says its code and the first frame of src/, never anything from its message', () => {
    const e = new Error('saved src/our-secret-plan.ts:7 for later\nsrc/second-line.ts:9')
    e.stack = `Error: saved src/our-secret-plan.ts:7 for later\nsrc/second-line.ts:9\n    at save (file:///app/src/domain/entries.ts:88:5)\n    at run (node:internal/x:1:1)`
    assert.deepEqual(failureFields(e), { code: 'Error', file: 'src/domain/entries.ts:88' })
    const only = new Error('src/our-secret-plan.ts:7')
    only.stack = 'Error: src/our-secret-plan.ts:7\n    at x (node:internal/y:1:1)'
    assert.deepEqual(failureFields(only), { code: 'Error' })
    assert.deepEqual(failureFields(Object.assign(new Error('x'), { code: '23505' })).code, '23505')
    assert.deepEqual(failureFields({ code: 'duplicate key (title)=(plan)' }), { code: 'unknown' })
  })
})
