import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { readConfig } from '../../src/config.ts'

describe('configuration', () => {
  it('refuses an unknown time zone with the way out', () => {
    assert.throws(
      () => readConfig({ RSC_BRAIN_DATABASE_URL: 'postgres://x', RSC_BRAIN_TIMEZONE: 'Europe/Madird' }),
      /Europe\/Madrid or UTC/,
    )
  })
  it('defaults to UTC and port 8090 on 127.0.0.1', () => {
    const c = readConfig({ RSC_BRAIN_DATABASE_URL: 'postgres://x' })
    assert.deepEqual([c.timezone, c.port, c.host], ['UTC', 8090, '127.0.0.1'])
  })
  it('needs the database URL', () => {
    assert.throws(() => readConfig({}), /RSC_BRAIN_DATABASE_URL/)
  })
})
