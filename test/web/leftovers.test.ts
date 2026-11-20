// CA24 (spec web redesign, Annex B): nothing of the retired look is left — in the web's sources, the
// server-drawn pages, the mails, the built web and the pictures of the docs. The closed list has eight groups;
// for each one a leftover planted on purpose is caught, so the check can fail as well as pass.
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, relative } from 'node:path'
import { describe, it } from 'node:test'

const ROOT = new URL('../../', import.meta.url).pathname

type Rule = { group: number; what: string; re: RegExp; only?: RegExp }

// Each rule names its group of Annex B. `only` limits a rule to some files.
export const RULES: Rule[] = [
  { group: 1, what: 'the two-way theme switch', re: /themeLight|theme\.value === 'light' \? 'dark'/ },
  { group: 1, what: 'dark forced at the start', re: /<html[^>]*data-theme="dark"|chosen\(\) \?\? 'dark'/ },
  { group: 2, what: 'the old monospaced face', re: /jetbrains/i },
  { group: 2, what: 'monospace as the face of the whole interface', re: /--sans:\s*var\(--font-mono\)/ },
  {
    group: 2,
    what: 'the system face on the server-drawn pages',
    re: /body\{[^}]*font:[^;}"]*\b(ui-sans-serif|system-ui)/,
    only: /oauth\.ts$/,
  },
  { group: 3, what: 'a panel number', re: /panel-num|PanelHead|panelNumber/ },
  { group: 3, what: 'a family colour or coloured corner', re: /data-c=|\[data-c|--panel-c|--fam-[a-z]+/ },
  { group: 3, what: 'tracked capitals', re: /text-transform:\s*uppercase/ },
  { group: 3, what: 'a figure in colour', re: /panel-figure/ },
  { group: 4, what: 'the green accent (hue 156)', re: /oklch\([^)]*\s156\s*\)/ },
  { group: 4, what: 'a community colour of the graph', re: /--com-(\d|other|lone)/ },
  { group: 4, what: 'a fixed mail colour of the old wrapper', re: /#1b1d22/ },
  { group: 4, what: "the server-drawn pages' own palette", re: /oklch\(/, only: /oauth\.ts$/ },
  {
    group: 5,
    what: 'the accent bar of the current section',
    re: /aria-current\]::before\s*\{[^}]*background:\s*var\(--accent\)/,
  },
  {
    group: 5,
    what: 'the accent icon of the current section',
    re: /aria-current\]\s*>\s*\.icon\s*\{[^}]*--accent/,
  },
  {
    group: 5,
    what: 'a coloured side stripe on a notice or card',
    re: /border-left(-color)?:\s*\d+px solid (var\(--(negative|positive|warning|accent)\)|currentColor)|box-shadow:\s*inset \d+px 0 0 var\(--accent\)/,
  },
  { group: 6, what: 'the dotted ground of the graph', re: /--grid-dot|radial-gradient/ },
  { group: 7, what: 'glow and pulse', re: /--glow|--pulse(-len|-speed)?\b/ },
  { group: 7, what: 'the shimmer of a skeleton', re: /@keyframes\s+(shimmer|shine|sheen)/ },
  { group: 7, what: 'a backdrop blur', re: /backdrop-filter/ },
]

// The pictures of the interface in the docs at v0.7.1 (Annex B, group 8): none may still be there.
export const OLD_SHOTS = new Set([
  '7d22f7b1eb0e137aaac1acc6193899dec1e20c67f5a7a1db09f6db49a390d472',
  'e57e098db2ec5af5b51a8b26b2bdc2eb5cf932fd35d186442f17270b9186f8ca',
  '229024796803d0f3dc38cc98da0e53b066c9f10fd75252cf1e4d95592f78e5b3',
  '89e44ea7cbbbe3021d15163bb487100b86de8607f2c6d184e51ffe7908d14524',
  '1544d836d65999cb7820f9c664a3ea5dc55859bae8b560030de45ec9c419ea3c',
  '04682ee32dea180eef63c821dc53c3e0a493e2e0bbe08d93e2022f53c7dc840e',
  '217563051b01e3562f3242f7ff73f8180354a0f8ec29582714e38942e1869402',
  '9baef907ba7898f6efa02ef38b2a95da07b9fd01309bc0b728a0f1e417f9633f',
  'd36442c6b5cc0fa541551ecf3b3596dc9a0911f88279f8fe73066764e9106894',
])

export function findLeftovers(file: string, text: string): string[] {
  const code = text.replace(/\/\*[\s\S]*?\*\//g, '')
  return RULES.filter((r) => (!r.only || r.only.test(file)) && r.re.test(code)).map(
    (r) => `group ${r.group}: ${r.what} in ${file}`,
  )
}

function* walk(dir: string): Generator<string> {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name)
    if (e.isDirectory()) yield* walk(p)
    else if (e.isFile()) yield p
  }
}

const SOURCES = [
  ...[...walk(join(ROOT, 'web'))].filter((f) => /\.(css|tsx?|html|js)$/.test(f)),
  join(ROOT, 'src/http/routes/oauth.ts'),
  join(ROOT, 'src/mail/mail.ts'),
]
const DIST = join(ROOT, 'dist', 'web')

// The pictures of the interface in a folder that are known by hash to be of the old look.
export function oldPictures(dir: string, known: ReadonlySet<string>): string[] {
  return readdirSync(dir)
    .filter((f) => /^ui-.*\.webp$/.test(f))
    .filter((f) =>
      known.has(
        createHash('sha256')
          .update(readFileSync(join(dir, f)))
          .digest('hex'),
      ),
    )
}

describe('no leftovers of the retired look (Annex B)', () => {
  it('each group is caught when a leftover of it is planted', () => {
    const planted: [string, string][] = [
      ['web/src/lib/mode.ts', 'label: T.shell.themeLight'],
      ['web/src/styles/tokens.css', '--font-mono: "JetBrains Mono", ui-monospace;'],
      ['web/src/screens/Brain.tsx', '<section class="panel pad" data-c="orange">'],
      ['web/src/styles/tokens.css', '--accent: oklch(0.82 0.16 156);'],
      [
        'web/src/styles/shell.css',
        '.rail-item[aria-current]::before { content: ""; background: var(--accent); }',
      ],
      [
        'web/src/styles/app.css',
        '.graph-box { background-image: radial-gradient(var(--grid-dot) 1px, transparent 0); }',
      ],
      [
        'web/src/styles/app.css',
        '.skeleton { animation: shimmer 1s; } @keyframes shimmer { to { opacity: 0 } }',
      ],
      ['src/http/routes/oauth.ts', 'body{background:var(--bg);font:14px/1.5 ui-sans-serif,system-ui}'],
    ]
    const groups = new Set<number>()
    for (const [file, text] of planted) {
      const found = findLeftovers(file, text)
      assert.ok(found.length > 0, `${file}: ${text}`)
      for (const f of found) groups.add(Number(/group (\d)/.exec(f)?.[1]))
    }
    assert.deepEqual([...groups].sort(), [1, 2, 3, 4, 5, 6, 7])
  })

  it('group 8 is caught when a picture of the old look is planted', () => {
    const dir = mkdtempSync(join(tmpdir(), 'shots-'))
    try {
      writeFileSync(join(dir, 'ui-planted.webp'), 'a picture of the old look')
      writeFileSync(join(dir, 'ui-new.webp'), 'a picture of the new look')
      const known = new Set([createHash('sha256').update('a picture of the old look').digest('hex')])
      assert.deepEqual(oldPictures(dir, known), ['ui-planted.webp'])
      assert.deepEqual(oldPictures(dir, OLD_SHOTS), [])
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('appear in no source of the web, the server-drawn pages or the mails', () => {
    const found = SOURCES.flatMap((f) => findLeftovers(relative(ROOT, f), readFileSync(f, 'utf8')))
    assert.deepEqual(found, [])
  })

  it('no file of the old face is left beside the styles', () => {
    const fonts = join(ROOT, 'web/src/styles/fonts')
    const left = readdirSync(fonts).filter((f) => /jetbrains/i.test(f))
    assert.deepEqual(left, [])
  })

  it('appear nowhere in the built web (dist/web)', {
    skip: existsSync(DIST) ? false : 'dist/web is not built: run npm run build first (verify.sh does)',
  }, () => {
    const found = [...walk(DIST)]
      .filter((f) => /\.(css|js|html)$/.test(f) && statSync(f).size > 0)
      .flatMap((f) => findLeftovers(relative(ROOT, f), readFileSync(f, 'utf8')))
    assert.deepEqual(found, [])
  })

  it('the pictures of the docs show the new look (group 8)', () => {
    assert.ok(readdirSync(join(ROOT, 'docs/assets')).some((f) => /^ui-.*\.webp$/.test(f)))
    const old = oldPictures(join(ROOT, 'docs/assets'), OLD_SHOTS)
    assert.deepEqual(old, [])
  })
})
