// The export of a brain in the fixture API (spec B7 PR31): a small zip that says what was asked for, so a
// browser test can read the file it saved. Built with the server's own writer.
import { zipWriter } from '../../../src/core/zip.ts'

async function zipOf(files: Record<string, string>): Promise<Buffer> {
  const chunks: Buffer[] = []
  const z = zipWriter(async (b) => {
    chunks.push(Buffer.from(b))
  })
  for (const [name, text] of Object.entries(files)) await z.file(name, text)
  await z.end()
  return Buffer.concat(chunks)
}

const ZIPS = new Map<string, Buffer>()
for (const format of ['readable', 'faithful'])
  for (const forgotten of [false, true])
    ZIPS.set(
      `${format} ${forgotten}`,
      await zipOf({
        'README.md': `# Growth\n\nformat: ${format}\nincludeForgotten: ${forgotten}\n`,
        ...(format === 'readable'
          ? { 'wiki/audience/retention.md': '# Retention\n', 'index.md': '# Growth\n' }
          : { 'manifest.json': `${JSON.stringify({ format: 'rsc-brain-faithful', version: 1 })}\n` }),
      }),
    )

export const exportZip = (format: string, includeForgotten: boolean) =>
  ZIPS.get(`${format} ${includeForgotten}`) as Buffer
