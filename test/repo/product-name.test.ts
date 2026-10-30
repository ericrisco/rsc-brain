// The product is called rsc-brain (Eric, 2026-10-30): never by an older or a personal name, and never a
// bare «Brain» (review of PR18). The common noun stays: a brain is a knowledge container ("Create brain",
// "Your brains"). The source, the web, the README and the built web (where a name could arrive through a
// bundled string) are checked.
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

// A capitalised «Brain» standing alone, as the product's name. "Brain" inside a longer name (BrainRow,
// X-Brain-Cut, RSC_BRAIN_*) is not a word on its own, and "brain" in lower case is the noun.
const BARE = /(?<![\w-])Brain(?![\w-]|\.\w)/

// Where «Brain» is the noun capitalised at the start of a heading or label, not the product. Each entry
// says why. None today: the web writes the noun in lower case ("Create brain", "Your brains").
const NOUN_OK: ReadonlyArray<[why: string, text: RegExp]> = []

// The string literals of a TypeScript file, comments left out (a comment is not product text).
export function stringsOf(code: string): string[] {
  const out: string[] = []
  let i = 0
  while (i < code.length) {
    const c = code[i] as string
    if (c === '/' && code[i + 1] === '/') {
      i = code.indexOf('\n', i)
      if (i < 0) break
      continue
    }
    if (c === '/' && code[i + 1] === '*') {
      i = code.indexOf('*/', i + 2)
      if (i < 0) break
      i += 2
      continue
    }
    if (c === "'" || c === '"' || c === '`') {
      let j = i + 1
      let text = ''
      while (j < code.length && code[j] !== c) {
        if (code[j] === '\\') {
          text += code[j + 1] ?? ''
          j += 2
          continue
        }
        if (c !== '`' && code[j] === '\n') break
        text += code[j]
        j++
      }
      out.push(text)
      i = j + 1
      continue
    }
    i++
  }
  return out
}

// JSX text between tags of a .tsx file (product text written in place, if any).
const jsxTextOf = (code: string) => [...code.matchAll(/>([^<>{}\n]+)</g)].map((m) => m[1] as string)

export function bareNames(file: string, code: string): string[] {
  const texts =
    file.endsWith('.md') || file.endsWith('.html')
      ? code
          .split('\n')
          // Code spans and blocks of the README are commands and headers, not prose.
          .map((l) => l.replace(/`[^`]*`/g, ''))
      : [...stringsOf(code), ...(file.endsWith('.tsx') ? jsxTextOf(code) : [])]
  // Module paths ('./screens/Brain.tsx') are not text.
  return texts.filter(
    (t) => !/^\.{1,2}\//.test(t) && BARE.test(t) && !NOUN_OK.some(([, ok]) => ok.test(t.trim())),
  )
}

async function bareIn(dir: string): Promise<string[]> {
  const hits: string[] = []
  const walk = async (d: string): Promise<void> => {
    for (const e of await readdir(d, { withFileTypes: true })) {
      const p = join(d, e.name)
      if (e.isDirectory()) await walk(p)
      else if (/\.(ts|tsx)$/.test(p))
        for (const t of bareNames(p, await readFile(p, 'utf8')))
          hits.push(`${relative(ROOT, p)}: ${t.slice(0, 90)}`)
    }
  }
  await walk(dir)
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

  it('a bare «Brain» in product text is caught; the noun, longer names and comments pass', () => {
    assert.deepEqual(bareNames('a.ts', "const t = 'Add Brain for all your projects'"), [
      'Add Brain for all your projects',
    ])
    // biome-ignore lint/suspicious/noTemplateCurlyInString: the source text of a template literal, on purpose
    assert.equal(bareNames('a.ts', 'const t = `Open Brain at ${url}`').length, 1)
    assert.equal(bareNames('a.tsx', '<p>Brain is ready</p>').length, 1)
    assert.equal(bareNames('a.md', 'Brain serves MCP at the address.').length, 1)
    for (const fine of [
      "import { Brain } from './screens/Brain.tsx'",
      "const t = 'Create brain'",
      "const h = 'X-Brain-Cut'",
      "const e = 'RSC_BRAIN_TOKEN'",
      '// Brain does this in a comment',
      "const t = 'Your brains'",
      "const t = 'rsc-brain is set up.'",
    ])
      assert.deepEqual(bareNames('a.tsx', fine), [], fine)
    assert.deepEqual(bareNames('a.md', 'Send the header `X-Brain-Cut: true` and `Brain`.'), [])
  })

  it('never a bare «Brain» in the source, the web, index.html or the README', async () => {
    const hits = [
      ...(await bareIn(join(ROOT, 'src'))),
      ...(await bareIn(join(ROOT, 'web', 'src'))),
      ...bareNames('README.md', await readFile(join(ROOT, 'README.md'), 'utf8')).map(
        (t) => `README.md: ${t}`,
      ),
      ...bareNames('index.html', await readFile(join(ROOT, 'web', 'index.html'), 'utf8')).map(
        (t) => `web/index.html: ${t}`,
      ),
    ]
    assert.deepEqual(hits, [])
  })

  it('is rsc-brain in the built web (dist/web)', {
    skip: existsSync(WEB_DIST) ? false : 'dist/web is not built: run npm run build first (verify.sh does)',
  }, async () => {
    assert.deepEqual(await wrongNames(WEB_DIST), [])
  })
})
