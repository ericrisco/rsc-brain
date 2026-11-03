// Settings › Import and the third first step (spec B7 «Importar», plan T031), against the fixture API. Job: a
// curator of a new brain brings in a documentation folder as a .zip. Done when: the screen says what came in and
// what did not, leads to the wiki, and the overview's step 3 is marked (by the event, without reloading). States:
// ready, a file that cannot go (said before it goes), uploading then writing, done with the report, refused (the
// server's words; the file stays chosen), a brain with content (no form, said why), offline, a long report. By
// keyboard alone; at 320 px without sideways scroll; the audit passes.
import AxeBuilder from '@axe-core/playwright'
import type { Page } from '@playwright/test'
import { zipOfFolder } from '../helpers/zipfolder.ts'
import { expect, noSideScroll, scenario, test } from './fixture.ts'

const SAMPLE = new URL('../fixtures/docs-sample/', import.meta.url).pathname

async function audit(page: Page, where: string) {
  const r = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa', 'best-practice'])
    .analyze()
  const bad = r.violations
    .filter((v) => v.impact === 'serious' || v.impact === 'critical')
    .map((v) => `${where}: ${v.id} (${v.impact}) ${v.nodes.map((n) => n.target.join(' ')).join(', ')}`)
  expect(bad).toEqual([])
}

const part = (page: Page) => page.getByRole('region', { name: 'Import a documentation folder' })

async function newBrain(page: Page, name = 'Onboarding') {
  await page.goto('/')
  await page.getByRole('button', { name: 'Create brain' }).first().click()
  const dialog = page.getByRole('dialog', { name: 'Create a brain' })
  await dialog.getByLabel('Name').fill(name)
  await dialog.getByRole('button', { name: 'Create brain' }).click()
  await expect(page.getByRole('heading', { level: 1, name })).toBeVisible()
}

test.describe('importing a documentation folder', () => {
  test('from the first steps to the report, and the third step marks itself', async ({
    page,
    context,
    baseURL,
  }) => {
    await scenario(context, baseURL as string, 'signed-in')
    await newBrain(page)
    const steps = page.getByRole('region', { name: 'First steps' })
    const third = steps.getByRole('listitem').nth(2)
    await expect(steps.getByRole('listitem')).toHaveCount(3)
    await expect(
      third.getByRole('heading', { level: 3, name: '3. Import a documentation folder' }),
    ).toBeVisible()
    await expect(third).toContainText('To do')
    await third.getByRole('link', { name: 'Import a folder' }).click()
    await expect(page).toHaveURL(/\/b\/onboarding\/settings\/import$/)
    const p = part(page)
    await expect(p).toContainText('Only into an empty brain')
    await expect(page.getByRole('link', { name: 'Import', exact: true })).toHaveAttribute(
      'aria-current',
      'page',
    )
    await audit(page, 'import ready')
    await p.getByLabel('Zip to import').setInputFiles({
      name: 'docs-sample.zip',
      mimeType: 'application/zip',
      buffer: await zipOfFolder(SAMPLE),
    })
    await p.getByRole('button', { name: 'Import the folder' }).click()
    const report = p.getByRole('region', { name: 'What came in' })
    await expect(report).toBeVisible()
    await expect(report.getByRole('heading', { name: 'What came in' })).toBeFocused()
    await expect(report).toContainText('Imported 5 pages, 4 entries and 5 links from docs-sample.zip.')
    await report.getByText('Left out (7)').click()
    await expect(report).toContainText('raw/keys/admin.totp — named like a key or a secret: never read')
    await report.getByText('Links that lead nowhere (2)').click()
    await expect(report).toContainText('missing-page from topics/retention')
    await report.getByText('Names made into addresses (1)').click()
    await expect(report).toContainText('wiki/topics/Audience Notes.md becomes topics/audience-notes')
    await expect(report.getByRole('link', { name: 'Open the wiki' })).toHaveAttribute(
      'href',
      '/b/onboarding/wiki',
    )
    await audit(page, 'import done')
    await page.goto('/b/onboarding')
    await expect(third).toContainText('Done')
    await expect(third).toContainText('Imported.')
  })

  test('the third step marks itself when someone else imports, without reloading', async ({
    page,
    context,
    baseURL,
  }) => {
    const s = await scenario(context, baseURL as string, 'signed-in')
    await newBrain(page)
    const third = page.getByRole('region', { name: 'First steps' }).getByRole('listitem').nth(2)
    await expect(third).toContainText('To do')
    const url = page.url()
    await s.emit('onboarding', 'brain.imported', { target: { id: '', label: 'docs' } })
    await expect(third).toContainText('Done', { timeout: 5_000 })
    expect(page.url()).toBe(url)
  })

  test('a file that cannot go is said before it goes; a refusal keeps the file and says what to do', async ({
    page,
    context,
    baseURL,
  }) => {
    await scenario(context, baseURL as string, 'signed-in')
    await newBrain(page)
    await page.goto('/b/onboarding/settings/import')
    const p = part(page)
    const input = p.getByLabel('Zip to import')
    // Nothing chosen: the button says what to do first.
    await p.getByRole('button', { name: 'Import the folder' }).click()
    await expect(p).toContainText('Choose a .zip to import first.')
    await expect(input).toBeFocused()
    await input.setInputFiles({
      name: 'notes.tar.gz',
      mimeType: 'application/gzip',
      buffer: Buffer.from('x'),
    })
    await expect(input).toHaveAttribute('aria-invalid', 'true')
    await expect(p).toContainText('This is not a .zip.')
    // A .zip that is not one: the server's words, and the person can choose another.
    await input.setInputFiles({
      name: 'broken.zip',
      mimeType: 'application/zip',
      buffer: Buffer.from('not a zip'),
    })
    await expect(input).not.toHaveAttribute('aria-invalid', 'true')
    await p.getByRole('button', { name: 'Import the folder' }).click()
    const alert = p.getByRole('alert')
    await expect(alert).toContainText('This is not a zip rsc-brain can read')
    await expect(alert).toContainText('Make the zip again')
    await expect(alert).toBeFocused()
    await expect(p.getByRole('region', { name: 'What came in' })).toHaveCount(0)
    await audit(page, 'import refused')
  })

  test('a brain with content says why it cannot import, instead of a form', async ({
    page,
    context,
    baseURL,
  }) => {
    await scenario(context, baseURL as string, 'signed-in')
    await page.goto('/b/growth/settings/import')
    const p = part(page)
    await expect(p).toContainText('This brain already has content')
    await expect(p.getByLabel('Zip to import')).toHaveCount(0)
  })

  test('by keyboard alone, with a long report', async ({ page, context, baseURL }) => {
    await scenario(context, baseURL as string, 'signed-in', { import: 'much-data' })
    await newBrain(page)
    await page.goto('/b/onboarding/settings/import')
    await expect(page.locator('#import-title')).toBeFocused()
    const p = part(page)
    await p.getByLabel('Zip to import').setInputFiles({
      name: 'docs.zip',
      mimeType: 'application/zip',
      buffer: await zipOfFolder(SAMPLE),
    })
    await p.getByLabel('Zip to import').focus()
    await page.keyboard.press('Tab')
    await expect(p.getByRole('button', { name: 'Import the folder' })).toBeFocused()
    await page.keyboard.press('Enter')
    const report = p.getByRole('region', { name: 'What came in' })
    await expect(report.getByRole('heading', { name: 'What came in' })).toBeFocused()
    await page.keyboard.press('Tab')
    await expect(report.getByRole('link', { name: 'Open the wiki' })).toBeFocused()
    await page.keyboard.press('Tab')
    await page.keyboard.press('Tab')
    await page.keyboard.press('Enter')
    await expect(report).toContainText('Left out (1,234)')
    await expect(report).toContainText('And 734 more, not listed here.')
  })

  test('offline, the button says why it waits; at 320 px it fits and passes the audit', async ({
    page,
    context,
    baseURL,
  }) => {
    await page.setViewportSize({ width: 320, height: 720 })
    await scenario(context, baseURL as string, 'signed-in')
    await newBrain(page)
    await page.goto('/b/onboarding/settings/import')
    const button = part(page).getByRole('button', { name: 'Import the folder' })
    await expect(button).toBeEnabled()
    await noSideScroll(page)
    await audit(page, 'import 320')
    await context.setOffline(true)
    await expect(button).toBeDisabled()
    await context.setOffline(false)
    await expect(button).toBeEnabled()
  })
})
