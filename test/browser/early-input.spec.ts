// F1-PR13: a form seeded from what the page knows used to copy that value into what is typed or picked in an
// effect that runs after paint, also on the first render. Typed or picked before that first effect (a fast
// hand, Playwright's fill and selectOption, a loaded machine), the choice was put back. Each test makes the
// choice the moment the field is in the page (a MutationObserver), then checks it stayed.
import type { Page } from '@playwright/test'
import { expect, scenario, test } from './fixture.ts'

// When `selector` first appears: give it `value` (an option's index for a select) and send the event its form
// listens to. The value given is kept in window.__early.
async function early(page: Page, selector: string, how: { text?: string; option?: number; event: string }) {
  await page.addInitScript(
    ([sel, text, option, event]) => {
      const watch = new MutationObserver(() => {
        const el = document.querySelector<HTMLInputElement | HTMLSelectElement>(sel as string)
        if (!el) return
        watch.disconnect()
        const value =
          el instanceof HTMLSelectElement ? (el.options[option as number]?.value ?? '') : (text as string)
        el.value = value
        ;(window as unknown as { __early: string }).__early = value
        el.dispatchEvent(new Event(event as string, { bubbles: true }))
      })
      document.addEventListener('DOMContentLoaded', () =>
        watch.observe(document.body, { childList: true, subtree: true }),
      )
    },
    [selector, how.text ?? '', how.option ?? 1, how.event],
  )
}
const given = (page: Page) => page.evaluate(() => (window as unknown as { __early?: string }).__early ?? null)

test('sessions: a filter picked the moment the form is in the page is kept', async ({
  page,
  context,
  baseURL,
}) => {
  await scenario(context, baseURL as string, 'signed-in')
  await early(page, '#sf-status', { option: 1, event: 'change' })
  await page.goto('/b/growth/journal')
  await expect.poll(() => given(page)).not.toBeNull()
  // Past the next frames, when the first effect has run.
  await page.waitForTimeout(400)
  expect(await page.locator('#sf-status').inputValue()).toBe(await given(page))
})

test('add a correction: a page typed the moment its field appears is kept', async ({
  page,
  context,
  baseURL,
}) => {
  await scenario(context, baseURL as string, 'member')
  await early(page, '#correction-page', { text: 'retention', event: 'input' })
  await page.goto('/b/growth/journal/correct')
  await page.getByLabel('A page of the wiki').check()
  await expect.poll(() => given(page)).toBe('retention')
  await page.waitForTimeout(400)
  await expect(page.locator('#correction-page')).toHaveValue('retention')
})

test('wiki log: a page typed the moment its filter appears is kept, coming from the wiki', async ({
  page,
  context,
  baseURL,
}) => {
  await scenario(context, baseURL as string, 'signed-in')
  await early(page, '#log-page', { text: 'style/intros', event: 'input' })
  // From the wiki, in the web: the brain is known already, so the log's form is there at its first render.
  await page.goto('/b/growth/wiki')
  await page.getByRole('link', { name: 'Log', exact: true }).first().click()
  await expect.poll(() => given(page)).toBe('style/intros')
  await page.waitForTimeout(400)
  await expect(page.locator('#log-page')).toHaveValue('style/intros')
})
