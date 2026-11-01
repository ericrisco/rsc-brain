// Images for the tests of the logo (plan G3): a real PNG (it decodes, so a browser shows it), and the
// headers of a JPEG and a WebP, which is all the server reads of them (type and size in pixels).
import { crc32, deflateSync } from 'node:zlib'

function chunk(type: string, data: Buffer): Buffer {
  const len = Buffer.alloc(4)
  len.writeUInt32BE(data.length)
  const body = Buffer.concat([Buffer.from(type, 'latin1'), data])
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(body))
  return Buffer.concat([len, body, crc])
}

// A solid-colour PNG of w × h pixels. `pad` adds a text chunk of that many bytes (a big file, small image).
export function png(w: number, h: number, o: { rgb?: [number, number, number]; pad?: number } = {}): Buffer {
  const [r, g, b] = o.rgb ?? [40, 200, 120]
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(w, 0)
  ihdr.writeUInt32BE(h, 4)
  ihdr[8] = 8 // bit depth
  ihdr[9] = 2 // truecolour
  // Rows of a big image are not drawn: only its header matters to the server.
  const drawn = w * h <= 512 * 512
  const row = Buffer.alloc(1 + w * 3)
  for (let x = 0; x < w; x += 1) row.set([r, g, b], 1 + x * 3)
  const raw = drawn ? Buffer.concat(Array.from({ length: h }, () => row)) : Buffer.alloc(0)
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    ...(o.pad ? [chunk('tEXt', Buffer.alloc(o.pad, 0x61))] : []),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ])
}

// The start of a baseline JPEG: SOI, an APP0 and the frame header that holds its size.
export function jpeg(w: number, h: number): Buffer {
  const app0 = Buffer.from([0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 1, 1, 0, 0, 1, 0, 1, 0, 0])
  const sof = Buffer.from([
    0xff,
    0xc0,
    0x00,
    0x11,
    8,
    h >> 8,
    h & 255,
    w >> 8,
    w & 255,
    3,
    1,
    0x22,
    0,
    2,
    0x11,
    1,
    3,
    0x11,
    1,
  ])
  return Buffer.concat([Buffer.from([0xff, 0xd8]), app0, sof, Buffer.from([0xff, 0xd9])])
}

// A WebP with its extended header (VP8X), which holds the canvas size.
export function webp(w: number, h: number): Buffer {
  const vp8x = Buffer.alloc(10)
  vp8x.writeUIntLE(w - 1, 4, 3)
  vp8x.writeUIntLE(h - 1, 7, 3)
  const body = Buffer.concat([Buffer.from('WEBP'), Buffer.from('VP8X'), Buffer.from([10, 0, 0, 0]), vp8x])
  const size = Buffer.alloc(4)
  size.writeUInt32LE(body.length)
  return Buffer.concat([Buffer.from('RIFF'), size, body])
}

export const SVG = Buffer.from(
  '<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><script>alert(1)</script></svg>',
)
