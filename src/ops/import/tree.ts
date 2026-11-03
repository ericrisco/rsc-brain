// What an import reads (plan §3.6): a tree of files, from a zip held in memory (the bounded reader of
// src/core/unzip.ts) or from a folder on the server (the command line). Either way a file is read only when the
// import asks for it, one over 1 MB never, and the same limits hold: at most 20 000 files and 200 MB to read. A
// folder is walked without following links; in a 02-DOCS folder only `wiki/`, `raw/` and the files at its root
// are walked (the rest is said to be outside what an import reads, not read).
import { constants } from 'node:fs'
import { lstat, open, readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { openZip, UNZIP_LIMITS, UnzipError } from '../../core/unzip.ts'

export type Why = 'binary' | 'too_large' | 'not_markdown' | 'hidden' | 'secret' | 'outside' | 'link'
export type Ignored = { path: string; why: Why }

export type TreeFile = { path: string; size: number; tooLarge: boolean; read(): Promise<Buffer> }
// `skipped`: what the walk itself left out (links, hidden folders, folders outside a 02-DOCS tree).
export type FileTree = { files: TreeFile[]; skipped: Ignored[] }

// A faithful export (a manifest.json at its root, or in the one folder around it) is a few large files: each may
// take the whole of the limit instead of 1 MB.
const manifestAt = (path: string) => path === 'manifest.json' || /^[^/]+\/manifest\.json$/.test(path)
const faithfulLimits = (limits: typeof UNZIP_LIMITS) => ({ ...limits, fileBytes: limits.totalBytes })

export function treeFromZip(buf: Buffer, limits = UNZIP_LIMITS): FileTree {
  let items = openZip(buf, limits)
  if (items.some((i) => manifestAt(i.path))) items = openZip(buf, faithfulLimits(limits))
  const files = items.map((i) => ({
    path: i.path,
    size: i.size,
    tooLarge: i.tooLarge,
    read: async () => i.read(),
  }))
  return { files, skipped: [] }
}

const MB = 1024 * 1024
// The folders of a 02-DOCS tree an import reads.
export const DOCS_FOLDERS = new Set(['wiki', 'raw'])

export async function treeFromFolder(root: string, given = UNZIP_LIMITS): Promise<FileTree> {
  const limits = (await lstat(join(root, 'manifest.json')).catch(() => null))?.isFile()
    ? faithfulLimits(given)
    : given
  const files: TreeFile[] = []
  const skipped: Ignored[] = []
  let total = 0
  let seen = 0
  const top = await readdir(root, { withFileTypes: true })
  const docs = top.some((d) => d.isDirectory() && DOCS_FOLDERS.has(d.name))
  const walk = async (dir: string, rel: string) => {
    const items = (await readdir(dir, { withFileTypes: true })).sort((a, b) => (a.name < b.name ? -1 : 1))
    for (const d of items) {
      const path = rel ? `${rel}/${d.name}`.normalize('NFC') : d.name.normalize('NFC')
      const full = join(dir, d.name)
      seen += 1
      if (seen > limits.entries)
        throw new UnzipError(
          'archive_too_large',
          `The folder holds more than ${limits.entries} files to read.`,
        )
      // Never followed: a link could lead anywhere on the server.
      const st = await lstat(full)
      if (st.isSymbolicLink()) {
        skipped.push({ path, why: 'link' })
        continue
      }
      if (st.isDirectory()) {
        if (d.name.startsWith('.')) skipped.push({ path: `${path}/`, why: 'hidden' })
        else if (!rel && docs && !DOCS_FOLDERS.has(d.name)) skipped.push({ path: `${path}/`, why: 'outside' })
        else await walk(full, path)
        continue
      }
      if (!st.isFile()) {
        skipped.push({ path, why: 'binary' })
        continue
      }
      const size = st.size
      const tooLarge = size > limits.fileBytes
      if (!tooLarge) total += size
      if (total > limits.totalBytes)
        throw new UnzipError(
          'archive_too_large',
          `The folder holds more than ${Math.round(limits.totalBytes / MB)} MB to read.`,
        )
      files.push({
        path,
        size,
        tooLarge,
        read: async () => {
          // Opened without following a link that took its place since the walk, and read no further than allowed.
          const fh = await open(full, constants.O_RDONLY | constants.O_NOFOLLOW)
          try {
            const now = await fh.stat()
            if (!now.isFile() || now.size > limits.fileBytes)
              throw new UnzipError('invalid_archive', `${path} changed while it was imported.`)
            const buf = Buffer.alloc(now.size)
            let at = 0
            while (at < buf.length) {
              const { bytesRead } = await fh.read(buf, at, buf.length - at, at)
              if (bytesRead === 0) break
              at += bytesRead
            }
            return buf.subarray(0, at)
          } finally {
            await fh.close()
          }
        },
      })
    }
  }
  await walk(root, '')
  return { files, skipped }
}
