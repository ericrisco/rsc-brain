// The copy file, `.rscb` (spec B7 «Copias y restauración»; plan §3.2). A copy is encrypted whole with the
// installation key, so a stolen copy reads as nothing without it (CA9b), and a copy cut, reordered or changed
// is refused whole instead of restoring half (CA10):
//
//   file   = MAGIC "RSCB1\n" · u32 header length · header JSON · frames…
//   frame  = u32 ciphertext length · nonce (12) · ciphertext · tag (16)
//
// The header is readable without the key (what the list shows: when, why, which key; never how much there is:
// the row counts and the sequences are the first two sections of the encrypted text). Each
// frame is AES-256-GCM with a key derived from the installation key and the file's own salt (scrypt), and
// authenticates sha256(header) ‖ its index ‖ whether it is the last one: a changed header, frames in another
// order, frames from another copy, or a file without its last frame never decrypt. The plain text is gzip of
// the tables, each as a `\copy` line, its rows in PostgreSQL's COPY text format, and a `\.` line.
import { createCipheriv, createDecipheriv, createHash, randomBytes, scrypt } from 'node:crypto'
import { type FileHandle, open } from 'node:fs/promises'
import { pipeline, Readable } from 'node:stream'
import { createGunzip, createGzip } from 'node:zlib'
import { keyedHash } from '../../auth/vault.ts'
import { AppError } from '../../core/errors.ts'

export const MAGIC = Buffer.from('RSCB1\n', 'latin1')
// Plain text per frame (gzip output). A frame on disk is never longer than this plus its 32 bytes of framing.
export const FRAME_BYTES = 64 * 1024
// A header lists tables and migrations; it is never near this, and a longer one is not read.
const MAX_HEADER = 1024 * 1024
// The one key derivation this format uses (32 MiB of memory). A header asking for anything else is refused
// before running it: the header is not authenticated until the first frame opens.
const KDF = { name: 'scrypt', N: 2 ** 15, r: 8, p: 1 } as const
const KEY_ID_LABEL = 'rsc-brain installation key id'

export const BACKUP_REASONS = ['scheduled', 'manual', 'pre-update', 'pre-restore'] as const
export type BackupReason = (typeof BACKUP_REASONS)[number]

export type Header = {
  format: 1
  product: 'rsc-brain'
  release: string
  migrations: string[]
  createdAt: string
  installation: { id: number; name: string }
  reason: BackupReason
  keyId: string
  kdf: { name: 'scrypt'; N: number; r: number; p: number; salt: string }
  // The tables the copy holds, in load order (their row counts are inside the encryption).
  tables: string[]
  // The last write the copy holds (the web warns what a restore loses after it).
  lastWriteAt: string | null
}
export type HeaderInput = Omit<Header, 'format' | 'product' | 'keyId' | 'kdf'>

// The id of an installation key, short enough to read aloud. It is a fingerprint keyed by the key itself, so
// whoever has a copy can test a guess of the key against it (one scrypt per guess): it protects nothing that the
// key's own length and randomness do not. The installer generates a long random key, and copies refuse a key
// shorter than RSC_BRAIN_SECRET may be (strongKey).
export function keyId(secret: string): string {
  return keyedHash(secret, KEY_ID_LABEL).slice(0, 12)
}

// At least 32 characters, measured as RSC_BRAIN_SECRET is measured at start (config.ts): the one rule there is.
// Whether the key is random is not checked here (no test of that is reliable); the installer generates it.
export function strongKey(secret: string): boolean {
  return secret.length >= 32
}

export const weakKey = () =>
  new AppError(
    409,
    'weak_installation_key',
    'The installation key is too short to protect a copy (RSC_BRAIN_SECRET needs at least 32 characters).',
    'Rotate to a long random key (the installer generates one: openssl rand -base64 48), then make a copy again.',
  )

// Writes every byte of `b`, however few each call takes (a nearly full disk may take part of a buffer without an
// error). A call that takes none is a full disk.
export async function writeFully(
  write: (b: Buffer, offset: number, length: number) => Promise<{ bytesWritten: number }>,
  b: Buffer,
): Promise<void> {
  let at = 0
  while (at < b.length) {
    const { bytesWritten } = await write(b, at, b.length - at)
    if (!(bytesWritten > 0)) {
      throw Object.assign(new Error('The disk took no more bytes.'), { code: 'ENOSPC' })
    }
    at += bytesWritten
  }
}

export const corruptCopy = () =>
  new AppError(
    422,
    'corrupt_copy',
    'This file is not a complete rsc-brain copy: it was cut, changed or not written to the end.',
    'Use another copy from the list (rsc-brain backups list); this one cannot be restored.',
  )

export const wrongKey = (needs: string) => {
  const e = new AppError(
    409,
    'wrong_key',
    `This copy was made with another installation key (key id ${needs}).`,
    `Pass the installation key whose id is ${needs}; rsc-brain key id prints the id of a key.`,
  )
  e.extra = { needs }
  return e
}

function deriveKey(secret: string, salt: Buffer): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scrypt(secret, salt, 32, { N: KDF.N, r: KDF.r, p: KDF.p, maxmem: 64 * 1024 * 1024 }, (err, key) =>
      err ? reject(err) : resolve(key),
    )
  })
}

function u32(n: number): Buffer {
  const b = Buffer.alloc(4)
  b.writeUInt32BE(n)
  return b
}
function u64(n: number): Buffer {
  const b = Buffer.alloc(8)
  b.writeBigUInt64BE(BigInt(n))
  return b
}
const aad = (headerHash: Buffer, index: number, final: boolean) =>
  Buffer.concat([headerHash, u64(index), Buffer.from([final ? 1 : 0])])

// Writes a whole copy through `write` (each call awaited, so the disk sets the pace) and says how many bytes.
export async function writeBackup(
  write: (b: Buffer) => Promise<unknown>,
  input: HeaderInput,
  rows: AsyncIterable<Buffer>,
  secret: string,
): Promise<{ bytes: number; header: Header }> {
  if (!strongKey(secret)) throw weakKey()
  const id = keyId(secret)
  const salt = randomBytes(16)
  const header: Header = {
    format: 1,
    product: 'rsc-brain',
    release: input.release,
    migrations: input.migrations,
    createdAt: input.createdAt,
    installation: input.installation,
    reason: input.reason,
    keyId: id,
    kdf: { ...KDF, salt: salt.toString('base64') },
    tables: input.tables,
    lastWriteAt: input.lastWriteAt,
  }
  const headerBytes = Buffer.from(JSON.stringify(header), 'utf8')
  const headerHash = createHash('sha256').update(headerBytes).digest()
  const key = await deriveKey(secret, salt)
  const prefix = randomBytes(4)
  let bytes = 0
  const put = async (b: Buffer) => {
    await write(b)
    bytes += b.length
  }
  await put(Buffer.concat([MAGIC, u32(headerBytes.length), headerBytes]))
  let index = 0
  const frame = async (plain: Buffer, final: boolean) => {
    const nonce = Buffer.concat([prefix, u64(index)])
    const c = createCipheriv('aes-256-gcm', key, nonce, { authTagLength: 16 })
    c.setAAD(aad(headerHash, index, final))
    const body = Buffer.concat([c.update(plain), c.final()])
    await put(Buffer.concat([u32(body.length), nonce, body, c.getAuthTag()]))
    index += 1
  }
  // A frame goes out only once more text follows it, so the last one is always known to be the last.
  let pending = Buffer.alloc(0)
  const gz = pipeline(Readable.from(rows), createGzip(), () => {})
  for await (const chunk of gz) {
    pending = Buffer.concat([pending, chunk as Buffer])
    while (pending.length > FRAME_BYTES) {
      await frame(pending.subarray(0, FRAME_BYTES), false)
      pending = pending.subarray(FRAME_BYTES)
    }
  }
  await frame(pending, true)
  return { bytes, header }
}

async function readExact(fh: FileHandle, position: number, length: number): Promise<Buffer | null> {
  const b = Buffer.alloc(length)
  let got = 0
  while (got < length) {
    const { bytesRead } = await fh.read(b, got, length - got, position + got)
    if (bytesRead === 0) return null
    got += bytesRead
  }
  return b
}

const isText = (v: unknown, max = 200): v is string => typeof v === 'string' && v.length <= max
const isCount = (v: unknown) => typeof v === 'number' && Number.isInteger(v) && v >= 0

function validHeader(h: unknown): h is Header {
  const x = h as Partial<Header> | null
  if (!x || typeof x !== 'object') return false
  const kdf = x.kdf
  return (
    x.format === 1 &&
    x.product === 'rsc-brain' &&
    isText(x.release, 64) &&
    Array.isArray(x.migrations) &&
    x.migrations.every((m) => isText(m, 120)) &&
    isText(x.createdAt, 40) &&
    !Number.isNaN(Date.parse(x.createdAt)) &&
    typeof x.installation === 'object' &&
    x.installation !== null &&
    isCount(x.installation.id) &&
    isText(x.installation.name, 400) &&
    BACKUP_REASONS.includes(x.reason as BackupReason) &&
    typeof x.keyId === 'string' &&
    /^[0-9a-f]{12}$/.test(x.keyId) &&
    typeof kdf === 'object' &&
    kdf !== null &&
    kdf.name === KDF.name &&
    kdf.N === KDF.N &&
    kdf.r === KDF.r &&
    kdf.p === KDF.p &&
    isText(kdf.salt, 64) &&
    Buffer.from(kdf.salt, 'base64').length === 16 &&
    Array.isArray(x.tables) &&
    x.tables.every((t) => isText(t, 64)) &&
    (x.lastWriteAt === null || isText(x.lastWriteAt, 40))
  )
}

async function headerOf(fh: FileHandle): Promise<{ header: Header; bytes: Buffer; end: number }> {
  const start = await readExact(fh, 0, MAGIC.length + 4)
  if (start === null) throw corruptCopy()
  if (!start.subarray(0, MAGIC.length).equals(MAGIC)) throw corruptCopy()
  const len = start.readUInt32BE(MAGIC.length)
  if (len === 0 || len > MAX_HEADER) throw corruptCopy()
  const bytes = await readExact(fh, MAGIC.length + 4, len)
  if (!bytes) throw corruptCopy()
  let header: unknown
  try {
    header = JSON.parse(bytes.toString('utf8'))
  } catch {
    throw corruptCopy()
  }
  if (!validHeader(header)) throw corruptCopy()
  return { header, bytes, end: MAGIC.length + 4 + len }
}

// The header alone, without the key: what the list of copies shows.
export async function readHeader(path: string): Promise<Header> {
  const fh = await open(path, 'r')
  try {
    return (await headerOf(fh)).header
  } finally {
    await fh.close()
  }
}

// Opens a copy with an installation key: refused at once with the id of the key it needs when the key is
// another; then the plain text, frame by frame, each authenticated before it is handed on. A damage found
// later (a cut, a frame out of place, no final frame) ends the reading with corrupt_copy, so whoever reads
// it (a restore, in one transaction) throws everything away. It carries the header its frames are bound to: a
// restore uses that one only, never a second reading of the file (decisions, B7 PR28 review).
export type OpenedBackup = AsyncIterable<Buffer> & { header: Header }
export async function openBackup(path: string, secret: string): Promise<OpenedBackup> {
  const fh = await open(path, 'r')
  let header: Header
  let headerBytes: Buffer
  let at: number
  try {
    ;({ header, bytes: headerBytes, end: at } = await headerOf(fh))
    if (keyId(secret) !== header.keyId) throw wrongKey(header.keyId)
  } catch (err) {
    await fh.close()
    throw err
  }
  const key = await deriveKey(secret, Buffer.from(header.kdf.salt, 'base64'))
  const headerHash = createHash('sha256').update(headerBytes).digest()
  async function* frames(): AsyncGenerator<Buffer> {
    try {
      let prefix: Buffer | null = null
      for (let index = 0; ; index += 1) {
        const lenBytes = await readExact(fh, at, 4)
        if (!lenBytes) throw corruptCopy() // ended without its final frame
        const len = lenBytes.readUInt32BE(0)
        if (len > FRAME_BYTES) throw corruptCopy()
        const rest = await readExact(fh, at + 4, 12 + len + 16)
        if (!rest) throw corruptCopy()
        at += 4 + 12 + len + 16
        const nonce = rest.subarray(0, 12)
        if (prefix === null) prefix = nonce.subarray(0, 4)
        if (!nonce.subarray(0, 4).equals(prefix) || nonce.readBigUInt64BE(4) !== BigInt(index))
          throw corruptCopy()
        const body = rest.subarray(12, 12 + len)
        const tag = rest.subarray(12 + len)
        const open = (final: boolean): Buffer | null => {
          try {
            const d = createDecipheriv('aes-256-gcm', key, nonce, { authTagLength: 16 })
            d.setAAD(aad(headerHash, index, final))
            d.setAuthTag(tag)
            return Buffer.concat([d.update(body), d.final()])
          } catch {
            return null
          }
        }
        const middle = open(false)
        const plain = middle ?? open(true)
        if (!plain) throw corruptCopy()
        yield plain
        if (middle === null) {
          // The final frame: the file ends here.
          if (await readExact(fh, at, 1)) throw corruptCopy()
          return
        }
      }
    } finally {
      await fh.close()
    }
  }
  const out = pipeline(Readable.from(frames()), createGunzip(), () => {})
  return {
    header,
    async *[Symbol.asyncIterator]() {
      try {
        for await (const c of out) yield c as Buffer
      } catch (err) {
        throw err instanceof AppError ? err : corruptCopy()
      }
    },
  }
}

// --- the plain text: tables in COPY text format ---

export const sectionHead = (table: string, columns: string[]) => `\\copy ${table} (${columns.join(',')})\n`
export const sectionEnd = '\\.\n'

// One value in PostgreSQL's COPY text format: \N for null; backslash, tab, newline and carriage return escaped,
// so a row is one line and a line `\.` can only be the end of a table.
export function encodeValue(v: string | null): string {
  if (v === null) return '\\N'
  return v.replace(/[\\\t\n\r]/g, (c) =>
    c === '\\' ? '\\\\' : c === '\t' ? '\\t' : c === '\n' ? '\\n' : '\\r',
  )
}
export const encodeRow = (values: Array<string | null>) => `${values.map(encodeValue).join('\t')}\n`

const UNESCAPE: Record<string, string> = { b: '\b', f: '\f', n: '\n', r: '\r', t: '\t', v: '\v' }
function decodeValue(field: string): string | null {
  if (field === '\\N') return null
  return field.replace(/\\(.)/g, (_, c: string) => UNESCAPE[c] ?? c)
}

const HEAD = /^\\copy ([a-z_][a-z0-9_]*) \(([a-z0-9_,]*)\)$/

export type SectionEvent =
  | { kind: 'table'; table: string; columns: string[] }
  | { kind: 'row'; values: Array<string | null> }

// Reads the plain text of a copy back as tables and rows. Anything out of shape is a corrupt copy.
export async function* readSections(plain: AsyncIterable<Buffer>): AsyncGenerator<SectionEvent> {
  let rest: Buffer = Buffer.alloc(0)
  let columns: string[] | null = null
  const line = function* (text: string): Generator<SectionEvent> {
    if (columns === null) {
      const m = HEAD.exec(text)
      if (!m) throw corruptCopy()
      columns = m[2] ? (m[2] as string).split(',') : []
      yield { kind: 'table', table: m[1] as string, columns }
      return
    }
    if (text === '\\.') {
      columns = null
      return
    }
    const values = text.split('\t').map(decodeValue)
    if (values.length !== columns.length) throw corruptCopy()
    yield { kind: 'row', values }
  }
  for await (const chunk of plain) {
    rest = rest.length ? Buffer.concat([rest, chunk]) : chunk
    let nl = rest.indexOf(0x0a)
    while (nl !== -1) {
      yield* line(rest.subarray(0, nl).toString('utf8'))
      rest = rest.subarray(nl + 1)
      nl = rest.indexOf(0x0a)
    }
  }
  if (rest.length > 0 || columns !== null) throw corruptCopy()
}
