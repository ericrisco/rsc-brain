// The last step of the first-time setup (B7 PR30): the installation key shown once, ticked as saved, then in.
import type { Page } from '@playwright/test'

export async function keepTheKey(page: Page): Promise<void> {
  await page.getByRole('heading', { level: 1, name: 'Keep the installation key' }).waitFor()
  await page.getByLabel('I saved the installation key somewhere safe, outside this machine').check()
  await page.getByRole('button', { name: 'Continue to rsc-brain' }).click()
}
