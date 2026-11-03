// A bounded zip reader of our own, for imports (plan §3.6, risk 8; no dependency, plan §0). It reads a zip held in
// memory and never writes anything to disk: what it gives is a list of files, each read (and checked) only when
// asked. It trusts nothing in the file:
//   - a name that could land outside the folder it is unpacked in (`..`, absolute, a drive, NUL or another control
//     character, an empty part), a symbolic link or anything that is not a file or a folder refuses the whole zip;
//   - so do an encrypted entry, a way of packing other than stored or deflate, a zip64 end or field (nothing it
//     reads needs one: the limits below are far under 4 GiB and 65 535 files), entries that overlap or run past the
//     directory, a local name unlike the central one, and the same name twice (after NFC and "." parts);
//   - a file over 1 MB is listed and never unpacked; more than 200 MB to unpack, or more than 20 000 entries, is
//     refused before anything is unpacked; a file never unpacks to more than it says, and its CRC must match.
import { crc32, inflateRawSync } from 'node:zlib'

const MB = 1024 * 1024

// Mutable for the tests only.
export const UNZIP_LIMITS = { totalBytes: 200 * MB, fileBytes: MB, entries: 20_000 }

export type UnzipCode = 'invalid_archive' | 'archive_too_large'
export class UnzipError extends Error {
  readonly code: UnzipCode
  constructor(code: UnzipCode, message: string) {
    super(message)
    this.code = code
  }
}

export type ZipItem = {
  path: string
  size: number
  // Over the limit of one file: listed, never unpacked.
  tooLarge: boolean
  read(): Buffer
}

const invalid = (why: string) =>
  new UnzipError('invalid_archive', `This is not a zip rsc-brain can read: ${why}.`)
const EOCD = 0x06054b50
const CENTRAL = 0x02014b50
const LOCAL = 0x04034b50
const ZIP64_LOCATOR = 0x07064b50
const ENCRYPTED = 0x0001
const STRONG = 0x0040
const MASKED = 0x2000
const UTF8 = 0x0800

const utf8 = new TextDecoder('utf-8', { fatal: true })

// A name from the zip as a path inside the import, or a refusal. Separators are "/" (a "\" from Windows counts as
// one), "." parts go, and the rest must be plain parts.
export function zipPath(raw: string): { path: string; folder: boolean } {
  const bad = () => invalid(`the name ${JSON.stringify(raw.slice(0, 80))} could land outside the folder`)
  // biome-ignore lint/suspicious/noControlCharactersInRegex: control characters are what is refused here.
  if (!raw || /[\u0000-\u001f\u007f]/.test(raw)) throw bad()
  const name = raw.normalize('NFC').replace(/\\/g, '/')
  if (name.startsWith('/') || /^[A-Za-z]:/.test(name)) throw bad()
  const folder = name.endsWith('/')
  const parts = (folder ? name.slice(0, -1) : name).split('/')
  const kept: string[] = []
  for (const p of parts) {
    if (p === '' || p === '..') throw bad()
    if (p !== '.') kept.push(p)
  }
  if (kept.length === 0) throw bad()
  return { path: kept.join('/'), folder }
}

function nameOf(bytes: Buffer, flags: number): string {
  try {
    // Without the UTF-8 flag a name is meant to be CP437; in practice only ASCII is that, and the tools that leave
    // the flag out (a Mac's) write UTF-8 anyway. Anything else is refused rather than guessed.
    return utf8.decode(bytes)
  } catch {
    throw invalid(`a name is not valid text${flags & UTF8 ? '' : ' (and does not say how it is written)'}`)
  }
}

function endOf(buf: Buffer): { count: number; cdSize: number; cdOffset: number; at: number } {
  if (buf.length < 22) throw invalid('it is too short')
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 22 - 0xffff); i--) {
    if (buf.readUInt32LE(i) !== EOCD) continue
    // The end record is the last thing in the file, but for its comment.
    if (i + 22 + buf.readUInt16LE(i + 20) !== buf.length) continue
    const disk = buf.readUInt16LE(i + 4)
    const cdDisk = buf.readUInt16LE(i + 6)
    const here = buf.readUInt16LE(i + 8)
    const count = buf.readUInt16LE(i + 10)
    const cdSize = buf.readUInt32LE(i + 12)
    const cdOffset = buf.readUInt32LE(i + 16)
    if (
      count === 0xffff ||
      here === 0xffff ||
      cdSize === 0xffffffff ||
      cdOffset === 0xffffffff ||
      (i >= 20 && buf.readUInt32LE(i - 20) === ZIP64_LOCATOR)
    )
      throw invalid('it uses zip64, which no file it imports needs')
    if (disk !== 0 || cdDisk !== 0 || here !== count) throw invalid('it is split across several files')
    if (cdOffset + cdSize > i) throw invalid('its directory runs past its end')
    return { count, cdSize, cdOffset, at: i }
  }
  throw invalid('its end record is missing')
}

const S_IFMT = 0o170000
const S_IFREG = 0o100000
const S_IFDIR = 0o040000
const S_IFLNK = 0o120000

export function openZip(buf: Buffer, limits: typeof UNZIP_LIMITS = UNZIP_LIMITS): ZipItem[] {
  const { count, cdSize, cdOffset } = endOf(buf)
  if (count > limits.entries)
    throw new UnzipError(
      'archive_too_large',
      `The zip holds more than ${limits.entries.toLocaleString('en-US').replace(/,/g, ' ')} files.`,
    )
  type Entry = {
    path: string
    method: number
    crc: number
    comp: number
    size: number
    start: number
    local: number
  }
  const entries: Entry[] = []
  const seen = new Set<string>()
  const spans: Array<[number, number]> = []
  let total = 0
  let p = cdOffset
  const cdEnd = cdOffset + cdSize
  for (let n = 0; n < count; n++) {
    if (p + 46 > cdEnd || buf.readUInt32LE(p) !== CENTRAL) throw invalid('its directory is damaged')
    const host = buf.readUInt16LE(p + 4) >> 8
    const flags = buf.readUInt16LE(p + 8)
    const method = buf.readUInt16LE(p + 10)
    const crc = buf.readUInt32LE(p + 16)
    const comp = buf.readUInt32LE(p + 20)
    const size = buf.readUInt32LE(p + 24)
    const nameLen = buf.readUInt16LE(p + 28)
    const extraLen = buf.readUInt16LE(p + 30)
    const commentLen = buf.readUInt16LE(p + 32)
    const disk = buf.readUInt16LE(p + 34)
    const attr = buf.readUInt32LE(p + 38)
    const local = buf.readUInt32LE(p + 42)
    const next = p + 46 + nameLen + extraLen + commentLen
    if (next > cdEnd) throw invalid('its directory is damaged')
    const nameBytes = buf.subarray(p + 46, p + 46 + nameLen)
    const extra = buf.subarray(p + 46 + nameLen, p + 46 + nameLen + extraLen)
    p = next
    for (let e = 0; e + 4 <= extra.length; e += 4 + extra.readUInt16LE(e + 2))
      if (extra.readUInt16LE(e) === 0x0001) throw invalid('it uses zip64, which no file it imports needs')
    if (flags & (ENCRYPTED | STRONG | MASKED)) throw invalid('a file in it is encrypted')
    if (disk !== 0) throw invalid('it is split across several files')
    const { path, folder } = zipPath(nameOf(nameBytes, flags))
    // Unix (3) and macOS (19) keep the file's type in the upper half of the attributes.
    if (host === 3 || host === 19) {
      const type = (attr >>> 16) & S_IFMT
      if (type === S_IFLNK) throw invalid(`${JSON.stringify(path)} is a symbolic link`)
      if (type !== 0 && type !== S_IFREG && type !== S_IFDIR)
        throw invalid(`${JSON.stringify(path)} is not a file or a folder`)
      if (type === S_IFDIR && !folder) throw invalid(`${JSON.stringify(path)} is a folder without its "/"`)
    }
    if (method !== 0 && method !== 8) throw invalid(`a file in it is packed in a way rsc-brain does not read`)
    if (method === 0 && comp !== size) throw invalid('the sizes of a stored file differ')
    // The local header: inside the file, before the directory, saying the same.
    if (local + 30 > cdOffset || buf.readUInt32LE(local) !== LOCAL) throw invalid('a file in it is damaged')
    const lFlags = buf.readUInt16LE(local + 6)
    const lMethod = buf.readUInt16LE(local + 8)
    const lName = buf.readUInt16LE(local + 26)
    const lExtra = buf.readUInt16LE(local + 28)
    if (lFlags & (ENCRYPTED | STRONG)) throw invalid('a file in it is encrypted')
    if (lMethod !== method || !buf.subarray(local + 30, local + 30 + lName).equals(nameBytes))
      throw invalid('a file in it says two different things about itself')
    const start = local + 30 + lName + lExtra
    if (start + comp > cdOffset) throw invalid('a file in it runs past its end')
    spans.push([local, start + comp])
    if (folder) {
      if (size !== 0) throw invalid(`the folder ${JSON.stringify(path)} holds data`)
      continue
    }
    if (seen.has(path)) throw invalid(`${JSON.stringify(path)} is in it twice`)
    seen.add(path)
    if (size <= limits.fileBytes) total += size
    entries.push({ path, method, crc, comp, size, start, local })
  }
  if (p !== cdEnd) throw invalid('its directory is damaged')
  // No two entries share bytes (a bomb made of one deflate stream named many times).
  spans.sort((a, b) => a[0] - b[0])
  for (let i = 1; i < spans.length; i++)
    if ((spans[i] as [number, number])[0] < (spans[i - 1] as [number, number])[1])
      throw invalid('files in it overlap')
  if (total > limits.totalBytes)
    throw new UnzipError(
      'archive_too_large',
      `The zip unpacks to more than ${Math.round(limits.totalBytes / MB)} MB.`,
    )
  return entries.map((e) => ({
    path: e.path,
    size: e.size,
    tooLarge: e.size > limits.fileBytes,
    read(): Buffer {
      if (e.size > limits.fileBytes)
        throw invalid(`${JSON.stringify(e.path)} is larger than ${Math.round(limits.fileBytes / MB)} MB`)
      const data = buf.subarray(e.start, e.start + e.comp)
      let out: Buffer
      if (e.method === 0) out = Buffer.from(data)
      else {
        try {
          // Never more than it says: a file that unpacks to more stops here.
          out = inflateRawSync(data, { maxOutputLength: Math.max(1, e.size) })
        } catch {
          throw invalid(`${JSON.stringify(e.path)} is damaged`)
        }
      }
      if (out.length !== e.size || crc32(out) >>> 0 !== e.crc >>> 0)
        throw invalid(`${JSON.stringify(e.path)} is damaged`)
      return out
    },
  }))
}
