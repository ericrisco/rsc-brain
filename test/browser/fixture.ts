// Each browser test gets its own scenario of the fixture API (its own sign-ins, setup and forced states),
// named in a header the fixture reads, so tests run in parallel without sharing anything.
import { type BrowserContext, test as base, expect, type Page } from '@playwright/test'

export type Preset = 'signed-out' | 'signed-in' | 'member' | 'fresh' | 'insecure'
export type States = Record<
  string,
  'normal' | 'loading' | 'empty' | 'filtered-empty' | 'error' | 'forbidden' | 'much-data'
>

export const PASSWORD = 'correct horse battery staple'
export const CODE = '424242'
export const INVITE = 'inv_fixture_good_token_0001'
export const RESET = 'rst_fixture_good_token_0001'

type Scenario = {
  id: string
  state(screen: string, state: States[string]): Promise<void>
  // Every session ends on the server, while the web is open (the cookie stays in the browser).
  endSessions(): Promise<void>
}

export async function scenario(
  context: BrowserContext,
  baseURL: string,
  preset: Preset,
  states: States = {},
  o: { mail?: boolean } = {},
): Promise<Scenario> {
  const res = await fetch(`${baseURL}/__fixture/scenarios`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ preset, states, ...(o.mail === false ? { mail: false } : {}) }),
  })
  const { id } = (await res.json()) as { id: string }
  await context.setExtraHTTPHeaders({ 'x-fixture-scenario': id })
  if (preset === 'signed-in' || preset === 'member') {
    const value = preset === 'member' ? 'fx.acc_ana' : 'fx.acc_eric'
    await context.addCookies([{ name: 'rscb_session', value, url: baseURL, httpOnly: true, sameSite: 'Lax' }])
  }
  return {
    id,
    state: async (screen, state) => {
      await fetch(`${baseURL}/__fixture/scenarios/${id}/state`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ screen, state }),
      })
    },
    endSessions: async () => {
      await fetch(`${baseURL}/__fixture/scenarios/${id}/end-sessions`, { method: 'POST' })
    },
  }
}

// Fails the test on any violation of the content security policy or uncaught error in the page.
export const test = base.extend<{ watch: string[] }>({
  watch: [
    async ({ page }, use) => {
      const problems: string[] = []
      page.on('console', (m) => {
        if (m.type() === 'error' && /Content Security Policy|Refused to/i.test(m.text()))
          problems.push(m.text())
      })
      page.on('pageerror', (e) => problems.push(`page error: ${e.message}`))
      await use(problems)
      expect(problems, 'no CSP violation and no uncaught error').toEqual([])
    },
    { auto: true },
  ],
})
export { expect }

// The document is no wider than the window: nothing scrolls sideways (spec B6 CA15).
export async function noSideScroll(page: Page): Promise<void> {
  const r = await page.evaluate(() => ({
    scroll: document.documentElement.scrollWidth,
    client: document.documentElement.clientWidth,
  }))
  expect(r.scroll, `page is ${r.scroll}px wide in a ${r.client}px window`).toBeLessThanOrEqual(r.client)
}
