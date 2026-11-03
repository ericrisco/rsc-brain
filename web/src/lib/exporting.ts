// Settings › Export (spec B7 «Exportar»): what the screen asks the server for, and the size of what arrived.
export type ExportFormat = 'readable' | 'faithful'

export function exportAsk(slug: string, format: ExportFormat, includeForgotten: boolean) {
  return {
    path: { slug },
    query: includeForgotten ? { format, includeForgotten: 1 } : { format },
  }
}

// Decimal units, one decimal past a thousand: what a file manager shows.
export function sizeLabel(bytes: number): string {
  if (bytes < 1000) return `${bytes} ${bytes === 1 ? 'byte' : 'bytes'}`
  const units = ['kB', 'MB', 'GB', 'TB']
  let v = bytes / 1000
  let u = 0
  while (v >= 1000 && u < units.length - 1) {
    v /= 1000
    u += 1
  }
  return `${v.toFixed(1)} ${units[u]}`
}
