import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { type Action, type Actor, can, minRole, type Role } from '../../src/auth/can.ts'

const person = (o: Partial<Actor> = {}, perm: 'read' | 'write' = 'write'): Actor => ({
  kind: 'person',
  isAdmin: false,
  canCreateBrains: false,
  credential: { kind: 'token', perm },
  ...o,
})
const service = (kind: 'main' | 'short' = 'main'): Actor => ({
  kind: 'service',
  isAdmin: false,
  canCreateBrains: true,
  credential: { kind, perm: 'write' },
})

describe('can()', () => {
  it('every refusal says why and how to proceed', () => {
    const actions: Action[] = [
      'brain.create',
      'brain.read',
      'brain.archive',
      'brain.delete',
      'journal.write',
      'entry.edit',
      'entry.forget',
      'entry.pin',
      'entry.purge',
      'relation.write',
      'correction.relay',
      'key.short',
    ]
    for (const a of actions) {
      for (const actor of [person(), person({}, 'read'), service(), service('short')]) {
        for (const role of [null, 'reader', 'contributor', 'curator'] as (Role | null)[]) {
          const d = can(actor, a, { role, brainStatus: 'active', onBehalfRole: null })
          if (!d.ok) {
            assert.ok(d.reason.length > 0, `${a}: reason`)
            assert.ok(d.howToProceed.length > 0, `${a}: howToProceed`)
          }
        }
      }
    }
  })

  it('a read-only key reads and never writes', () => {
    const ro = person({ isAdmin: true, canCreateBrains: true }, 'read')
    assert.equal(can(ro, 'brain.read', { role: 'curator' }).ok, true)
    for (const a of [
      'brain.create',
      'journal.write',
      'entry.pin',
      'brain.delete',
      'entry.purge',
    ] as Action[]) {
      assert.equal(can(ro, a, { role: 'curator', brainStatus: 'active' }).ok, false, a)
    }
  })

  it('writing in the journal needs contributor and an active brain', () => {
    assert.equal(can(person(), 'journal.write', { role: 'reader', brainStatus: 'active' }).ok, false)
    assert.equal(can(person(), 'journal.write', { role: 'contributor', brainStatus: 'active' }).ok, true)
    const archived = can(person(), 'journal.write', { role: 'curator', brainStatus: 'archived' })
    assert.equal(archived.ok, false)
    assert.match(archived.ok ? '' : archived.howToProceed, /unarchive/)
  })

  it('only the author or a curator changes an entry', () => {
    assert.equal(
      can(person(), 'entry.edit', { role: 'contributor', isOwner: false, brainStatus: 'active' }).ok,
      false,
    )
    assert.equal(
      can(person(), 'entry.edit', { role: 'contributor', isOwner: true, brainStatus: 'active' }).ok,
      true,
    )
    assert.equal(
      can(person(), 'entry.forget', { role: 'curator', isOwner: false, brainStatus: 'active' }).ok,
      true,
    )
    assert.equal(
      can(person(), 'entry.edit', { role: 'reader', isOwner: true, brainStatus: 'active' }).ok,
      false,
    )
  })

  it('pinning is for curators', () => {
    assert.equal(can(person(), 'entry.pin', { role: 'contributor', brainStatus: 'active' }).ok, false)
    assert.equal(can(person(), 'entry.pin', { role: 'curator', brainStatus: 'active' }).ok, true)
  })

  it('purge and delete are for the administration, as a person', () => {
    assert.equal(can(person({ isAdmin: true }), 'entry.purge').ok, true)
    assert.equal(can(person(), 'entry.purge').ok, false)
    assert.equal(can(person({ isAdmin: true }), 'brain.delete').ok, true)
    assert.equal(can(service(), 'brain.delete').ok, false)
  })

  it('corrections: never from an agent key; a service main key relays for a contributor or more', () => {
    assert.equal(can(person(), 'correction.relay', { role: 'curator', onBehalfRole: 'curator' }).ok, false)
    assert.equal(
      can(service('short'), 'correction.relay', { role: 'contributor', onBehalfRole: 'curator' }).ok,
      false,
    )
    const r = can(service(), 'correction.relay', {
      role: 'contributor',
      brainStatus: 'active',
      onBehalfRole: 'reader',
    })
    assert.equal(r.ok, false)
    assert.equal(
      can(service(), 'correction.relay', {
        role: 'contributor',
        brainStatus: 'active',
        onBehalfRole: 'contributor',
      }).ok,
      true,
    )
    assert.equal(
      can(service(), 'correction.relay', { role: 'reader', brainStatus: 'active', onBehalfRole: 'curator' })
        .ok,
      false,
    )
  })

  it('short keys: only a main key mints them, and they cannot create brains', () => {
    assert.equal(can(service(), 'key.short').ok, true)
    assert.equal(can(service('short'), 'key.short').ok, false)
    assert.equal(can(person({ isAdmin: true }), 'key.short').ok, false)
    assert.equal(can(service('short'), 'brain.create').ok, false)
  })

  it('creating brains needs the permission or the administration', () => {
    assert.equal(can(person(), 'brain.create').ok, false)
    assert.equal(can(person({ canCreateBrains: true }), 'brain.create').ok, true)
    assert.equal(can(person({ isAdmin: true }), 'brain.create').ok, true)
  })

  it('minRole takes the narrower one', () => {
    assert.equal(minRole('curator', 'reader'), 'reader')
    assert.equal(minRole(null, 'reader'), null)
    assert.equal(minRole('contributor', 'curator'), 'contributor')
  })
})
