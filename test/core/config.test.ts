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
  it('copies: daily at 03:00, 14 kept, unless RSC_BRAIN_BACKUP_AT and RSC_BRAIN_BACKUP_KEEP say otherwise', () => {
    const c = readConfig({ RSC_BRAIN_DATABASE_URL: 'postgres://x' })
    assert.deepEqual([c.backupAt, c.backupKeep], ['03:00', 14])
    const d = readConfig({
      RSC_BRAIN_DATABASE_URL: 'postgres://x',
      RSC_BRAIN_BACKUP_AT: '22:15',
      RSC_BRAIN_BACKUP_KEEP: '30',
    })
    assert.deepEqual([d.backupAt, d.backupKeep], ['22:15', 30])
  })
  it('refuses a time that is not HH:MM and a number of copies outside 1..365, with the way out', () => {
    assert.throws(
      () => readConfig({ RSC_BRAIN_DATABASE_URL: 'postgres://x', RSC_BRAIN_BACKUP_AT: '3am' }),
      /RSC_BRAIN_BACKUP_AT must be HH:MM/,
    )
    for (const keep of ['0', '366', '1.5', 'many']) {
      assert.throws(
        () => readConfig({ RSC_BRAIN_DATABASE_URL: 'postgres://x', RSC_BRAIN_BACKUP_KEEP: keep }),
        /RSC_BRAIN_BACKUP_KEEP must be a whole number from 1 to 365/,
      )
    }
  })
})
