// The lines a big cloud shows at Fit (closing pass, 2026-11-09): each page ranks its visible links, inside its
// family first, then toward the better linked page, and a line is drawn when it is among the K strongest of
// both its pages, so no page shows more than K. The pages in `keep` (picked, under the pointer) show all of
// theirs. Pure; no DOM.
export function thinEdges(
  sc: { edges: Uint32Array; fam: Uint8Array; degree: Uint32Array },
  visible: Uint8Array,
  k: number,
  keep: number[],
): Uint8Array {
  const m = visible.length
  const n = sc.fam.length
  const out = new Uint8Array(m)
  // Each page's visible lines.
  const start = new Uint32Array(n + 1)
  for (let e = 0; e < m; e++) {
    if (!visible[e]) continue
    start[(sc.edges[2 * e] as number) + 1] = (start[(sc.edges[2 * e] as number) + 1] as number) + 1
    start[(sc.edges[2 * e + 1] as number) + 1] = (start[(sc.edges[2 * e + 1] as number) + 1] as number) + 1
  }
  for (let i = 0; i < n; i++) start[i + 1] = (start[i + 1] as number) + (start[i] as number)
  const at = start.slice(0, n)
  const lines = new Uint32Array(start[n] as number)
  for (let e = 0; e < m; e++) {
    if (!visible[e]) continue
    for (const i of [sc.edges[2 * e] as number, sc.edges[2 * e + 1] as number]) {
      lines[at[i] as number] = e
      at[i] = (at[i] as number) + 1
    }
  }
  // How many of its K each line is chosen by (2: by both pages).
  const votes = new Uint8Array(m)
  const strength = (i: number, e: number) => {
    const j =
      (sc.edges[2 * e] as number) === i ? (sc.edges[2 * e + 1] as number) : (sc.edges[2 * e] as number)
    return (sc.fam[i] === sc.fam[j] ? 1e6 : 0) + (sc.degree[j] as number) - e * 1e-7
  }
  for (let i = 0; i < n; i++) {
    const own = Array.from(lines.subarray(start[i] as number, start[i + 1] as number))
    if (own.length > k) own.sort((a, b) => strength(i, b) - strength(i, a))
    for (const e of own.slice(0, k)) votes[e] = (votes[e] as number) + 1
  }
  for (let e = 0; e < m; e++) if (votes[e] === 2) out[e] = 1
  const kept = new Set(keep)
  if (kept.size)
    for (let e = 0; e < m; e++)
      if (visible[e] && (kept.has(sc.edges[2 * e] as number) || kept.has(sc.edges[2 * e + 1] as number)))
        out[e] = 1
  return out
}
