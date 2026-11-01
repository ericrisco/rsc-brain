// «Connect your agent» (spec B6, B5 «Kit de conexión», plan T043) against the fixture API: one tab per
// agent; the standard connection; the token connection, which makes a token and fills the configuration
// with it, shown once; the optional reminder; how to check it works; and the live check, which turns
// green on the first request of that key (or when a new connected app appears).
import AxeBuilder from '@axe-core/playwright'
import { expect, noSideScroll, scenario, test } from './fixture.ts'

const agent = (baseURL: string, id: string, body: Record<string, unknown>) =>
  fetch(`${baseURL}/__fixture/scenarios/${id}/agent`, { method: 'POST', body: JSON.stringify(body) })

test('one tab per agent, with the standard connection, the reminder and how to check it', async ({
  page,
  context,
  baseURL,
}) => {
  await scenario(context, baseURL as string, 'member')
  await page.goto('/connect')
  await expect(page.getByRole('heading', { level: 1, name: 'Connect your agent' })).toBeVisible()
  const tabs = page.getByRole('tablist', { name: 'Your agent' })
  await expect(tabs.getByRole('tab')).toHaveText([
    'Claude Code',
    'Codex',
    'OpenCode',
    'Cursor',
    'Other agents',
  ])
  await expect(tabs.getByRole('tab', { name: 'Claude Code' })).toHaveAttribute('aria-selected', 'true')
  const panel = page.getByRole('tabpanel', { name: 'Claude Code' })
  await expect(panel.getByRole('region', { name: 'Standard connection' })).toContainText(
    'claude mcp add --transport http rsc-brain https://brain.example.test/mcp',
  )
  await expect(panel.getByRole('region', { name: 'Reminder (optional)' })).toContainText('SessionStart')
  await expect(panel.getByRole('region', { name: 'How to check it works' })).toContainText('Ask your agent')
  // Arrow keys move between the tabs, as tabs do.
  await tabs.getByRole('tab', { name: 'Claude Code' }).focus()
  await page.keyboard.press('ArrowRight')
  await expect(tabs.getByRole('tab', { name: 'Codex' })).toBeFocused()
  await expect(tabs.getByRole('tab', { name: 'Codex' })).toHaveAttribute('aria-selected', 'true')
  await expect(page.getByRole('tabpanel', { name: 'Codex' })).toContainText('codex mcp add rsc-brain')
  await page.keyboard.press('End')
  await expect(tabs.getByRole('tab', { name: 'Other agents' })).toBeFocused()
  await expect(page.getByRole('tabpanel', { name: 'Other agents' })).toContainText(
    'https://brain.example.test/mcp',
  )
  await page.keyboard.press('Home')
  await expect(tabs.getByRole('tab', { name: 'Claude Code' })).toBeFocused()
})

test('the live check waits, then turns green on the first request of the token made here; shown once', async ({
  page,
  context,
  baseURL,
}) => {
  const s = await scenario(context, baseURL as string, 'signed-in')
  await page.goto('/connect')
  const check = page.getByRole('region', { name: 'Live check' })
  await expect(check).toContainText('Waiting for your agent…')
  const withToken = page
    .getByRole('tabpanel', { name: 'Claude Code' })
    .getByRole('region', { name: 'Token connection' })
  await withToken.getByRole('button', { name: 'Create a token' }).click()
  const once = withToken.getByRole('region', { name: 'Your new token' })
  await expect(once).toContainText('only this once')
  await expect(once.getByRole('button', { name: 'Copy the token' })).toBeFocused()
  const secret = String(await once.locator('pre code').first().textContent()).trim()
  expect(secret).toMatch(/^rscb_/)
  // The commands never carry it: it is pasted at a hidden prompt, into this agent's own file.
  await expect(once).toContainText('read -rs t')
  await expect(once).toContainText('RSC_BRAIN_TOKEN_CLAUDE_CODE')
  await expect(once).not.toContainText(`export RSC_BRAIN_TOKEN_CLAUDE_CODE="${secret}"`)
  await expect(once).toContainText('.mcp.json')
  await expect(check).toContainText('Waiting for your agent…')
  // The agent makes its first request.
  await agent(baseURL as string, s.id, { via: 'token', client: 'claude-code/2.1.3' })
  await expect(check).toContainText('Connected', { timeout: 6_000 })
  await expect(check).toContainText('Claude Code reached rsc-brain')
  await expect(check.locator('[data-check="connected"]')).toBeVisible()
  await withToken.getByRole('button', { name: 'Done, hide the token' }).click()
  await expect(page.locator('body')).not.toContainText(secret)
  await expect(withToken.getByText('The token is hidden now.')).toBeFocused()
  const kept = await page.evaluate(
    () =>
      JSON.stringify({ ...sessionStorage }) +
      JSON.stringify({ ...localStorage }) +
      location.href +
      JSON.stringify(history.state),
  )
  expect(kept).not.toContain(secret)
  await expect(withToken.getByRole('link', { name: 'your profile' })).toHaveAttribute(
    'href',
    '/profile/tokens',
  )
})

test('the standard connection turns the check green when a new connected app appears', async ({
  page,
  context,
  baseURL,
}) => {
  const s = await scenario(context, baseURL as string, 'signed-in')
  await page.goto('/connect')
  const check = page.getByRole('region', { name: 'Live check' })
  await expect(check).toContainText('Waiting for your agent…')
  // The app that was already connected (Cursor) does not count; wait for the first answer to know it.
  await page.waitForResponse((r) => r.url().endsWith('/v1/me/apps'))
  // The code exchange alone is not the agent reaching rsc-brain: still waiting.
  await agent(baseURL as string, s.id, { via: 'app', client: 'Claude Code', requested: false })
  await page.waitForResponse((r) => r.url().endsWith('/v1/me/apps'))
  await page.waitForResponse((r) => r.url().endsWith('/v1/me/apps'))
  await expect(check).toContainText('Waiting for your agent…')
  await agent(baseURL as string, s.id, { via: 'app-request' })
  await expect(check).toContainText('Connected', { timeout: 6_000 })
  await expect(check).toContainText('Claude Code reached rsc-brain')
})

test('each agent has its own token and check: green for Claude Code, then Codex waits for its own', async ({
  page,
  context,
  baseURL,
}) => {
  const s = await scenario(context, baseURL as string, 'signed-in')
  await page.goto('/connect')
  const check = page.getByRole('region', { name: 'Live check' })
  await page.getByRole('button', { name: 'Create a token' }).click()
  const first = String(
    await page.getByRole('region', { name: 'Your new token' }).locator('pre code').first().textContent(),
  )
  await agent(baseURL as string, s.id, { via: 'token' })
  await expect(check).toContainText('Connected', { timeout: 6_000 })
  await page.getByRole('tab', { name: 'Codex' }).click()
  const codex = page.getByRole('tabpanel', { name: 'Codex' })
  // Codex never shows the token made for Claude Code.
  await expect(codex).not.toContainText(first.trim())
  await expect(codex.getByRole('region', { name: 'Your new token' })).toHaveCount(0)
  await codex.getByRole('button', { name: 'Create a token' }).click()
  await expect(codex.getByRole('region', { name: 'Your new token' })).toBeVisible()
  await expect(check).toContainText('Waiting for your agent…')
  await expect(codex).toContainText('RSC_BRAIN_TOKEN_CODEX')
  // Back on Claude Code, its green is still there.
  await page.getByRole('tab', { name: 'Claude Code' }).click()
  await expect(check).toContainText('Connected')
  // A new token there starts its check again: it waits for that token.
  await page
    .getByRole('tabpanel', { name: 'Claude Code' })
    .getByRole('button', { name: 'Done, hide the token' })
    .click()
  await page
    .getByRole('tabpanel', { name: 'Claude Code' })
    .getByRole('button', { name: 'Create a token' })
    .click()
  await expect(check).toContainText('Waiting for your agent…')
})

test('the check never asks while the tab is hidden, stops once green, and stops when the page is left', async ({
  page,
  context,
  baseURL,
}) => {
  const s = await scenario(context, baseURL as string, 'signed-in')
  let asks = 0
  page.on('request', (r) => {
    if (r.url().endsWith('/v1/me/apps')) asks += 1
  })
  await page.goto('/connect')
  await expect(page.getByRole('region', { name: 'Live check' })).toContainText('Waiting for your agent…')
  await page.waitForResponse((r) => r.url().endsWith('/v1/me/apps'))
  // Hidden: no asking.
  await page.evaluate(() => {
    Object.defineProperty(document, 'hidden', { configurable: true, get: () => true })
  })
  await page.waitForTimeout(2_500)
  const hidden = asks
  await page.waitForTimeout(4_500)
  expect(asks, 'no request while hidden').toBe(hidden)
  await page.evaluate(() => {
    Object.defineProperty(document, 'hidden', { configurable: true, get: () => false })
  })
  await page.waitForResponse((r) => r.url().endsWith('/v1/me/apps'), { timeout: 5_000 })
  // Green: no more asking.
  await page.getByRole('button', { name: 'Create a token' }).click()
  await agent(baseURL as string, s.id, { via: 'token' })
  await expect(page.getByRole('region', { name: 'Live check' })).toContainText('Connected', {
    timeout: 6_000,
  })
  await page.waitForTimeout(500)
  const green = asks
  await page.waitForTimeout(4_500)
  expect(asks, 'no request once green').toBe(green)
  // Left: no asking from a page that is gone.
  await page.getByRole('tab', { name: 'Codex' }).click()
  await page.waitForResponse((r) => r.url().endsWith('/v1/me/apps'))
  await page.getByRole('link', { name: 'rsc-brain , home' }).click()
  await expect(page.getByRole('heading', { level: 1, name: 'Your brains' })).toBeVisible()
  await page.waitForTimeout(500)
  const left = asks
  await page.waitForTimeout(4_500)
  expect(asks, 'no request after leaving').toBe(left)
})

test('after a minute it offers tips; after 10 minutes it stops and offers «Check again»', async ({
  page,
  context,
  baseURL,
}) => {
  await scenario(context, baseURL as string, 'signed-in')
  await page.clock.install()
  await page.goto('/connect')
  const check = page.getByRole('region', { name: 'Live check' })
  await expect(check).toContainText('Waiting for your agent…')
  await expect(check).not.toContainText('Still waiting?')
  await page.clock.fastForward('01:05')
  await expect(check).toContainText('Still waiting?')
  await expect(check).toContainText('run /mcp')
  await expect(check).toContainText('echo $' + '{#RSC_BRAIN_TOKEN_CLAUDE_CODE}')
  await page.clock.fastForward('09:00')
  await expect(check).toContainText('Stopped checking after 10 minutes.')
  await check.getByRole('button', { name: 'Check again' }).click()
  await expect(check).toContainText('Waiting for your agent…')
  await expect(check).not.toContainText('Still waiting?')
})

test('a token shown is forgotten when the page goes to the back/forward cache', async ({
  page,
  context,
  baseURL,
}) => {
  await scenario(context, baseURL as string, 'signed-in')
  await page.goto('/connect')
  await page.getByRole('button', { name: 'Create a token' }).click()
  const secret = String(
    await page.getByRole('region', { name: 'Your new token' }).locator('pre code').first().textContent(),
  ).trim()
  await page.evaluate(() => window.dispatchEvent(new PageTransitionEvent('pagehide', { persisted: true })))
  await expect(page.getByRole('region', { name: 'Your new token' })).toHaveCount(0)
  expect(await page.evaluate(() => document.documentElement.outerHTML)).not.toContain(secret)
})

test('each copy button says what it copies', async ({ page, context, baseURL }) => {
  await scenario(context, baseURL as string, 'member')
  await page.goto('/connect')
  await expect(
    page.getByRole('button', { name: 'Copy: Add rsc-brain for all your projects and sign in', exact: true }),
  ).toBeVisible()
})

test('a program without a known name reads as a sentence: «An API client reached rsc-brain»', async ({
  page,
  context,
  baseURL,
}) => {
  const s = await scenario(context, baseURL as string, 'signed-in')
  await page.goto('/connect')
  await page.getByRole('button', { name: 'Create a token' }).click()
  await expect(page.getByRole('region', { name: 'Your new token' })).toBeVisible()
  await agent(baseURL as string, s.id, { via: 'token', client: 'node' })
  await expect(page.getByRole('region', { name: 'Live check' })).toContainText(
    'An API client reached rsc-brain',
    {
      timeout: 6_000,
    },
  )
})

test('opened for a brain, the token reaches only that brain and the page says so', async ({
  page,
  context,
  baseURL,
}) => {
  await scenario(context, baseURL as string, 'signed-in')
  // The first step of a new brain links here with its name (overview.spec.ts follows that link).
  await page.goto('/connect?brain=growth')
  await expect(page.getByRole('main')).toContainText('Growth')
  const req = page.waitForRequest((r) => r.url().endsWith('/v1/me/tokens') && r.method() === 'POST')
  await page.getByRole('button', { name: 'Create a token' }).click()
  expect((await req).postDataJSON()).toMatchObject({ brains: ['growth'], perm: 'write', days: 90 })
})

test('offline: the check pauses and says so; creating a token says why it cannot', async ({
  page,
  context,
  baseURL,
}) => {
  await scenario(context, baseURL as string, 'signed-in')
  await page.goto('/connect')
  await expect(page.getByRole('region', { name: 'Live check' })).toContainText('Waiting for your agent…')
  await context.setOffline(true)
  await expect(page.getByRole('region', { name: 'Live check' })).toContainText('Offline')
  await expect(page.getByRole('button', { name: 'Create a token' })).toHaveAttribute('aria-disabled', 'true')
  await context.setOffline(false)
  await expect(page.getByRole('region', { name: 'Live check' })).toContainText('Waiting for your agent…')
})

test('at 320 px nothing scrolls sideways outside the code blocks', async ({ page, context, baseURL }) => {
  await page.setViewportSize({ width: 320, height: 640 })
  await scenario(context, baseURL as string, 'signed-in')
  await page.goto('/connect')
  await expect(page.getByRole('button', { name: 'Create a token' })).toBeVisible()
  // Before the token too: the longest button is there then.
  await noSideScroll(page)
  await page.getByRole('button', { name: 'Create a token' }).click()
  await expect(page.getByRole('region', { name: 'Your new token' })).toBeVisible()
  await noSideScroll(page)
  await page.getByRole('tab', { name: 'Other agents' }).click()
  await noSideScroll(page)
})

// The page before the token, and the token's region after: once the focus goes to the new token, what is
// above has scrolled under the sticky top bar, a layout of the test that axe would read as overlapping.
for (const theme of ['dark', 'light'] as const) {
  test(`axe: connect your agent, then with a token shown, ${theme}`, async ({ page, context, baseURL }) => {
    await scenario(context, baseURL as string, 'signed-in')
    await page.addInitScript((t) => localStorage.setItem('rscb.theme', t), theme)
    await page.goto('/connect')
    await expect(page.getByRole('tabpanel', { name: 'Claude Code' })).toBeVisible()
    const audit = async (where: string, include?: string) => {
      let b = new AxeBuilder({ page }).withTags([
        'wcag2a',
        'wcag2aa',
        'wcag21a',
        'wcag21aa',
        'wcag22aa',
        'best-practice',
      ])
      if (include) b = b.include(include)
      const r = await b.analyze()
      const bad = r.violations.filter((v) => v.impact === 'serious' || v.impact === 'critical')
      expect(bad.map((v) => `${where}: ${v.id}: ${v.nodes.map((n) => n.target).join(' ')}`)).toEqual([])
    }
    await audit('page')
    await page.getByRole('button', { name: 'Create a token' }).click()
    await expect(page.getByRole('region', { name: 'Your new token' })).toBeVisible()
    await audit('token', '.once')
  })
}

test('the consent hint is left only when the standard command is copied, never on loading the page', async ({
  page,
  context,
  baseURL,
}) => {
  await scenario(context, baseURL as string, 'signed-in')
  await page.goto('/connect?brain=growth')
  await expect(page.getByRole('tabpanel', { name: 'Claude Code' })).toBeVisible()
  const hint = async () =>
    (await context.cookies(`${baseURL}/oauth/authorize`)).find((c) => c.name === 'rscb_connect')
  expect(await hint()).toBeUndefined()
  await page
    .getByRole('region', { name: 'Standard connection' })
    .getByRole('button', { name: /^Copy: Add rsc-brain/ })
    .click()
  expect((await hint())?.value).toBe('growth')
})

// Review of PR26: the live check reads request times on the server's clock (`now` of GET /v1/me/apps).
// With the browser's clock 10 minutes ahead, Cursor (already connected) asking again after the check
// began is seen at once; read on the browser's clock it would wait 10 minutes.
test('a browser clock 10 minutes ahead: an app asking after the check began turns it green', async ({
  page,
  context,
  baseURL,
}) => {
  const s = await scenario(context, baseURL as string, 'signed-in')
  await page.clock.setSystemTime(Date.now() + 10 * 60_000)
  await page.goto('/connect')
  await page.getByRole('tablist', { name: 'Your agent' }).getByRole('tab', { name: 'Cursor' }).click()
  const check = page.getByRole('region', { name: 'Live check' })
  await expect(check).toContainText('Waiting for your agent…')
  await page.waitForResponse((r) => r.url().endsWith('/v1/me/apps'))
  await page.waitForResponse((r) => r.url().endsWith('/v1/me/apps'))
  await expect(check).toContainText('Waiting for your agent…')
  await agent(baseURL as string, s.id, { via: 'app-request', id: 'app_cursor' })
  await expect(check).toContainText('Connected', { timeout: 6_000 })
})
