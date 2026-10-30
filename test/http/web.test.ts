// Spec B6 «Dónde vive la web» and plan §3.1: the same process serves the built web next to the API. The
// web never answers on a reserved prefix, never reads outside its folder, carries the headers of plan §0
// and loads before the first-time setup is done. These tests need no database: a database that throws
// proves the web does not touch it.
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, describe, it } from 'node:test'
import { brotliCompressSync, gzipSync } from 'node:zlib'
import type { Db } from '../../src/db/db.ts'
import { createHandler, ROUTES } from '../../src/http/app.ts'
import { answerWeb, openWeb, WEB_CSP } from '../../src/http/web.ts'

const INDEX = '<!doctype html><html><head><title>Brain</title></head><body><div id="app"></div></body></html>'
const SCRIPT = 'console.log("brain web")'.repeat(40)

// A database that fails on any use: the web must answer without one.
const noDb: Db = {
  query: () => Promise.reject(new Error('the web touched the database')),
  one: () => Promise.reject(new Error('the web touched the database')),
  tx: () => Promise.reject(new Error('the web touched the database')),
}

async function builtWeb(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'brain-web-'))
  await mkdir(join(root, 'assets'))
  await writeFile(join(root, 'index.html'), INDEX)
  await writeFile(join(root, 'assets', 'main-Ab12Cd34.js'), SCRIPT)
  await writeFile(join(root, 'assets', 'main-Ab12Cd34.js.br'), brotliCompressSync(SCRIPT))
  await writeFile(join(root, 'assets', 'main-Ab12Cd34.js.gz'), gzipSync(SCRIPT))
  await writeFile(join(root, 'assets', 'style-Zz98Yy76.css'), 'body{margin:0}')
  return root
}

describe('the web next to the API', () => {
  let root: string
  let server: Server
  let base: string
  before(async () => {
    root = await builtWeb()
    server = createServer(
      createHandler({ db: noDb, clock: () => new Date('2026-10-30T10:00:00Z'), web: root, log: () => {} }),
    )
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  })
  after(async () => {
    await new Promise<void>((r) => server.close(() => r()))
    await rm(root, { recursive: true, force: true })
  })

  // fetch normalises "..", so the raw request line is sent by hand where the path matters.
  const rawGet = (path: string) =>
    new Promise<{ status: number; type: string; body: string }>((resolve, reject) => {
      const { port } = server.address() as AddressInfo
      import('node:http').then(({ request }) => {
        const req = request({ host: '127.0.0.1', port, path, method: 'GET' }, (res) => {
          let body = ''
          res.on('data', (c) => {
            body += c
          })
          res.on('end', () =>
            resolve({ status: res.statusCode ?? 0, type: String(res.headers['content-type']), body }),
          )
        })
        req.on('error', reject)
        req.end()
      }, reject)
    })

  it('any web route answers the app page with the headers of plan §0, before the setup and without a database', async () => {
    for (const path of ['/', '/brains', '/b/acme/wiki/audience/retention', '/sign-in?next=/b/x']) {
      const res = await fetch(`${base}${path}`)
      assert.equal(res.status, 200, path)
      assert.match(res.headers.get('content-type') ?? '', /^text\/html/)
      assert.equal(await res.text(), INDEX)
      assert.equal(res.headers.get('content-security-policy'), WEB_CSP)
      assert.equal(res.headers.get('x-content-type-options'), 'nosniff')
      assert.equal(res.headers.get('referrer-policy'), 'same-origin')
      assert.equal(res.headers.get('x-frame-options'), 'DENY')
      assert.equal(res.headers.get('cache-control'), 'no-cache')
    }
  })

  it('the content security policy is the one of plan §0, word for word', () => {
    assert.equal(
      WEB_CSP,
      "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data: blob:; connect-src 'self'; worker-src 'self'; font-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'; object-src 'none'",
    )
  })

  it('a hashed asset is served for a year, immutable; compressed when the browser accepts it', async () => {
    const plain = await fetch(`${base}/assets/main-Ab12Cd34.js`, {
      headers: { 'accept-encoding': 'identity' },
    })
    assert.equal(plain.status, 200)
    assert.equal(plain.headers.get('cache-control'), 'public, max-age=31536000, immutable')
    assert.match(plain.headers.get('content-type') ?? '', /^text\/javascript/)
    assert.equal(plain.headers.get('content-encoding'), null)
    assert.equal(await plain.text(), SCRIPT)
    // fetch decodes the body itself; the header says which file was sent.
    const br = await fetch(`${base}/assets/main-Ab12Cd34.js`, { headers: { 'accept-encoding': 'gzip, br' } })
    assert.equal(br.headers.get('content-encoding'), 'br')
    assert.equal(br.headers.get('vary'), 'Accept-Encoding')
    assert.equal(await br.text(), SCRIPT)
    const gz = await fetch(`${base}/assets/main-Ab12Cd34.js`, { headers: { 'accept-encoding': 'gzip' } })
    assert.equal(gz.headers.get('content-encoding'), 'gzip')
    assert.equal(await gz.text(), SCRIPT)
    const css = await fetch(`${base}/assets/style-Zz98Yy76.css`)
    assert.match(css.headers.get('content-type') ?? '', /^text\/css/)
    assert.equal(css.headers.get('content-security-policy'), WEB_CSP)
  })

  it('HEAD answers the headers without the body', async () => {
    const res = await fetch(`${base}/brains`, { method: 'HEAD' })
    assert.equal(res.status, 200)
    assert.equal(res.headers.get('content-security-policy'), WEB_CSP)
    assert.equal(await res.text(), '')
  })

  it('an asset that is not in the build is a JSON 404, never the app page', async () => {
    for (const path of ['/assets/nope.js', '/assets/main-Ab12Cd34.js.br', '/assets/', '/assets']) {
      const res = await fetch(`${base}${path}`)
      assert.equal(res.status, 404, path)
      assert.match(res.headers.get('content-type') ?? '', /application\/json/)
      const body = (await res.json()) as { error: { code: string; howToProceed: string } }
      assert.equal(body.error.code, 'no_such_route')
      assert.ok(body.error.howToProceed)
    }
  })

  it('a path that tries to leave the folder is a 404 without reading the disk', async () => {
    for (const path of [
      '/a/../b',
      '/assets/../index.html',
      '/%2e%2e/etc/passwd',
      '/%2E%2E/x',
      '/a\\b',
      '/a%00b',
    ]) {
      const res = await rawGet(path)
      assert.equal(res.status, 404, path)
      assert.match(res.type, /application\/json/, path)
    }
  })

  it('the reserved prefixes stay with the API: /v1, /mcp, /oauth and /.well-known answer JSON', async () => {
    const v1 = await fetch(`${base}/v1/x`)
    assert.equal(v1.status, 404)
    assert.match(v1.headers.get('content-type') ?? '', /application\/json/)
    assert.equal(((await v1.json()) as { error: { code: string } }).error.code, 'no_such_route')
    for (const path of ['/v1', '/mcp/x', '/oauth/nothing', '/.well-known/nothing']) {
      const res = await fetch(`${base}${path}`)
      assert.match(res.headers.get('content-type') ?? '', /application\/json/, path)
      assert.equal(res.headers.get('content-security-policy'), null, path)
    }
  })

  it('writes are never the web: a POST to a web path is the API answer', async () => {
    const res = await fetch(`${base}/brains`, { method: 'POST', body: '{}' })
    assert.equal(res.status, 404)
    assert.match(res.headers.get('content-type') ?? '', /application\/json/)
  })

  it('no route of the server falls into the web (plan risk 6)', async () => {
    const web = openWeb(root)
    for (const r of ROUTES) {
      const path = r.path.replace(/[:*]\w+/g, 'x')
      for (const method of ['GET', 'HEAD', r.method]) {
        assert.equal(answerWeb(web, method, path, ''), 'pass', `${method} ${path}`)
      }
    }
  })
})

describe('the web when it is not built', () => {
  it('says how to build it, and the API keeps answering', async () => {
    const root = join(tmpdir(), `brain-web-missing-${process.pid}`)
    const web = openWeb(root)
    assert.equal(web.kind, 'not-built')
    const page = answerWeb(web, 'GET', '/', '')
    assert.notEqual(page, 'pass')
    if (page === 'pass') return
    assert.equal(page.status, 503)
    assert.match(String(page.body), /The web is not built: run npm run build/)
    assert.equal(answerWeb(web, 'GET', '/v1/brains', ''), 'pass')
  })
})
