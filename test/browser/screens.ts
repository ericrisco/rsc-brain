// The screens of the web map (spec B6 «Mapa de la web»), one row each: where it is, what shows it is ready,
// which fixture screen forces its states, and the reason for each state it cannot have. The state matrix
// (matrix.spec.ts) and the accessibility audit (axe.spec.ts) both walk it.
import type { Locator, Page } from '@playwright/test'
import type { Preset } from './fixture.ts'

export type Key = string
// A cell the screen has (true, or what to open for it), or the reason it does not.
export type Na = { na: string }
export type Row = {
  name: string
  // The address in the web; `route` is the pattern of app.tsx it stands for.
  path: string
  route: string
  preset?: Preset
  // The fixture's screen whose answers make the state (loading, error, no access, empty, a lot).
  key: Key | Na
  ready: (page: Page) => Locator
  // A write the screen offers: offline, it is off and says why.
  write?: (page: Page) => Locator
  empty: true | Na
  // What the empty state shows when it is not the common one (the overview's first steps).
  emptyShows?: (page: Page) => Locator
  // A filter that matches nothing: by the address, or typed into the screen.
  filtered: { path: string; act?: (page: Page) => Promise<void> } | Na
  much: true | Na
  // The fixture's screen whose «much-data» makes the long list, when not `key`.
  muchKey?: Key
  // What leads to the rest, when not a «more» button or link.
  muchShows?: (page: Page) => Locator
  forbidden?: Na
  // Makes the default state hold something (an event in the live feed) before the page is read again.
  seed?: (s: { emit(brain: string, kind?: string): Promise<void> }) => Promise<void>
  // Why a box to type in is there while loading (a form for something new, empty by nature).
  typing?: string
}

const READ_ONLY_FORM = 'a form over values that always exist: there is nothing to be empty'
const DETAIL =
  'one thing by its address: a missing one is «no access» (it reads like one that does not exist)'
const NO_FILTERS = 'the screen has no filters'
const ONE_THING = 'one thing, drawn whole: no list to page'
const INVITE_FORM =
  'the invitation form is for new people: its box starts empty by nature; only the list loads'
const DOOR = 'a door before a session: it shows a form and reads nothing to list'

const named = (re: RegExp | string) => (page: Page) => page.getByRole('main').getByText(re).first()
const heading = (name: string) => (page: Page) => page.getByRole('heading', { name, exact: true }).first()
const button = (name: string) => (page: Page) =>
  page.getByRole('main').getByRole('button', { name, exact: true }).first()

export const ROWS: Row[] = [
  {
    name: 'home',
    path: '/',
    route: '/',
    key: 'home',
    ready: (p) => p.getByRole('link', { name: 'Growth' }),
    empty: true,
    filtered: { na: NO_FILTERS },
    much: {
      na: 'the brains a person is in come whole in one answer (G7) and are few by nature; 63 fit without side scroll (states.spec)',
    },
  },
  {
    name: 'overview',
    path: '/b/growth',
    route: '/b/:slug',
    key: 'overview',
    ready: (p) => p.getByRole('region', { name: "Today's sessions" }),
    empty: true,
    emptyShows: (p) => p.getByRole('region', { name: 'First steps' }),
    filtered: { na: NO_FILTERS },
    much: true,
    muchShows: (p) => p.getByRole('link', { name: 'All sessions in the journal' }),
  },
  {
    name: 'wiki map',
    path: '/b/growth/wiki',
    route: '/b/:slug/wiki',
    key: 'map',
    ready: (p) => p.getByRole('link', { name: 'Retention', exact: true }),
    empty: true,
    filtered: { path: '/b/growth/wiki?q=zzzz-nothing' },
    much: true,
  },
  {
    name: 'decisions',
    path: '/b/growth/wiki/decisions',
    route: '/b/:slug/wiki/decisions',
    key: 'decisions',
    ready: (p) => p.getByRole('link', { name: 'Annual plans' }),
    empty: true,
    filtered: { path: '/b/growth/wiki/decisions?q=zzzz-nothing' },
    much: {
      na: 'B2 lists the decision pages whole (no cursor); they are a small part of a wiki (27 of 300 measured, no side scroll)',
    },
  },
  {
    name: 'log',
    path: '/b/growth/wiki/log',
    route: '/b/:slug/wiki/log',
    key: 'log',
    ready: (p) => p.getByRole('list', { name: 'Changes' }),
    empty: true,
    filtered: { path: '/b/growth/wiki/log?page=zzzz/nothing' },
    much: true,
  },
  {
    name: 'graph',
    path: '/b/growth/wiki/graph?view=list',
    route: '/b/:slug/wiki/graph',
    key: 'graph',
    ready: (p) => p.getByRole('table', { name: /Pages of the wiki/ }),
    empty: true,
    filtered: { path: '/b/growth/wiki/graph?view=list&q=zzzz-nothing' },
    much: true,
    muchKey: 'pages',
  },
  {
    name: 'page',
    path: '/b/growth/pages/audience/retention',
    route: '/b/:slug/pages/:address+',
    key: 'page',
    ready: heading('What keeps viewers'),
    empty: { na: DETAIL },
    filtered: { na: NO_FILTERS },
    much: { na: ONE_THING },
  },
  {
    name: 'sessions',
    path: '/b/growth/journal',
    route: '/b/:slug/journal',
    key: 'sessions',
    ready: named('Fix the onboarding emails'),
    empty: true,
    filtered: { path: '/b/growth/journal?client=Nobody' },
    much: true,
  },
  {
    name: 'session',
    path: '/b/growth/journal/sessions/ses_fx_1',
    route: '/b/:slug/journal/sessions/:id',
    key: 'session',
    ready: heading('Review the intros of October'),
    empty: { na: DETAIL },
    filtered: { na: NO_FILTERS },
    much: { na: ONE_THING },
  },
  {
    name: 'entry',
    path: '/b/growth/journal/entries/ent_fx_intros',
    route: '/b/:slug/journal/entries/:id',
    key: 'entry',
    ready: heading('Short intros keep viewers'),
    write: button('Pin'),
    empty: { na: DETAIL },
    filtered: { na: NO_FILTERS },
    much: { na: ONE_THING },
  },
  {
    name: 'conflicts',
    path: '/b/growth/journal/conflicts',
    route: '/b/:slug/journal/conflicts',
    key: 'conflicts',
    ready: heading('These two contradict each other'),
    empty: true,
    filtered: { na: NO_FILTERS },
    much: true,
  },
  {
    name: 'forgotten',
    path: '/b/growth/journal/forgotten',
    route: '/b/:slug/journal/forgotten',
    key: 'forgotten',
    ready: named('Old pricing note'),
    write: (p) => p.getByRole('button', { name: /^Recover: / }).first(),
    empty: true,
    filtered: { na: NO_FILTERS },
    much: true,
  },
  {
    name: 'to review',
    path: '/b/growth/journal/to-review',
    route: '/b/:slug/journal/to-review',
    key: 'to-review',
    ready: named('Plain-text onboarding emails'),
    write: (p) => p.getByRole('button', { name: /^Mark reviewed: / }).first(),
    empty: true,
    filtered: { na: NO_FILTERS },
    much: true,
  },
  {
    name: 'add a correction',
    path: '/b/growth/journal/correct',
    route: '/b/:slug/journal/correct',
    key: 'brain',
    ready: heading('Add a correction'),
    write: button('Add correction'),
    empty: { na: 'a form to write: it starts blank by design' },
    filtered: { na: NO_FILTERS },
    much: { na: 'a form to write: nothing to page' },
  },
  {
    name: 'entries about a page',
    path: '/b/growth/journal/about?address=audience/retention',
    route: '/b/:slug/journal/about',
    key: 'entries',
    ready: named('Short intros keep viewers'),
    empty: true,
    filtered: { na: NO_FILTERS },
    much: {
      na: 'paged by cursor with «Show more» like Sessions (About.tsx); the fixture holds no long trail about one page',
    },
  },
  {
    name: 'proposals',
    path: '/b/growth/proposals',
    route: '/b/:slug/proposals',
    key: 'proposals',
    ready: named('Intros: keep them under 10 seconds'),
    empty: true,
    filtered: { na: 'the statuses are tabs, each with its own empty words (tested as empty)' },
    much: true,
  },
  {
    name: 'proposal',
    path: '/b/growth/proposals/prp_growth1',
    route: '/b/:slug/proposals/:id',
    key: 'proposal',
    ready: heading('Intros: keep them under 10 seconds'),
    write: button('Approve all'),
    empty: { na: DETAIL },
    filtered: { na: NO_FILTERS },
    much: { na: 'a proposal is drawn whole: its changes are what the curator approves' },
  },
  {
    name: 'activity',
    path: '/b/growth/activity',
    route: '/b/:slug/activity',
    key: 'brain',
    ready: heading('Live feed'),
    seed: async (s) => s.emit('growth', 'entry.saved'),
    empty: true,
    filtered: {
      na: 'its filters are folded and act on what was heard (activity.spec: «filtered empty clears»)',
    },
    much: { na: 'the feed keeps the newest 500 lines and pages nothing (activity.spec, plan §3.4)' },
  },
  {
    name: 'health',
    path: '/b/growth/health',
    route: '/b/:slug/health',
    key: 'health',
    ready: heading('Broken links'),
    empty: true,
    filtered: { na: NO_FILTERS },
    much: true,
  },
  {
    name: 'settings · members',
    path: '/b/growth/settings',
    route: '/b/:slug/settings',
    key: 'members',
    ready: heading('Members'),
    write: button('Add member'),
    empty: { na: 'a brain always has a curator, who is the one looking' },
    filtered: { na: NO_FILTERS },
    much: { na: 'members of one brain: the list is short by nature (B4)' },
  },
  {
    name: 'settings · agents',
    path: '/b/growth/settings/agents',
    route: '/b/:slug/settings/agents',
    key: 'settings',
    ready: heading('Usage note'),
    write: button('Save the note'),
    empty: { na: READ_ONLY_FORM },
    filtered: { na: NO_FILTERS },
    much: { na: READ_ONLY_FORM },
  },
  {
    name: 'settings · health thresholds',
    path: '/b/growth/settings/health',
    route: '/b/:slug/settings/health',
    key: 'settings',
    ready: heading('Health thresholds'),
    write: button('Save'),
    empty: { na: READ_ONLY_FORM },
    filtered: { na: NO_FILTERS },
    much: { na: READ_ONLY_FORM },
  },
  {
    // Growth has content: the part says why it cannot import (the form and its states: import.spec.ts).
    name: 'settings · import',
    path: '/b/growth/settings/import',
    route: '/b/:slug/settings/import',
    key: 'brain',
    ready: heading('Import a documentation folder'),
    empty: { na: 'one form for an empty brain: nothing of its own to be empty' },
    filtered: { na: NO_FILTERS },
    much: { na: 'the long report (500 listed, the rest counted) is checked in import.spec.ts' },
  },
  {
    name: 'settings · archive',
    path: '/b/growth/settings/archive',
    route: '/b/:slug/settings/archive',
    key: 'brain',
    ready: button('Archive this brain'),
    write: button('Archive this brain'),
    empty: { na: 'two actions on the brain: nothing to be empty' },
    filtered: { na: NO_FILTERS },
    much: { na: 'two actions on the brain: nothing to page' },
  },
  {
    name: 'people',
    path: '/people',
    route: '/people',
    key: 'people',
    ready: heading('Invitations'),
    write: button('Send invitations'),
    typing: INVITE_FORM,
    empty: true,
    filtered: { na: NO_FILTERS },
    much: true,
  },
  {
    name: 'admin · people',
    path: '/admin/people',
    route: '/admin/people',
    key: 'people',
    ready: heading('People in this installation'),
    empty: { na: 'the administration looking is always in the list' },
    filtered: {
      path: '/admin/people',
      act: async (p) => p.getByLabel('Find by name or email').fill('zzzz-nobody'),
    },
    much: true,
  },
  {
    name: 'admin · invitations',
    path: '/admin/invitations',
    route: '/admin/invitations',
    key: 'people',
    ready: heading('Invitations'),
    write: button('Send invitations'),
    typing: INVITE_FORM,
    empty: true,
    filtered: {
      path: '/admin/invitations',
      act: async (p) => {
        await p.getByLabel('Show').selectOption('revoked')
      },
    },
    much: true,
  },
  {
    name: 'admin · service accounts',
    path: '/admin/services',
    route: '/admin/services',
    key: 'people',
    ready: heading('Service accounts'),
    write: button('Create service account'),
    empty: true,
    filtered: { na: NO_FILTERS },
    much: { na: 'service accounts are few by nature (one per program); the list is whole' },
  },
  {
    name: 'admin · email',
    path: '/admin/email',
    route: '/admin/email',
    key: 'admin-email',
    ready: heading('Outgoing mail'),
    empty: true,
    emptyShows: (p) => p.getByText('Mail is not set up'),
    filtered: { na: NO_FILTERS },
    much: { na: 'the recent failures are the last 20 the server keeps' },
  },
  {
    name: 'admin · meaning search',
    path: '/admin/meaning',
    route: '/admin/meaning',
    key: 'admin-meaning',
    ready: heading('Providers'),
    empty: { na: READ_ONLY_FORM },
    filtered: { na: NO_FILTERS },
    much: { na: READ_ONLY_FORM },
  },
  {
    name: 'admin · limits',
    path: '/admin/limits',
    route: '/admin/limits',
    key: 'admin-settings',
    ready: heading('Requests per key'),
    empty: { na: READ_ONLY_FORM },
    filtered: { na: NO_FILTERS },
    much: { na: READ_ONLY_FORM },
  },
  {
    name: 'admin · audit',
    path: '/admin/audit',
    route: '/admin/audit',
    key: 'admin-audit',
    ready: (p) => p.getByRole('table', { name: 'Audit lines' }),
    empty: {
      na: 'an installation has audit lines from its setup on; a filter with none is the filtered state',
    },
    filtered: {
      path: '/admin/audit',
      act: async (p) => {
        await p.getByLabel('Action').fill('zzzz.nothing')
        await p.getByLabel('Action').press('Enter')
      },
    },
    much: true,
  },
  {
    name: 'admin · backups & system',
    path: '/admin/system',
    route: '/admin/system',
    key: 'admin-system',
    ready: heading('Service'),
    empty: { na: READ_ONLY_FORM },
    filtered: { na: NO_FILTERS },
    much: { na: READ_ONLY_FORM },
  },
  {
    name: 'admin · branding',
    path: '/admin/branding',
    route: '/admin/branding',
    key: 'admin-settings',
    ready: heading('Logo'),
    empty: { na: READ_ONLY_FORM },
    filtered: { na: NO_FILTERS },
    much: { na: READ_ONLY_FORM },
  },
  {
    name: 'profile',
    path: '/profile',
    route: '/profile',
    key: 'tokens',
    ready: heading('Connected apps'),
    write: button('Change password'),
    empty: true,
    filtered: { na: NO_FILTERS },
    much: true,
  },
  {
    name: 'connect your agent',
    path: '/connect',
    route: '/connect',
    key: 'connect',
    ready: heading('Live check'),
    write: button('Create a token'),
    empty: { na: 'the kit always exists: it is built from the installation address' },
    filtered: { na: NO_FILTERS },
    much: { na: 'five agents, one tab each' },
  },
  {
    name: 'sign in',
    path: '/sign-in',
    route: '/sign-in',
    preset: 'signed-out',
    key: { na: DOOR },
    ready: (p) => p.getByLabel('Email'),
    write: (p) => p.getByRole('button', { name: 'Sign in', exact: true }),
    empty: { na: DOOR },
    filtered: { na: DOOR },
    much: { na: DOOR },
  },
  {
    name: 'first run',
    path: '/setup',
    route: '/setup',
    preset: 'fresh',
    key: 'setup',
    ready: (p) => p.getByRole('heading', { name: 'Set up rsc-brain' }),
    empty: { na: DOOR },
    filtered: { na: DOOR },
    much: { na: DOOR },
    forbidden: { na: 'it opens to anyone until the setup is done, then leads to sign-in (doors.spec)' },
  },
  {
    name: 'accept an invitation',
    path: '/invite#token=inv_fixture_good_token_0001',
    route: '/invite',
    preset: 'signed-out',
    key: 'invite',
    ready: (p) => p.getByLabel('Choose a password'),
    empty: { na: DOOR },
    filtered: { na: DOOR },
    much: { na: DOOR },
    forbidden: { na: 'a link that does not work says so (doors.spec: «link not valid»)' },
  },
  {
    name: 'reset a password',
    path: '/reset',
    route: '/reset',
    preset: 'signed-out',
    key: { na: DOOR },
    ready: (p) => p.getByLabel('Email'),
    write: (p) => p.getByRole('button', { name: 'Send the link' }),
    empty: { na: DOOR },
    filtered: { na: DOOR },
    much: { na: DOOR },
  },
]

// Routes that are not screens of their own: they lead somewhere else.
export const REDIRECTS = new Set(['/admin', '/profile/tokens'])

export const isNa = (x: unknown): x is Na => typeof x === 'object' && x !== null && 'na' in x
