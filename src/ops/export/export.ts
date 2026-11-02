// Exporting a brain (spec B7 «Exportar un cerebro», plan §3.5): its curators only, in the web (someone outside is
// told it does not exist; the administration exports once it has joined and made itself a curator, pack rule 3),
// in either format, with forgotten entries only when asked. The export is checked, audited and told to the brain
// first. Then it is prepared, at the server's own pace, into a private file from one short snapshot (REPEATABLE
// READ, READ ONLY): the transaction ends and its connection goes back before a byte goes to the client, so a
// client that stops reading never holds the database (review of PR31). At most two are prepared at once; a disk
// short of room refuses; the file goes once sent, refused or abandoned, and a crash's leftovers on the next start.
import { randomBytes } from 'node:crypto'
import { chmod, mkdir, open, readdir, rm, stat, statfs } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AppError, invalid } from '../../core/errors.ts'
import { VERSION } from '../../core/version.ts'
import { zipWriter } from '../../core/zip.ts'
import { allow, type Ctx, inBrain, ok } from '../../domain/context.ts'
import { emit } from '../../domain/events.ts'
import { inWeb } from '../../domain/guards.ts'
import { writeFaithful } from './faithful.ts'
import { writeReadable } from './readable.ts'

export const EXPORT_FORMATS = ['readable', 'faithful'] as const
export type ExportFormat = (typeof EXPORT_FORMATS)[number]

// How far exports go. Mutable for the tests only.
export const EXPORT_LIMITS = {
  // Prepared at once in this installation.
  building: 2,
  // A client that takes nothing for this long is let go.
  stallMs: 60_000,
  // Room the disk keeps free while an export is prepared.
  minFreeBytes: 512 * 1024 * 1024,
  // The most one prepared export may take on disk.
  maxBytes: 20 * 1024 * 1024 * 1024,
}
export const EXPORT_STATE = { building: 0 }

// Where exports are prepared by default: a folder of the system's temporary space only this user reads.
export const EXPORT_DIR = join(tmpdir(), 'rsc-brain-exports')
// What a crash left behind is this old at least (a live export is never this long in the making).
const STALE_MS = 3_600_000

export type ExportFile = {
  name: string
  type: 'application/zip'
  path: string
  bytes: number
  // Removes the file; called once it is sent, refused or abandoned.
  done(): Promise<void>
}

// The query of the route, checked: a format, and "includeForgotten" as 1 or 0 (left out: 0).
export function exportQuery(format: string | null, includeForgotten: string | null) {
  if (!(EXPORT_FORMATS as readonly string[]).includes(format ?? ''))
    throw invalid(
      '"format" is "readable" or "faithful".',
      'Send format=readable (to read) or format=faithful (to import elsewhere).',
    )
  if (includeForgotten !== null && includeForgotten !== '0' && includeForgotten !== '1')
    throw invalid(
      '"includeForgotten" is 1 or 0.',
      'Send includeForgotten=1 to include forgotten entries, or leave it out.',
    )
  return { format: format as ExportFormat, includeForgotten: includeForgotten === '1' }
}

const stamp = (at: Date) =>
  at
    .toISOString()
    .replace(/[-:]/g, '')
    .replace(/\.\d{3}/, '')

const busy = () =>
  new AppError(
    409,
    'export_busy',
    'Another export is being prepared. Try again in a minute.',
    'Wait a minute and download the export again.',
  )
const noSpace = () =>
  new AppError(
    507,
    'export_no_space',
    'The server does not have enough free disk space to prepare this export.',
    'Ask an administrator to free disk space on the server, then try again.',
  )

async function privateDir(dir: string): Promise<void> {
  await mkdir(dir, { recursive: true, mode: 0o700 })
  await chmod(dir, 0o700)
}

// Removes what a crash left: prepared files older than an hour. Called when the server starts.
export async function sweepExports(dir: string, now: Date): Promise<void> {
  let names: string[]
  try {
    names = await readdir(dir)
  } catch {
    return
  }
  for (const n of names) {
    if (!n.endsWith('.zip.part')) continue
    const p = join(dir, n)
    try {
      if (now.getTime() - (await stat(p)).mtimeMs > STALE_MS) await rm(p, { force: true })
    } catch {
      // Gone already, or not ours to remove.
    }
  }
}

export async function exportBrain(
  ctx: Ctx,
  slug: string,
  o: { format: ExportFormat; includeForgotten: boolean },
  dir: string = EXPORT_DIR,
): Promise<ExportFile> {
  inWeb(ctx, 'Exporting a brain')
  const { brain, role } = await inBrain(ctx, { slug })
  await allow(ctx, 'brain.export', { role, brainStatus: brain.status }, brain.id)
  if (EXPORT_STATE.building >= EXPORT_LIMITS.building) throw busy()
  EXPORT_STATE.building += 1
  let path: string | null = null
  try {
    await privateDir(dir)
    const free = async () => {
      const s = await statfs(dir)
      return Number(s.bavail) * Number(s.bsize)
    }
    if ((await free()) < EXPORT_LIMITS.minFreeBytes) throw noSpace()
    const at = ctx.clock()
    await ok(ctx, 'brain.export', brain.id, undefined, JSON.stringify(o))
    await emit(ctx.db, ctx, {
      brainId: brain.id,
      kind: 'brain.exported',
      label: o.includeForgotten ? `${o.format}, forgotten included` : o.format,
    })
    path = join(dir, `${randomBytes(12).toString('hex')}.zip.part`)
    const fh = await open(path, 'wx', 0o600)
    let bytes = 0
    try {
      await ctx.db.tx(async (db) => {
        await db.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY')
        await db.query("SET LOCAL TIME ZONE 'UTC'")
        // The brain as the snapshot has it (renamed since the check: its name of now; left since: not found).
        const now = (await inBrain({ ...ctx, db }, { id: brain.id })).brain
        let sinceCheck = 0
        const zip = zipWriter(
          async (b) => {
            bytes += b.length
            if (bytes > EXPORT_LIMITS.maxBytes) throw noSpace()
            await fh.write(b)
            sinceCheck += b.length
            // The room left is looked at every 8 MB: an export never fills the disk.
            if (sinceCheck >= 8 * 1024 * 1024) {
              sinceCheck = 0
              if ((await free()) < EXPORT_LIMITS.minFreeBytes) throw noSpace()
            }
          },
          { at },
        )
        const x = { brain: now, includeForgotten: o.includeForgotten, at, release: VERSION }
        if (o.format === 'readable') await writeReadable(db, zip, x)
        else await writeFaithful(db, zip, x)
        await zip.end()
      })
    } finally {
      await fh.close()
    }
    const file = path
    path = null
    return {
      name: `rsc-brain-${brain.slug}-${o.format}-${stamp(at)}.zip`,
      type: 'application/zip',
      path: file,
      bytes,
      done: () => rm(file, { force: true }),
    }
  } catch (err) {
    if (path) await rm(path, { force: true })
    // A disk that filled up while writing says so in the same words.
    if ((err as NodeJS.ErrnoException)?.code === 'ENOSPC') throw noSpace()
    throw err
  } finally {
    EXPORT_STATE.building -= 1
  }
}
