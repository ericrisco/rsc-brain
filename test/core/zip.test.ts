// The zip writer of the exports (spec B7 C16, plan T021): our own, on node:zlib only. The system's `unzip -t`
// accepts what it writes; names are UTF-8 and flagged as such; a big file goes through in pieces (memory stays
// bounded); more than 65 535 files take the zip64 end; a name that could land outside the folder it is
// unpacked in is refused before anything of it is written.
import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, describe, it } from 'node:test'
import { safeZipName, zipWriter } from '../../src/core/zip.ts'
import { readZip } from '../helpers/unzip.ts'

const hasUnzip = spawnSync('unzip', ['-v']).status === 0
const unicodeUnzip =
  hasUnzip && /UNICODE_SUPPORT/.test(spawnSync('unzip', ['-v'], { encoding: 'utf8' }).stdout)
const hasPython = spawnSync('python3', ['-I', '-c', 'import zipfile']).status === 0
const PY_NAMES = 'import json,sys,zipfile; print(json.dumps(zipfile.ZipFile(sys.argv[1]).namelist()))'
const dir = mkdtempSync(join(tmpdir(), 'rsc-brain-zip-'))
after(() => rmSync(dir, { recursive: true, force: true }))

// A sink that keeps what it is given: what an export streams to the client.
function memory() {
  const chunks: Buffer[] = []
  let biggest = 0
  return {
    sink: async (b: Buffer) => {
      biggest = Math.max(biggest, b.length)
      chunks.push(Buffer.from(b))
    },
    bytes: () => Buffer.concat(chunks),
    biggest: () => biggest,
  }
}

const unzipTest = (file: string) => spawnSync('unzip', ['-t', '-qq', file], { encoding: 'utf8' })

describe('the zip writer', () => {
  it('writes a file the system unzip accepts, with UTF-8 names, an empty file and a streamed one', async (t) => {
    const m = memory()
    const z = zipWriter(m.sink, { at: new Date('2026-11-02T10:20:30Z') })
    await z.file('README.md', '# Hello\n')
    await z.file('wiki/café/ñandú-日本.md', 'Text with ñ and 日本.\n')
    await z.file('empty.md', '')
    const big = await z.open('raw/big.ndjson')
    const line = `${JSON.stringify({ id: 'x', text: 'lorem ipsum '.repeat(40) })}\n`
    for (let i = 0; i < 20_000; i++) await big.write(line)
    await big.close()
    const done = await z.end()
    const bytes = m.bytes()
    assert.equal(done.bytes, bytes.length)
    assert.equal(done.files, 4)

    const entries = readZip(bytes)
    assert.deepEqual(
      entries.map((e) => e.name),
      ['README.md', 'wiki/café/ñandú-日本.md', 'empty.md', 'raw/big.ndjson'],
    )
    // Every name says it is UTF-8 (general purpose bit 11), so no tool guesses a code page.
    assert.ok(entries.every((e) => e.utf8))
    assert.equal(entries[1]?.data.toString('utf8'), 'Text with ñ and 日本.\n')
    assert.equal(entries[2]?.data.length, 0)
    assert.equal(entries[3]?.data.toString('utf8'), line.repeat(20_000))
    // Compressed, and streamed: no single piece handed to the sink holds the whole big file.
    assert.ok(bytes.length < (line.length * 20_000) / 5)
    assert.ok(m.biggest() < 1_048_576, `a piece of ${m.biggest()} bytes`)

    if (!hasUnzip) return t.skip('skipped: the system has no unzip')
    const file = join(dir, 'one.zip')
    writeFileSync(file, bytes)
    const r = unzipTest(file)
    assert.equal(r.status, 0, r.stdout + r.stderr)
    // The names as UTF-8: by unzip when it is built with Unicode (macOS's is not), and by Python's zipfile,
    // another reader that honours the flag.
    if (unicodeUnzip) {
      const listed = execFileSync('unzip', ['-Z1', file], { encoding: 'utf8' }).trim().split('\n')
      assert.ok(listed.includes('wiki/café/ñandú-日本.md'), listed.join(' | '))
    }
    if (hasPython) {
      const names = JSON.parse(
        execFileSync('python3', ['-I', '-c', PY_NAMES, file], { encoding: 'utf8' }),
      ) as string[]
      assert.ok(names.includes('wiki/café/ñandú-日本.md'), names.join(' | '))
    }
    assert.equal(execFileSync('unzip', ['-p', file, 'README.md'], { encoding: 'utf8' }), '# Hello\n')
  })

  it('takes more than 65 535 files (the zip64 end)', async (t) => {
    const m = memory()
    const z = zipWriter(m.sink)
    for (let i = 0; i < 65_600; i++) await z.file(`n/${i}.md`, i % 1000 === 0 ? `note ${i}` : '')
    const done = await z.end()
    assert.equal(done.files, 65_600)
    const entries = readZip(m.bytes())
    assert.equal(entries.length, 65_600)
    assert.equal(entries[65_000]?.name, 'n/65000.md')
    assert.equal(entries[65_000]?.data.toString(), 'note 65000')
    if (!hasUnzip) return t.skip('skipped: the system has no unzip')
    const file = join(dir, 'many.zip')
    writeFileSync(file, m.bytes())
    const r = unzipTest(file)
    assert.equal(r.status, 0, r.stdout + r.stderr)
  })

  it('refuses a name that could land outside the folder, before writing any of it', async () => {
    const bad = [
      '',
      '../escape.md',
      'wiki/../../escape.md',
      'wiki/..',
      './here.md',
      'wiki/./x.md',
      '/etc/passwd',
      'C:/windows.md',
      'c:evil.md',
      'wiki\\..\\escape.md',
      'wiki//double.md',
      'wiki/trailing/',
      'nul\u0000.md',
      'line\nbreak.md',
      'tab\there.md',
      'broken\ud800.md',
      'x'.repeat(65_536),
    ]
    for (const name of bad) {
      assert.throws(() => safeZipName(name), /not a safe name/, JSON.stringify(name.slice(0, 40)))
      const m = memory()
      const z = zipWriter(m.sink)
      await assert.rejects(z.file(name, 'x'), /not a safe name/)
      await assert.rejects(z.open(name), /not a safe name/)
      assert.equal(m.bytes().length, 0, `something of ${JSON.stringify(name.slice(0, 40))} was written`)
    }
    for (const good of ['a.md', 'wiki/audience/retention.md', 'raw/journal/2026/11/x.md', 'wiki/a..b.md'])
      assert.equal(safeZipName(good), good)
  })

  it('refuses the same name twice, and a file opened while another is open', async () => {
    const z = zipWriter(memory().sink)
    await z.file('a.md', 'one')
    await assert.rejects(z.file('a.md', 'two'), /twice/)
    const open = await z.open('b.md')
    await assert.rejects(z.file('c.md', 'x'), /still open/)
    await assert.rejects(z.end(), /still open/)
    await open.close()
    await z.end()
    await assert.rejects(z.file('d.md', 'x'), /ended/)
  })

  it('stops at the first failure of the sink (the client went away), and stays stopped', async () => {
    // The sink fails once, then would take anything: the zip must not go on as if nothing happened.
    let calls = 0
    const z = zipWriter(async () => {
      calls += 1
      if (calls === 1) throw new Error('client gone')
    })
    await assert.rejects(z.file('a.md', 'one'), /client gone/)
    await assert.rejects(z.file('b.md', 'two'), /client gone/)
    await assert.rejects(z.open('c.md'), /client gone/)
    await assert.rejects(z.end(), /client gone/)
    assert.equal(calls, 1)
  })
})
