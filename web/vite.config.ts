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
  plugins: [precompress()],
  server: {
    port: 5173,
    proxy: Object.fromEntries(
      ['/v1', '/mcp', '/oauth', '/.well-known'].map((p) => [p, { target: 'http://127.0.0.1:4100' }]),
    ),
  },
})
