// Zips made by hand for the tests of the bounded reader (src/core/unzip.ts): every field can be set to what a
// hostile file would hold — a name with "..", a symbolic link, an encrypted entry, a size that lies, a CRC that
// does not match, entries that overlap, a zip64 end.
import { crc32, deflateRawSync } from 'node:zlib'

export type RawEntry = {
  name: string | Buffer
  data?: Buffer | string
  method?: 0 | 8 | number
  flags?: number
  // Other flags in the local header than in the central directory.
  localFlags?: number
  // The upper 16 bits: a Unix mode (regular file 0o100644, link 0o120777, folder 0o040755).
  mode?: number
  host?: number
  crc?: number
  size?: number
  compSize?: number
  // Another name in the local header than in the central directory.
  localName?: string
  extra?: Buffer
  // Points the central record at another entry's local header (overlapping entries).
  sameLocalAs?: number
}

export function rawZip(
  entries: RawEntry[],
  o: { count?: number; zip64?: boolean; comment?: string; cdOffset?: number; cdPad?: number } = {},
): Buffer {
  const parts: Buffer[] = []
  const central: Buffer[] = []
  const offsets: number[] = []
  let offset = 0
  entries.forEach((e, i) => {
    const name = typeof e.name === 'string' ? Buffer.from(e.name, 'utf8') : e.name
    const raw = typeof e.data === 'string' ? Buffer.from(e.data, 'utf8') : (e.data ?? Buffer.alloc(0))
    const method = e.method ?? 8
    const comp = method === 8 ? deflateRawSync(raw) : raw
    const crc = e.crc ?? crc32(raw)
    const flags = e.flags ?? 0x0800
    const local = Buffer.alloc(30)
    const localName = e.localName === undefined ? name : Buffer.from(e.localName, 'utf8')
    local.writeUInt32LE(0x04034b50, 0)
    local.writeUInt16LE(20, 4)
    local.writeUInt16LE(e.localFlags ?? flags, 6)
    local.writeUInt16LE(method, 8)
    local.writeUInt32LE(crc >>> 0, 14)
    local.writeUInt32LE(e.compSize ?? comp.length, 18)
    local.writeUInt32LE(e.size ?? raw.length, 22)
    local.writeUInt16LE(localName.length, 26)
    const at = e.sameLocalAs === undefined ? offset : (offsets[e.sameLocalAs] as number)
    offsets.push(at)
    if (e.sameLocalAs === undefined) {
      const chunk = Buffer.concat([local, localName, comp])
      parts.push(chunk)
      offset += chunk.length
    }
    const extra = e.extra ?? Buffer.alloc(0)
    const c = Buffer.alloc(46)
    c.writeUInt32LE(0x02014b50, 0)
    c.writeUInt16LE(((e.host ?? 3) << 8) | 20, 4)
    c.writeUInt16LE(20, 6)
    c.writeUInt16LE(flags, 8)
    c.writeUInt16LE(method, 10)
    c.writeUInt32LE(crc >>> 0, 16)
    c.writeUInt32LE(e.compSize ?? comp.length, 20)
    c.writeUInt32LE(e.size ?? raw.length, 24)
    c.writeUInt16LE(name.length, 28)
    c.writeUInt16LE(extra.length, 30)
    c.writeUInt32LE(((e.mode ?? 0o100644) << 16) >>> 0, 38)
    c.writeUInt32LE(at, 42)
    central.push(Buffer.concat([c, name, extra]))
    void i
  })
  const cd = Buffer.concat([...central, Buffer.alloc(o.cdPad ?? 0)])
  const cdStart = offset
  const end: Buffer[] = []
  if (o.zip64) {
    const z = Buffer.alloc(56)
    z.writeUInt32LE(0x06064b50, 0)
    z.writeBigUInt64LE(44n, 4)
    z.writeBigUInt64LE(BigInt(entries.length), 24)
    z.writeBigUInt64LE(BigInt(entries.length), 32)
    z.writeBigUInt64LE(BigInt(cd.length), 40)
    z.writeBigUInt64LE(BigInt(cdStart), 48)
    const loc = Buffer.alloc(20)
    loc.writeUInt32LE(0x07064b50, 0)
    loc.writeBigUInt64LE(BigInt(cdStart + cd.length), 8)
    loc.writeUInt32LE(1, 16)
    end.push(z, loc)
  }
  const comment = Buffer.from(o.comment ?? '', 'utf8')
  const e = Buffer.alloc(22)
  const count = o.count ?? entries.length
  e.writeUInt32LE(0x06054b50, 0)
  e.writeUInt16LE(o.zip64 ? 0xffff : count, 8)
  e.writeUInt16LE(o.zip64 ? 0xffff : count, 10)
  e.writeUInt32LE(o.zip64 ? 0xffffffff : cd.length, 12)
  e.writeUInt32LE(o.zip64 ? 0xffffffff : (o.cdOffset ?? cdStart), 16)
  e.writeUInt16LE(comment.length, 20)
  return Buffer.concat([...parts, cd, ...end, e, comment])
}

// Two entries whose bytes overlap without sharing a header: the second's local header and data sit inside the first
// (stored) entry's data, as in the "quoted" zip bombs.
export function quotedZip(): Buffer {
  const inner = Buffer.from('inner data', 'utf8')
  const name2 = Buffer.from('b.md', 'utf8')
  const local2 = Buffer.alloc(30)
  local2.writeUInt32LE(0x04034b50, 0)
  local2.writeUInt16LE(20, 4)
  local2.writeUInt16LE(0x0800, 6)
  local2.writeUInt32LE(crc32(inner) >>> 0, 14)
  local2.writeUInt32LE(inner.length, 18)
  local2.writeUInt32LE(inner.length, 22)
  local2.writeUInt16LE(name2.length, 26)
  const quoted = Buffer.concat([local2, name2, inner])
  const name1 = Buffer.from('a.md', 'utf8')
  const local1 = Buffer.alloc(30)
  local1.writeUInt32LE(0x04034b50, 0)
  local1.writeUInt16LE(20, 4)
  local1.writeUInt16LE(0x0800, 6)
  local1.writeUInt32LE(crc32(quoted) >>> 0, 14)
  local1.writeUInt32LE(quoted.length, 18)
  local1.writeUInt32LE(quoted.length, 22)
  local1.writeUInt16LE(name1.length, 26)
  const body = Buffer.concat([local1, name1, quoted])
  const central = (name: Buffer, crc: number, size: number, at: number) => {
    const c = Buffer.alloc(46)
    c.writeUInt32LE(0x02014b50, 0)
    c.writeUInt16LE((3 << 8) | 20, 4)
    c.writeUInt16LE(20, 6)
    c.writeUInt16LE(0x0800, 8)
    c.writeUInt32LE(crc >>> 0, 16)
    c.writeUInt32LE(size, 20)
    c.writeUInt32LE(size, 24)
    c.writeUInt16LE(name.length, 28)
    c.writeUInt32LE((0o100644 << 16) >>> 0, 38)
    c.writeUInt32LE(at, 42)
    return Buffer.concat([c, name])
  }
  const cd = Buffer.concat([
    central(name1, crc32(quoted), quoted.length, 0),
    central(name2, crc32(inner), inner.length, 30 + name1.length),
  ])
  const e = Buffer.alloc(22)
  e.writeUInt32LE(0x06054b50, 0)
  e.writeUInt16LE(2, 8)
  e.writeUInt16LE(2, 10)
  e.writeUInt32LE(cd.length, 12)
  e.writeUInt32LE(body.length, 16)
  return Buffer.concat([body, cd, e])
}
