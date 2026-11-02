// Settings › Export (spec B7 «Exportar un cerebro», plan T024), against the fixture API. Job: a curator saves the
// brain as a zip, readable (a vault) or faithful (to import elsewhere), with forgotten entries only when asked.
// Done when: the file is saved and the screen says its name and size. States: ready, preparing (what has
// arrived so far), saved, refused (the server's words and what to do), offline (the button says why it waits).
// By keyboard alone; at 320 px without sideways scroll; the audit passes.
import { readFileSync } from 'node:fs'
import AxeBuilder from '@axe-core/playwright'
import type { Page } from '@playwright/test'
import { filesOf } from '../helpers/unzip.ts'
import { expect, noSideScroll, scenario, test } from './fixture.ts'

async function audit(page: Page, where: string) {
  const r = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa', 'best-practice'])
    .analyze()
  const bad = r.violations
    .filter((v) => v.impact === 'serious' || v.impact === 'critical')
    .map((v) => `${where}: ${v.id} (${v.impact}) ${v.nodes.map((n) => n.target.join(' ')).join(', ')}`)
  expect(bad).toEqual([])
}

const part = (page: Page) => page.getByRole('region', { name: 'Export', exact: true })

test.describe('exporting a brain', () => {
  test('a curator saves the readable export; the screen says the file and its size', async ({
    page,
    context,
    baseURL,
  }) => {
    await scenario(context, baseURL as string, 'signed-in')
    await page.goto('/b/growth/settings/archive')
    const p = part(page)
    await expect(p).toBeVisible()
    await expect(p.getByRole('radio', { name: /Readable/ })).toBeChecked()
    await expect(p.getByRole('checkbox', { name: 'Include forgotten entries' })).not.toBeChecked()
    await audit(page, 'export ready')
    const [file] = await Promise.all([
      page.waitForEvent('download'),
      p.getByRole('button', { name: 'Download the export' }).click(),
    ])
    expect(file.suggestedFilename()).toMatch(/^rsc-brain-growth-readable-\d{8}T\d{6}Z\.zip$/)
    const saved = filesOf(readFileSync(await file.path()))
    expect(saved.get('README.md')).toContain('format: readable')
    expect(saved.get('README.md')).toContain('includeForgotten: false')
    await expect(p.getByRole('status')).toContainText(
      /Saved rsc-brain-growth-readable-\d{8}T\d{6}Z\.zip \(\d+(\.\d)? (bytes|kB)\)\./,
    )
    await audit(page, 'export saved')
  })

  test('by keyboard alone: the faithful export with forgotten entries', async ({
    page,
    context,
    baseURL,
  }) => {
    await scenario(context, baseURL as string, 'signed-in')
    await page.goto('/b/growth/settings/archive')
    const p = part(page)
    await p.getByRole('radio', { name: /Readable/ }).focus()
    await page.keyboard.press('ArrowDown')
    await expect(p.getByRole('radio', { name: /Faithful/ })).toBeChecked()
    await page.keyboard.press('Tab')
    await expect(p.getByRole('checkbox', { name: 'Include forgotten entries' })).toBeFocused()
    await page.keyboard.press('Space')
    await expect(p.getByRole('checkbox', { name: 'Include forgotten entries' })).toBeChecked()
    await page.keyboard.press('Tab')
    await expect(p.getByRole('button', { name: 'Download the export' })).toBeFocused()
    const [file] = await Promise.all([page.waitForEvent('download'), page.keyboard.press('Enter')])
    expect(file.suggestedFilename()).toMatch(/^rsc-brain-growth-faithful-/)
    const saved = filesOf(readFileSync(await file.path()))
    expect(saved.get('README.md')).toContain('includeForgotten: true')
    await expect(p.getByRole('status')).toContainText('Saved rsc-brain-growth-faithful-')
  })

  test('while the server makes it, the screen says so and the button waits', async ({
    page,
    context,
    baseURL,
  }) => {
    await scenario(context, baseURL as string, 'signed-in', { export: 'loading' })
    await page.goto('/b/growth/settings/archive')
    const p = part(page)
    const downloading = page.waitForEvent('download')
    await p.getByRole('button', { name: 'Download the export' }).click()
    await expect(p.getByRole('status')).toContainText('Preparing the export')
    await expect(p.getByRole('button', { name: /Preparing/ })).toBeDisabled()
    await downloading
    await expect(p.getByRole('status')).toContainText('Saved')
    await expect(p.getByRole('button', { name: 'Download the export' })).toBeEnabled()
  })

  test('a refusal says what happened and what to do, and nothing is saved', async ({
    page,
    context,
    baseURL,
  }) => {
    await scenario(context, baseURL as string, 'signed-in', { export: 'error' })
    await page.goto('/b/growth/settings/archive')
    const p = part(page)
    let saved = false
    page.on('download', () => {
      saved = true
    })
    await p.getByRole('button', { name: 'Download the export' }).click()
    const alert = p.getByRole('alert')
    await expect(alert).toContainText('Something went wrong')
    await expect(alert).toBeFocused()
    await expect(p.getByText(/^Saved/)).toHaveCount(0)
    expect(saved).toBe(false)
    await audit(page, 'export refused')
  })

  test('offline, the button says why it waits', async ({ page, context, baseURL }) => {
    await scenario(context, baseURL as string, 'signed-in')
    await page.goto('/b/growth/settings/archive')
    // The screen is drawn first: offline before it loads is another state (the page's own).
    await expect(part(page).getByRole('button', { name: 'Download the export' })).toBeEnabled()
    await context.setOffline(true)
    await expect(part(page).getByRole('button', { name: 'Download the export' })).toBeDisabled()
    await expect(part(page)).toContainText(/offline|connection/i)
    await context.setOffline(false)
    await expect(part(page).getByRole('button', { name: 'Download the export' })).toBeEnabled()
  })

  test('at 320 px it fits without sideways scroll, and passes the audit', async ({
    page,
    context,
    baseURL,
  }) => {
    await page.setViewportSize({ width: 320, height: 720 })
    await scenario(context, baseURL as string, 'signed-in')
    await page.goto('/b/growth/settings/archive')
    await expect(part(page)).toBeVisible()
    await noSideScroll(page)
    await audit(page, 'export 320')
  })
})
