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
  await withToken.getByRole('button', { name: 'Create a token and fill in the configuration' }).click()
  const once = withToken.getByRole('region', { name: 'Your new token' })
  await expect(once).toContainText('only this once')
  await expect(once.getByRole('button', { name: 'Copy the token' })).toBeFocused()
  const secret = String(await once.locator('pre code').first().textContent()).trim()
  expect(secret).toMatch(/^rscb_/)
  // The configuration carries it, filled in.
  await expect(once).toContainText(`export RSC_BRAIN_TOKEN="${secret}"`)
  await expect(once).toContainText('.mcp.json')
  await expect(check).toContainText('Waiting for your agent…')
  // Another agent's tab fills in the same token.
  await page.getByRole('tab', { name: 'Other agents' }).click()
  await expect(page.getByRole('tabpanel', { name: 'Other agents' })).toContainText(`Bearer ${secret}`)
  await page.getByRole('tab', { name: 'Claude Code' }).click()
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
  await agent(baseURL as string, s.id, { via: 'app', client: 'Claude Code' })
  await expect(check).toContainText('Connected', { timeout: 6_000 })
  await expect(check).toContainText('Claude Code reached rsc-brain')
})

test('a program without a known name reads as a sentence: «An API client reached rsc-brain»', async ({
  page,
  context,
  baseURL,
}) => {
  const s = await scenario(context, baseURL as string, 'signed-in')
  await page.goto('/connect')
  await page.getByRole('button', { name: 'Create a token and fill in the configuration' }).click()
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
  await page.getByRole('button', { name: 'Create a token and fill in the configuration' }).click()
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
  await expect(
    page.getByRole('button', { name: 'Create a token and fill in the configuration' }),
  ).toHaveAttribute('aria-disabled', 'true')
  await context.setOffline(false)
  await expect(page.getByRole('region', { name: 'Live check' })).toContainText('Waiting for your agent…')
})

test('at 320 px nothing scrolls sideways outside the code blocks', async ({ page, context, baseURL }) => {
  await page.setViewportSize({ width: 320, height: 640 })
  await scenario(context, baseURL as string, 'signed-in')
  await page.goto('/connect')
  await expect(
    page.getByRole('button', { name: 'Create a token and fill in the configuration' }),
  ).toBeVisible()
  // Before the token too: the longest button is there then.
  await noSideScroll(page)
  await page.getByRole('button', { name: 'Create a token and fill in the configuration' }).click()
  await expect(page.getByRole('region', { name: 'Your new token' })).toBeVisible()
  await noSideScroll(page)
  await page.getByRole('tab', { name: 'Other agents' }).click()
  await noSideScroll(page)
})

for (const theme of ['dark', 'light'] as const) {
  test(`axe: connect your agent with a token shown, ${theme}`, async ({ page, context, baseURL }) => {
    await scenario(context, baseURL as string, 'signed-in')
    await page.addInitScript((t) => localStorage.setItem('rscb.theme', t), theme)
    await page.goto('/connect')
    await page.getByRole('button', { name: 'Create a token and fill in the configuration' }).click()
    await expect(page.getByRole('region', { name: 'Your new token' })).toBeVisible()
    const r = await new AxeBuilder({ page })
      .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa', 'best-practice'])
      .analyze()
    const bad = r.violations.filter((v) => v.impact === 'serious' || v.impact === 'critical')
    expect(bad.map((v) => `${v.id}: ${v.nodes.map((n) => n.target).join(' ')}`)).toEqual([])
  })
}
