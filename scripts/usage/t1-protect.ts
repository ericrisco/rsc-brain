// Usage of T003 (spec learning-memory A3 and A4: CA-A19, U3 «back to Ask first»): protected pages and the write mode
// of a wiki on a clean installation, over HTTP only, as the web and an agent's key would.
//   - a new brain: its pages are not protected;
//   - the curator, in the web, protects a page and unprotects it: two lines «protect» in the wiki log, no revision;
//   - the curator's own key, and the contributor in the web, cannot protect;
//   - the curator sets the wiki to «Ask first» and back: the brain's audit has a «wiki.mode» line for each.
//
//   RSC_BRAIN_PG_URL=… node scripts/usage/t1-protect.ts [--no-build]
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { api, cleanInstall, ROOT, say } from './clean-install.ts'

const run = promisify(execFile)
let failed = 0
const check = (what: string, ok: boolean) => {
  say(`${ok ? 'ok  ' : 'FAIL'} ${what}`)
  if (!ok) failed += 1
}
const pause = () => new Promise((r) => setTimeout(r, 20))

const commit = (await run('git', ['-C', ROOT, 'rev-parse', '--short', 'HEAD'])).stdout.trim()
say(`# t1-protect ${new Date().toISOString()} · commit ${commit}`)
const inst = await cleanInstall({ build: !process.argv.includes('--no-build') })
const call = api(inst.base)
try {
  const web = { cookie: inst.curator.cookie, name: 'Cora' }
  const coraKey = { token: inst.curator.token, name: 'Cora' }
  const coleWeb = { cookie: inst.contributor.cookie, name: 'Cole' }
  const rita = { token: inst.reader.token, name: 'Rita' }
  type Page = { page: { revision: number; protected: boolean } }
  const shown = (b: Record<string, unknown>) => ({
    revision: (b as Page).page.revision,
    protected: (b as Page).page.protected,
  })
  const page = async () =>
    (await call(rita, 'GET', '/v1/brains/demo/pages/runbook', undefined, shown)).body as Page
  const protect = (who: { cookie?: string; token?: string; name: string }, value: boolean) =>
    call(who, 'PUT', '/v1/brains/demo/protection/runbook', { protected: value }, shown)

  await call(
    web,
    'POST',
    '/v1/brains/demo/wiki/changes',
    {
      op: 'create',
      address: 'runbook',
      type: 'guide',
      title: 'Runbook',
      summary: 'What to do.',
      body: 'Steps.',
    },
    shown,
  )
  check('CA-A19: a page of a new brain is not protected', (await page()).page.protected === false)

  const on = await protect(web, true)
  check('the curator in the web protects it', on.status === 200 && (await page()).page.protected === true)
  await pause()
  const off = await protect(web, false)
  const after = await page()
  check(
    'and unprotects it; the page is still at revision 1',
    off.status === 200 && !after.page.protected && after.page.revision === 1,
  )
  const log = await call(web, 'GET', '/v1/brains/demo/wiki/log?kind=protect', undefined, (b) =>
    (b.items as Array<{ kind: string; summary: string }>).map((l) => `${l.kind}: ${l.summary}`),
  )
  const lines = (log.body.items as Array<{ summary: string }>).map((l) => l.summary)
  check(
    'CA-A19: the wiki log has «Protected: runbook» and «Unprotected: runbook»',
    lines.join(' | ') === 'Unprotected: runbook | Protected: runbook',
  )

  const byKey = await protect(coraKey, true)
  check('a key cannot protect, a curator’s own neither (403 protect_web_only)', byKey.status === 403)
  const byContributor = await protect(coleWeb, true)
  check('a contributor in the web cannot protect (403)', byContributor.status === 403)
  check('nothing changed', (await page()).page.protected === false)

  const mode = (b: Record<string, unknown>) => ({ writeMode: b.writeMode })
  await call(rita, 'GET', '/v1/brains/demo/wiki/settings', undefined, mode)
  const ask = await call(web, 'PUT', '/v1/brains/demo/wiki/settings', { writeMode: 'ask_first' }, mode)
  check('the curator sets «Ask first»', ask.status === 200 && ask.body.writeMode === 'ask_first')
  await pause()
  const back = await call(web, 'PUT', '/v1/brains/demo/wiki/settings', { writeMode: 'auto' }, mode)
  check(
    'CA-U3: and goes back to «Apply automatically»',
    back.status === 200 && back.body.writeMode === 'auto',
  )
  const keyMode = await call(coraKey, 'PUT', '/v1/brains/demo/wiki/settings', { writeMode: 'ask_first' })
  check('a key cannot change the mode (403)', keyMode.status === 403)
  const audit = await call(web, 'GET', '/v1/brains/demo/audit', undefined, (b) =>
    (b.items as Array<{ action: string; detail: string }>)
      .filter((a) => a.action === 'wiki.mode')
      .map((a) => `${a.action} ${a.detail}`),
  )
  const modes = (audit.body.items as Array<{ action: string; detail: string }>)
    .filter((a) => a.action === 'wiki.mode')
    .map((a) => a.detail)
  check('each change of mode is an audit line «wiki.mode»', modes.join(',') === 'auto,ask_first')
} finally {
  await inst.stop()
  await inst.drop()
}
say(failed === 0 ? 'PASS' : `FAIL (${failed})`)
process.exit(failed === 0 ? 0 : 1)
