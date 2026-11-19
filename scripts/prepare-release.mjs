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
async function confirmedPulls(sha, match) {
  for (const wait of [0, 1000, 3000, 6000, 10000]) {
    if (wait) await new Promise((resolve) => setTimeout(resolve, wait))
    const matches = pullsAt(sha).filter(match)
    if (matches.length) return matches
  }
  throw Error(`No merged PR confirmed for ${sha}. Rerun after GitHub indexes the merge.`)
}
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
async function unstamped(before, version) {
  const commits = git('rev-list', '--first-parent', before).split('\n')
  const pending = []
  for (let i = 0; i < commits.length - 1; i++) {
    const sha = commits[i]
    if (git('tag', '--points-at', sha, '--list', `v${version}`)) break
    if (versionAt(commits[i + 1]) !== version) {
      // With a rebase, the commit that set an explicit version can precede its PR's merge SHA.
      if (!pending.length) return []
      const owners = new Set((await confirmedPulls(sha, () => true)).map((pr) => pr.number))
      return pending.filter(({ pr }) => !owners.has(pr.number)).reverse()
    }
    const associated = await confirmedPulls(sha, () => true)
    const pr = associated.find((candidate) => candidate.merge_commit_sha === sha)
    if (pr) pending.push({ sha, pr })
  }
  return pending.reverse()
}

async function prepare(before) {
  const source = git('rev-parse', 'HEAD')
  const [pr] = await confirmedPulls(source, (candidate) => candidate.merge_commit_sha === source)
  git('merge-base', '--is-ancestor', before, source)
  const declared = versionAt(source)
  const previous = versionAt(before)
  if (![declared, previous].every((v) => isPublished(`v${v}`))) throw Error('Expected stable versions')
  const missing = await unstamped(before, previous)
  const last = missing.reduce((v) => patch(v), previous)
  const automatic = declared === previous
  const version = automatic ? patch(last) : declared
  const log = read('CHANGELOG.md')
  if (!automatic) {
    if (compareVersions(`v${last}`, `v${declared}`) !== 'newer')
      throw Error(`Expected a version above ${last}`)
    if (!notesFor(log, `v${declared}`)) throw Error(`Missing release notes for v${declared}`)
    if (!missing.length) return source
  } else {
    stampVersion(declared, version)
  }
  let current = previous
  const entries = automatic ? [...missing, { sha: source, pr }] : missing
  const sections = entries
    .map(({ sha, pr }) => {
      current = patch(current)
      if (notesFor(log, `v${current}`)) return ''
      return `## v${current}\n\n${note(sha, pr)}\n\n`
    })
    .reverse()
    .join('')
  if (!sections && !automatic) return source
  const headings = [...log.matchAll(/^## v\d+\.\d+\.\d+[ \t]*$/gm)]
  if (!headings.length) throw Error('Could not find the published changelog')
  const insert = headings[automatic ? 0 : 1]?.index ?? log.length
  const prefix = log.slice(0, insert).trimEnd()
  writeFileSync('CHANGELOG.md', `${prefix}\n\n${sections}${log.slice(insert)}`)
  return commitRelease(source, version, pr.number)
}

function stampVersion(declared, version) {
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
}
function commitRelease(source, version, number) {
  git('add', '--', 'package.json', 'package-lock.json', 'src/core/version.ts', 'CHANGELOG.md')
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
      `Release Brain v${version} for PR #${number}`,
    ],
    { env },
  )
  return git('rev-parse', 'HEAD')
}
console.log(await prepare(process.argv[2]))
