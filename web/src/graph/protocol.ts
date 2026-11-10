// The messages between the graph screen and its worker (plan §3.4; v0.5.0). The worker runs the live layout
// and, when the browser lets it hold the canvas (OffscreenCanvas), paints it too.
import type { Drawn, Scene, State } from './render.ts'

export type LayoutRequest = {
  type: 'layout'
  // Which layout this is: a message about an older one is ignored.
  id: number
  n: number
  edges: Uint32Array
  weights: Float32Array
  role: Uint8Array
  seed: number
}
export type ToWorker =
  | LayoutRequest
  | { type: 'canvas'; canvas: OffscreenCanvas }
  | { type: 'scene'; scene: Scene }
  | { type: 'state'; state: State }
  // The pointer holds item i of layout `id` at (x, y) in layout units; `i` −1 lets go.
  | { type: 'hold'; id: number; i: number; x: number; y: number }
  // Motion allowed or not, and whether the canvas is seen (out of sight, or the tab hidden, nothing moves).
  | { type: 'motion'; reduced: boolean; seen: boolean }

export type PositionsMessage = {
  type: 'positions'
  id: number
  // Where each item is now, [x0, y0, …]: the page finds what is under the pointer and where a key leads in it.
  xy: Float32Array
  // The layout is at rest.
  done: boolean
  // At its first rest: the worker's working time on it, the waits between steps left out (CA5 reads it: CDP
  // cannot slow a worker).
  ms?: number
}
export type DrawnMessage = Drawn & {
  type: 'drawn'
  // The layout this picture shows: a picture of an older one says nothing about the new one.
  id: number
  // The layout this picture shows has come to rest at least once.
  settled: boolean
  // The layout is moving: more pictures follow.
  moving: boolean
}
export type FromWorker = PositionsMessage | DrawnMessage
