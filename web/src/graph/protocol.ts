// The messages between the graph screen and its worker (plan §3.4). The worker works out the layout and,
// when the browser lets it hold the canvas (OffscreenCanvas), paints it too.
import type { View } from './model.ts'
import type { Scene, State } from './render.ts'

export type LayoutRequest = {
  type: 'layout'
  // Which layout this is: an answer about an older one is ignored.
  id: number
  n: number
  edges: Uint32Array
  weights: Float32Array
  area: Int32Array
  role: Uint8Array
  seed: number
  reducedMotion: boolean
}
export type ToWorker =
  | LayoutRequest
  | { type: 'canvas'; canvas: OffscreenCanvas }
  | { type: 'scene'; scene: Scene }
  | { type: 'labels'; labels: string[] }
  | { type: 'state'; state: State }

export type PositionsMessage = {
  type: 'positions'
  id: number
  xy: Float32Array
  done: boolean
  // Once done: how long the worker took, wall time from the request (CA5 reads it: CDP cannot slow a worker).
  ms?: number
}
export type DrawnMessage = {
  type: 'drawn'
  // The layout this picture shows: a picture of an older one says nothing about the new one.
  id: number
  view: View
  active: [number, number] | null
  // The layout this picture shows has settled.
  settled: boolean
}
export type FromWorker = PositionsMessage | DrawnMessage
