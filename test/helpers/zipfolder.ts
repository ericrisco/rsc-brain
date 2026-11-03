// A zip of a folder as the product's writer makes it (a person zipping their 02-DOCS), each file under `prefix`.
import { readdir, readFile } from 'node:fs/promises'
import { join, relative } from 'node:path'
import { zipWriter } from '../../src/core/zip.ts'

async function filesOf(dir: string): Promise<string[]> {
  const out: string[] = []
  const walk = async (d: string) => {
    for (const e of await readdir(d, { withFileTypes: true })) {
      const p = join(d, e.name)
      if (e.isDirectory()) await walk(p)
      else out.push(relative(dir, p))
    }
  }
  await walk(dir)
  return out.sort()
}

export async function zipOfFolder(dir: string, prefix = ''): Promise<Buffer> {
  const chunks: Buffer[] = []
  const z = zipWriter(async (b) => {
    chunks.push(Buffer.from(b))
  })
  for (const f of await filesOf(dir)) await z.file(`${prefix}${f}`, await readFile(join(dir, f)))
  await z.end()
  return Buffer.concat(chunks)
}
