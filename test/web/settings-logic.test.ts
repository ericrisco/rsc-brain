// The logic behind a brain's settings and the administration of people and service accounts (spec B6
// «Settings de un cerebro», «Admin»; B6 PR25a), kept out of the screens so it is tested on its own.
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { repoKey as serverRepoKey } from '../../src/domain/repos.ts'
import {
  type AdminAccount,
  fieldDrafts,
  memberRows,
  peopleRows,
  refsLabel,
  repoKey,
  rolesLabel,
  type SettingsRead,
  serviceRows,
  settingsSave,
  textDrafts,
  thresholdProblems,
} from '../../web/src/lib/settings.ts'

describe('repository addresses, as brain_resolve matches them', () => {
  const cases = [
    'https://github.com/Org/Repo.git',
    'git@github.com:org/repo',
    'ssh://git@github.com:22/org/repo/',
    'https://user@gitlab.example.com:8443/team/sub/app',
    'git@host:2024/app',
    'http://example.com/a/b?x=1#y',
    'github.com/org/repo',
    '/Users/eric/code/repo',
    '~/code/repo',
    'not a repo',
    '',
    '   ',
    'https://github.com/../etc',
    'git+ssh://git@github.com:22/org/repo.git',
    // Fixes of PR25a: relative paths and a bare org/repo name no host; git:// on its own port; case.
    './app',
    '../app',
    'org/repo',
    'gitserver/team/app',
    'localhost/team/app',
    'git@gitserver:team/app',
    'git://host.example:9418/A/b.git/',
    'git://host.example:9419/a/b',
    'GIT@GitHub.com:Org/Repo.git/',
    'ssh://git@host.example/a/b//',
  ]
  for (const c of cases) {
    it(`the web reads "${c}" exactly as the server does`, () => {
      assert.equal(repoKey(c), serverRepoKey(c))
    })
  }
})

describe('members of a brain', () => {
  const m = (accountId: string, role: string, kind = 'person') => ({
    accountId,
    kind,
    name: accountId.toUpperCase(),
    email: `${accountId}@x.test`,
    role,
  })
  it('the only curator cannot be demoted or removed, and the screen says why', () => {
    const rows = memberRows([m('a', 'curator'), m('b', 'reader')], 'b')
    const a = rows.find((r) => r.accountId === 'a')
    assert.equal(a?.lastCurator, true)
    assert.equal(rows.find((r) => r.accountId === 'b')?.lastCurator, false)
    assert.equal(rows.find((r) => r.accountId === 'b')?.you, true)
  })
  it('with two curators, neither is the last', () => {
    const rows = memberRows([m('a', 'curator'), m('c', 'curator')], 'a')
    assert.deepEqual(
      rows.map((r) => r.lastCurator),
      [false, false],
    )
  })
  it('a service account is never offered the curator role', () => {
    const rows = memberRows([m('a', 'curator'), m('s', 'contributor', 'service')], 'a')
    assert.deepEqual(rows.find((r) => r.accountId === 's')?.roles, ['reader', 'contributor'])
    assert.deepEqual(rows.find((r) => r.accountId === 'a')?.roles, ['reader', 'contributor', 'curator'])
  })
})

describe('health thresholds', () => {
  it('accepts the ranges the server accepts and names each field out of them', () => {
    assert.deepEqual(thresholdProblems({ staleDays: '90', longChars: '20000', maintenanceEvery: '20' }), {})
    const p = thresholdProblems({ staleDays: '0', longChars: '999', maintenanceEvery: '1001' })
    assert.deepEqual(Object.keys(p).sort(), ['longChars', 'maintenanceEvery', 'staleDays'])
    // The bounds themselves are in.
    assert.deepEqual(
      thresholdProblems({ staleDays: '3650', longChars: '100000', maintenanceEvery: '1000' }),
      {},
    )
    assert.deepEqual(thresholdProblems({ staleDays: '1', longChars: '1000', maintenanceEvery: '1' }), {})
    assert.deepEqual(
      Object.keys(thresholdProblems({ staleDays: '3651', longChars: '100001', maintenanceEvery: '1001' }))
        .length,
      3,
    )
    assert.match(String(p.staleDays), /1 to 3650/)
    assert.deepEqual(
      Object.keys(thresholdProblems({ staleDays: '1.5', longChars: 'x', maintenanceEvery: '' })).sort(),
      ['longChars', 'maintenanceEvery', 'staleDays'],
    )
  })
})

describe('what a save sends: only the fields changed, each with the value it was based on', () => {
  const read: SettingsRead = {
    guide: 'Default guide.',
    guideDefault: 'Default guide.',
    customGuide: false,
    usageNote: '',
    usageNoteDefault: '',
    meaningExcluded: false,
    staleDays: 90,
    longChars: 20000,
    maintenanceEvery: 20,
  }
  it('nothing changed still sends the base of what the part shows: the server compares it', () => {
    assert.deepEqual(settingsSave(read, { guide: 'Default guide.' }), { base: { guide: null } })
  })
  it('a custom guide goes with the base it was written on (null while the default)', () => {
    assert.deepEqual(settingsSave(read, { guide: 'Ours.' }), { guide: 'Ours.', base: { guide: null } })
    const custom = { ...read, guide: 'Ours.', customGuide: true }
    assert.deepEqual(settingsSave(custom, { guide: '' }), { guide: null, base: { guide: 'Ours.' } })
    assert.deepEqual(settingsSave(custom, { guide: '  Default guide.\n' }), {
      guide: null,
      base: { guide: 'Ours.' },
    })
  })
  it('the usage note goes trimmed, with its base', () => {
    assert.deepEqual(settingsSave(read, { usageNote: '  Use ticket ids. ' }), {
      usageNote: 'Use ticket ids.',
      base: { usageNote: '' },
    })
  })
  it('thresholds: only those that changed, as numbers', () => {
    assert.deepEqual(settingsSave(read, { staleDays: 30, longChars: 20000, maintenanceEvery: 20 }), {
      staleDays: 30,
      base: { staleDays: 90, longChars: 20000, maintenanceEvery: 20 },
    })
    assert.deepEqual(settingsSave(read, { staleDays: 90, longChars: 20000, maintenanceEvery: 20 }), {
      base: { staleDays: 90, longChars: 20000, maintenanceEvery: 20 },
    })
  })
})

describe('unsaved fields of the settings live in memory only', () => {
  it('any field, kept by account, brain and field, until saved or signed out', () => {
    fieldDrafts.set('acc_a', 'growth', 'staleDays', '33')
    assert.equal(fieldDrafts.get('acc_a', 'growth', 'staleDays'), '33')
    assert.equal(fieldDrafts.get('acc_b', 'growth', 'staleDays'), undefined)
    fieldDrafts.clearAll()
    assert.equal(fieldDrafts.get('acc_a', 'growth', 'staleDays'), undefined)
  })
})

describe('drafts of the settings texts live in memory only', () => {
  it('kept by account, brain and part; cleared one by one and all at sign-out', () => {
    textDrafts.set('acc_a', 'growth', 'guide', 'secret pasted')
    textDrafts.set('acc_b', 'growth', 'guide', 'other')
    assert.equal(textDrafts.get('acc_a', 'growth', 'guide'), 'secret pasted')
    assert.equal(textDrafts.get('acc_a', 'growth', 'usage'), undefined)
    textDrafts.clear('acc_a', 'growth', 'guide')
    assert.equal(textDrafts.get('acc_a', 'growth', 'guide'), undefined)
    textDrafts.clearAll()
    assert.equal(textDrafts.get('acc_b', 'growth', 'guide'), undefined)
  })
})

describe('the administration', () => {
  const acc = (o: Partial<AdminAccount> & { id: string }): AdminAccount => ({
    kind: 'person',
    name: o.id,
    email: `${o.id}@x.test`,
    isAdmin: false,
    canCreateBrains: false,
    status: 'active',
    brains: 0,
    roles: [],
    lastSeenAt: null,
    createdAt: '2026-10-01T10:00:00.000Z',
    ...o,
  })
  it('people only, active first; the last active administrator is marked', () => {
    const rows = peopleRows([
      acc({ id: 'zed', status: 'removed', isAdmin: true }),
      acc({ id: 'eric', isAdmin: true }),
      acc({ id: 'ana' }),
      acc({ id: 'svc', kind: 'service' }),
    ])
    assert.deepEqual(
      rows.map((r) => r.id),
      ['ana', 'eric', 'zed'],
    )
    assert.equal(rows.find((r) => r.id === 'eric')?.lastAdmin, true)
    assert.equal(rows.find((r) => r.id === 'ana')?.lastAdmin, false)
  })
  it('with two active administrators, neither is the last', () => {
    const rows = peopleRows([acc({ id: 'a', isAdmin: true }), acc({ id: 'b', isAdmin: true })])
    assert.deepEqual(
      rows.map((r) => r.lastAdmin),
      [false, false],
    )
  })
  it('names each role in each brain, or says there is none', () => {
    assert.equal(rolesLabel([]), 'No brains yet')
    assert.equal(
      rolesLabel([
        { slug: 'growth', name: 'Growth', role: 'curator' },
        { slug: 'support', name: 'Support', role: 'reader' },
      ]),
      'Growth (curator) · Support (reader)',
    )
  })
  it('service accounts only, active first', () => {
    const rows = serviceRows([
      acc({ id: 'b', kind: 'service', status: 'removed' }),
      acc({ id: 'a', kind: 'service' }),
      acc({ id: 'p' }),
    ])
    assert.deepEqual(
      rows.map((r) => r.id),
      ['a', 'b'],
    )
  })
  it('says how many short keys are live and from which references', () => {
    assert.equal(refsLabel(0, []), 'No short keys live')
    assert.equal(refsLabel(1, ['run r_1']), '1 short key live: run r_1')
    assert.equal(refsLabel(3, ['run r_1', 'run r_2']), '3 short keys live: run r_1, run r_2')
    const many = Array.from({ length: 20 }, (_, i) => `r_${i}`)
    assert.match(refsLabel(40, many), /^40 short keys live: r_0, r_1, r_2, r_3, r_4 and 15 more$/)
  })
})

describe('«you removed your own administrator rights»: set only by a change that went through, said once', () => {
  it('a refused change, someone else, or a grant sets nothing; my own removal that went through does', async () => {
    const { leftAdmin, rightsChanged, takeLeftAdmin } = await import('../../web/src/lib/flags.ts')
    leftAdmin.value = false
    rightsChanged({ ok: false, self: true, body: { isAdmin: false } })
    assert.equal(leftAdmin.value, false)
    rightsChanged({ ok: true, self: false, body: { isAdmin: false } })
    assert.equal(leftAdmin.value, false)
    rightsChanged({ ok: true, self: true, body: { isAdmin: true } })
    assert.equal(leftAdmin.value, false)
    rightsChanged({ ok: true, self: true, body: { isAdmin: false } })
    assert.equal(leftAdmin.value, true)
    assert.equal(takeLeftAdmin(), true)
    assert.equal(takeLeftAdmin(), false)
    assert.equal(leftAdmin.value, false)
  })
})
