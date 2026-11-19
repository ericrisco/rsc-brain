// Prepare the tree main CI will verify. Print the candidate commit ID after confirming its merged PR.
import { execFileSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import { compareVersions, isPublished, notesFor } from '../src/ops/releases.ts'

const git = (...args) => execFileSync('git', args, { encoding: 'utf8' }).trim()
const read = (file) => readFileSync(file, 'utf8')
const versionAt = (sha) => JSON.parse(git('show', `${sha}:package.json`)).version
function pullsAt(sha) {
  return JSON.parse(execFileSync('gh', ['api', `repos/{owner}/{repo}/commits/${sha}/pulls`])).filter(
    (pr) =>
      pr.merged_at && pr.base.ref === 'main' && pr.base.repo.full_name === process.env.GITHUB_REPOSITORY,
  )
}
const mergedAt = (sha) => pullsAt(sha).find((pr) => pr.merge_commit_sha === sha)
const patch = (version) => version.replace(/\d+$/, (n) => String(BigInt(n) + 1n))
const note = (sha, pr) => {
  const subject = git('show', '-s', '--format=%s', sha)
  if (subject.endsWith(`(#${pr.number})`)) return `- ${subject}`
  const title = /^Merge pull request #\d+/.test(subject)
    ? git('show', '-s', '--format=%b', sha).split('\n')[0]
    : subject
  return `- ${title || 'Merge pull request'} (#${pr.number})`
}

// Usually the preceding main commit already carries its release number. For overlapping
// runs, count each as-yet unstamped PR at its merge SHA, including a multi-commit rebase just once.
function unstamped(before, version) {
  const commits = git('rev-list', '--first-parent', before).split('\n')
  const pending = []
  for (let i = 0; i < commits.length - 1; i++) {
    const sha = commits[i]
    if (versionAt(commits[i + 1]) !== version) {
      // With a rebase, the commit that set an explicit version can precede its PR's merge SHA.
      if (!pending.length) return []
      const owners = new Set(pullsAt(sha).map((pr) => pr.number))
      return pending.filter(({ pr }) => !owners.has(pr.number)).reverse()
    }
    const pr = mergedAt(sha)
    if (pr) pending.push({ sha, pr })
  }
  return pending.reverse()
}

async function prepare(before) {
  const source = git('rev-parse', 'HEAD')
  let pr = mergedAt(source)
  // The push can reach Actions before GitHub associates its commit with the merged PR.
  for (const ms of [1000, 3000, 6000, 10000]) {
    if (pr) break
    await new Promise((resolve) => setTimeout(resolve, ms))
    pr = mergedAt(source)
  }
  if (!pr) throw Error('No merged PR associated with this push. Rerun after GitHub indexes the merge.')
  git('merge-base', '--is-ancestor', before, source)
  const declared = versionAt(source)
  const previous = versionAt(before)
  if (![declared, previous].every((v) => isPublished(`v${v}`))) throw Error('Expected stable versions')
  const missing = unstamped(before, previous)
  const last = missing.reduce((v) => patch(v), previous)
  if (declared !== previous) {
    if (compareVersions(`v${last}`, `v${declared}`) !== 'newer')
      throw Error(`Expected a version above ${last}`)
    if (!notesFor(read('CHANGELOG.md'), `v${declared}`)) throw Error(`Missing release notes for v${declared}`)
    return source
  }

  const version = patch(last)
  for (const file of ['package.json', 'package-lock.json']) {
    const pkg = JSON.parse(read(file))
    pkg.version = version
    if (file === 'package-lock.json') pkg.packages[''].version = version
    writeFileSync(file, `${JSON.stringify(pkg, null, 2)}\n`)
  }
  const versionFile = 'src/core/version.ts'
  const original = read(versionFile)
  const changed = original.replace(
    `export const VERSION = '${declared}'`,
    `export const VERSION = '${version}'`,
  )
  if (original === changed) throw Error('Could not update server version')
  writeFileSync(versionFile, changed)
  const log = read('CHANGELOG.md')
  const firstSection = log.search(/^## v\d+\.\d+\.\d+\s*$/m)
  if (firstSection < 0) throw Error('Could not find the published changelog')
  let current = previous
  const sections = [...missing, { sha: source, pr }].map(({ sha, pr }) => {
    current = patch(current)
    return `## v${current}\n\n${note(sha, pr)}\n\n`
  })
  writeFileSync(
    'CHANGELOG.md',
    log.slice(0, firstSection) + sections.reverse().join('') + log.slice(firstSection),
  )
  git('add', '--', 'package.json', 'package-lock.json', versionFile, 'CHANGELOG.md')
  const date = git('show', '-s', '--format=%cI', source)
  const env = { ...process.env, GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date }
  execFileSync(
    'git',
    [
      '-c',
      'user.name=github-actions[bot]',
      '-c',
      'user.email=41898282+github-actions[bot]@users.noreply.github.com',
      'commit',
      '-qm',
      `Release Brain v${version} for PR #${pr.number}`,
    ],
    { env },
  )
  return git('rev-parse', 'HEAD')
}
console.log(await prepare(process.argv[2]))
