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
// The commit-association index can lag a merge. The PR records distinguish an
// actual merge endpoint from an unrelated direct push or the interior of a rebase.
function mergedPulls() {
  const rows = execFileSync(
    'gh',
    [
      'api',
      '--paginate',
      'repos/{owner}/{repo}/pulls?base=main&state=closed&per_page=100',
      '--jq',
      '.[] | select(.merged_at != null) | [.merge_commit_sha, .number] | @tsv',
    ],
    { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 },
  ).trim()
  const merged = new Map()
  for (const row of rows.split('\n').filter(Boolean)) {
    const [sha, number] = row.split('\t')
    if (!/^[0-9a-f]{40}$/.test(sha) || !/^[1-9]\d*$/.test(number ?? ''))
      throw Error('Invalid merged PR record')
    merged.set(sha, { number: Number(number) })
  }
  return merged
}
async function associatedPulls(sha, match) {
  for (const wait of [0, 1000, 3000, 6000, 10000]) {
    if (wait) await new Promise((resolve) => setTimeout(resolve, wait))
    const found = pullsAt(sha).filter(match)
    if (found.length) return found
  }
  return []
}
async function currentMerge(sha) {
  const [indexed] = await associatedPulls(sha, (pr) => pr.merge_commit_sha === sha)
  return indexed ?? mergedPulls().get(sha)
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

// Only needed when GitHub cannot associate the version-setting commit inside
// a rebase. Inspect the first following PR's manifest delta before assigning it a patch.
function selectedVersion(pr, version) {
  const patch = execFileSync(
    'gh',
    [
      'api',
      '--paginate',
      `repos/{owner}/{repo}/pulls/${pr.number}/files?per_page=100`,
      '--jq',
      '.[] | select(.filename == "package.json") | (.patch // error("missing package.json diff"))',
    ],
    { encoding: 'utf8' },
  )
  const sides = new Map()
  for (const line of patch.split('\n')) {
    const side = line[0]
    if (side !== '+' && side !== '-') continue
    const text = line.slice(1)
    const field = /^ {2}"version"\s*:\s*"([^"]+)"/.exec(text)
    if (field) sides.set(side, field[1])
    else if (text.startsWith('{') && text.includes('"version"')) sides.set(side, JSON.parse(text).version)
    else if (/^\s*"version"\s*:/.test(text)) throw Error('Cannot identify the top-level version change')
  }
  if (!sides.size) return false
  if (!sides.has('-') || !sides.has('+')) throw Error('Incomplete package version delta')
  return sides.get('+') === version && sides.get('-') !== version
}

// Follow the source version back to its tag or to the commit that chose it.
// Only PR merge endpoints along this path can have an outstanding patch.
async function unstamped(before, version) {
  const commits = git('rev-list', '--first-parent', before).split('\n')
  const pending = []
  let merged
  for (let i = 0; i < commits.length - 1; i++) {
    const sha = commits[i]
    if (git('tag', '--points-at', sha, '--list', `v${version}`)) break
    if (versionAt(commits[i + 1]) !== version) {
      if (!pending.length) break
      // The version-setting commit can be inside a rebase, at its tip, or a direct push.
      // Exclude the PR that chose this explicit baseline from the outstanding patches.
      if (merged.has(sha)) break
      const first = pending.at(-1).pr
      const owners = await associatedPulls(sha, () => true)
      if (owners.length ? owners.some((pr) => pr.number === first.number) : selectedVersion(first, version)) {
        pending.pop()
      }
      break
    }
    merged ??= mergedPulls()
    const pr = merged.get(sha)
    if (pr) pending.push({ sha, pr })
  }
  return pending.reverse()
}

async function prepare(before) {
  const source = git('rev-parse', 'HEAD')
  const pr = await currentMerge(source)
  if (!pr) return
  git('merge-base', '--is-ancestor', before, source)
  const declared = versionAt(source)
  const previous = versionAt(before)
  const missing = await unstamped(before, previous)
  if (![declared, previous].every((v) => isPublished(`v${v}`))) throw Error('Expected stable versions')
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
const release = await prepare(process.argv[2])
if (release) console.log(release)
