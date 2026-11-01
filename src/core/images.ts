// What an uploaded image is, read from its own bytes (plan G3): PNG, JPEG or WebP, and its size in pixels
// from its header. Nothing else is accepted. SVG never: it is a document that can carry scripts and links,
// and no header check makes it inert. The type a client declares only has to agree with what the bytes are.

export type ImageType = 'image/png' | 'image/jpeg' | 'image/webp'
export type ImageInfo = { type: ImageType; width: number; height: number }

const PNG_SIG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]

function png(b: Buffer): ImageInfo | null {
  if (b.length < 33 || !PNG_SIG.every((x, i) => b[i] === x)) return null
  // The first chunk is IHDR: width and height, 4 bytes each.
  if (b.toString('latin1', 12, 16) !== 'IHDR') return null
  return { type: 'image/png', width: b.readUInt32BE(16), height: b.readUInt32BE(20) }
}

// Frame headers (SOF0–SOF15) hold the size; C4, C8 and CC are other markers with the same prefix.
function jpeg(b: Buffer): ImageInfo | null {
  if (b.length < 4 || b[0] !== 0xff || b[1] !== 0xd8) return null
  let i = 2
  while (i + 9 < b.length) {
    if (b[i] !== 0xff) return null
    const marker = b[i + 1] as number
    if (marker === 0xff) {
      i += 1
      continue
    }
    if (marker === 0xd9 || marker === 0xda) return null
    const len = b.readUInt16BE(i + 2)
    if (len < 2) return null
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      return { type: 'image/jpeg', height: b.readUInt16BE(i + 5), width: b.readUInt16BE(i + 7) }
    }
    i += 2 + len
  }
  return null
}

function webp(b: Buffer): ImageInfo | null {
  if (b.length < 30 || b.toString('latin1', 0, 4) !== 'RIFF' || b.toString('latin1', 8, 12) !== 'WEBP')
    return null
  const kind = b.toString('latin1', 12, 16)
  if (kind === 'VP8X')
    return { type: 'image/webp', width: b.readUIntLE(24, 3) + 1, height: b.readUIntLE(27, 3) + 1 }
  if (kind === 'VP8L') {
    if (b[20] !== 0x2f) return null
    const bits = b.readUInt32LE(21)
    return { type: 'image/webp', width: (bits & 0x3fff) + 1, height: ((bits >> 14) & 0x3fff) + 1 }
  }
  if (kind === 'VP8 ') {
    // A key frame starts with 9D 01 2A, then 14 bits of width and of height.
    if (b[23] !== 0x9d || b[24] !== 0x01 || b[25] !== 0x2a) return null
    return { type: 'image/webp', width: b.readUInt16LE(26) & 0x3fff, height: b.readUInt16LE(28) & 0x3fff }
  }
  return null
}

export function imageInfo(b: Buffer): ImageInfo | null {
  const found = png(b) ?? jpeg(b) ?? webp(b)
  if (!found || found.width < 1 || found.height < 1) return null
  return found
}
