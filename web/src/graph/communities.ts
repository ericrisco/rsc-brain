// The graph's communities (v0.5.0): clusters of densely linked pages, found from the links alone by Louvain
// (modularity, every level), visiting nodes in index order so the same wiki always gives the same clusters.
// Each is named after its most linked page; the biggest get a colour each, the small rest share one, and the
// pages without links are a bucket of their own. The canvas colours by them; the Communities panel lists and
// hides them. No DOM here.
import type { Item, Model } from './model.ts'
import { roles } from './model.ts'

// How many communities get a colour of their own (tokens.css --com-0 … --com-9).
export const COLOURS = 10
// The colour slots after them: the small communities, and the items outside any (no links, the rim's groups).
export const OTHER = COLOURS
export const LONE = COLOURS + 1
// What `of` holds for an item in no community: a page without links, or a group on the rim of an opened one.
export const NO_LINKS = -1
export const AROUND = -2

// Louvain over n nodes and their links (pairs of indices; repeated pairs add up, self links are left out):
// each node's community, numbered from 0 in the order they are first met.
export function louvain(n: number, edges: Uint32Array, use?: Uint8Array): Int32Array {
  const member = Int32Array.from({ length: n }, (_, i) => i)
  // The graph of this level: its links with their weights.
  let size = n
  let src: number[] = []
  let dst: number[] = []
  let wt: number[] = []
  for (let e = 0; e + 1 < edges.length; e += 2) {
    const a = edges[e] as number
    const b = edges[e + 1] as number
    if (a === b || a >= n || b >= n || (use && (!use[a] || !use[b]))) continue
    src.push(a)
    dst.push(b)
    wt.push(1)
  }
  for (let level = 0; level < 16 && src.length; level++) {
    // Each node's neighbours (both ways) with weights, its self weight (a community folded in) and its degree.
    const start = new Int32Array(size + 1)
    for (let e = 0; e < src.length; e++)
      if (src[e] !== dst[e]) {
        start[(src[e] as number) + 1] = (start[(src[e] as number) + 1] as number) + 1
        start[(dst[e] as number) + 1] = (start[(dst[e] as number) + 1] as number) + 1
      }
    for (let i = 0; i < size; i++) start[i + 1] = (start[i + 1] as number) + (start[i] as number)
    const fill = start.slice(0, size)
    const nb = new Int32Array(start[size] as number)
    const nw = new Float64Array(start[size] as number)
    const k = new Float64Array(size)
    for (let e = 0; e < src.length; e++) {
      const a = src[e] as number
      const b = dst[e] as number
      const w = wt[e] as number
      k[a] = (k[a] as number) + w
      k[b] = (k[b] as number) + w
      if (a === b) continue
      nb[fill[a] as number] = b
      nw[fill[a] as number] = w
      fill[a] = (fill[a] as number) + 1
      nb[fill[b] as number] = a
      nw[fill[b] as number] = w
      fill[b] = (fill[b] as number) + 1
    }
    let m2 = 0
    for (let i = 0; i < size; i++) m2 += k[i] as number
    if (m2 === 0) break
    // Local moves: each node, in index order, to the neighbouring community that gains the most modularity.
    const comm = Int32Array.from({ length: size }, (_, i) => i)
    const tot = Float64Array.from(k)
    const toward = new Float64Array(size)
    const seen: number[] = []
    let movedAny = false
    for (let pass = 0; pass < 32; pass++) {
      let moves = 0
      for (let i = 0; i < size; i++) {
        const own = comm[i] as number
        for (let p = start[i] as number; p < (start[i + 1] as number); p++) {
          const c = comm[nb[p] as number] as number
          if (toward[c] === 0) seen.push(c)
          toward[c] = (toward[c] as number) + (nw[p] as number)
        }
        const ki = k[i] as number
        tot[own] = (tot[own] as number) - ki
        let best = own
        let gain = (toward[own] as number) - ((tot[own] as number) * ki) / m2
        for (const c of seen) {
          const g = (toward[c] as number) - ((tot[c] as number) * ki) / m2
          if (g > gain + 1e-12) {
            gain = g
            best = c
          }
        }
        tot[best] = (tot[best] as number) + ki
        comm[i] = best
        if (best !== own) moves += 1
        for (const c of seen) toward[c] = 0
        seen.length = 0
      }
      if (!moves) break
      movedAny = true
    }
    if (!movedAny) break
    // Number the communities in the order they are first met, and fold each into one node of the next level.
    const renum = new Int32Array(size).fill(-1)
    let count = 0
    for (let i = 0; i < size; i++) {
      const c = comm[i] as number
      if (renum[c] === -1) renum[c] = count++
    }
    for (let v = 0; v < n; v++) member[v] = renum[comm[member[v] as number] as number] as number
    const folded = new Map<number, number>()
    for (let e = 0; e < src.length; e++) {
      let a = renum[comm[src[e] as number] as number] as number
      let b = renum[comm[dst[e] as number] as number] as number
      if (a > b) [a, b] = [b, a]
      const key = a * count + b
      folded.set(key, (folded.get(key) ?? 0) + (wt[e] as number))
    }
    src = []
    dst = []
    wt = []
    for (const key of [...folded.keys()].sort((x, y) => x - y)) {
      src.push(Math.floor(key / count))
      dst.push(key % count)
      wt.push(folded.get(key) as number)
    }
    size = count
  }
  // The final numbering, in the order first met.
  const order = new Map<number, number>()
  for (let v = 0; v < n; v++) {
    const c = member[v] as number
    if (!order.has(c)) order.set(c, order.size)
    member[v] = order.get(c) as number
  }
  return member
}

// A page's title cut to fit a row of the panel.
const NAME_MAX = 28
export const shortName = (title: string) => {
  const t = title.trim()
  return t.length <= NAME_MAX ? t : `${t.slice(0, NAME_MAX - 1).trimEnd()}…`
}

export type Community = {
  id: number
  // Its most linked item's title (a group's last part of the address), shortened.
  name: string
  // Its most linked item.
  lead: number
  count: number
  // Its colour slot: 0 … COLOURS − 1, or OTHER.
  colour: number
}

export type Communities = {
  // Per item: its community's id, NO_LINKS or AROUND.
  of: Int32Array
  // Per item: its colour slot (0 … COLOURS − 1, OTHER or LONE).
  colour: Uint8Array
  // The biggest first, then by their most linked item's place.
  list: Community[]
  // How many pages have no links.
  none: number
}

// `nameOf`: what an item is called (a page's title by default, a group's last part of its address).
export function communitiesOf(m: Model, nameOf?: (it: Item) => string): Communities {
  const n = m.items.length
  const role = roles(m)
  const free = Uint8Array.from(role, (r) => (r === 0 ? 1 : 0))
  const raw = louvain(n, m.edges, free)
  const name = (i: number) => {
    const it = m.items[i]
    if (!it) return ''
    if (nameOf) return nameOf(it)
    return it.kind === 'page' ? it.title : (it.prefix.split('/').at(-1) ?? it.prefix)
  }
  const groups = new Map<number, number[]>()
  for (let i = 0; i < n; i++) {
    if (!free[i]) continue
    const c = raw[i] as number
    const list = groups.get(c)
    if (list) list.push(i)
    else groups.set(c, [i])
  }
  // A lone node (in an opened group, a page whose only links go out of it) counts as a community of one.
  const lead = (members: number[]) =>
    members.reduce((best, i) =>
      (m.degree[i] as number) > (m.degree[best] as number) ||
      ((m.degree[i] as number) === (m.degree[best] as number) &&
        (m.into[i] as number) > (m.into[best] as number))
        ? i
        : best,
    )
  const sorted = [...groups.values()]
    .map((members) => ({ members, lead: lead(members) }))
    .sort((a, b) => b.members.length - a.members.length || a.lead - b.lead)
  const of = new Int32Array(n)
  const colour = new Uint8Array(n)
  let none = 0
  for (let i = 0; i < n; i++) {
    if (free[i]) continue
    if (role[i] === 1) {
      of[i] = NO_LINKS
      colour[i] = LONE
      none += 1
    } else {
      of[i] = AROUND
      colour[i] = OTHER
    }
  }
  const list: Community[] = sorted.map((s, id) => {
    const slot = id < COLOURS ? id : OTHER
    for (const i of s.members) {
      of[i] = id
      colour[i] = slot
    }
    return { id, name: shortName(name(s.lead)), lead: s.lead, count: s.members.length, colour: slot }
  })
  return { of, colour, list, none }
}
