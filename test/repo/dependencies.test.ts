// Plan B6 §0 «Dependencias»: versions pinned exactly (no ^ or ~), and what is distributed — the server's
// dependencies and the libraries bundled into the web — under MIT, ISC, BSD or Apache-2.0 (MIT-0 is MIT
// without the notice). Development tools (Playwright, axe, Vite) are not distributed.
import assert from 'node:assert/strict'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { describe, it } from 'node:test'

const ROOT = new URL('../../', import.meta.url)
const pkg = JSON.parse(readFileSync(new URL('package.json', ROOT), 'utf8')) as Record<
  string,
  Record<string, string>
>
const lock = JSON.parse(readFileSync(new URL('package-lock.json', ROOT), 'utf8')) as {
  packages: Record<string, { license?: string; dev?: boolean; version?: string }>
}

const PERMISSIVE = /^(MIT|MIT-0|ISC|0BSD|BSD-2-Clause|BSD-3-Clause|Apache-2\.0)$/

export function shippedProblems(packages: typeof lock.packages): string[] {
  return Object.entries(packages)
    .filter(([path, p]) => path !== '' && !p.dev)
    .filter(([, p]) => !PERMISSIVE.test(p.license ?? ''))
    .map(([path, p]) => `${path.replace(/^.*node_modules\//, '')}@${p.version}: ${p.license ?? 'no licence'}`)
}

describe('dependencies', () => {
  it('are pinned to exact versions', () => {
    for (const field of ['dependencies', 'devDependencies']) {
      for (const [name, v] of Object.entries(pkg[field] ?? {}))
        assert.match(v, /^\d+\.\d+\.\d+$/, `${name}@${v}`)
    }
  })

  it('that are distributed carry a permissive licence', () => {
    assert.deepEqual(shippedProblems(lock.packages), [])
  })

  it('a copyleft licence among them is caught', () => {
    assert.deepEqual(
      shippedProblems({ '': {}, 'node_modules/x': { license: 'GPL-3.0', version: '1.0.0' } }),
      ['x@1.0.0: GPL-3.0'],
    )
    assert.deepEqual(shippedProblems({ 'node_modules/y': { license: 'MPL-2.0', dev: true } }), [])
  })
})

// The page body renderer (PR19) is built into the web by Vite, so it is listed with the build tools; the
// licences of what it brings into the bundle are checked here: markdown-it and the libraries it uses are
// MIT or BSD. Its command line's argument parser (PSF-2.0) never reaches the web.
describe('the markdown renderer bundled into the web', () => {
  const BUNDLED = ['markdown-it', 'mdurl', 'uc.micro', 'linkify-it', 'entities', 'punycode.js']
  it('carries permissive licences, pinned', () => {
    assert.equal(pkg.devDependencies?.['markdown-it'], '15.0.2')
    for (const name of BUNDLED) {
      const p = lock.packages[`node_modules/${name}`]
      assert.ok(p, `${name} is installed`)
      assert.match(p.license ?? '', PERMISSIVE, `${name}@${p.version}: ${p.license}`)
    }
  })

  const web = new URL('dist/web/assets/', ROOT)
  it('leaves the argument parser of its command line out of the built web', {
    skip: !existsSync(web),
  }, () => {
    const js = readdirSync(web).filter((f) => f.endsWith('.js'))
    assert.ok(js.length > 0)
    for (const f of js) assert.doesNotMatch(readFileSync(new URL(f, web), 'utf8'), /ArgumentParser/, f)
  })
})

// MIT and BSD ask that the copyright notice travel with every copy. The build writes the notices of the
// libraries it bundles into dist/web/licences.txt, served at /licences.txt. The QR library (PR24) has no
// licence file of its own; its notice sits in its source header, so the build carries it from there.
describe('the licence notices of the bundled web', () => {
  const file = new URL('dist/web/licences.txt', ROOT)
  it('ship with the build, the QR library and the renderer included', {
    skip: !existsSync(new URL('dist/web/', ROOT)),
  }, () => {
    assert.ok(existsSync(file), 'dist/web/licences.txt: run npm run build')
    const text = readFileSync(file, 'utf8')
    assert.match(text, /qrcode-generator@2\.0\.4 \(MIT\)/)
    assert.match(text, /Copyright \(c\) 2009 Kazuhiko Arase/)
    assert.match(text, /markdown-it@15\.0\.2 \(MIT\)/)
    assert.match(text, /preact@\S+ \(MIT\)/)
    assert.match(text, /Permission is hereby granted, free of charge/)
  })

  // The interface's face (shared.css v2) is a font under the SIL Open Font License, which asks that the
  // licence travel with the font.
  it('carry the font and its SIL Open Font License', {
    skip: !existsSync(new URL('dist/web/', ROOT)),
  }, () => {
    const text = readFileSync(file, 'utf8')
    assert.match(text, /JetBrains Mono \(OFL-1\.1\)/)
    assert.match(text, /SIL OPEN FONT LICENSE Version 1\.1/)
    const fonts = readdirSync(new URL('dist/web/assets/', ROOT)).filter((f) => f.endsWith('.woff2'))
    assert.equal(fonts.length, 2, 'the regular and the bold face, as files of their own')
  })
})
