// The rate limiter forgets keys that made no request for a minute, so its memory does not grow with
// old keys; a key still inside its minute keeps its count through that sweep (spec B5 CA14).
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { rateLimiter } from '../../src/http/ratelimit.ts'

describe('the rate limiter in memory', () => {
  it('the sweep of old keys does not reset a key still inside its minute', () => {
    let now = 0
    const limiter = rateLimiter(() => new Date(now))
    limiter.take('busy', 2)
    limiter.take('busy', 2)
    // Many other keys, enough to set off the sweep, 59 s later.
    now = 59_000
    for (let i = 0; i < 1000; i += 1) limiter.take(`other-${i}`, 2)
    assert.throws(
      () => limiter.take('busy', 2),
      (e: { code: string; extra: { retryAfter: number } }) =>
        e.code === 'rate_limited' && e.extra.retryAfter === 1,
    )
    now = 60_000
    limiter.take('busy', 2)
  })

  it('a key forgotten by the sweep starts afresh', () => {
    let now = 0
    const limiter = rateLimiter(() => new Date(now))
    limiter.take('old', 1)
    now = 61_000
    for (let i = 0; i < 1000; i += 1) limiter.take(`other-${i}`, 1)
    limiter.take('old', 1)
    assert.throws(() => limiter.take('old', 1))
  })
})
