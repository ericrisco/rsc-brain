// What ships holds no path of the machine it was made on (spec B7 «El repositorio público»): the README, the launcher
// and its files, the source, the web, the image recipe and the migrations. The repository's own address
// (github.com/ericrisco/rsc-brain, the package @ericrisco/rsc-brain) is not a personal path. Tests may use made-up
// paths as data; they do not ship.
import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { readdir, readFile, stat } from 'node:fs/promises'
import { join, relative } from 'node:path'
import { describe, it } from 'node:test'

const ROOT = new URL('../../', import.meta.url).pathname
const SHIPPED = [
  'README.md',
  'Dockerfile',
  'package.json',
  'deploy',
  'src',
  'web/src',
  'web/index.html',
  'migrations',
]
const PERSONAL = /\/Users\/[^/\s'"`]+|\/Volumes\/[^/\s'"`]+|\/home\/(?!node\b)[a-z][^/\s'"`]*|[A-Z]:\\Users\\/
const REPO =
  /(github\.com|githubusercontent\.com\/|api\.github\.com\/repos)[/:]?ericrisco\/rsc-brain|@ericrisco\/rsc-brain/g

export function personalPaths(text: string): string[] {
  const hits: string[] = []
  for (const line of text.replace(REPO, '').split('\n')) {
    const m = PERSONAL.exec(line)
    if (m || /ericrisco/i.test(line)) hits.push(line.trim().slice(0, 120))
  }
  return hits
}

async function* files(p: string): AsyncGenerator<string> {
  if ((await stat(p)).isFile()) {
    yield p
    return
  }
  for (const e of await readdir(p, { withFileTypes: true })) yield* files(join(p, e.name))
}

describe('personal paths', () => {
  it('a home folder, a mounted disk or an account name is caught; the repository address is not', () => {
    for (const bad of [
      'see /Users/someone/code',
      'cd /Volumes/DISK/dev',
      'C:\\Users\\x',
      'home is /home/alice/rsc',
      'by ericrisco',
    ])
      assert.equal(personalPaths(bad).length, 1, bad)
    for (const fine of [
      'git clone https://github.com/ericrisco/rsc-brain.git',
      'curl -fsSLO https://raw.githubusercontent.com/ericrisco/rsc-brain/main/deploy/rsc-brain.sh',
      'npm i @ericrisco/rsc-brain',
      "'https://api.github.com/repos/ericrisco/rsc-brain/releases'",
      'the image user is /home/node',
      '/opt/rsc-brain and ~/rsc-brain',
    ])
      assert.deepEqual(personalPaths(fine), [], fine)
  })

  it('appear in nothing that ships', async () => {
    const hits: string[] = []
    for (const p of SHIPPED) {
      const full = join(ROOT, p)
      if (!existsSync(full)) continue
      for await (const f of files(full)) {
        if (/\.(png|jpe?g|webp|ico|woff2?)$/.test(f)) continue
        for (const h of personalPaths(await readFile(f, 'utf8'))) hits.push(`${relative(ROOT, f)}: ${h}`)
      }
    }
    assert.deepEqual(hits, [])
  })
})
