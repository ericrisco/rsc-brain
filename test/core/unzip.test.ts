// The bounded zip reader of the import (plan §3.6, risk 8): it reads a zip held in memory and never writes to disk;
// a name that could land outside the folder (`..`, absolute, a drive, a link) refuses the whole file, as do an
// encrypted entry, a zip64 end, sizes or a CRC that lie, entries that overlap, and the same name twice. A file over
// 1 MB is listed but never read; more than 200 MB to unpack, or too many files, is refused before anything is read.
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { describe, it } from 'node:test'
import { openZip, UNZIP_LIMITS, UnzipError } from '../../src/core/unzip.ts'
import { zipWriter } from '../../src/core/zip.ts'
import { quotedZip, rawZip } from '../helpers/rawzip.ts'

const MB = 1024 * 1024

async function written(files: Record<string, string | Buffer>): Promise<Buffer> {
  const chunks: Buffer[] = []
  const z = zipWriter(async (b) => {
    chunks.push(Buffer.from(b))
  })
  for (const [name, data] of Object.entries(files)) {
    // Half of them by pieces (with a data descriptor after them), half at once.
    if (name.length % 2) {
      const f = await z.open(name)
      await f.write(data)
      await f.close()
    } else await z.file(name, data)
  }
  await z.end()
  return Buffer.concat(chunks)
}

const refused = (f: () => unknown, code: 'invalid_archive' | 'archive_too_large', why?: RegExp) =>
  assert.throws(f, (e: unknown) => {
    assert.ok(e instanceof UnzipError, String(e))
    assert.equal(e.code, code, e.message)
    if (why) assert.match(e.message, why)
    return true
  })

describe('the bounded zip reader', () => {
  it('reads what the export writes: every file, its bytes, by its name', async () => {
    const buf = await written({
      'wiki/a.md': '# A\n\nSee [[b]].',
      'wiki/deep/b.md': 'B',
      'raw/note.txt': 'x'.repeat(5000),
      'raw/é.md': 'accent',
    })
    const items = openZip(buf)
    assert.deepEqual(
      items.map((i) => [i.path, i.size, i.read().toString('utf8').slice(0, 6)]),
      [
        ['wiki/a.md', 15, '# A\n\nS'],
        ['wiki/deep/b.md', 1, 'B'],
        ['raw/note.txt', 5000, 'xxxxxx'],
        ['raw/é.md', 6, 'accent'],
      ],
    )
  })

  it('reads stored entries, skips folders, drops "." parts, and names in NFC', () => {
    const items = openZip(
      rawZip([
        { name: 'docs/', mode: 0o040755 },
        { name: 'docs/./a.md', data: 'stored', method: 0 },
        { name: 'docs/cafe\u0301.md', data: 'nfd' },
        // A name written without the UTF-8 flag, in plain ASCII, and one with Windows separators.
        { name: 'docs/plain.md', data: 'p', flags: 0 },
        { name: 'docs\\win\\c.md', data: 'w', host: 0, mode: 0 },
      ]),
    )
    assert.deepEqual(
      items.map((i) => [i.path, i.read().toString('utf8')]),
      [
        ['docs/a.md', 'stored'],
        ['docs/café.md', 'nfd'],
        ['docs/plain.md', 'p'],
        ['docs/win/c.md', 'w'],
      ],
    )
  })

  it('refuses a name that could land outside the folder it is unpacked in', () => {
    for (const name of [
      '../evil.md',
      'docs/../../evil.md',
      'docs/..',
      '..\\..\\evil.md',
      '/etc/passwd',
      '\\windows\\evil.md',
      'C:/evil.md',
      'c:evil.md',
      'docs//evil.md',
      'docs/\u0000.md',
      'docs/\u001b[31m.md',
      'docs/\u007f.md',
      '',
    ])
      refused(() => openZip(rawZip([{ name, data: 'x' }])), 'invalid_archive', /name/)
  })

  it('refuses a name that is not valid UTF-8, whether or not it says it is', () => {
    for (const flags of [0, 0x0800])
      refused(
        () =>
          openZip(rawZip([{ name: Buffer.from([0x64, 0xff, 0xfe, 0x2e, 0x6d, 0x64]), data: 'x', flags }])),
        'invalid_archive',
        /name/,
      )
  })

  it('refuses a symbolic link, and anything that is not a file or a folder', () => {
    refused(
      () => openZip(rawZip([{ name: 'link.md', data: '/etc/passwd', mode: 0o120777 }])),
      'invalid_archive',
      /link/,
    )
    for (const mode of [0o010644, 0o020644, 0o060644, 0o140644])
      refused(() => openZip(rawZip([{ name: 'odd.md', data: 'x', mode }])), 'invalid_archive')
    // A link made on a Mac says so the same way.
    refused(
      () => openZip(rawZip([{ name: 'l.md', data: 'x', mode: 0o120755, host: 19 }])),
      'invalid_archive',
      /link/,
    )
  })

  it('refuses an encrypted entry, and a way of packing it does not know', () => {
    refused(() => openZip(rawZip([{ name: 'a.md', data: 'x', flags: 0x0801 }])), 'invalid_archive', /encrypt/)
    refused(() => openZip(rawZip([{ name: 'a.md', data: 'x', flags: 0x0840 }])), 'invalid_archive', /encrypt/)
    // Said in only one of its two headers, it is still encrypted.
    for (const [flags, localFlags] of [
      [0x0801, 0x0800],
      [0x0841, 0x0800],
      [0x0840, 0x0800],
      [0x0800, 0x0801],
      [0x0800, 0x0840],
    ] as Array<[number, number]>)
      refused(
        () => openZip(rawZip([{ name: 'a.md', data: 'x', flags, localFlags }])),
        'invalid_archive',
        /encrypt/,
      )
    for (const method of [12, 14, 99])
      refused(() => openZip(rawZip([{ name: 'a.md', data: 'x', method }])), 'invalid_archive', /pack/)
  })

  it('refuses a zip64 end and a zip64 field (no export it reads needs one)', () => {
    refused(() => openZip(rawZip([{ name: 'a.md', data: 'x' }], { zip64: true })), 'invalid_archive', /zip64/)
    const extra = Buffer.alloc(20)
    extra.writeUInt16LE(0x0001, 0)
    extra.writeUInt16LE(16, 2)
    refused(() => openZip(rawZip([{ name: 'a.md', data: 'x', extra }])), 'invalid_archive', /zip64/)
  })

  it('refuses a CRC that does not match, and sizes that lie', () => {
    const bad = openZip(rawZip([{ name: 'a.md', data: 'hello', crc: 1234 }]))
    refused(() => bad[0]?.read(), 'invalid_archive', /damaged/)
    // It says 5 bytes and unpacks to 50 000: never more than it said.
    const bomb = openZip(rawZip([{ name: 'a.md', data: 'z'.repeat(50_000), size: 5 }]))
    refused(() => bomb[0]?.read(), 'invalid_archive', /damaged/)
    const short = openZip(rawZip([{ name: 'a.md', data: 'hello', size: 50 }]))
    refused(() => short[0]?.read(), 'invalid_archive', /damaged/)
    // Stored, its two sizes must be one.
    refused(() => openZip(rawZip([{ name: 'a.md', data: 'hello', method: 0, size: 6 }])), 'invalid_archive')
    // Data that runs past the end of the file.
    refused(() => openZip(rawZip([{ name: 'a.md', data: 'hello', compSize: 9999 }])), 'invalid_archive')
  })

  it('refuses entries that overlap, a local name unlike the central one, and the same name twice', () => {
    refused(
      () =>
        openZip(
          rawZip([
            { name: 'a.md', data: 'x'.repeat(100) },
            { name: 'b.md', data: 'x'.repeat(100), sameLocalAs: 0 },
          ]),
        ),
      'invalid_archive',
    )
    refused(() => openZip(rawZip([{ name: 'a.md', data: 'x', localName: '../a.md' }])), 'invalid_archive')
    // One entry inside another's bytes, each with its own header (a "quoted" bomb).
    refused(() => openZip(quotedZip()), 'invalid_archive', /overlap/)
    refused(
      () =>
        openZip(
          rawZip([
            { name: 'a/b.md', data: 'x' },
            { name: 'a/./b.md', data: 'y' },
          ]),
        ),
      'invalid_archive',
      /twice/,
    )
    refused(
      () =>
        openZip(
          rawZip([
            { name: 'caf\u00e9.md', data: 'x' },
            { name: 'cafe\u0301.md', data: 'y' },
          ]),
        ),
      'invalid_archive',
      /twice/,
    )
  })

  it('refuses what is not a zip, or is cut short', async () => {
    refused(() => openZip(Buffer.from('not a zip at all, just text')), 'invalid_archive')
    refused(() => openZip(Buffer.alloc(0)), 'invalid_archive')
    const whole = await written({ 'a.md': 'a', 'b.md': 'b' })
    refused(() => openZip(whole.subarray(0, whole.length - 30)), 'invalid_archive')
    // An end that counts more entries than the directory holds.
    refused(() => openZip(rawZip([{ name: 'a.md', data: 'x' }], { count: 2 })), 'invalid_archive')
    refused(() => openZip(rawZip([{ name: 'a.md', data: 'x' }], { cdOffset: 3 })), 'invalid_archive')
    // Bytes after the end, or in the directory past its entries: nothing is hidden where it is not read.
    refused(() => openZip(Buffer.concat([whole, Buffer.from('trailing')])), 'invalid_archive')
    refused(() => openZip(rawZip([{ name: 'a.md', data: 'x' }], { cdPad: 46 })), 'invalid_archive')
  })

  it('lists a file over 1 MB without reading it, and does not count it', () => {
    const items = openZip(
      rawZip([
        { name: 'big.md', data: 'y'.repeat(MB + 1) },
        { name: 'edge.md', data: 'y'.repeat(MB) },
      ]),
    )
    assert.deepEqual(
      items.map((i) => [i.path, i.size, i.tooLarge]),
      [
        ['big.md', MB + 1, true],
        ['edge.md', MB, false],
      ],
    )
    refused(() => items[0]?.read(), 'invalid_archive', /1 MB/)
    assert.equal(items[1]?.read().length, MB)
  })

  it('refuses more than 200 MB to unpack before reading any of it', () => {
    assert.equal(UNZIP_LIMITS.totalBytes, 200 * MB)
    assert.equal(UNZIP_LIMITS.fileBytes, MB)
    // 201 files that each say 1 MB: refused by what they say, nothing unpacked.
    const many = Array.from({ length: 201 }, (_, i) => ({ name: `f${i}.md`, data: 'x', size: MB }))
    refused(() => openZip(rawZip(many)), 'archive_too_large', /200 MB/)
    // 200 of them is the limit, not over it; and a file over 1 MB is never unpacked, so it does not count.
    assert.equal(openZip(rawZip(many.slice(0, 200))).length, 200)
    const withBig = [...many.slice(0, 200), { name: 'big.md', data: 'x', size: 50 * MB }]
    assert.equal(openZip(rawZip(withBig)).length, 201)
  })

  it('refuses too many files', () => {
    assert.equal(UNZIP_LIMITS.entries, 20_000)
    const names = Array.from({ length: 20_001 }, (_, i) => ({ name: `d/${i}.md`, method: 0 }))
    refused(() => openZip(rawZip(names)), 'archive_too_large', /20 000/)
    assert.equal(openZip(rawZip(names.slice(0, 20_000))).length, 20_000)
    // Folders count too: a zip of empty folders is no cheaper to walk.
    refused(
      () => openZip(rawZip(Array.from({ length: 20_001 }, (_, i) => ({ name: `d${i}/`, mode: 0o040755 })))),
      'archive_too_large',
    )
  })

  it('never touches the disk', async () => {
    const src = await readFile(new URL('../../src/core/unzip.ts', import.meta.url), 'utf8')
    assert.doesNotMatch(src, /node:fs|from 'fs'|node:child_process/)
  })
})
