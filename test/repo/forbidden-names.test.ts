// Constitution P3: the product never names the projects it studied. The names are stored encoded so
// this file does not contain them either.
import assert from 'node:assert/strict'
import { readdir, readFile } from 'node:fs/promises'
import { join, relative } from 'node:path'
import { describe, it } from 'node:test'

const ROOT = new URL('../../', import.meta.url).pathname
const SKIP = new Set(['node_modules', '.git', 'dist', '.pg-test', '.rsc', 'package-lock.json'])
const FORBIDDEN = ['ZW5ncmFt', 'Z2VudGxlbWFuIHByb2dyYW1taW5n', 'Z2JyYWlu'].map((b) =>
  Buffer.from(b, 'base64').toString('utf8'),
)

async function* files(dir: string): AsyncGenerator<string> {
  for (const e of await readdir(dir, { withFileTypes: true })) {
    if (SKIP.has(e.name)) continue
    const p = join(dir, e.name)
    if (e.isDirectory()) yield* files(p)
    else if (e.isFile()) yield p
  }
}

export function findForbidden(text: string): string | undefined {
  const lower = text.toLowerCase()
  return FORBIDDEN.find((name) => lower.includes(name))
}

describe('forbidden names', () => {
  it('detects them in any case', () => {
    assert.ok(findForbidden(`see ${FORBIDDEN[0]?.toUpperCase()} docs`))
    assert.equal(findForbidden('a journal for agents'), undefined)
  })

  it('appear in no file of the repository', async () => {
    const hits: string[] = []
    for await (const f of files(ROOT)) {
      const name = findForbidden(await readFile(f, 'utf8'))
      if (name || findForbidden(relative(ROOT, f))) hits.push(relative(ROOT, f))
    }
    assert.deepEqual(hits, [])
  })
})
