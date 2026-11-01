// Builds the Brain web into dist/web (plan §2): hashed files under /assets, no inline script or style (the
// CSP of plan §0 forbids them), and a .br and .gz copy of each text file so the server sends them without
// compressing on the fly.
import { readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { brotliCompressSync, constants, gzipSync } from 'node:zlib'
import { defineConfig, type Plugin } from 'vite'

const out = fileURLToPath(new URL('../dist/web/', import.meta.url))

function precompress(): Plugin {
  return {
    name: 'brain-precompress',
    apply: 'build',
    closeBundle() {
      const walk = (dir: string): string[] =>
        readdirSync(dir).flatMap((f) => {
          const p = join(dir, f)
          return statSync(p).isDirectory() ? walk(p) : [p]
        })
      for (const p of walk(out)) {
        if (!/\.(js|css|html|svg|json)$/.test(p)) continue
        const body = readFileSync(p)
        if (body.length < 1024) continue
        writeFileSync(
          `${p}.br`,
          brotliCompressSync(body, { params: { [constants.BROTLI_PARAM_QUALITY]: 11 } }),
        )
        writeFileSync(`${p}.gz`, gzipSync(body, { level: 9 }))
      }
    },
  }
}

// MIT and BSD ask that the copyright notice travel with every copy: the notices of the libraries bundled into
// the web go to licences.txt, served at /licences.txt. A library without a licence file of its own (the QR
// library) carries its notice in its source header; the MIT text is then written with that copyright line.
const MIT = `Permission is hereby granted, free of charge, to any person obtaining a copy of this software and
associated documentation files (the "Software"), to deal in the Software without restriction, including
without limitation the rights to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is furnished to do so, subject to the
following conditions:

The above copyright notice and this permission notice shall be included in all copies or substantial
portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT
LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO
EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER
IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE
USE OR OTHER DEALINGS IN THE SOFTWARE.`

function licences(): Plugin {
  return {
    name: 'brain-licences',
    apply: 'build',
    generateBundle() {
      const dirs = new Map<string, string>()
      for (const id of this.getModuleIds()) {
        const m = /^(.*\/node_modules\/(?:@[^/]+\/)?[^/]+)\//.exec(id.replace(/\\/g, '/'))
        if (m?.[1] && !dirs.has(m[1])) dirs.set(m[1], id)
      }
      const notices = [...dirs]
        .map(([dir, file]) => {
          const pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')) as Record<string, string>
          const own = readdirSync(dir).find((f) => /^licen[cs]e(-mit)?(\.(md|txt))?$/i.test(f))
          const copyright = /Copyright \(c\)[^\n]*/.exec(readFileSync(file.split('?')[0] ?? file, 'utf8'))
          const text = own
            ? readFileSync(join(dir, own), 'utf8').trim()
            : pkg.license === 'MIT' && copyright
              ? `${copyright[0].trim()}\n\n${MIT}`
              : ''
          if (!text) throw new Error(`${pkg.name}: no licence notice to ship with the web`)
          return `${pkg.name}@${pkg.version} (${pkg.license})\n\n${text}`
        })
        .sort()
      this.emitFile({
        type: 'asset',
        fileName: 'licences.txt',
        source: `Libraries bundled into the rsc-brain web, with their licence notices.\n\n${notices.join('\n\n---\n\n')}\n`,
      })
    },
  }
}

export default defineConfig({
  root: fileURLToPath(new URL('.', import.meta.url)),
  base: '/',
  publicDir: false,
  oxc: { jsx: { runtime: 'automatic', importSource: 'preact' } },
  build: {
    outDir: out,
    emptyOutDir: true,
    assetsDir: 'assets',
    // Every asset is a file: an inlined data: script or style would break the CSP.
    assetsInlineLimit: 0,
    modulePreload: { polyfill: false },
    sourcemap: false,
    target: 'es2022',
  },
  // The graph's worker is a file of its own under /assets (CSP worker-src 'self'), an ES module.
  worker: { format: 'es' },
  plugins: [licences(), precompress()],
  server: {
    port: 5173,
    proxy: Object.fromEntries(
      ['/v1', '/mcp', '/oauth', '/.well-known'].map((p) => [p, { target: 'http://127.0.0.1:4100' }]),
    ),
  },
})
