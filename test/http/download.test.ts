// A download prepared on disk (an export, spec B7; reviews of PR31): sent whole with its size, at the client's
// pace, from the handle it was written with (the file has no name any more); a client that takes nothing for the
// stall time is let go; the handle is closed in every case, a client already gone included. No database.
import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { type FileHandle, open, unlink } from 'node:fs/promises'
import { createServer, get, type Server, type ServerResponse } from 'node:http'
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
  const closed: boolean[] = []
  // The file as an export leaves it: written, then its name removed, only the handle left.
  async function prepared(): Promise<{ fh: FileHandle; i: number }> {
    n += 1
    const path = join(dir, `${n}.zip.part`)
    const fh = await open(path, 'wx+', 0o600)
    await fh.write(body, 0, body.length, 0)
    await unlink(path)
    closed.push(false)
    return { fh, i: closed.length - 1 }
  }
  const send = async (res: ServerResponse) => {
    const { fh, i } = await prepared()
    sent.push(
      sendDownload(
        res,
        {
          name: 'x.zip',
          type: 'application/zip',
          fh,
          bytes: body.length,
          done: async () => {
            closed[i] = true
            await fh.close()
          },
        },
        silentLog,
        300,
      ),
    )
  }
  before(async () => {
    server = createServer((_req, res) => void send(res))
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  })
  after(async () => {
    server.closeAllConnections()
    await new Promise<void>((r) => server.close(() => r()))
    rmSync(dir, { recursive: true, force: true })
  })

  it('sends it whole from the handle, sized, never cached or sniffed, and closes it', async () => {
    const res = await fetch(`${base}/`)
    assert.equal(res.status, 200)
    assert.equal(res.headers.get('content-type'), 'application/zip')
    assert.equal(res.headers.get('content-disposition'), 'attachment; filename="x.zip"')
    assert.equal(res.headers.get('content-length'), String(body.length))
    assert.equal(res.headers.get('cache-control'), 'no-store')
    assert.equal(res.headers.get('x-content-type-options'), 'nosniff')
    assert.ok(Buffer.from(await res.arrayBuffer()).equals(body))
    await sent.at(-1)
    assert.equal(closed.at(-1), true)
  })

  it('lets go of a client that stops reading, and closes the handle', async () => {
    // Seen from the server: a paused client does not read, so it would not notice either way.
    let req: ReturnType<typeof get> | undefined
    await new Promise<void>((resolve) => {
      req = get(`${base}/`, (res) => {
        res.pause()
        resolve()
      })
      req.on('error', () => {})
    })
    const ended = await Promise.race([
      (sent.at(-1) as Promise<void>).then(() => true),
      new Promise<boolean>((r) => setTimeout(() => r(false), 3000)),
    ])
    req?.destroy()
    assert.ok(ended, 'the stalled download was not let go')
    assert.equal(closed.at(-1), true)
  })

  it('closes the handle when the client leaves mid-way', async () => {
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
    assert.equal(closed.at(-1), true)
  })

  it('a client gone before the file was ready: nothing is sent, the handle closes at once (second pass)', async () => {
    const res = { destroyed: true, writableEnded: false } as unknown as ServerResponse
    const { fh, i } = await prepared()
    let wrote = false
    Object.assign(res, {
      writeHead: () => {
        wrote = true
      },
    })
    await sendDownload(
      res,
      {
        name: 'x.zip',
        type: 'application/zip',
        fh,
        bytes: body.length,
        done: async () => {
          closed[i] = true
          await fh.close()
        },
      },
      silentLog,
      300,
    )
    assert.equal(closed[i], true)
    assert.equal(wrote, false)
  })
})
