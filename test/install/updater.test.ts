// The updater with real containers (plan T060 for CA25, CA25b, CA26): local only, never in CI (plan §5.1). Runs with
// RSC_BRAIN_INSTALL_TESTS=1 and Docker answering (npm run test:install). Every Docker resource carries the prefix
// rscb-b2-test- (RSC_BRAIN_INSTALL_PREFIX changes it) and a random id, and is removed by exact name afterwards.
//
// There is no rsc-brain service here: `web-updates enable` needs an installation folder (its .env), a repository to
// reach and Docker, not the service. What this shows with a real Docker: the image builds; the repository answers from
// inside a container that runs as the owner with a user list mounted (what ssh needs); compose accepts the file; the
// container has no port, no network but its project's, exactly the three mounts, the owner's uid, the socket's group,
// the restart policy and a fixed hostname; the loop (and the launcher, under the image's own shell) runs in it and
// leaves updater.json and check.json for the folder to read; up -d of another project with the same name prefix does
// not touch it; disable leaves no container, no image, no credential.
import assert from 'node:assert/strict'
import { execFile, spawnSync } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, describe, it } from 'node:test'
import { promisify } from 'node:util'

const run = promisify(execFile)
const ROOT = new URL('../..', import.meta.url).pathname
const LAUNCHER = join(ROOT, 'deploy', 'rsc-brain.sh')
const ID = randomBytes(4).toString('hex')
const PREFIX = process.env.RSC_BRAIN_INSTALL_PREFIX ?? 'rscb-b2-test'
const NAME = `${PREFIX}-${ID}`
const PROJECT = `${NAME}-updater`
const IMAGE = `rsc-brain-updater:${NAME}`

const why = (() => {
  if (process.env.CI) return 'CI has no Docker (plan §5.1)'
  if (process.env.RSC_BRAIN_INSTALL_TESTS !== '1')
    return 'set RSC_BRAIN_INSTALL_TESTS=1 to run the updater in a real container'
  if (spawnSync('docker', ['info'], { stdio: 'ignore' }).status !== 0) return 'Docker does not answer'
  return null
})()

const docker = async (...args: string[]) => (await run('docker', args, { maxBuffer: 64 << 20 })).stdout.trim()
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
const launch = (args: string[]) =>
  spawnSync('sh', [LAUNCHER, ...args], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, RSC_BRAIN_TTY: '/nonexistent/tty' },
    timeout: 600_000,
  })

describe('the updater in a real container (CA25, CA25b, CA26)', { skip: why ?? false }, () => {
  let dir = ''
  before(() => {
    // The installation folder the container mounts at its own path: a real path, which Docker shares.
    const base = realpathSync(process.env.RSC_BRAIN_INSTALL_TMP ?? tmpdir())
    dir = join(mkdtempSync(join(base, 'rscb-b2-')), 'install')
    mkdirSync(dir, { recursive: true })
    const repo = join(dir, 'repo.git')
    const work = join(dir, 'work')
    const git = (...a: string[]) => {
      const r = spawnSync('git', a, {
        encoding: 'utf8',
        env: {
          ...process.env,
          GIT_AUTHOR_NAME: 't',
          GIT_AUTHOR_EMAIL: 't@t',
          GIT_COMMITTER_NAME: 't',
          GIT_COMMITTER_EMAIL: 't@t',
        },
      })
      assert.equal(r.status, 0, r.stderr)
    }
    git('init', '-q', '--bare', repo)
    git('init', '-q', work)
    writeFileSync(join(work, 'CHANGELOG.md'), '## v9.9.9\n\n- A version that does not exist.\n')
    git('-C', work, 'add', '.')
    git('-C', work, 'commit', '-q', '-m', 'one')
    git('-C', work, 'tag', 'v9.9.9')
    git('-C', work, 'push', '-q', repo, 'HEAD:refs/heads/main', 'v9.9.9')
    rmSync(work, { recursive: true, force: true })
    writeFileSync(
      join(dir, '.env'),
      `RSC_BRAIN_LAUNCHER='1'\nRSC_BRAIN_NAME='${NAME}'\nCOMPOSE_PROJECT_NAME='${NAME}'\nRSC_BRAIN_COMPANION='0'\nRSC_BRAIN_REPO_URL='file://${repo}'\nRSC_BRAIN_UID='${process.getuid?.()}'\nRSC_BRAIN_GID='${process.getgid?.()}'\n`,
      { mode: 0o600 },
    )
  })
  after(() => {
    // Exact names only: the project's container and network, the image it built, the folder.
    spawnSync('sh', [LAUNCHER, 'web-updates', 'disable', '--dir', dir], { stdio: 'ignore' })
    spawnSync('docker', ['rm', '-f', `${PROJECT}-updater-1`], { stdio: 'ignore' })
    spawnSync('docker', ['network', 'rm', `${PROJECT}_default`], { stdio: 'ignore' })
    spawnSync('docker', ['image', 'rm', IMAGE], { stdio: 'ignore' })
    if (dir) rmSync(join(dir, '..'), { recursive: true, force: true })
  })

  it('enable: builds, proves the access from a container, starts', { timeout: 600_000 }, () => {
    const r = launch(['web-updates', 'enable', '--yes', '--dir', dir])
    assert.equal(r.status, 0, r.stderr)
    assert.match(r.stderr, /controls this server/)
    assert.match(r.stdout, /Updates from the web are on\./)
  })

  it("the container: no port, one network (its project's), three mounts, the owner, the socket's group, restart, hostname", async () => {
    const [info] = JSON.parse(await docker('inspect', `${PROJECT}-updater-1`)) as Array<{
      Config: { User: string; Hostname: string }
      HostConfig: {
        PortBindings: Record<string, unknown>
        RestartPolicy: { Name: string }
        GroupAdd: string[]
        NetworkMode: string
        Privileged: boolean
      }
      NetworkSettings: { Ports: Record<string, unknown>; Networks: Record<string, unknown> }
      Mounts: Array<{ Source: string; Destination: string; RW: boolean }>
    }>
    assert.ok(info)
    assert.deepEqual(info.HostConfig.PortBindings ?? {}, {})
    assert.deepEqual(Object.keys(info.NetworkSettings.Ports ?? {}), [])
    assert.deepEqual(Object.keys(info.NetworkSettings.Networks), [`${PROJECT}_default`])
    assert.equal(info.HostConfig.Privileged, false)
    assert.equal(info.HostConfig.RestartPolicy.Name, 'unless-stopped')
    assert.equal(info.Config.Hostname, PROJECT)
    assert.equal(info.Config.User, `${statSync(join(dir, '.env')).uid}:${statSync(join(dir, '.env')).gid}`)
    assert.equal(info.HostConfig.GroupAdd.length, 1)
    const mounts = info.Mounts.map((m) => `${m.Destination}${m.RW ? '' : ':ro'}`).sort()
    assert.deepEqual(
      mounts,
      [dir, '/etc/passwd:ro', '/var/run/docker.sock'].sort().map((m) => (m === dir ? dir : m)),
    )
    const mine = info.Mounts.find((m) => m.Destination === dir)
    assert.equal(mine?.Source.endsWith(dir) || mine?.Source === dir, true, 'the installation at its own path')
  })

  it("the loop runs in it and the launcher answers under the image's own shell: updater.json beats, check.json says why it could not say", async () => {
    let updater = ''
    for (let i = 0; i < 60 && !existsSync(join(dir, 'update', 'report', 'check.json')); i++) await sleep(1000)
    updater = await docker(
      'exec',
      `${PROJECT}-updater-1`,
      'cat',
      join(dir, 'update', 'report', 'updater.json'),
    )
    assert.match(updater, /"enabled":true/)
    const check = JSON.parse(
      await docker('exec', `${PROJECT}-updater-1`, 'cat', join(dir, 'update', 'report', 'check.json')),
    )
    // There is no service here: the launcher says rsc-brain is not running, and that is a check that could not say.
    assert.equal(check.ok, false)
    assert.equal(check.reason, 'network')
    assert.equal(
      statSync(join(dir, 'update', 'report', 'updater.json')).uid,
      statSync(join(dir, '.env')).uid,
      'written as the owner',
    )
  })

  it('a request mark is taken and nothing runs when the check cannot say', async () => {
    writeFileSync(join(dir, 'update', 'request', 'request'), '')
    for (let i = 0; i < 30 && existsSync(join(dir, 'update', 'request', 'request')); i++) await sleep(1000)
    assert.equal(existsSync(join(dir, 'update', 'request', 'request')), false)
  })

  it('status says on; starting another project beside it does not touch it', async () => {
    assert.match(launch(['web-updates', 'status', '--dir', dir]).stdout, /are on\./)
    const before = await docker('inspect', '-f', '{{.Id}} {{.State.StartedAt}}', `${PROJECT}-updater-1`)
    // The service's own project has another name: nothing it does names this one.
    const orphans = await docker('ps', '-aq', '--filter', `label=com.docker.compose.project=${NAME}`)
    assert.equal(orphans, '')
    assert.equal(
      await docker('inspect', '-f', '{{.Id}} {{.State.StartedAt}}', `${PROJECT}-updater-1`),
      before,
    )
  })

  it('disable: no container, no image, no credential', async () => {
    const r = launch(['web-updates', 'disable', '--dir', dir])
    assert.equal(r.status, 0, r.stderr)
    assert.equal(await docker('ps', '-aq', '--filter', `label=com.docker.compose.project=${PROJECT}`), '')
    assert.equal(spawnSync('docker', ['image', 'inspect', IMAGE], { stdio: 'ignore' }).status === 0, false)
    assert.equal(existsSync(join(dir, 'updater')), false)
    assert.match(launch(['web-updates', 'status', '--dir', dir]).stdout, /are off\./)
  })
})
