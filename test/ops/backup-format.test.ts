// The copy file `.rscb` (spec B7 «Copias y restauración», CA9b, CA10, CA20; plan §3.2): a readable header and
// frames of AES-256-GCM, each bound to the header, to its place and to whether it is the last one. A copy
// read without its key says which key it needs; a copy cut, reordered, changed or without its last frame is
// refused whole. Runs without PostgreSQL (CI).
import assert from 'node:assert/strict'
import { createCipheriv, createHash, randomBytes, scryptSync } from 'node:crypto'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, describe, it } from 'node:test'
import { gunzipSync, gzipSync } from 'node:zlib'
import { AppError } from '../../src/core/errors.ts'
import {
  FRAME_BYTES,
  type HeaderInput,
  keyId,
  MAGIC,
  openBackup,
  readHeader,
  readSections,
  sectionEnd,
  sectionHead,
  strongKey,
  writeBackup,
  writeFully,
} from '../../src/ops/backup/format.ts'

const A = 'key-a-of-the-tests-with-more-than-thirty-two-chars'
const B = 'key-b-of-the-tests-with-more-than-thirty-two-chars'

const input = (o: Partial<HeaderInput> = {}): HeaderInput => ({
  release: '0.1.0',
  migrations: ['0001_accounts_brains_keys', '0022_maintenance'],
  createdAt: '2026-11-02T03:00:00.000Z',
  installation: { id: 1, name: 'Acme rsc-brain' },
  reason: 'manual',
  tables: ['entries'],
  lastWriteAt: '2026-11-02T02:59:00.000Z',
  ...o,
})

async function* chunks(...parts: Array<string | Buffer>): AsyncIterable<Buffer> {
  for (const p of parts) yield Buffer.isBuffer(p) ? p : Buffer.from(p, 'utf8')
}

// Where each piece of a file is, read the way plan §3.2 lays it out: magic, u32 length, header, then frames of
// u32 length of the ciphertext · nonce (12) · ciphertext · tag (16).
function layout(file: Buffer): { headerEnd: number; frames: Array<{ start: number; end: number }> } {
  const len = file.readUInt32BE(MAGIC.length)
  const headerEnd = MAGIC.length + 4 + len
  const frames: Array<{ start: number; end: number }> = []
  let at = headerEnd
  while (at < file.length) {
    const n = file.readUInt32BE(at)
    const end = at + 4 + 12 + n + 16
    frames.push({ start: at, end })
    at = end
  }
  return { headerEnd, frames }
}

async function readAll(it: AsyncIterable<Buffer>): Promise<Buffer> {
  const out: Buffer[] = []
  for await (const c of it) out.push(c)
  return Buffer.concat(out)
}

function isCode(code: string) {
  return (err: unknown) => {
    assert.ok(err instanceof AppError, String(err))
    assert.equal(err.code, code)
    assert.ok(err.howToProceed.length > 0)
    return true
  }
}

describe('the .rscb copy format', () => {
  let dir: string
  // Random hex barely compresses: ~3 frames of gzip output.
  const big = Array.from({ length: 3000 }, () => `${randomBytes(48).toString('hex')}\n`).join('')
  let bigFile: string
  before(async () => {
    dir = await mkdtemp(join(tmpdir(), 'rscb-format-'))
    bigFile = join(dir, 'big.rscb')
    const parts: Buffer[] = []
    await writeBackup(async (b) => void parts.push(Buffer.from(b)), input(), chunks(big), A)
    await writeFile(bigFile, Buffer.concat(parts))
  })
  after(async () => rm(dir, { recursive: true, force: true }))

  async function write(name: string, text: string, secret = A, o: Partial<HeaderInput> = {}) {
    const parts: Buffer[] = []
    const r = await writeBackup(async (b) => void parts.push(Buffer.from(b)), input(o), chunks(text), secret)
    const file = Buffer.concat(parts)
    assert.equal(r.bytes, file.length)
    await writeFile(join(dir, name), file)
    return { path: join(dir, name), file, header: r.header }
  }

  it('keyId: 12 hex characters, the same for the same key, never the key nor a plain hash of it', () => {
    assert.match(keyId(A), /^[0-9a-f]{12}$/)
    assert.equal(keyId(A), keyId(A))
    assert.notEqual(keyId(A), keyId(B))
    assert.ok(!A.includes(keyId(A)))
    // Keyed: a plain digest of the key would let anyone test guesses against the id.
    assert.notEqual(keyId(A), createHash('sha256').update(A).digest('hex').slice(0, 12))
  })

  it('review of PR #29: opening gives the header the frames are bound to, so a restore never reads it twice', async () => {
    const opened = await openBackup(bigFile, A)
    assert.deepEqual(opened.header, await readHeader(bigFile))
    assert.equal((await readAll(opened)).toString('utf8'), big)
  })

  it('review of PR #29: no copy with a short or obviously weak key', async () => {
    const sink = async () => {}
    for (const weak of ['short-key', 'a'.repeat(64), '01'.repeat(20), 'abcdefgh'.repeat(5)]) {
      await assert.rejects(
        () => writeBackup(sink, input(), chunks('x'), weak),
        (err: unknown) => isCode('weak_installation_key')(err) && !(err as Error).message.includes(weak),
      )
    }
    assert.ok(strongKey(A) && strongKey(B))
  })

  it('review of PR #29: every byte is written, however few each write takes; a write that takes none is a full disk', async () => {
    const got: Buffer[] = []
    const dribble = async (b: Buffer, offset: number, length: number) => {
      const n = Math.min(length, 7)
      got.push(Buffer.from(b.subarray(offset, offset + n)))
      return { bytesWritten: n }
    }
    const data = Buffer.from('0123456789'.repeat(10))
    await writeFully(dribble, data)
    assert.deepEqual(Buffer.concat(got), data)
    // A disk that takes nothing: refused at the first such call, never retried for ever.
    let calls = 0
    const stuck = async () => {
      calls += 1
      if (calls > 100) throw new Error('still retrying')
      return { bytesWritten: 0 }
    }
    await assert.rejects(
      () => writeFully(stuck, data),
      (err: unknown) => (err as { code?: string }).code === 'ENOSPC',
    )
    assert.equal(calls, 1)
  })

  it('round trip: what was written is what is read, across several frames', async () => {
    assert.ok(layout(await readFile(bigFile)).frames.length > 2, 'the test data spans more than two frames')
    const back = await readAll(await openBackup(bigFile, A))
    assert.equal(back.toString('utf8'), big)
    assert.ok(FRAME_BYTES >= 16 * 1024 && FRAME_BYTES <= 1024 * 1024)
  })

  it('the header reads without the key, and carries what the list and a restore need', async () => {
    const { path } = await write('h.rscb', 'x')
    const h = await readHeader(path)
    assert.equal(h.format, 1)
    assert.equal(h.product, 'rsc-brain')
    assert.equal(h.reason, 'manual')
    assert.equal(h.keyId, keyId(A))
    assert.deepEqual(h.tables, ['entries'])
    // Review of PR #29: nothing in the readable header says how much there is (no counts, no sequences).
    assert.deepEqual(Object.keys(h).sort(), [
      'createdAt',
      'format',
      'installation',
      'kdf',
      'keyId',
      'lastWriteAt',
      'migrations',
      'product',
      'reason',
      'release',
      'tables',
    ])
    assert.deepEqual(h.installation, { id: 1, name: 'Acme rsc-brain' })
    assert.equal(h.createdAt, '2026-11-02T03:00:00.000Z')
    assert.equal(h.kdf.name, 'scrypt')
    assert.deepEqual([h.kdf.N, h.kdf.r, h.kdf.p], [2 ** 15, 8, 1])
    // A fresh salt per file: the same key gives a different file key each time.
    const h2 = await readHeader((await write('h2.rscb', 'x')).path)
    assert.notEqual(h.kdf.salt, h2.kdf.salt)
  })

  it('an empty copy still ends with its final frame', async () => {
    const { path, file } = await write('empty.rscb', '')
    assert.equal(layout(file).frames.length, 1)
    assert.equal((await readAll(await openBackup(path, A))).length, 0)
  })

  it('CA20: another key is refused with the id of the key it needs, before reading anything', async () => {
    await assert.rejects(
      () => openBackup(bigFile, B),
      (err: unknown) => {
        isCode('wrong_key')(err)
        assert.equal((err as AppError).extra?.needs, keyId(A))
        assert.match((err as AppError).message, new RegExp(keyId(A)))
        assert.ok(!(err as AppError).message.includes(A) && !(err as AppError).message.includes(B))
        return true
      },
    )
  })

  it('a copy that says the right key id but was sealed with another key is corrupt, not opened', async () => {
    const other = await write('other.rscb', big, B)
    // The header of B's copy with A's id written in (same length: 12 hex each).
    const swapped = Buffer.from(other.file.toString('latin1').replace(keyId(B), keyId(A)), 'latin1')
    assert.equal(swapped.length, other.file.length)
    const p = join(dir, 'swapped.rscb')
    await writeFile(p, swapped)
    await assert.rejects(() => readAll(openBackupSync(p, A)), isCode('corrupt_copy'))
  })

  // openBackup is async; reading through it either rejects at open or during iteration.
  function openBackupSync(path: string, secret: string): AsyncIterable<Buffer> {
    return {
      async *[Symbol.asyncIterator]() {
        yield* await openBackup(path, secret)
      },
    }
  }

  async function corrupt(name: string, bytes: Buffer) {
    const p = join(dir, name)
    await writeFile(p, bytes)
    await assert.rejects(() => readAll(openBackupSync(p, A)), isCode('corrupt_copy'))
  }

  it('cut in the middle of a frame → corrupt_copy', async () => {
    const f = await readFile(bigFile)
    const { frames } = layout(f)
    const mid = frames[1] as { start: number; end: number }
    await corrupt('cut-mid.rscb', f.subarray(0, mid.start + 40))
    await corrupt('cut-last-byte.rscb', f.subarray(0, f.length - 1))
  })

  it('cut at a frame boundary, without its final frame → corrupt_copy', async () => {
    const f = await readFile(bigFile)
    const { frames } = layout(f)
    const last = frames[frames.length - 1] as { start: number }
    await corrupt('no-final.rscb', f.subarray(0, last.start))
    // Only the header left.
    await corrupt('header-only.rscb', f.subarray(0, layout(f).headerEnd))
  })

  it('frames reordered, repeated or dropped → corrupt_copy', async () => {
    const f = await readFile(bigFile)
    const { headerEnd, frames } = layout(f)
    const piece = (i: number) => f.subarray(frames[i]?.start, frames[i]?.end)
    const head = f.subarray(0, headerEnd)
    const rest = frames.slice(2).map((_, i) => piece(i + 2))
    await corrupt('swapped.rscb', Buffer.concat([head, piece(1), piece(0), ...rest]))
    await corrupt('repeated.rscb', Buffer.concat([head, piece(0), piece(0), piece(1), ...rest]))
    await corrupt('dropped.rscb', Buffer.concat([head, piece(0), ...rest]))
  })

  it('a final frame moved into the middle is not taken as the end', async () => {
    const f = await readFile(bigFile)
    const { headerEnd, frames } = layout(f)
    const n = frames.length
    const piece = (i: number) => f.subarray(frames[i]?.start, frames[i]?.end)
    const middle = frames.slice(1, n - 1).map((_, i) => piece(i + 1))
    await corrupt('final-early.rscb', Buffer.concat([f.subarray(0, headerEnd), piece(n - 1), ...middle]))
  })

  it('a whole gzip stream in frames none of which says it is the last → corrupt_copy', async () => {
    // Written here from plan §3.2 alone, not by the product: the same header, then one frame that holds a
    // complete gzip stream but is sealed as a middle frame. Only the final flag can tell it is cut.
    const f = await readFile(bigFile)
    const { headerEnd } = layout(f)
    const header = f.subarray(MAGIC.length + 4, headerEnd)
    const salt = Buffer.from(JSON.parse(header.toString('utf8')).kdf.salt, 'base64')
    const key = scryptSync(A, salt, 32, { N: 2 ** 15, r: 8, p: 1, maxmem: 64 * 1024 * 1024 })
    const hash = createHash('sha256').update(header).digest()
    const u64 = (n: number) => {
      const b = Buffer.alloc(8)
      b.writeBigUInt64BE(BigInt(n))
      return b
    }
    // `sealedAs`: the index in the authenticated data, when a test wants it to differ from the nonce's.
    const frameOf = (plain: Buffer, index: number, final: boolean, sealedAs = index) => {
      const nonce = Buffer.concat([Buffer.from([1, 2, 3, 4]), u64(index)])
      const c = createCipheriv('aes-256-gcm', key, nonce)
      c.setAAD(Buffer.concat([hash, u64(sealedAs), Buffer.from([final ? 1 : 0])]))
      const body = Buffer.concat([c.update(plain), c.final()])
      const len = Buffer.alloc(4)
      len.writeUInt32BE(body.length)
      return Buffer.concat([len, nonce, body, c.getAuthTag()])
    }
    const whole = gzipSync(Buffer.from('a complete stream\n'))
    // The same frame sealed as the last one opens: the test speaks the format.
    const good = join(dir, 'crafted-final.rscb')
    await writeFile(good, Buffer.concat([f.subarray(0, headerEnd), frameOf(whole, 0, true)]))
    assert.equal((await readAll(await openBackup(good, A))).toString('utf8'), 'a complete stream\n')
    await corrupt(
      'crafted-no-final.rscb',
      Buffer.concat([f.subarray(0, headerEnd), frameOf(whole, 0, false)]),
    )
    // A frame out of its place, its text still a whole gzip stream (so only the index can tell): the nonce
    // and the authenticated index both say 5 at place 0; the nonce says 5 and the authenticated index 0; the
    // second frame's nonce says 1 and its authenticated index 0.
    const head = f.subarray(0, headerEnd)
    await corrupt('crafted-index-both.rscb', Buffer.concat([head, frameOf(whole, 5, true)]))
    await corrupt('crafted-index-nonce.rscb', Buffer.concat([head, frameOf(whole, 5, true, 0)]))
    await corrupt(
      'crafted-index-aad.rscb',
      Buffer.concat([head, frameOf(whole.subarray(0, 8), 0, false), frameOf(whole.subarray(8), 1, true, 0)]),
    )
    // And the two-frame split sealed rightly opens: the content above was never the problem.
    const split = join(dir, 'crafted-split.rscb')
    await writeFile(
      split,
      Buffer.concat([head, frameOf(whole.subarray(0, 8), 0, false), frameOf(whole.subarray(8), 1, true)]),
    )
    assert.equal((await readAll(await openBackup(split, A))).toString('utf8'), 'a complete stream\n')
  })

  it('anything after the final frame → corrupt_copy', async () => {
    const f = await readFile(bigFile)
    await corrupt('trailing.rscb', Buffer.concat([f, Buffer.from([0, 0, 0, 0])]))
  })

  it('one bit changed in a frame → corrupt_copy', async () => {
    const f = Buffer.from(await readFile(bigFile))
    const { frames } = layout(f)
    const at = (frames[1]?.start as number) + 4 + 12 + 5
    f[at] = (f[at] as number) ^ 1
    await corrupt('bitflip.rscb', f)
  })

  it('the header is bound to the frames: a changed date (same length) → corrupt_copy', async () => {
    const { file } = await write('bound.rscb', 'row\n', A)
    const changed = Buffer.from(
      file.toString('latin1').replace('"createdAt":"2026-11-02T03', '"createdAt":"2026-11-02T04'),
      'latin1',
    )
    assert.notDeepEqual(changed, file)
    await corrupt('bound-changed.rscb', changed)
  })

  it('frames of another copy with the same key do not fit this header', async () => {
    const one = await write('one.rscb', 'first copy\n')
    const two = await write('two.rscb', 'second copy\n')
    const l1 = layout(one.file)
    const l2 = layout(two.file)
    await corrupt(
      'mixed.rscb',
      Buffer.concat([one.file.subarray(0, l1.headerEnd), two.file.subarray(l2.headerEnd)]),
    )
  })

  it('not a copy, a huge header length or unknown key-derivation settings → corrupt_copy, nothing run', async () => {
    await corrupt('nomagic.rscb', Buffer.from('PK\u0003\u0004 not a copy at all'))
    const huge = Buffer.concat([MAGIC, Buffer.from([0xff, 0xff, 0xff, 0xf0])])
    await corrupt('huge.rscb', huge)
    await assert.rejects(() => readHeader(join(dir, 'huge.rscb')), isCode('corrupt_copy'))
    // A header asking for a key derivation that would take gigabytes is never run.
    const { file } = await write('kdf.rscb', 'x')
    const greedy = Buffer.from(file.toString('latin1').replace('"N":32768', '"N":99999'), 'latin1')
    await corrupt('kdf-greedy.rscb', greedy)
    const t0 = Date.now()
    await assert.rejects(() => readHeader(join(dir, 'kdf-greedy.rscb')), isCode('corrupt_copy'))
    assert.ok(Date.now() - t0 < 1000)
  })

  it('CA9b: no content, name, email, secret or audit text is readable in the file, nor in any gunzip of it', async () => {
    const canaries = [
      'CANARY-ENTRY-7f3a9e',
      'canary.person@example.org',
      'Canary Person Name',
      'CANARY-PAGE-BODY-b81c',
      'CANARY-AUDIT-DETAIL-22d0',
      'sk-canary-provider-key-0123456789',
    ]
    const text = `${canaries.map((c) => `${c}\t${c}\n`).join('')}${big.slice(0, 5000)}`
    const { file } = await write('canary.rscb', text)
    const views = [file.toString('utf8'), file.toString('latin1'), file.toString('utf16le')]
    // Any gzip stream inside the file, wherever it starts.
    for (let i = 0; i + 1 < file.length; i += 1) {
      if (file[i] === 0x1f && file[i + 1] === 0x8b) {
        try {
          views.push(gunzipSync(file.subarray(i)).toString('utf8'))
        } catch {
          // not a stream: nothing readable there
        }
      }
    }
    for (const v of views) {
      for (const c of canaries) assert.ok(!v.includes(c), `"${c}" is readable in the copy`)
      assert.ok(!v.includes(A), 'the key is in the copy')
    }
    // And it does read back with the key.
    assert.equal((await readAll(await openBackup(join(dir, 'canary.rscb'), A))).toString('utf8'), text)
  })

  it('sections: COPY text rows per table, with escapes, read back value by value', async () => {
    const rows: Array<Array<string | null>> = [
      ['e1', 'tab\there', 'line\nbreak', null],
      ['e2', 'back\\slash', '\\.', 'cr\rend'],
      ['e3', '', '\\N', 'ünïcödé ✓'],
    ]
    const text =
      sectionHead('entries', ['id', 'a', 'b', 'c']) +
      rows.map((r) => `${r.map((v) => encodeForTest(v)).join('\t')}\n`).join('') +
      sectionEnd +
      sectionHead('pages', ['id']) +
      sectionEnd
    const { path } = await write('sections.rscb', text)
    const got: Array<{ table: string; columns: string[]; rows: Array<Array<string | null>> }> = []
    for await (const ev of readSections(await openBackup(path, A))) {
      if (ev.kind === 'table') got.push({ table: ev.table, columns: ev.columns, rows: [] })
      else got[got.length - 1]?.rows.push(ev.values)
    }
    assert.deepEqual(got, [
      { table: 'entries', columns: ['id', 'a', 'b', 'c'], rows },
      { table: 'pages', columns: ['id'], rows: [] },
    ])
  })
})

// The test's own encoder, written from PostgreSQL's COPY text rules, so the product's encoder is not
// checked against itself.
function encodeForTest(v: string | null): string {
  if (v === null) return '\\N'
  return v.replaceAll('\\', '\\\\').replaceAll('\t', '\\t').replaceAll('\n', '\\n').replaceAll('\r', '\\r')
}
