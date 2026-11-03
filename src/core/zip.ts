// A zip writer of our own (spec B7 C16, plan §0: no dependency), for the exports. It writes forward only, to a
// sink that marks the pace (each piece is awaited), so a big export never sits whole in memory: every file is
// deflated as it arrives and closed with a data descriptor (its CRC and sizes after the data). Names are UTF-8
// and say so (general purpose bit 11). More than 65 535 files, or a directory past 4 GiB, take the zip64 end;
// one file past 4 GiB is refused (no export holds one). A name that could land outside the folder it is
// unpacked in (`..`, absolute, a drive, a backslash, NUL or another control character) is refused before
// anything of it is written.
import { crc32, createDeflateRaw, deflateRawSync } from 'node:zlib'

export type ZipSink = (chunk: Buffer) => Promise<void>
export type ZipFile = { write(data: string | Buffer): Promise<void>; close(): Promise<void> }
export type Zip = {
  file(name: string, data: string | Buffer): Promise<void>
  open(name: string): Promise<ZipFile>
  end(): Promise<{ bytes: number; files: number }>
}

const MAX32 = 0xffffffff
const MAX16 = 0xffff
// Version 2.0 (deflate) and 4.5 (zip64) of the format; "made by" says Unix, so the mode below is read.
const NEEDS = 20
const NEEDS64 = 45
const MADE_BY = (3 << 8) | NEEDS64
const UTF8 = 0x0800
const DESCRIPTOR = 0x0008
const FLAGS = UTF8 | DESCRIPTOR
const MODE = (0o100644 << 16) >>> 0

export class ZipNameError extends Error {}

// The name as it goes in the zip, or a refusal: relative, forward slashes, no empty, "." or ".." part, no
// drive, no control character, well-formed and at most 65 535 bytes of UTF-8.
export function safeZipName(name: string): string {
  const refuse = (): never => {
    throw new ZipNameError(`${JSON.stringify(name.slice(0, 80))} is not a safe name inside a zip.`)
  }
  if (typeof name !== 'string' || name.length === 0 || !name.isWellFormed()) refuse()
  if (Buffer.byteLength(name, 'utf8') > MAX16) refuse()
  // biome-ignore lint/suspicious/noControlCharactersInRegex: control characters are what is refused here.
  if (/[\u0000-\u001f\u007f\\]/.test(name)) refuse()
  if (name.startsWith('/') || /^[A-Za-z]:/.test(name)) refuse()
  for (const part of name.split('/')) if (part === '' || part === '.' || part === '..') refuse()
  return name
}

// The date and time of the files, in the DOS form zip keeps (local time of the zip = UTC here, two seconds).
function dosTime(at: Date): { time: number; date: number } {
  const y = Math.min(Math.max(at.getUTCFullYear(), 1980), 2107)
  return {
    time: (at.getUTCHours() << 11) | (at.getUTCMinutes() << 5) | (at.getUTCSeconds() >> 1),
    date: ((y - 1980) << 9) | ((at.getUTCMonth() + 1) << 5) | at.getUTCDate(),
  }
}

type Done = { name: Buffer; crc: number; comp: number; size: number; offset: number }

export function zipWriter(sink: ZipSink, o: { at?: Date } = {}): Zip {
  const { time, date } = dosTime(o.at ?? new Date())
  const names = new Set<string>()
  const done: Done[] = []
  let offset = 0
  let open = false
  let ended = false
  // The first failure of the sink stops the zip for good: what follows would be a broken file anyway.
  let failed: unknown = null

  const put = async (b: Buffer) => {
    if (failed) throw failed
    try {
      await sink(b)
    } catch (err) {
      failed = err
      throw err
    }
    offset += b.length
  }

  const ready = (name: string): Buffer => {
    if (failed) throw failed
    if (ended) throw new Error('The zip has ended.')
    if (open) throw new Error('A file of the zip is still open.')
    safeZipName(name)
    if (names.has(name)) throw new Error(`${JSON.stringify(name)} is in the zip twice.`)
    names.add(name)
    return Buffer.from(name, 'utf8')
  }

  const localHeader = (name: Buffer) => {
    const h = Buffer.alloc(30)
    h.writeUInt32LE(0x04034b50, 0)
    h.writeUInt16LE(NEEDS, 4)
    h.writeUInt16LE(FLAGS, 6)
    h.writeUInt16LE(8, 8)
    h.writeUInt16LE(time, 10)
    h.writeUInt16LE(date, 12)
    // CRC and sizes: zero here, in the descriptor after the data.
    h.writeUInt16LE(name.length, 26)
    return Buffer.concat([h, name])
  }

  const finish = async (name: Buffer, start: number, crc: number, comp: number, size: number) => {
    if (comp > MAX32 || size > MAX32)
      throw new Error(`${name.toString('utf8')} is bigger than 4 GiB, more than one file of an export holds.`)
    const d = Buffer.alloc(16)
    d.writeUInt32LE(0x08074b50, 0)
    d.writeUInt32LE(crc >>> 0, 4)
    d.writeUInt32LE(comp, 8)
    d.writeUInt32LE(size, 12)
    await put(d)
    done.push({ name, crc: crc >>> 0, comp, size, offset: start })
  }

  return {
    async file(name, data) {
      const n = ready(name)
      const raw = typeof data === 'string' ? Buffer.from(data, 'utf8') : data
      const start = offset
      await put(localHeader(n))
      const comp = deflateRawSync(raw)
      await put(comp)
      await finish(n, start, crc32(raw), comp.length, raw.length)
    },

    async open(name) {
      const n = ready(name)
      open = true
      const start = offset
      await put(localHeader(n))
      const z = createDeflateRaw()
      let crc = 0
      let size = 0
      let comp = 0
      const out: Buffer[] = []
      z.on('data', (c: Buffer) => out.push(c))
      const flush = async () => {
        while (out.length) {
          const c = out.shift() as Buffer
          comp += c.length
          await put(c)
        }
      }
      return {
        async write(data) {
          const raw = typeof data === 'string' ? Buffer.from(data, 'utf8') : data
          if (raw.length === 0) return
          crc = crc32(raw, crc)
          size += raw.length
          await new Promise<void>((resolve, reject) => z.write(raw, (err) => (err ? reject(err) : resolve())))
          await flush()
        },
        async close() {
          await new Promise<void>((resolve, reject) => {
            z.once('end', resolve)
            z.once('error', reject)
            z.end()
          })
          await flush()
          open = false
          await finish(n, start, crc, comp, size)
        },
      }
    },

    async end() {
      if (failed) throw failed
      if (open) throw new Error('A file of the zip is still open.')
      if (ended) throw new Error('The zip has ended.')
      ended = true
      const dirStart = offset
      for (const f of done) {
        const far = f.offset >= MAX32
        const extra = far ? Buffer.alloc(12) : Buffer.alloc(0)
        if (far) {
          extra.writeUInt16LE(0x0001, 0)
          extra.writeUInt16LE(8, 2)
          extra.writeBigUInt64LE(BigInt(f.offset), 4)
        }
        const h = Buffer.alloc(46)
        h.writeUInt32LE(0x02014b50, 0)
        h.writeUInt16LE(MADE_BY, 4)
        h.writeUInt16LE(far ? NEEDS64 : NEEDS, 6)
        h.writeUInt16LE(FLAGS, 8)
        h.writeUInt16LE(8, 10)
        h.writeUInt16LE(time, 12)
        h.writeUInt16LE(date, 14)
        h.writeUInt32LE(f.crc, 16)
        h.writeUInt32LE(f.comp, 20)
        h.writeUInt32LE(f.size, 24)
        h.writeUInt16LE(f.name.length, 28)
        h.writeUInt16LE(extra.length, 30)
        h.writeUInt32LE(MODE, 38)
        h.writeUInt32LE(far ? MAX32 : f.offset, 42)
        await put(Buffer.concat([h, f.name, extra]))
      }
      const dirSize = offset - dirStart
      const big = done.length >= MAX16 || dirStart >= MAX32 || dirSize >= MAX32
      if (big) {
        const at = offset
        const z = Buffer.alloc(56)
        z.writeUInt32LE(0x06064b50, 0)
        z.writeBigUInt64LE(44n, 4)
        z.writeUInt16LE(MADE_BY, 12)
        z.writeUInt16LE(NEEDS64, 14)
        z.writeBigUInt64LE(BigInt(done.length), 24)
        z.writeBigUInt64LE(BigInt(done.length), 32)
        z.writeBigUInt64LE(BigInt(dirSize), 40)
        z.writeBigUInt64LE(BigInt(dirStart), 48)
        const loc = Buffer.alloc(20)
        loc.writeUInt32LE(0x07064b50, 0)
        loc.writeBigUInt64LE(BigInt(at), 8)
        loc.writeUInt32LE(1, 16)
        await put(Buffer.concat([z, loc]))
      }
      const e = Buffer.alloc(22)
      e.writeUInt32LE(0x06054b50, 0)
      e.writeUInt16LE(big ? MAX16 : done.length, 8)
      e.writeUInt16LE(big ? MAX16 : done.length, 10)
      e.writeUInt32LE(big ? MAX32 : dirSize, 12)
      e.writeUInt32LE(big ? MAX32 : dirStart, 16)
      await put(e)
      return { bytes: offset, files: done.length }
    },
  }
}
