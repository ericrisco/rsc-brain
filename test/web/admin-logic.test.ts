// The logic behind the rest of the administration (spec B6 «Admin»: Email, Meaning search, Limits, Audit,
// Backups & system, Branding; B6 PR25b), kept out of the screens so it is tested on its own: what a save
// sends (each field on what was read), what a field says before anything is sent, how the audit's filters
// become the view's query and the download's address (the same rows), and how secrets are named.
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { factoryUrlOf as serverFactoryUrl } from '../../src/domain/installation.ts'
import {
  auditExportHref,
  auditQuery,
  factoryProblem,
  type InstallationRead,
  installationSave,
  logoProblem,
  type MailBase,
  mailProblems,
  mailSave,
  progressLabel,
  rateProblem,
  secretLabel,
} from '../../web/src/lib/admin.ts'

const READ: InstallationRead = {
  name: 'Acme',
  publicUrl: 'https://brain.example.com',
  curatorsInvite: false,
  rateLimit: 600,
  rateLimitDefault: 600,
  rateLimitMin: 60,
  rateLimitMax: 10000,
  factoryUrl: null,
}

describe('installation settings: each field saved on what was read', () => {
  it('sends the base of the fields the part shows, and only the fields that changed', () => {
    assert.deepEqual(installationSave(READ, { rateLimit: 900 }), { base: { rateLimit: 600 }, rateLimit: 900 })
    assert.deepEqual(installationSave(READ, { name: ' Acme ', factoryUrl: 'https://f.example.com' }), {
      base: { name: 'Acme', factoryUrl: null },
      factoryUrl: 'https://f.example.com',
    })
  })

  it('nothing changed still sends the base, so the server says whether it still holds', () => {
    assert.deepEqual(installationSave(READ, { rateLimit: 600 }), { base: { rateLimit: 600 } })
  })

  it('an empty Factory address is none (null)', () => {
    assert.deepEqual(
      installationSave({ ...READ, factoryUrl: 'https://f.example.com' }, { factoryUrl: '  ' }),
      {
        base: { factoryUrl: 'https://f.example.com' },
        factoryUrl: null,
      },
    )
  })
})

describe('what a field says before anything is sent', () => {
  it('the limit per key is a whole number within the bounds the server gives', () => {
    assert.equal(rateProblem('600', 60, 10000), null)
    assert.equal(rateProblem('60', 60, 10000), null)
    for (const bad of ['', '59', '10001', '1.5', 'many', '-1']) {
      assert.match(rateProblem(bad, 60, 10000) ?? '', /60.+10,000/, bad)
    }
  })

  it('the Factory address: the web accepts what the server accepts, and nothing it refuses', () => {
    const tries = [
      '',
      'https://factory.example.com',
      'https://factory.example.com/',
      'http://localhost:4000',
      'http://127.0.0.1:4000/f',
      'http://factory.example.com',
      'https://u:p@factory.example.com',
      'https://factory.example.com/#x',
      'https://factory.example.com/?a=1',
      'https://factory.example.com/$(rm)',
      'javascript:alert(1)',
      'factory.example.com',
    ]
    for (const t of tries) {
      let server: string | null | 'refused'
      try {
        server = t.trim() === '' ? null : serverFactoryUrl(t)
      } catch {
        server = 'refused'
      }
      assert.equal(factoryProblem(t) === null, server !== 'refused', t)
    }
  })

  it('mail: the server, a port from 1 to 65535 and an address to send from', () => {
    const ok = { host: 'smtp.example.com', port: '587', fromAddress: 'brain@example.com' }
    assert.deepEqual(mailProblems(ok), {})
    assert.deepEqual(Object.keys(mailProblems({ host: '', port: '0', fromAddress: 'nope' })).sort(), [
      'fromAddress',
      'host',
      'port',
    ])
    assert.ok(mailProblems({ ...ok, host: 'smtp example' }).host)
    assert.ok(mailProblems({ ...ok, port: '70000' }).port)
  })

  it('a logo is a PNG, JPEG or WebP of at most 2 MB; an SVG is refused with the reason', () => {
    assert.equal(logoProblem({ type: 'image/png', size: 1000 }), null)
    assert.equal(logoProblem({ type: 'image/webp', size: 2 * 1024 * 1024 }), null)
    assert.match(logoProblem({ type: 'image/svg+xml', size: 10 }) ?? '', /SVG/)
    assert.match(logoProblem({ type: 'image/gif', size: 10 }) ?? '', /PNG, JPEG or WebP/)
    assert.match(logoProblem({ type: 'image/png', size: 2 * 1024 * 1024 + 1 }) ?? '', /2 MB/)
  })
})

describe('mail: a save on what was read; the password only when it changes', () => {
  const base: MailBase = {
    configured: true,
    host: 'smtp.example.com',
    port: 587,
    secure: false,
    user: 'brain',
    fromName: 'Acme',
    fromAddress: 'brain@example.com',
    hasPassword: true,
    passwordLast4: 'wxyz',
  }
  const form = {
    host: ' smtp.example.com ',
    port: '587',
    secure: false,
    user: 'brain',
    fromName: 'Acme',
    fromAddress: 'brain@example.com',
  }

  it('keeps the password unless a new one is typed or removing it is chosen', () => {
    const keep = mailSave(base, form, { mode: 'keep', value: 'ignored' })
    assert.equal('password' in keep, false)
    assert.deepEqual(keep.base, base)
    assert.equal(keep.host, 'smtp.example.com')
    assert.equal(keep.port, 587)
    assert.equal(mailSave(base, form, { mode: 'replace', value: 'new-pass' }).password, 'new-pass')
    assert.equal(mailSave(base, form, { mode: 'remove', value: '' }).password, '')
  })

  it('an empty user is none', () => {
    assert.equal(mailSave(base, { ...form, user: '  ' }, { mode: 'keep', value: '' }).user, null)
  })
})

describe('the audit: the view and the download ask for the same rows', () => {
  it('dates are whole local days: "to" includes its day', () => {
    const q = auditQuery({
      actor: 'acc_1',
      action: 'member.',
      brain: 'growth',
      outcome: '',
      from: '2026-10-01',
      to: '2026-10-31',
    })
    assert.equal(q.actor, 'acc_1')
    assert.equal(q.action, 'member.')
    assert.equal(q.brain, 'growth')
    assert.equal(q.outcome, undefined)
    assert.equal(q.from, new Date(2026, 9, 1).toISOString())
    assert.equal(q.to, new Date(2026, 10, 1).toISOString())
  })

  it('empty filters ask for everything', () => {
    assert.deepEqual(auditQuery({ actor: '', action: ' ', brain: '', outcome: '', from: '', to: '' }), {})
  })

  it('the download carries exactly the query of the view (never its page cursor)', () => {
    const q = auditQuery({
      actor: 'acc_1',
      action: 'key.',
      brain: '',
      outcome: 'denied',
      from: '2026-10-01',
      to: '',
    })
    const href = auditExportHref({ ...q, before: '123' })
    const u = new URL(href, 'http://x')
    assert.equal(u.pathname, '/v1/admin/audit/export')
    assert.deepEqual(Object.fromEntries(u.searchParams), q)
  })
})

describe('naming what is secret, and progress', () => {
  it('a secret by whether it is set and its last 4, never more', () => {
    assert.equal(secretLabel(true, 'wxyz'), 'Set, ends in …wxyz')
    assert.equal(secretLabel(true, null), 'Set')
    assert.equal(secretLabel(false, null), 'Not set')
  })

  it('processing says how far it got, in words', () => {
    assert.equal(progressLabel({ done: 1200, total: 3400 }), '1,200 of 3,400 texts processed (35%)')
    assert.equal(progressLabel({ done: 0, total: 0 }), 'Nothing to process yet')
    assert.equal(progressLabel({ done: 10, total: 10 }), 'All 10 texts processed')
  })
})
