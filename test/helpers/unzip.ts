// A small zip reader for the tests only: it trusts the file (it is ours), reads the central directory (zip64
// included) and inflates every entry. The product's own bounded reader is PR32's (plan §3.6, risk 8).
import { crc32, inflateRawSync } from 'node:zlib'

export type ZipEntry = { name: string; data: Buffer; utf8: boolean; method: number; flags: number }

function eocd(buf: Buffer): { count: number; offset: number } {
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65_557); i--) {
    if (buf.readUInt32LE(i) !== 0x06054b50) continue
    let count = buf.readUInt16LE(i + 10)
    let offset = buf.readUInt32LE(i + 16)
    // A zip64 end: its locator sits just before.
    const loc = i - 20
    if (loc >= 0 && buf.readUInt32LE(loc) === 0x07064b50) {
      const at = Number(buf.readBigUInt64LE(loc + 8))
      if (buf.readUInt32LE(at) !== 0x06064b50) throw new Error('bad zip64 end record')
      count = Number(buf.readBigUInt64LE(at + 32))
      offset = Number(buf.readBigUInt64LE(at + 48))
    }
    return { count, offset }
  }
  throw new Error('no end of central directory')
}

export function readZip(buf: Buffer): ZipEntry[] {
  const { count, offset } = eocd(buf)
  const out: ZipEntry[] = []
  let p = offset
  for (let n = 0; n < count; n++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) throw new Error(`bad central header at ${p}`)
    const flags = buf.readUInt16LE(p + 8)
    const method = buf.readUInt16LE(p + 10)
    const crc = buf.readUInt32LE(p + 16)
    let comp = buf.readUInt32LE(p + 20)
    const nameLen = buf.readUInt16LE(p + 28)
    const extraLen = buf.readUInt16LE(p + 30)
    const commentLen = buf.readUInt16LE(p + 32)
    let local = buf.readUInt32LE(p + 42)
    const nameBytes = buf.subarray(p + 46, p + 46 + nameLen)
    const extra = buf.subarray(p + 46 + nameLen, p + 46 + nameLen + extraLen)
    for (let e = 0; e + 4 <= extra.length; ) {
      const id = extra.readUInt16LE(e)
      const size = extra.readUInt16LE(e + 2)
      if (id === 0x0001) {
        let q = e + 4
        if (buf.readUInt32LE(p + 24) === 0xffffffff) q += 8
        if (comp === 0xffffffff) {
          comp = Number(extra.readBigUInt64LE(q))
          q += 8
        }
        if (local === 0xffffffff) local = Number(extra.readBigUInt64LE(q))
      }
      e += 4 + size
    }
    if (buf.readUInt32LE(local) !== 0x04034b50) throw new Error(`bad local header at ${local}`)
    const lName = buf.readUInt16LE(local + 26)
    const lExtra = buf.readUInt16LE(local + 28)
    const start = local + 30 + lName + lExtra
    const raw = buf.subarray(start, start + comp)
    const data = method === 8 ? inflateRawSync(raw) : Buffer.from(raw)
    if (crc32(data) !== crc) throw new Error(`bad crc for ${nameBytes.toString('utf8')}`)
    out.push({ name: nameBytes.toString('utf8'), data, utf8: (flags & 0x800) !== 0, method, flags })
    p += 46 + nameLen + extraLen + commentLen
  }
  return out
}

export const filesOf = (buf: Buffer): Map<string, string> =>
  new Map(readZip(buf).map((e) => [e.name, e.data.toString('utf8')]))
