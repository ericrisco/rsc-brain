// A download from the API as bytes (an export), by key or by web session, with its headers.
import { WEB_HEADER } from '../../src/http/app.ts'
import type { World } from './world.ts'

export type Download = {
  status: number
  headers: Headers
  bytes: Buffer
  json: Record<string, unknown> | null
}

export async function download(
  w: World,
  who: { key?: string; session?: string },
  path: string,
): Promise<Download> {
  const res = await fetch(`${w.base}${path}`, {
    headers: who.session
      ? { cookie: `rscb_session=${who.session}`, 'x-requested-with': WEB_HEADER }
      : who.key
        ? { authorization: `Bearer ${who.key}` }
        : {},
  })
  const bytes = Buffer.from(await res.arrayBuffer())
  let json: Record<string, unknown> | null = null
  if (String(res.headers.get('content-type')).startsWith('application/json'))
    json = JSON.parse(bytes.toString('utf8'))
  return { status: res.status, headers: res.headers, bytes, json }
}
