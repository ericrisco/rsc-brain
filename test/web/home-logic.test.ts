// The logic behind Home, the overview and inviting people (spec B6 «Home», «Overview», «Admin › people»),
// kept out of the screens so it is tested on its own (plan §2: the .tsx files only paint).
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { ago, slugOf, toReview } from '../../web/src/lib/brains.ts'
import { emailsOf, firstPersonAlone } from '../../web/src/lib/people.ts'

describe('a brain address from its name', () => {
  it('lowercase words joined by single hyphens, as the server accepts', () => {
    assert.equal(slugOf('Growth'), 'growth')
    assert.equal(slugOf('  YouTube channel!  '), 'youtube-channel')
    assert.equal(slugOf('Café & Ops -- 2026'), 'cafe-ops-2026')
    assert.equal(slugOf('ñ'), 'n')
    assert.equal(slugOf('***'), '')
    assert.equal(slugOf('a'.repeat(80)).length, 64)
    assert.match(slugOf(`${'a'.repeat(63)} b`), /^[a-z0-9]+(-[a-z0-9]+)*$/)
  })
})

describe('what waits for me', () => {
  const b = (slug: string, role: string, pending: number) => ({
    slug,
    name: slug,
    role,
    stats: { pendingProposals: pending },
  })
  it('counts the proposals of the brains I curate, and leads to the one brain when only one waits', () => {
    assert.deepEqual(toReview([b('a', 'curator', 2), b('b', 'reader', 5)]), { count: 2, href: '/b/a' })
    assert.deepEqual(toReview([b('a', 'curator', 2), b('c', 'curator', 1)]), { count: 3, href: '/' })
    assert.deepEqual(toReview([b('a', 'contributor', 4)]), { count: 0, href: '/' })
    assert.deepEqual(toReview([]), { count: 0, href: '/' })
  })
})

describe('when something last happened', () => {
  const now = new Date('2026-10-30T12:00:00Z')
  it('says it in words a person reads at a glance', () => {
    assert.equal(ago(null, now), null)
    assert.equal(ago('2026-10-30T11:59:40Z', now), 'just now')
    assert.equal(ago('2026-10-30T11:55:00Z', now), '5 min ago')
    assert.equal(ago('2026-10-30T09:00:00Z', now), '3 h ago')
    assert.equal(ago('2026-10-29T09:00:00Z', now), 'yesterday')
    assert.equal(ago('2026-10-25T12:00:00Z', now), '5 days ago')
    assert.equal(ago('2026-08-01T12:00:00Z', now), '1 Aug 2026')
    // A clock a little ahead on the server is still "just now".
    assert.equal(ago('2026-10-30T12:00:20Z', now), 'just now')
  })
})

describe('the emails of an invitation', () => {
  it('takes one or many, separated by commas, semicolons, spaces or lines, once each', () => {
    assert.deepEqual(emailsOf('ana@example.com'), { emails: ['ana@example.com'], bad: [] })
    assert.deepEqual(emailsOf(' Ana@Example.com,  bo@example.com;\nana@example.com '), {
      emails: ['ana@example.com', 'bo@example.com'],
      bad: [],
    })
    assert.deepEqual(emailsOf('ana@example.com, not-an-email'), {
      emails: ['ana@example.com'],
      bad: ['not-an-email'],
    })
    assert.deepEqual(emailsOf('   '), { emails: [], bad: [] })
  })
  it('accepts a pasted "Name <email>" as the email', () => {
    assert.deepEqual(emailsOf('Ana Ruiz <ana@example.com>, bo@example.com').emails, [
      'ana@example.com',
      'bo@example.com',
    ])
  })
})

describe('the "invite people" panel of an administrator', () => {
  const person = (id: string, status = 'active') => ({ id, kind: 'person', status })
  it('shows until a second person is in the installation', () => {
    assert.equal(firstPersonAlone([person('me')]), true)
    assert.equal(firstPersonAlone([person('me'), { id: 's', kind: 'service', status: 'active' }]), true)
    assert.equal(firstPersonAlone([person('me'), person('old', 'removed')]), true)
    assert.equal(firstPersonAlone([person('me'), person('ana')]), false)
  })
})
