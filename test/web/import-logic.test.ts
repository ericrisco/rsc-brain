// Settings › Import (spec B7 «Importar», plan T031): what the screen checks before anything goes up (a .zip, not
// empty, at most 50 MB), and how it says the report: a sentence of what came in, and why each thing was left out.
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { fileProblem, IMPORT_MAX_BYTES, importAsk, importDone, whyText } from '../../web/src/lib/importing.ts'

describe('the import of a folder, in the web', () => {
  it('takes a .zip of at most 50 MB, and says what is wrong with anything else before it goes up', () => {
    assert.equal(IMPORT_MAX_BYTES, 50 * 1024 * 1024)
    assert.equal(fileProblem({ name: 'docs.zip', size: 10 }), null)
    assert.equal(fileProblem({ name: 'DOCS.ZIP', size: IMPORT_MAX_BYTES }), null)
    assert.match(String(fileProblem({ name: 'docs.tar.gz', size: 10 })), /\.zip/)
    assert.match(String(fileProblem({ name: 'docs.zip', size: 0 })), /empty/)
    const big = String(fileProblem({ name: 'docs.zip', size: IMPORT_MAX_BYTES + 1 }))
    assert.match(big, /52\.4 MB/)
    assert.match(big, /50 MB/)
    assert.match(big, /command line/)
  })

  it('asks with the name of the file', () => {
    assert.deepEqual(importAsk('growth', 'docs.zip'), {
      path: { slug: 'growth' },
      query: { name: 'docs.zip' },
    })
  })

  it('says what came in, in one sentence', () => {
    const r = { kind: 'docs', pages: 5, entries: 1, links: 0 } as const
    assert.equal(importDone(r, 'docs.zip'), 'Imported 5 pages, 1 entry and no links from docs.zip.')
    assert.equal(
      importDone({ kind: 'faithful', pages: 1, entries: 0, links: 2 }, 'faith.zip'),
      'Imported 1 page, no entries and 2 links from faith.zip.',
    )
  })

  it('says why each file was left out, in words', () => {
    for (const why of ['binary', 'too_large', 'not_markdown', 'hidden', 'secret', 'outside', 'link'] as const)
      assert.ok(whyText(why).length > 5, why)
    assert.match(whyText('secret'), /never read/)
    assert.equal(whyText('unknown' as never), 'left out')
  })
})
