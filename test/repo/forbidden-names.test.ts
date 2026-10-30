// Constitution P3: the product never names the projects it studied — nor the product the visual
// prototype cites as a reference (plan B6 §0). The names are stored encoded so this file does not contain
// them either. The built web (dist/web) is checked too: a name could arrive through a bundled string.
import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, relative } from 'node:path'
import { describe, it } from 'node:test'

const ROOT = new URL('../../', import.meta.url).pathname
const WEB_DIST = join(ROOT, 'dist', 'web')
const SKIP = new Set([
  'node_modules',
  '.git',
  'dist',
  '.pg-test',
  '.rsc',
  'package-lock.json',
  'test-results',
])
const FORBIDDEN = ['ZW5ncmFt', 'Z2VudGxlbWFuIHByb2dyYW1taW5n', 'Z2JyYWlu', 'YWkgb3MgbWFwcw=='].map((b) =>
  Buffer.from(b, 'base64').toString('utf8'),
)

async function* files(dir: string, skip: Set<string>): AsyncGenerator<string> {
  for (const e of await readdir(dir, { withFileTypes: true })) {
    if (skip.has(e.name)) continue
    const p = join(dir, e.name)
    if (e.isDirectory()) yield* files(p, skip)
    else if (e.isFile()) yield p
  }
}

export function findForbidden(text: string): string | undefined {
  const lower = text.toLowerCase()
  return FORBIDDEN.find((name) => lower.includes(name))
}

// Every file under `dir` (and its name) that holds a forbidden name. Compressed copies are skipped: they
// are made from files that are read here.
export async function scan(dir: string, skip = new Set<string>()): Promise<string[]> {
  const hits: string[] = []
  for await (const f of files(dir, skip)) {
    if (f.endsWith('.br') || f.endsWith('.gz')) continue
    const name = findForbidden(await readFile(f, 'utf8'))
    if (name || findForbidden(relative(dir, f))) hits.push(relative(dir, f))
  }
  return hits
}

describe('forbidden names', () => {
  it('detects them in any case', () => {
    assert.ok(findForbidden(`see ${FORBIDDEN[0]?.toUpperCase()} docs`))
    assert.ok(findForbidden(`inspired by ${FORBIDDEN[3]?.toUpperCase()}`))
    assert.equal(findForbidden('a journal for agents'), undefined)
  })

  it('appear in no file of the repository', async () => {
    assert.deepEqual(await scan(ROOT, SKIP), [])
  })

  it('a name planted in a built web is caught, and a clean one passes', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'brain-names-'))
    try {
      await mkdir(join(dir, 'assets'))
      await writeFile(join(dir, 'index.html'), '<title>Brain</title>')
      await writeFile(join(dir, 'assets', 'index-a1.js'), 'const label = "journal"')
      assert.deepEqual(await scan(dir), [])
      await writeFile(join(dir, 'assets', 'index-a1.js'), `const label = "${FORBIDDEN[0]}"`)
      assert.deepEqual(await scan(dir), ['assets/index-a1.js'])
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('appear nowhere in the built web (dist/web)', {
    skip: existsSync(WEB_DIST) ? false : 'dist/web is not built: run npm run build first (verify.sh does)',
  }, async () => {
    assert.deepEqual(await scan(WEB_DIST), [])
  })
})
