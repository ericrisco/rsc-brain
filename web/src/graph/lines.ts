// How the graph draws its lines (plan §3.4, closing review): each link kind's dash, width and arrowhead,
// and how strong a line is drawn. Kept apart from the painter so it is tested without a canvas.

export const LINE: Record<string, { dash: number[]; width: number; arrow: boolean }> = {
  mentions: { dash: [1.5, 4], width: 1, arrow: true },
  related: { dash: [], width: 1, arrow: false },
  'depends-on': { dash: [8, 4], width: 1.1, arrow: true },
  contradicts: { dash: [2, 3, 9, 3], width: 1, arrow: false },
  supersedes: { dash: [], width: 1.4, arrow: true },
  'part-of': { dash: [16, 5], width: 1.2, arrow: true },
  'example-of': { dash: [7, 3, 1.5, 3], width: 1, arrow: true },
  group: { dash: [], width: 4, arrow: false },
}

// How strong the lines are: faint (another page under the pointer, or a superseded end), quiet at rest,
// contradicts a little stronger in its tint, and lit (the lines of the page picked or under the pointer).
export const EDGE = { faint: 0.08, quiet: 0.35, contradicts: 0.42, lit: 0.95 }
