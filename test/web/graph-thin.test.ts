// Closing pass (2026-11-09): at Fit a big cloud shows each page's few strongest links only, so the colour
// regions read calmly; the page picked or under the pointer shows all of its links, and zoomed in all show.
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { thinEdges } from '../../web/src/graph/thin.ts'

// A star: page 0 linked to 1–8; 1–8 in a ring among themselves. Families: 0–4 family 0, 5–8 family 1.
const n = 9
const pairs: number[] = []
for (let k = 1; k <= 8; k++) pairs.push(0, k)
for (let k = 1; k <= 8; k++) pairs.push(k, (k % 8) + 1)
const edges = new Uint32Array(pairs)
const m = edges.length / 2
const fam = new Uint8Array([0, 0, 0, 0, 0, 1, 1, 1, 1])
const degree = new Uint32Array(n)
for (const p of pairs) degree[p] = (degree[p] as number) + 1
const all = new Uint8Array(m).fill(1)
const drawnAt = (shown: Uint8Array, i: number) => {
  let k = 0
  for (let e = 0; e < m; e++) if (shown[e] && (edges[2 * e] === i || edges[2 * e + 1] === i)) k += 1
  return k
}

describe('thinning the lines at Fit', () => {
  it('each page shows at most its K strongest links', () => {
    const shown = thinEdges({ edges, fam, degree }, all, 2, [])
    for (let i = 0; i < n; i++) assert.ok(drawnAt(shown, i) <= 2, `page ${i}: ${drawnAt(shown, i)}`)
    // Only lines that were visible, and some of them.
    let k = 0
    for (let e = 0; e < m; e++) k += shown[e] as number
    assert.ok(k > 0)
    const hidden = new Uint8Array(m)
    assert.equal(
      thinEdges({ edges, fam, degree }, hidden, 2, []).reduce((a, b) => a + b, 0),
      0,
    )
  })

  it('prefers links inside the family', () => {
    const shown = thinEdges({ edges, fam, degree }, all, 1, [])
    // Page 4 (family 0) links to 0 and 3 (family 0) and 5 (family 1): its one line stays in its family.
    for (let e = 0; e < m; e++) {
      if (!shown[e]) continue
      const a = edges[2 * e] as number
      const b = edges[2 * e + 1] as number
      if (a === 4 || b === 4) assert.equal(fam[a], fam[b], `line ${a}–${b}`)
    }
  })

  it('the page picked or under the pointer shows all its links', () => {
    const shown = thinEdges({ edges, fam, degree }, all, 2, [0])
    assert.equal(drawnAt(shown, 0), 8)
    for (let i = 1; i < n; i++) assert.ok(drawnAt(shown, i) <= 3, `page ${i}: ${drawnAt(shown, i)}`)
  })
})
