// The product is called rsc-brain (Eric, 2026-10-30): never by an older or a personal name. The source,
// the web, the README and the built web (where a name could arrive through a bundled string) are checked.
import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, relative } from 'node:path'
import { describe, it } from 'node:test'

const ROOT = new URL('../../', import.meta.url).pathname
const WEB_DIST = join(ROOT, 'dist', 'web')
// "RSC Brain", "Risco Brain", in any case; RSC_BRAIN_* variables and the package name are fine.
const WRONG = /\b(rsc|risco)[ \t]+brain\b/i

export async function wrongNames(dir: string): Promise<string[]> {
  const hits: string[] = []
  const walk = async (d: string): Promise<void> => {
    for (const e of await readdir(d, { withFileTypes: true })) {
      const p = join(d, e.name)
      if (e.isDirectory()) await walk(p)
      else if (e.isFile() && !/\.(br|gz|png|jpe?g|webp)$/.test(p) && WRONG.test(await readFile(p, 'utf8')))
        hits.push(relative(ROOT, p))
    }
  }
  if (existsSync(dir)) await walk(dir)
  return hits
}

describe('the product name', () => {
  it('a wrong name is caught, and the right one passes', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'brain-name-'))
    try {
      await writeFile(join(dir, 'a.ts'), "const title = 'rsc-brain'; const env = 'RSC_BRAIN_TOKEN'")
      assert.deepEqual(await wrongNames(dir), [])
      for (const bad of ['RSC Brain', 'Risco Brain', 'rsc  brain']) {
        await writeFile(join(dir, 'a.ts'), `const title = '${bad}'`)
        assert.equal((await wrongNames(dir)).length, 1, bad)
      }
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('is rsc-brain everywhere in the source, the web and the README', async () => {
    const hits = [
      ...(await wrongNames(join(ROOT, 'src'))),
      ...(await wrongNames(join(ROOT, 'web', 'src'))),
      ...(WRONG.test(await readFile(join(ROOT, 'README.md'), 'utf8')) ? ['README.md'] : []),
      ...(WRONG.test(await readFile(join(ROOT, 'web', 'index.html'), 'utf8')) ? ['web/index.html'] : []),
    ]
    assert.deepEqual(hits, [])
  })

  it('is rsc-brain in the built web (dist/web)', {
    skip: existsSync(WEB_DIST) ? false : 'dist/web is not built: run npm run build first (verify.sh does)',
  }, async () => {
    assert.deepEqual(await wrongNames(WEB_DIST), [])
  })
})
