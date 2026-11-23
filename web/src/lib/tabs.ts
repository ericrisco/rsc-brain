// Where a row of tabs that slides sideways starts (a phone). Tabs are measured from the row's left edge in the
// row's own scroll space. The row starts a little before a tab, in the blank between two, never inside one, so
// no word is cut at its left edge and the mark for "more to the left" has room. The current tab is in view
// whole; when the end of the row is reached first, the row goes as far as it can.
export type Span = { left: number; right: number }

// The blank kept before the first tab shown, for the mark; less than the gap between tabs.
export const LEAD = 16

export function tabsStart(tabs: Span[], current: number, width: number, max: number): number {
  const cur = tabs[current]
  if (!cur || max <= 0) return 0
  // The first tab to start at (the least slid) that leaves the current one whole in view and does not run
  // past the end.
  for (let s = 0; s <= current; s++) {
    const t = tabs[s] as Span
    const at = Math.max(t.left - (t.left > 0 ? LEAD : 0), 0)
    if (at <= max && cur.right - at <= width) return at
  }
  return Math.min(Math.max(cur.right - width, 0), max)
}

// What waits beyond the edges of the row, to say so: more to the left, more to the right.
export function tabsMore(
  scrollLeft: number,
  width: number,
  scrollWidth: number,
): { start: boolean; end: boolean } {
  return { start: scrollLeft > 1, end: scrollLeft + width < scrollWidth - 1 }
}
