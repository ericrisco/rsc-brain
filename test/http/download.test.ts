// A download prepared on disk (an export, spec B7; review of PR31): sent whole with its size, at the client's
// pace; a client that takes nothing for the stall time is let go; the file goes in every case. No database.
import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createServer, get, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, describe, it } from 'node:test'
import { silentLog } from '../../src/core/log.ts'
import { sendDownload } from '../../src/http/app.ts'

describe('a download sent from a prepared file', () => {
  const dir = mkdtempSync(join(tmpdir(), 'rsc-brain-download-'))
  const body = randomBytes(16 * 1024 * 1024)
  let server: Server
  let base = ''
  let n = 0
  const sent: Promise<void>[] = []
  const files: string[] = []
  before(async () => {
    server = createServer((_req, res) => {
      n += 1
      const path = join(dir, `${n}.zip.part`)
      writeFileSync(path, body)
      files.push(path)
      const removed = { path, bytes: body.length }
      sent.push(
        sendDownload(
          res,
          {
            name: 'x.zip',
            type: 'application/zip',
            ...removed,
            done: async () => rmSync(path, { force: true }),
          },
          silentLog,
          300,
        ),
      )
    })
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  })
  after(async () => {
    server.closeAllConnections()
    await new Promise<void>((r) => server.close(() => r()))
    rmSync(dir, { recursive: true, force: true })
  })

  it('sends it whole, sized, never cached or sniffed, and removes it', async () => {
    const res = await fetch(`${base}/`)
    assert.equal(res.status, 200)
    assert.equal(res.headers.get('content-type'), 'application/zip')
    assert.equal(res.headers.get('content-disposition'), 'attachment; filename="x.zip"')
    assert.equal(res.headers.get('content-length'), String(body.length))
    assert.equal(res.headers.get('cache-control'), 'no-store')
    assert.equal(res.headers.get('x-content-type-options'), 'nosniff')
    assert.ok(Buffer.from(await res.arrayBuffer()).equals(body))
    await sent.at(-1)
    assert.equal(existsSync(files.at(-1) as string), false)
  })

  it('lets go of a client that stops reading, and removes the file', async () => {
    // Seen from the server: a paused client does not read, so it would not notice either way.
    let req: ReturnType<typeof get> | undefined
    await new Promise<void>((resolve, reject) => {
      req = get(`${base}/`, (res) => {
        res.pause()
        resolve()
      })
      req.on('error', () => {})
      req.on('timeout', reject)
    })
    const ended = await Promise.race([
      (sent.at(-1) as Promise<void>).then(() => true),
      new Promise<boolean>((r) => setTimeout(() => r(false), 3000)),
    ])
    req?.destroy()
    assert.ok(ended, 'the stalled download was not let go')
    assert.equal(existsSync(files.at(-1) as string), false)
  })

  it('removes the file when the client leaves mid-way', async () => {
    await new Promise<void>((resolve) => {
      const req = get(`${base}/`, (res) => {
        res.once('data', () => {
          req.destroy()
          resolve()
        })
      })
      req.on('error', () => {})
    })
    await sent.at(-1)
    assert.equal(existsSync(files.at(-1) as string), false)
  })
})
