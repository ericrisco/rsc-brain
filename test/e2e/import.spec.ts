// Settings › Import against the real server and PostgreSQL (plan T031; local lane): a curator imports the sample
// 02-DOCS (test/fixtures/docs-sample/) as a .zip from the screen; the report says what came in; the overview of
// the brain, open in another tab, marks its third step by the event, without reloading; the wiki has the pages.
import { expect, type Page, test } from '@playwright/test'
import { zipOfFolder } from '../helpers/zipfolder.ts'
import { keepTheKey } from './key.ts'

const ADMIN = { name: 'Eric', email: 'eric@example.test', password: 'correct horse battery staple' }
const SAMPLE = new URL('../fixtures/docs-sample/', import.meta.url).pathname

test.describe.configure({ mode: 'serial' })

async function signedInAdmin(page: Page, baseURL: string): Promise<void> {
  await page.goto('/')
  const h1 = page.getByRole('heading', { level: 1 })
  await expect(h1).toHaveText(/Set up rsc-brain|Sign in|Your brains/)
  const where = await h1.textContent()
  if (where === 'Set up rsc-brain') {
    await page.getByLabel('Name of this installation').fill('rsc-brain')
    await page.getByLabel('Address people open').fill(baseURL)
    await page.getByLabel('Your name').fill(ADMIN.name)
    await page.getByLabel('Your email').fill(ADMIN.email)
    await page.getByLabel('Password', { exact: true }).fill(ADMIN.password)
    await page.getByRole('button', { name: 'Set up and sign in' }).click()
    await keepTheKey(page)
  } else if (where === 'Sign in') {
    await page.getByLabel('Email').fill(ADMIN.email)
    await page.getByLabel('Password').fill(ADMIN.password)
    await page.getByRole('button', { name: 'Sign in' }).click()
  }
  await expect(page.getByRole('heading', { level: 1, name: 'Your brains' })).toBeVisible()
}

test('a curator imports the sample docs; the overview marks step 3 by the event', async ({
  page,
  baseURL,
  context,
}) => {
  await signedInAdmin(page, baseURL as string)
  await page.getByRole('button', { name: 'Create brain' }).first().click()
  const dialog = page.getByRole('dialog', { name: 'Create a brain' })
  await dialog.getByLabel('Name').fill('Import walk')
  await dialog.getByRole('button', { name: 'Create brain' }).click()
  await expect(page).toHaveURL(/\/b\/[^/]+$/)
  const slug = decodeURIComponent(new URL(page.url()).pathname.split('/')[2] as string)
  const third = page.getByRole('region', { name: 'First steps' }).getByRole('listitem').nth(2)
  await expect(third).toContainText('To do')
  const overviewUrl = page.url()
  // The import, from Settings in another tab.
  const other = await context.newPage()
  await other.goto(`/b/${slug}/settings/import`)
  const part = other.getByRole('region', { name: 'Import a documentation folder' })
  await part.getByLabel('Zip to import').setInputFiles({
    name: 'docs-sample.zip',
    mimeType: 'application/zip',
    buffer: await zipOfFolder(SAMPLE),
  })
  await part.getByRole('button', { name: 'Import the folder' }).click()
  const report = part.getByRole('region', { name: 'What came in' })
  await expect(report).toContainText('Imported 5 pages, 4 entries and 5 links from docs-sample.zip.')
  await report.getByText('Left out (7)').click()
  await expect(report).toContainText('raw/keys/admin.totp')
  // The overview heard it.
  await expect(third).toContainText('Done', { timeout: 10_000 })
  expect(page.url()).toBe(overviewUrl)
  // The wiki has the pages, linked.
  await report.getByRole('link', { name: 'Open the wiki' }).click()
  await expect(other.getByText('Getting started').first()).toBeVisible()
  const graph = await other.request.get(`/v1/brains/${slug}/wiki/graph`)
  const g = (await graph.json()) as { nodes: unknown[]; edges: unknown[] }
  expect([g.nodes.length, g.edges.length]).toEqual([5, 5])
})
