// The name and logo of the installation (spec B6 «Admin › Branding», CA18; plan G1–G3). The logo is an
// image of its own type (PNG, JPEG or WebP, read from the bytes), at most 2 MB and 4096 pixels a side. It is
// served from this server with its own type, `nosniff` and a sandbox, so even a file that is also something
// else can only be shown as an image. SVG is refused (see src/core/images.ts).
import { createHash } from 'node:crypto'
import { AppError, invalid } from '../core/errors.ts'
import { type ImageType, imageInfo } from '../core/images.ts'
import type { Db } from '../db/db.ts'
import { type Ctx, ok } from './context.ts'
import { adminOnly } from './guards.ts'

export const LOGO_MAX_BYTES = 2 * 1024 * 1024
export const LOGO_MAX_PX = 4096
// The request that carries it (base64 in JSON) may be this big; any other request stays at 1 MiB.
export const LOGO_MAX_BODY = 3 * 1024 * 1024
const TYPES: readonly ImageType[] = ['image/png', 'image/jpeg', 'image/webp']

export type LogoRef = { url: string; updatedAt: string }

export async function logoRef(db: Db): Promise<LogoRef | null> {
  const r = await db.one<{ logo_sha256: string | null; logo_updated_at: Date | null }>(
    'SELECT logo_sha256, logo_updated_at FROM installation WHERE id = 1',
  )
  if (!r?.logo_sha256 || !r.logo_updated_at) return null
  // The address changes with the image, so a cached old logo is never shown for a new one.
  return {
    url: `/v1/branding/logo?v=${r.logo_sha256.slice(0, 12)}`,
    updatedAt: r.logo_updated_at.toISOString(),
  }
}

export async function logoBytes(db: Db): Promise<{ bytes: Buffer; type: string; sha256: string } | null> {
  const r = await db.one<{ logo: Buffer | null; logo_type: string | null; logo_sha256: string | null }>(
    'SELECT logo, logo_type, logo_sha256 FROM installation WHERE id = 1',
  )
  if (!r?.logo || !r.logo_type || !r.logo_sha256) return null
  return { bytes: r.logo, type: r.logo_type, sha256: r.logo_sha256 }
}

const badImage = (message: string) =>
  new AppError(
    422,
    'invalid_image',
    message,
    'Use a PNG, JPEG or WebP of at most 2 MB and 4096 pixels a side.',
  )

export async function setLogo(
  ctx: Ctx,
  input: { contentType?: unknown; data?: unknown },
): Promise<{ logo: LogoRef }> {
  adminOnly(ctx)
  if (typeof input.contentType !== 'string' || typeof input.data !== 'string' || !input.data) {
    throw invalid(
      'Send "contentType" and the image in "data", as base64.',
      'Such as {"contentType": "image/png", "data": "iVBOR…"}.',
    )
  }
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(input.data))
    throw invalid('"data" is not base64.', 'Send the image as base64.')
  const bytes = Buffer.from(input.data, 'base64')
  if (bytes.length > LOGO_MAX_BYTES) {
    throw new AppError(
      413,
      'image_too_large',
      'The logo is larger than 2 MB.',
      'Use a smaller image; a logo needs a few kilobytes.',
    )
  }
  if (!(TYPES as readonly string[]).includes(input.contentType)) {
    throw badImage(
      `A logo is a PNG, JPEG or WebP image, not "${input.contentType.slice(0, 60)}". SVG is not accepted: it can carry scripts.`,
    )
  }
  const info = imageInfo(bytes)
  if (!info) throw badImage('This file is not a PNG, JPEG or WebP image.')
  if (info.type !== input.contentType)
    throw badImage(`This file is a ${info.type}, not the ${input.contentType} it says.`)
  if (info.width > LOGO_MAX_PX || info.height > LOGO_MAX_PX) {
    throw badImage(`The logo is ${info.width} × ${info.height} pixels; at most ${LOGO_MAX_PX} a side.`)
  }
  const sha = createHash('sha256').update(bytes).digest('hex')
  const at = ctx.clock()
  await ctx.db.query(
    'UPDATE installation SET logo = $1, logo_type = $2, logo_sha256 = $3, logo_updated_at = $4 WHERE id = 1',
    [bytes, info.type, sha, at],
  )
  await ok(
    ctx,
    'branding.logo',
    null,
    'installation',
    `${info.type}, ${info.width} × ${info.height}, ${bytes.length} bytes`,
  )
  return { logo: (await logoRef(ctx.db)) as LogoRef }
}

export async function removeLogo(ctx: Ctx): Promise<{ logo: null }> {
  adminOnly(ctx)
  await ctx.db.query(
    'UPDATE installation SET logo = NULL, logo_type = NULL, logo_sha256 = NULL, logo_updated_at = NULL WHERE id = 1',
  )
  await ok(ctx, 'branding.logo', null, 'installation', 'removed')
  return { logo: null }
}
