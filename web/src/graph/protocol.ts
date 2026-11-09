// The messages between the graph screen and its worker (plan §3.4). The worker works out the layout and,
// when the browser lets it hold the canvas (OffscreenCanvas), paints it too.
import type { Drawn, Fact, Scene, State } from './render.ts'

export type LayoutRequest = {
  type: 'layout'
  // Which layout this is: an answer about an older one is ignored.
  id: number
  n: number
  edges: Uint32Array
  weights: Float32Array
  area: Int32Array
  role: Uint8Array
  // Each item's family (families.ts): in three dimensions a family gathers in a cluster of its own.
  family: Int32Array
  seed: number
  reducedMotion: boolean
}
export type ToWorker =
  | LayoutRequest
  | { type: 'canvas'; canvas: OffscreenCanvas }
  | { type: 'scene'; scene: Scene }
  | { type: 'labels'; labels: string[] }
  | { type: 'facts'; facts: Fact[] }
  | { type: 'state'; state: State }

export type PositionsMessage = {
  type: 'positions'
  id: number
  // The layout so far, [x0, y0, z0, …]: the page needs it only when it paints itself (no OffscreenCanvas).
  xyz: Float32Array
  done: boolean
  // Once done: the worker's busy time, inside the layout's slices with the waits between them left out (CA5
  // reads it: CDP cannot slow a worker).
  ms?: number
}
export type DrawnMessage = Drawn & {
  type: 'drawn'
  // The layout this picture shows: a picture of an older one says nothing about the new one.
  id: number
  // The layout this picture shows has settled.
  settled: boolean
}
export type FromWorker = PositionsMessage | DrawnMessage
