// Plan canvas-ui D6–D8 (B13): the cards of the graph, worked out as pure functions. A card goes where it
// fits without covering another card or another page; the person's own items always get one; there are at
// most 160; a point is hit by the card on top; a line stops at the edge of a card; the dotted ground moves
// with the view and is left out when its dots would crowd.
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  CARD_H,
  CARD_MAX,
  cardSize,
  clipToRect,
  dotGrid,
  fitCards,
  GROUP_H,
  hitCard,
  keepInView,
  MAX_CARDS,
  placeCards,
  TILE_PAD,
  TILE_SCALE,
} from '../../web/src/graph/cards.ts'
import { fit } from '../../web/src/graph/model.ts'

const xy = (...pts: [number, number][]) => Float32Array.from(pts.flat())
const none = new Set<number>()

describe('the size of a card', () => {
  it('a page: 28 px tall, its text plus 44 px wide, never wider than 220', () => {
    assert.deepEqual(cardSize(60, false), { w: 104, h: CARD_H })
    assert.equal(CARD_H, 28)
    assert.equal(cardSize(1000, false).w, CARD_MAX)
    assert.equal(CARD_MAX, 220)
  })
  it('a group: two lines, taller', () => {
    assert.equal(cardSize(60, true).h, GROUP_H)
    assert.ok(GROUP_H > CARD_H)
  })
})

describe('placing the cards', () => {
  const place = (sx: Float32Array, order: number[], extra: Partial<Parameters<typeof placeCards>[0]> = {}) =>
    placeCards({
      order,
      sx,
      textW: () => 60,
      group: () => false,
      width: 1000,
      height: 800,
      forced: none,
      ...extra,
    })

  it('a card is centred on its page', () => {
    const [c] = place(xy([500, 400]), [0])
    assert.deepEqual(c, { i: 0, x: 448, y: 386, w: 104, h: 28 })
  })

  it('two pages whose cards would meet: the first in the order gets the card, the other stays a point', () => {
    const cards = place(xy([500, 400], [500, 425]), [1, 0])
    assert.deepEqual(
      cards.map((c) => c.i),
      [1],
    )
  })

  it('a card never covers another page drawn under it', () => {
    // Page 1 lies inside where page 0's card would go; page 1 is not a candidate (no room for it either).
    const cards = place(xy([500, 400], [540, 400]), [0])
    assert.equal(cards.length, 0)
  })

  it('pages far enough apart each get a card', () => {
    const cards = place(xy([200, 200], [600, 200], [200, 600]), [0, 1, 2])
    assert.equal(cards.length, 3)
  })

  it('the person’s own items (active, selected) always get one, over the others', () => {
    const cards = place(xy([500, 400], [520, 405]), [0, 1], { forced: new Set([0, 1]) })
    assert.deepEqual(
      cards.map((c) => c.i),
      [0, 1],
    )
  })

  it('an item not drawn, repeated or off the canvas gets none', () => {
    const sx = xy([500, 400], [Number.NaN, Number.NaN], [-400, 400], [500, 2000])
    const cards = place(sx, [0, 0, 1, 2, 3])
    assert.deepEqual(
      cards.map((c) => c.i),
      [0],
    )
  })

  it('at most 160 cards', () => {
    const pts: [number, number][] = []
    for (let r = 0; r < 40; r++) for (let c = 0; c < 10; c++) pts.push([60 + c * 130, 20 + r * 40])
    const cards = placeCards({
      order: pts.map((_, i) => i),
      sx: xy(...pts),
      textW: () => 40,
      group: () => false,
      width: 1400,
      height: 1700,
      forced: none,
    })
    assert.equal(MAX_CARDS, 160)
    assert.equal(cards.length, 160)
  })
})

describe('what is under the pointer', () => {
  const cards = [
    { i: 3, x: 100, y: 100, w: 100, h: 28 },
    { i: 7, x: 150, y: 110, w: 100, h: 28 },
  ]
  it('the card first in the order wins where two meet', () => {
    assert.equal(hitCard(cards, 160, 115), 3)
  })
  it('its edge counts', () => {
    assert.equal(hitCard(cards, 100, 100), 3)
    assert.equal(hitCard(cards, 249, 137), 7)
  })
  it('outside every card: none', () => {
    assert.equal(hitCard(cards, 50, 50), -1)
    assert.equal(hitCard([], 0, 0), -1)
  })
})

describe('a line meeting a card', () => {
  const r = { x: 100, y: 100, w: 100, h: 20 }
  it('stops at the edge it crosses', () => {
    assert.deepEqual(clipToRect(0, 110, 150, 110, r), [100, 110])
    assert.deepEqual(clipToRect(150, 0, 150, 110, r), [150, 100])
  })
  it('a slanted line stops on the edge, on its way', () => {
    const [x, y] = clipToRect(0, 10, 150, 110, r)
    assert.ok(Math.abs(y - 100) < 1e-9)
    assert.ok(Math.abs(x - 135) < 1e-9)
  })
  it('a line starting inside the card is not cut', () => {
    assert.deepEqual(clipToRect(120, 105, 150, 110, r), [150, 110])
  })
})

describe('the dotted ground', () => {
  it('moves with the view: its offset follows the pan', () => {
    const a = dotGrid({ scale: 1, tx: 0, ty: 0 })
    const b = dotGrid({ scale: 1, tx: 10, ty: 5 })
    assert.ok(a && b)
    assert.equal(a.step, 24)
    assert.deepEqual([b.ox, b.oy], [10, 5])
    assert.deepEqual([dotGrid({ scale: 1, tx: -10, ty: 0 })?.ox], [14])
  })
  it('zoomed out, the dots stay apart: the step doubles until it is 12 px or more', () => {
    const g = dotGrid({ scale: 0.25, tx: 0, ty: 0 })
    assert.ok(g)
    assert.equal(g.step, 12)
  })
  it('zoomed in, the dots stay close: the step halves while it is 40 px or more', () => {
    assert.equal(dotGrid({ scale: 4, tx: 0, ty: 0 })?.step, 24)
    assert.equal(dotGrid({ scale: 1.5, tx: 0, ty: 0 })?.step, 36)
  })
  it('so far out that the dots would crowd under 6 px: none', () => {
    assert.equal(dotGrid({ scale: 0.001, tx: 0, ty: 0 }), null)
  })
})

// Review R2-1: Fit never draws tiles with the narrow pad of the pills. Close enough for tiles, it fits again
// with room for whole tiles at the edges, and keeps that view even when it then falls short of tiles.
describe('Fit and the tiles', () => {
  const xy = Float32Array.from([0, 0, 100, 0])
  const on = new Uint8Array([1, 1])
  const fitWith = (w: number) => (pad: number) => fit(xy, on, w, 600, pad, 0, { max: 8 })
  it('a view that draws tiles keeps every page a half tile from the edges', () => {
    for (const w of [416, 500, 700, 1200, 1920]) {
      const v = fitCards(fitWith(w), 48)
      if (v.scale < TILE_SCALE) continue
      for (const x of [0, 100]) {
        const sx = x * v.scale + v.tx
        assert.ok(sx >= TILE_PAD - 1e-6 && sx <= w - TILE_PAD + 1e-6, `w ${w}: ${sx}`)
      }
    }
  })
  it('the tight fit that would draw tiles gives way to the roomy one, even below the tile scale', () => {
    // 100 apart in 416 px: tight (pad 48) is 3.2, tiles; roomy (pad 150) is 1.16, pills.
    const v = fitCards(fitWith(416), 48)
    assert.ok(v.scale < TILE_SCALE, `scale ${v.scale}`)
  })
  it('far from tiles, the tight fit stays', () => {
    const v = fitCards(fitWith(200), 48)
    assert.equal(v.scale, fitWith(200)(48).scale)
  })
})

// Review R2-4: keeping an item in view moves the picture only by what sticks out, never re-centres an item
// already in view, and settles even when the card is wider than the room left.
describe('keeping an item in view', () => {
  const room = { left: 0, top: 60, right: 1000, bottom: 700 }
  it('in view: nothing moves', () => {
    assert.equal(keepInView({ sx: 500, sy: 400, hw: 50, hh: 14, ...room }), null)
  })
  it('sticking out at the right: moved back by that much only', () => {
    // The card's edge plus the 24 px gap reaches 1030: 30 too far.
    assert.deepEqual(keepInView({ sx: 956, sy: 400, hw: 50, hh: 14, ...room }), { dx: -30, dy: 0 })
  })
  it('under the top controls: moved down by that much only', () => {
    assert.deepEqual(keepInView({ sx: 500, sy: 80, hw: 50, hh: 14, ...room }), { dx: 0, dy: 18 })
  })
  it('a card wider than the room: centred once, then left alone', () => {
    const wide = { hw: 700, hh: 48, ...room }
    const first = keepInView({ sx: 900, sy: 400, ...wide })
    assert.ok(first)
    const again = keepInView({ sx: 900 + (first?.dx ?? 0), sy: 400 + (first?.dy ?? 0), ...wide })
    assert.equal(again, null)
  })
})
