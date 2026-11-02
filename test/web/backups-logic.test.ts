// The logic of Admin › Backups & system and the wizard's step «Installation key» (B7 PR30), out of the screens so it
// is tested on its own: a failure and a warning in words, the band of the administration until a good copy, why a
// copy cannot be restored here, the name to type before a restore, and the file the key is saved in.
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  bandOf,
  confirmProblem,
  failureText,
  keyFile,
  keyFileName,
  reasonLabel,
  restoreBlocked,
  sizeLabel,
  warningText,
} from '../../web/src/lib/backups.ts'

describe('backups in words', () => {
  it('every failure category and warning code the server gives has its words', () => {
    for (const c of [
      'disk_full',
      'no_permission',
      'no_installation_secret',
      'weak_installation_key',
      'database',
      'busy',
      'failed',
    ])
      assert.ok(failureText(c).length > 10, c)
    assert.match(failureText('disk_full'), /disk .*full/i)
    assert.match(failureText('something new'), /failed/i)
    for (const c of ['fsync_failed', 'status_not_saved', 'disk_full', 'no_permission'])
      assert.ok(warningText(c).length > 10, c)
  })

  it('reasons and sizes', () => {
    assert.equal(reasonLabel('scheduled'), 'Daily')
    assert.equal(reasonLabel('manual'), 'By hand')
    assert.equal(reasonLabel('pre-update'), 'Before an update')
    assert.equal(reasonLabel('pre-restore'), 'Before a restore')
    assert.equal(sizeLabel(512), '512 bytes')
    assert.equal(sizeLabel(2048), '2.0 KB')
    assert.equal(sizeLabel(52_000_000), '49.6 MB')
    assert.equal(sizeLabel(41_000_000_000), '38.2 GB')
  })

  it('the band of the administration: the last failure until a good copy after it', () => {
    const ok = { at: '2026-11-02T03:00:00.000Z', file: 'a.rscb' }
    const fail = { at: '2026-11-02T04:00:00.000Z', category: 'disk_full' }
    assert.deepEqual(bandOf({ lastOk: ok, lastFailure: fail }), fail)
    assert.equal(bandOf({ lastOk: { ...ok, at: '2026-11-02T05:00:00.000Z' }, lastFailure: fail }), null)
    assert.equal(bandOf({ lastOk: ok, lastFailure: null }), null)
    assert.deepEqual(bandOf({ lastOk: null, lastFailure: fail }), fail)
    assert.equal(bandOf(undefined), null)
  })

  it('a copy that needs an older key, or while a copy is made, cannot be restored here: and says why', () => {
    const item = { needsOldKey: false }
    assert.equal(restoreBlocked(item, { running: false, online: true }), null)
    assert.match(String(restoreBlocked({ needsOldKey: true }, { running: false, online: true })), /older key/)
    assert.match(String(restoreBlocked(item, { running: true, online: true })), /copy is being made/)
    assert.match(String(restoreBlocked(item, { running: false, online: false })), /offline/i)
  })

  it('the name typed before a restore must be the installation’s, exactly', () => {
    assert.equal(confirmProblem('Acme brain', 'Acme brain'), null)
    assert.match(String(confirmProblem('', 'Acme brain')), /Acme brain/)
    assert.match(String(confirmProblem('acme brain', 'Acme brain')), /exactly/)
    assert.match(String(confirmProblem(' Acme brain', 'Acme brain')), /exactly/)
  })

  it('the key file holds the key alone (rsc-brain restore --key-file reads it as it is); its name says whose and which', () => {
    assert.equal(keyFile('k'.repeat(48)), `${'k'.repeat(48)}\n`)
    assert.equal(keyFileName('Acme brain!', 'ab12cd34ef56'), 'rsc-brain-key-acme-brain-ab12cd34ef56.txt')
    assert.equal(keyFileName('', 'ab12cd34ef56'), 'rsc-brain-key-ab12cd34ef56.txt')
  })
})
