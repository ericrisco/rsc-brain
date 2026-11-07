// One tag with everything (decision «Una etiqueta por producto con el botón incluido»): the version in the code, in
// package.json and in its lockfile is the newest `## vX.Y.Z` of the CHANGELOG, and nothing sits under «Unreleased».
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { describe, it } from 'node:test'
import { VERSION } from '../../src/core/version.ts'

const ROOT = new URL('../..', import.meta.url).pathname
const read = (f: string) => readFileSync(`${ROOT}${f}`, 'utf8')

describe('the files that name the version', () => {
  const changelog = read('CHANGELOG.md')
  it('the newest section of the CHANGELOG is the version of the code, package.json and the lockfile', () => {
    const newest = /^## v(\d+\.\d+\.\d+)\s*$/m.exec(changelog)?.[1]
    assert.equal(newest, VERSION)
    assert.equal(JSON.parse(read('package.json')).version, VERSION)
    const lock = JSON.parse(read('package-lock.json'))
    assert.equal(lock.version, VERSION)
    assert.equal(lock.packages[''].version, VERSION)
  })
  it('nothing is left under «Unreleased»', () => {
    assert.doesNotMatch(changelog, /^## Unreleased/m)
  })
})
