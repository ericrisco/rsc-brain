// Builds the Brain web into dist/web (plan §2): hashed files under /assets, no inline script or style (the
// CSP of plan §0 forbids them), and a .br and .gz copy of each text file so the server sends them without
// compressing on the fly.
import { createHash } from 'node:crypto'
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
      // The interface's face, self-hosted beside shared.css: its licence travels with it.
      const font = readFileSync(fileURLToPath(new URL('src/styles/fonts/OFL.txt', import.meta.url)), 'utf8')
      notices.push(`IBM Plex Sans and IBM Plex Mono (OFL-1.1)\n\n${font.trim()}`)
      this.emitFile({
        type: 'asset',
        fileName: 'licences.txt',
        source: `Libraries and fonts bundled into the rsc-brain web, with their licence notices.\n\n${notices.join('\n\n---\n\n')}\n`,
      })
    },
  }
}

// The mode is on <html> before the first frame (boot/mode.js): a plain script of its own file in <head>, ahead
// of the styles, since the CSP allows no inline script. Built, it is a hashed file under /assets.
function bootMode(): Plugin {
  const file = fileURLToPath(new URL('src/boot/mode.js', import.meta.url))
  let built = ''
  return {
    name: 'brain-boot-mode',
    buildStart() {
      const source = readFileSync(file, 'utf8')
      const hash = createHash('sha256').update(source).digest('hex').slice(0, 8)
      built = `assets/mode-${hash}.js`
      if (this.meta.watchMode === false) this.emitFile({ type: 'asset', fileName: built, source })
    },
    transformIndexHtml: {
      order: 'pre',
      handler(_html, ctx) {
        const src = ctx.server ? '/src/boot/mode.js' : `/${built}`
        return [{ tag: 'script', attrs: { src }, injectTo: 'head-prepend' }]
      },
    },
  }
}

// The pages the server draws itself (the standard sign-in, maintenance) use the same faces as the web, served by
// the installation at addresses that do not change from one build to the next: /fonts/<name>.woff2.
function stableFonts(): Plugin {
  const dir = fileURLToPath(new URL('src/styles/fonts/', import.meta.url))
  return {
    name: 'brain-stable-fonts',
    apply: 'build',
    generateBundle() {
      for (const f of readdirSync(dir).filter((n) => n.endsWith('.woff2')))
        this.emitFile({ type: 'asset', fileName: `fonts/${f}`, source: readFileSync(join(dir, f)) })
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
  plugins: [bootMode(), stableFonts(), licences(), precompress()],
  server: {
    port: 5173,
    proxy: Object.fromEntries(
      ['/v1', '/mcp', '/oauth', '/.well-known'].map((p) => [p, { target: 'http://127.0.0.1:4100' }]),
    ),
  },
})
