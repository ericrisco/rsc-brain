// Review of PR31: an export is something looked at, like a search or a read: the brain's curators and whoever
// exported see it in the activity; nobody else does.
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { visibleTo } from '../../src/domain/events.ts'

describe('who sees that a brain was exported', () => {
  const e = { kind: 'brain.exported', accountId: 'acc_eric', credentialId: 'crd_eric' }
  it('its curators and whoever exported; not a reader or a contributor', () => {
    assert.equal(
      visibleTo({ curator: true, accountId: 'acc_ana', credentialId: 'crd_ana', short: false }, e),
      true,
    )
    assert.equal(
      visibleTo({ curator: false, accountId: 'acc_eric', credentialId: 'crd_x', short: false }, e),
      true,
    )
    assert.equal(
      visibleTo({ curator: false, accountId: 'acc_rita', credentialId: 'crd_rita', short: false }, e),
      false,
    )
  })
})
