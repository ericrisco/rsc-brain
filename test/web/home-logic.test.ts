// The logic behind Home, the overview and inviting people (spec B6 «Home», «Overview», «Admin › people»),
// kept out of the screens so it is tested on its own (plan §2: the .tsx files only paint).
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { TODAY_SESSIONS } from '../../src/domain/overview.ts'
import { ago, clientLabel, slugOf, TODAY_SHOWN, todayCapped, toReview } from '../../web/src/lib/brains.ts'
import { emailsOf, firstPersonAlone } from '../../web/src/lib/people.ts'

// PR26: the overview shows the newest sessions of today, as many as the server sends; at that many there
// may be more, and the overview leads to the journal for the rest.
describe("today's sessions", () => {
  it('the web knows how many the server sends at most', () => {
    assert.equal(TODAY_SHOWN, TODAY_SESSIONS)
  })
  it('at the cap there may be more; under it, the list is whole', () => {
    assert.equal(todayCapped(TODAY_SESSIONS), true)
    assert.equal(todayCapped(TODAY_SESSIONS - 1), false)
    assert.equal(todayCapped(0), false)
  })
})

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
    assert.deepEqual(toReview([b('a', 'curator', 2), b('b', 'reader', 5)]), {
      count: 2,
      href: '/b/a/proposals',
    })
    // The final review of B6: with several waiting, the count leads to the first brain with proposals.
    assert.deepEqual(toReview([b('a', 'curator', 2), b('c', 'curator', 1)]), {
      count: 3,
      href: '/b/a/proposals',
    })
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

// Review of PR18: a session names its client the way a person says it, never a raw user agent.
describe('the client of a session, in words', () => {
  it('known agents by name; programs and browsers by what they are; nothing when unknown', () => {
    assert.equal(clientLabel('Claude Code'), 'Claude Code')
    assert.equal(clientLabel('claude-code/2.1.4 (cli)'), 'Claude Code')
    assert.equal(clientLabel('codex_cli_rs/0.40.0 (Mac OS 15.1; arm64)'), 'Codex')
    assert.equal(clientLabel('Cursor/1.7.2'), 'Cursor')
    assert.equal(clientLabel('curl/8.7.1'), 'an API client')
    assert.equal(clientLabel('python-requests/2.32.3'), 'an API client')
    assert.equal(clientLabel('node'), 'an API client')
    assert.equal(
      clientLabel('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/141.0'),
      'a browser',
    )
    assert.equal(clientLabel('web'), 'the web')
    assert.equal(clientLabel('Lena agent/0.3'), 'Lena agent')
    assert.equal(clientLabel(null), null)
    assert.equal(clientLabel(''), null)
    assert.ok((clientLabel('x'.repeat(200)) ?? '').length <= 40)
  })
})

// The final review of B6: links for several people are «them», shown once each.
describe('the words when invitation links are ready', () => {
  it('one link is «it»; several are «them»', async () => {
    const { T } = await import('../../web/src/text.ts')
    assert.equal(
      T.people.linkReady(['ana@x.test']),
      'Link for ana@x.test is ready: copy it now, it is shown only once.',
    )
    assert.equal(
      T.people.linkReady(['ana@x.test', 'bo@x.test']),
      'Links for ana@x.test, bo@x.test are ready: copy them now, each is shown only once.',
    )
  })
})
