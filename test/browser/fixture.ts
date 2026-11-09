// Each browser test gets its own scenario of the fixture API (its own sign-ins, setup and forced states),
// named in a header the fixture reads, so tests run in parallel without sharing anything.
import { type BrowserContext, test as base, expect, type Page } from '@playwright/test'

// alone: the administrator the setup made, the only person in the installation.
export type Preset = 'signed-out' | 'signed-in' | 'member' | 'fresh' | 'insecure' | 'alone'
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
  // An event in a brain, as an agent's write makes it (the open live streams hear it).
  emit(brain: string, kind?: string, o?: EmitOptions): Promise<void>
  // The live events go down (open streams cut, new ones refused) or come back.
  streams(down: boolean): Promise<void>
  // The server ends the open streams of a brain with "closed" and its reason.
  close(brain: string, reason: string, message: string): Promise<void>
  // Another curator saves the settings of a brain meanwhile (PR25a).
  settingsEdit(brain: string, change: Record<string, unknown>): Promise<void>
  // rsc-factory sets the installation up meanwhile (companion mode, F1-PR11).
  setUpElsewhere(): Promise<void>
}

export type EmitOptions = {
  who?: { id: string; name: string } | null
  sessionRef?: string | null
  summaryEntryId?: string | null
  onBehalf?: { id: string; name: string } | null
  target?: { id: string; label: string }
  client?: string | null
  ref?: string | null
  query?: string | null
  // A service account's key did it (default: when it has a reference).
  service?: boolean
}

export async function scenario(
  context: BrowserContext,
  baseURL: string,
  preset: Preset,
  states: States = {},
  // seeded: the brains' wiki is the seeded one of 300 or 5 000 pages (the graph, CA5 and CA6).
  o: {
    mail?: boolean
    seeded?: 300 | 5000 | 'lumpy' | 'small'
    factoryUrl?: string
    companion?: boolean
    // The installation's public address (its kit's commands use it).
    publicUrl?: string
  } = {},
): Promise<Scenario> {
  const res = await fetch(`${baseURL}/__fixture/scenarios`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      preset,
      states,
      ...(o.mail === false ? { mail: false } : {}),
      ...(o.seeded ? { seeded: o.seeded } : {}),
      ...(o.factoryUrl ? { factoryUrl: o.factoryUrl } : {}),
      ...(o.companion ? { companion: true } : {}),
      ...(o.publicUrl ? { publicUrl: o.publicUrl } : {}),
    }),
  })
  const { id } = (await res.json()) as { id: string }
  await context.setExtraHTTPHeaders({ 'x-fixture-scenario': id })
  if (preset === 'signed-in' || preset === 'member' || preset === 'alone') {
    const value = preset === 'member' ? 'fx.acc_ana' : preset === 'alone' ? 'fx.acc_admin' : 'fx.acc_eric'
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
    setUpElsewhere: async () => {
      await fetch(`${baseURL}/__fixture/scenarios/${id}/set-up`, { method: 'POST' })
    },
    endSessions: async () => {
      await fetch(`${baseURL}/__fixture/scenarios/${id}/end-sessions`, { method: 'POST' })
    },
    emit: async (brain, kind = 'entry.saved', more = {}) => {
      await fetch(`${baseURL}/__fixture/scenarios/${id}/emit`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ brain, kind, ...more }),
      })
    },
    close: async (brain, reason, message) => {
      await fetch(`${baseURL}/__fixture/scenarios/${id}/close`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ brain, reason, message }),
      })
    },
    settingsEdit: async (brain, change) => {
      await fetch(`${baseURL}/__fixture/scenarios/${id}/settings-edit`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ brain, ...change }),
      })
    },
    streams: async (down) => {
      await fetch(`${baseURL}/__fixture/scenarios/${id}/streams`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ down }),
      })
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

// The last step of the first-time setup (B7 PR30): the installation key, ticked as saved, then in.
export async function keepTheKey(page: Page): Promise<void> {
  await page.getByLabel('I saved the installation key somewhere safe, outside this machine').check()
  await page.getByRole('button', { name: 'Continue to rsc-brain' }).click()
}
