// Settings › Export (spec B7 «Exportar», plan T024): what the screen asks the server for, and how it says the
// size of what arrived.
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { exportAsk, sizeLabel } from '../../web/src/lib/exporting.ts'

describe('the export of a brain, in the web', () => {
  it('asks for the format, and for forgotten entries only when ticked', () => {
    assert.deepEqual(exportAsk('growth', 'readable', false), {
      path: { slug: 'growth' },
      query: { format: 'readable' },
    })
    assert.deepEqual(exportAsk('growth', 'faithful', true), {
      path: { slug: 'growth' },
      query: { format: 'faithful', includeForgotten: 1 },
    })
  })

  it('says sizes as people read them', () => {
    assert.equal(sizeLabel(0), '0 bytes')
    assert.equal(sizeLabel(1), '1 byte')
    assert.equal(sizeLabel(999), '999 bytes')
    assert.equal(sizeLabel(1500), '1.5 kB')
    assert.equal(sizeLabel(2_400_000), '2.4 MB')
    assert.equal(sizeLabel(3_250_000_000), '3.3 GB')
  })
})
