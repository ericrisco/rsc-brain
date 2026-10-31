// The messages between the graph screen and its worker (plan §3.4).
export type LayoutRequest = {
  type: 'layout'
  // Which layout this is: an answer about an older one is ignored.
  id: number
  n: number
  edges: Uint32Array
  weights: Float32Array
  seed: number
  reducedMotion: boolean
}
export type PositionsMessage = { type: 'positions'; id: number; xy: Float32Array; done: boolean }
