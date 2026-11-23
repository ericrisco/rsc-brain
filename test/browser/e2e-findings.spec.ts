// Findings of an end-to-end walk with a 156-page wiki, each held by a test: wikilinks that show a page's title up
// to its colon; the links of a page listing each page once; the review of a proposal rendering and folding what it
// proposes; search as you type, with a hint when meaning search is off; known debates in Health; the first-time
// setup (its count, the key kept on screen until saved, no refused question before the setup is known).
import type { Page } from '@playwright/test'
import { expect, noSideScroll, PASSWORD, scenario, test } from './fixture.ts'

const LONG_TITLE = 'AWQ: Activation-aware Weight Quantization for LLM Compression and Acceleration'

// A page of the fixture answered with a body that mentions another page, and that page also linked as related.
async function patchPage(page: Page) {
  await page.route('**/v1/brains/growth/pages/audience/retention*', async (route) => {
    const res = await route.fetch()
    const j = await res.json()
    j.page.body = 'Read [[audience/intros]] first, or [[audience/intros|the intros page]].'
    const to = { address: 'audience/intros', pageId: 'pg_x', title: LONG_TITLE, state: 'ok' }
    j.links.out = [
      { kind: 'mentions', ...to },
      { kind: 'related', ...to },
    ]
    await route.fulfill({ response: res, json: j })
  })
}

test('a wikilink shows the title up to its colon; the full title is on hover; an alias wins', async ({
  page,
  context,
  baseURL,
}) => {
  await scenario(context, baseURL as string, 'signed-in')
  await patchPage(page)
  await page.goto('/b/growth/pages/audience/retention')
  const prose = page.locator('.prose')
  const short = prose.getByRole('link', { name: 'AWQ', exact: true })
  await expect(short).toHaveAttribute('title', LONG_TITLE)
  await expect(prose.getByRole('link', { name: 'the intros page' })).toBeVisible()
  await expect(prose).not.toContainText('Activation-aware')
})

test('the links of a page list a page once, under its typed kind, not again under Mentions', async ({
  page,
  context,
  baseURL,
}) => {
  await scenario(context, baseURL as string, 'signed-in')
  await patchPage(page)
  await page.goto('/b/growth/pages/audience/retention')
  const links = page.getByRole('region', { name: 'Links' })
  await expect(links.getByRole('heading', { name: 'Related' })).toBeVisible()
  await expect(links.getByRole('heading', { name: 'Mentions' })).toHaveCount(0)
  await expect(links.getByRole('link', { name: /Activation-aware/ })).toHaveCount(1)
})

test('a proposal shows a new page as it will read, and an edit by its changed lines with the rest folded', async ({
  page,
  context,
  baseURL,
}) => {
  await scenario(context, baseURL as string, 'signed-in')
  const lines = Array.from({ length: 14 }, (_, i) => `Line ${i + 1} of the page.`)
  await page.route('**/v1/proposals/prp_growth1/review*', async (route) => {
    const res = await route.fetch()
    const j = await res.json()
    const edit = j.ops[0]
    edit.before.body = lines.join('\n')
    edit.after.body = lines.map((l, i) => (i === 6 ? 'A new seventh line.' : l)).join('\n')
    j.ops[1].op.body = 'First paragraph.\n\n- one\n- **two**'
    j.ops[1].after.body = j.ops[1].op.body
    await route.fulfill({ response: res, json: j })
  })
  await page.goto('/b/growth/proposals/prp_growth1')
  const card = page.locator('.op-diff').first()
  const diff = card.locator('.body-diff')
  await expect(diff.getByText('A new seventh line.')).toBeVisible()
  await expect(diff.getByText('Line 1 of the page.')).toHaveCount(0)
  const fold = diff.getByRole('button', { name: /Show \d+ unchanged lines?/ })
  await expect(fold).toHaveCount(2)
  await fold.first().click()
  await expect(diff.getByText('Line 1 of the page.')).toBeVisible()
  await expect(diff.getByRole('button', { name: 'Hide the unchanged lines' })).toBeVisible()
  // What is proposed can be read as the page will look.
  await card.getByText('Read the page as it will look').click()
  await expect(card.locator('.prose')).toContainText('A new seventh line.')
  // A new page is rendered, not shown as raw markdown.
  await expect(page.locator('.op-new .prose li strong')).toHaveText('two')
  await noSideScroll(page)
})

test('search runs as you type, with the arrows still moving through the results', async ({
  page,
  context,
  baseURL,
}) => {
  await scenario(context, baseURL as string, 'signed-in')
  await page.goto('/b/growth')
  await expect(page.getByRole('heading', { level: 1, name: 'Growth' })).toBeVisible()
  await page.keyboard.press('Control+k')
  const d = page.getByRole('dialog', { name: 'Search' })
  const asked: string[] = []
  page.on('request', (r) => {
    if (r.url().includes('/v1/search')) asked.push(new URL(r.url()).searchParams.get('q') ?? '')
  })
  await d.getByLabel('Search for').pressSequentially('retention', { delay: 20 })
  await expect(d.getByRole('list', { name: 'Results' }).getByRole('listitem').first()).toBeVisible()
  // One search for the whole word, not one per key.
  expect(asked).toEqual(['retention'])
  await d.getByLabel('Search for').press('ArrowDown')
  await expect(d.locator('a.rt').first()).toBeFocused()
  // Meaning search is off in the fixture: the answer says so, for searches in another language.
  await expect(d.getByText(/Meaning search is off/)).toBeVisible()
})

test('a curator marks a contradiction as a known debate; it leaves the problems and can be brought back', async ({
  page,
  context,
  baseURL,
}) => {
  await scenario(context, baseURL as string, 'signed-in')
  await page.goto('/b/growth/health')
  const conflicts = page.getByRole('region', { name: 'Conflicts' })
  await expect(conflicts.getByRole('listitem')).toHaveCount(2)
  await expect(page.getByText('13 things to fix')).toBeVisible()
  await conflicts.getByRole('button', { name: 'Mark as a known debate' }).first().click()
  await expect(conflicts.getByRole('listitem')).toHaveCount(1)
  await expect(page.getByText('12 things to fix')).toBeVisible()
  const debates = page.getByRole('region', { name: 'Known debates' })
  await expect(debates.getByRole('listitem')).toHaveCount(1)
  await debates.getByRole('button', { name: 'Treat as a contradiction again' }).click()
  await expect(conflicts.getByRole('listitem')).toHaveCount(2)
  await expect(page.getByRole('region', { name: 'Known debates' })).toHaveCount(0)
})

async function fillSetup(page: Page) {
  await page.getByLabel('Name of this installation').fill('Acme')
  await page.getByLabel('Your name').fill('Ada')
  await page.getByLabel('Your email').fill('ada@example.test')
  await page.getByLabel('Password', { exact: true }).fill(PASSWORD)
}

test('setup: the lead counts the two steps of the form, and no refused question is sent first', async ({
  page,
  context,
  baseURL,
}) => {
  await scenario(context, baseURL as string, 'fresh')
  const me: number[] = []
  page.on('response', (r) => {
    if (/\/v1\/me$/.test(new URL(r.url()).pathname)) me.push(r.status())
  })
  await page.goto('/')
  await expect(page).toHaveURL(/\/setup$/)
  await expect(page.getByText(/^Two steps, then the installation key/)).toBeVisible()
  await expect(page.getByText('1', { exact: true }).first()).toBeVisible()
  await expect(page.locator('legend .step')).toHaveText(['1', '2'])
  expect(me).toEqual([])
})

test('setup: the installation key stays on screen until it is confirmed as saved', async ({
  page,
  context,
  baseURL,
}) => {
  await scenario(context, baseURL as string, 'fresh')
  await page.goto('/setup')
  await fillSetup(page)
  await page.getByRole('button', { name: 'Set up and sign in' }).click()
  await expect(page.getByRole('heading', { level: 1, name: 'Keep the installation key' })).toBeVisible()
  await expect(page.locator('pre')).toContainText('fixture-installation-key')
  // Moving inside the app (Back, a link followed from elsewhere) brings the person back to the key.
  await page.evaluate(() => {
    history.pushState({}, '', '/profile')
    window.dispatchEvent(new PopStateEvent('popstate'))
  })
  await expect(page.getByRole('heading', { level: 1, name: 'Keep the installation key' })).toBeVisible()
  await expect(page).toHaveURL(/\/setup$/)
  await expect(page.locator('pre')).toContainText('fixture-installation-key')
  // Closing the tab asks first.
  const asked = await page.evaluate(() => {
    const e = new Event('beforeunload', { cancelable: true })
    window.dispatchEvent(e)
    return e.defaultPrevented
  })
  expect(asked).toBe(true)
  // Once saved, the person goes on.
  await page.getByLabel('I saved the installation key somewhere safe, outside this machine').check()
  await page.getByRole('button', { name: 'Continue to rsc-brain' }).click()
  await expect(page).toHaveURL(/\/$/)
})
