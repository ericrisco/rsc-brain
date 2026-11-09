// Closing review, visual gap 1: the graph's lines are quiet, as in a flow editor. Thin and pale at rest, the
// kinds told apart by their dash and arrowhead (never by colour alone), contradicts only tinted, and the
// lines of the page picked (or under the pointer) at full strength.
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { EDGE, LINE } from '../../web/src/graph/lines.ts'

describe('the lines of the graph', () => {
  const kinds = Object.keys(LINE).filter((k) => k !== 'group')
  it('are thin: no kind wider than 1.4 px at rest', () => {
    for (const k of kinds) assert.ok((LINE[k]?.width ?? 9) <= 1.4, `${k}: ${LINE[k]?.width}`)
  })
  it('each kind differs from every other by its dash or its arrowhead', () => {
    for (const a of kinds)
      for (const b of kinds) {
        if (a >= b) continue
        const la = LINE[a] as { dash: number[]; arrow: boolean }
        const lb = LINE[b] as { dash: number[]; arrow: boolean }
        assert.ok(la.dash.join() !== lb.dash.join() || la.arrow !== lb.arrow, `${a} and ${b} look the same`)
      }
  })
  it('are pale at rest, contradicts only a little stronger, the picked page’s at full strength', () => {
    assert.ok(EDGE.quiet <= 0.4)
    assert.ok(EDGE.contradicts <= 0.45)
    assert.ok(EDGE.lit >= 0.9)
    assert.ok(EDGE.faint < EDGE.quiet)
  })
})
