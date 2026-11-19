// CA4 (spec web redesign, «Leer la wiki»): the body of a wiki page reads in a line of 60 to 80 characters,
// at 1440 and 1920 wide, with the rail open and folded. A long paragraph is set into the page's own body and
// its full lines are counted where the browser broke them.
import type { Page } from '@playwright/test'
import { expect, scenario, test } from './fixture.ts'

const WORDS =
  'Short intros keep viewers past thirty seconds while the long ones lose a third of them before the hook arrives, so the team keeps every intro under ten seconds and checks the retention curve each week before the next batch of videos goes out to the audience. '

async function lineLengths(page: Page): Promise<number[]> {
  return page.evaluate((words) => {
    const body = document.querySelector('main .prose') as HTMLElement
    const p = document.createElement('p')
    p.textContent = words.repeat(3)
    body.prepend(p)
    const text = p.firstChild as Text
    const tops: number[] = []
    const r = document.createRange()
    for (let i = 0; i < text.length; i++) {
      r.setStart(text, i)
      r.setEnd(text, i + 1)
      const rect = r.getClientRects()[0]
      tops.push(rect ? Math.round(rect.top) : -1)
    }
    const counts = new Map<number, number>()
    for (const t of tops) if (t >= 0) counts.set(t, (counts.get(t) ?? 0) + 1)
    p.remove()
    // Every full line: all but the last.
    return [...counts.values()].slice(0, -1)
  }, WORDS)
}

for (const width of [1440, 1920])
  for (const rail of ['open', 'folded'] as const)
    test(`CA4: a line of the page's body is 60 to 80 characters at ${width}, rail ${rail}`, async ({
      page,
      context,
      baseURL,
    }) => {
      await scenario(context, baseURL as string, 'signed-in')
      await page.addInitScript((r) => localStorage.setItem('rscb.rail', r), rail)
      await page.setViewportSize({ width, height: width === 1920 ? 1080 : 900 })
      await page.goto('/b/growth/pages/audience/retention')
      await expect(page.getByRole('heading', { name: 'What keeps viewers' })).toBeVisible()
      await page.evaluate(() => document.fonts.ready)
      // The body reads in the text face, not the monospaced one.
      const face = await page.evaluate(
        () => getComputedStyle(document.querySelector('main .prose') as Element).fontFamily,
      )
      expect(face).toMatch(/^"?IBM Plex Sans/)
      const lines = await lineLengths(page)
      expect(lines.length).toBeGreaterThan(3)
      for (const n of lines) {
        expect(n).toBeGreaterThanOrEqual(60)
        expect(n).toBeLessThanOrEqual(80)
      }
    })
