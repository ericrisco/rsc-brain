#!/usr/bin/env bash
# Use real Git commits, bundles and an isolated origin. Only the GitHub API is simulated.
set -euo pipefail
scripts=$(cd "$(dirname "$0")/../../scripts" && pwd)
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT
export GITHUB_REPOSITORY=test/product PATH="$tmp:$PATH" FIXTURE="$tmp"
git init -q --bare "$tmp/origin"
git init -q -b main "$tmp/work"
cd "$tmp/work"
git config user.name Test
git config user.email test@example.invalid
git remote add origin "$tmp/origin"
mkdir -p deploy src/core
printf '# Changelog\n\n## v0.7.2\n\nPrevious release.\n' > CHANGELOG.md
echo '{"version":"0.7.2"}' > package.json
echo '{"version":"0.7.2","packages":{"":{"version":"0.7.2"}}}' > package-lock.json
echo "export const VERSION = '0.7.2'" > src/core/version.ts
echo launcher > deploy/rsc-brain.sh
git add .
git commit -qm initial
base=$(git rev-parse HEAD)
git push -q origin main
cat > "$tmp/gh" <<'MOCK'
#!/usr/bin/env bash
set -euo pipefail
case "$1 $2" in
  'api --paginate')
    if [[ $3 == 'repos/{owner}/{repo}/pulls/'*'/files?per_page=100' ]]; then
      number=${3%/files*}
      if [[ -f $FIXTURE/pr-${number##*/}.patch ]]; then cat "$FIXTURE/pr-${number##*/}.patch"; fi
      exit 0
    fi
    [[ $3 == 'repos/{owner}/{repo}/pulls?base=main&state=closed&per_page=100' && $4 == --jq ]] || exit 2
    [[ ! -e $FIXTURE/api-failure ]] || exit 1
    cat "$FIXTURE/merged.tsv" ;;
  'api repos/{owner}/{repo}/commits/'*'/pulls')
    sha=${2%/pulls}
    if [[ -e $FIXTURE/${sha##*/}.json ]]; then cat "$FIXTURE/${sha##*/}.json"; else echo '[]'; fi ;;
  'api repos/{owner}/{repo}/commits/refs%2Ftags%2F'*)
    git --git-dir="$FIXTURE/origin" rev-parse "refs/tags/${2##*%2F}^{commit}" ;;
  'release view') test -f "$FIXTURE/$3.release" && cat "$FIXTURE/$3.release" ;;
  'release create')
    [[ $4 == --draft && $5 == --target && $6 == "$(git rev-parse HEAD)" ]] || exit 2
    git --git-dir="$FIXTURE/origin" cat-file -e "$6^{commit}"
    jq -n --arg sha "$6" --rawfile body "${!#}" \
      '{databaseId:42,isDraft:true,isPrerelease:false,targetCommitish:$sha,assets:[],body:$body}' > "$FIXTURE/$3.release" ;;
  'release upload')
    [[ $4 == deploy/rsc-brain.sh && $5 == --clobber && ! -e $FIXTURE/upload-failure ]] || exit 1
    jq --arg digest "sha256:$(sha256sum "$4" | cut -d' ' -f1)" \
      '.assets=[{name:"rsc-brain.sh",digest:$digest}]' "$FIXTURE/$3.release" > "$FIXTURE/updated"
    mv "$FIXTURE/updated" "$FIXTURE/$3.release" ;;
  'api --silent')
    [[ $3 == --method && $4 == PATCH && $5 == 'repos/{owner}/{repo}/releases/42' && $6 == --input ]] || exit 2
    jq -e '.draft == false and .prerelease == false and .make_latest == "legacy"' "$7" >/dev/null
    tag="v$(jq -r .version package.json)"
    sha=$(jq -er .target_commitish "$7")
    [[ $sha == "$(git rev-parse HEAD)" ]] || exit 2
    jq -rj .body "$7" > "$FIXTURE/$tag.notes"
    git --git-dir="$FIXTURE/origin" show-ref --verify --quiet "refs/tags/$tag" || git --git-dir="$FIXTURE/origin" tag "$tag" "$sha"
    jq --rawfile notes "$FIXTURE/$tag.notes" '.body=$notes | .isDraft=false | .isPrerelease=false' "$FIXTURE/$tag.release" > "$FIXTURE/updated"
    mv "$FIXTURE/updated" "$FIXTURE/$tag.release" ;;
  *) exit 2 ;;
esac
MOCK
chmod +x "$tmp/gh"
: > "$tmp/merged.tsv"
pr() {
  printf '%s\t%s\n' "$1" "$2" >> "$tmp/merged.tsv"
  printf '[{"merged_at":"today","merge_commit_sha":"%s","number":%s,"base":{"ref":"main","repo":{"full_name":"test/product"}}}]\n' "$1" "$2" > "$tmp/$1.json"
}
prepare() { node "$scripts/prepare-release.mjs" "$1"; }
publish() { bash "$scripts/publish.sh" "$1" "$2"; }
remote() { git --git-dir="$tmp/origin" rev-parse "$1"; }
refuse() {
  local reason=$1
  shift
  if "$@" > "$tmp/failure" 2>&1; then echo "Unexpected success: $*" >&2; exit 1; fi
  [[ -z $reason ]] || grep -Fq "$reason" "$tmp/failure"
}
# The current PR may be visible in the merged records before the commit association index.
git commit -q --allow-empty -m 'Merge with delayed indexing'
unindexed=$(git rev-parse HEAD)
pr "$unindexed" 70
rm "$tmp/$unindexed.json"
touch "$tmp/api-failure"
refuse '' prepare "$base"
rm "$tmp/api-failure"
unindexed_release=$(prepare "$base")
[[ $unindexed_release != "$unindexed" && $(jq -r .version package.json) == 0.7.3 ]]
grep -Fq 'Merge with delayed indexing (#70)' CHANGELOG.md
git switch -q --detach "$base"

# A version already staged by a direct push is the baseline, not an explicit choice by a later PR.
echo '{"version":"0.9.0"}' > package.json
echo '{"version":"0.9.0","packages":{"":{"version":"0.9.0"}}}' > package-lock.json
echo "export const VERSION = '0.9.0'" > src/core/version.ts
git commit -qam 'Stage version directly'
staged=$(git rev-parse HEAD)
git commit -q --allow-empty -m 'Document the new feature'
staged_pr=$(git rev-parse HEAD)
pr "$staged_pr" 71
stamped=$(prepare "$staged")
[[ $stamped != "$staged_pr" && $(jq -r .version package.json) == 0.9.1 ]]
grep -Fq 'Document the new feature (#71)' CHANGELOG.md
git switch -q --detach "$base"

# A direct push runs verification without a release. The next PR must still publish a single patch.
git commit -q --allow-empty -m 'Direct documentation edit'
direct=$(git rev-parse HEAD)
direct_candidate=$(prepare "$base")
[[ -z $direct_candidate ]]
[[ $(git rev-parse HEAD) == "$direct" ]]
git commit -q --allow-empty -m 'First change (#60)'
first=$(git rev-parse HEAD)
pr "$first" 60
touch "$tmp/api-failure"
refuse '' prepare "$direct"
rm "$tmp/api-failure"
first_release=$(prepare "$direct")
[[ $first_release != "$first" && $(jq -r .version package.json) == 0.7.3 ]]
grep -Fq 'First change (#60)' CHANGELOG.md
if grep -Fq 'Direct documentation edit' CHANGELOG.md; then exit 1; fi
[[ $(jq -r '.packages[""].version' package-lock.json) == 0.7.3 ]]
grep -Fq "VERSION = '0.7.3'" src/core/version.ts
git branch ci-release "$first_release"
git bundle create "$tmp/brain.bundle" refs/heads/ci-release "^$first"
git switch -q --detach "$first"
[[ $(prepare "$direct") == "$first_release" ]]

# A second PR can merge and finish before the first publication. Model a two-commit rebase.
git switch -q --detach "$first"
git commit -q --allow-empty -m 'Intermediate rebase commit'
intermediate=$(git rev-parse HEAD)
git commit -q --allow-empty -m 'Second change'
second=$(git rev-parse HEAD)
pr "$second" 61
cp "$tmp/$second.json" "$tmp/$intermediate.json"
git push -q origin "$second:refs/heads/main"
second_release=$(prepare "$first")
[[ $(jq -r .version package.json) == 0.7.4 ]]
grep -Fq 'Second change (#61)' CHANGELOG.md
grep -Fq '## v0.7.3' CHANGELOG.md
touch "$tmp/upload-failure"
refuse '' publish "$second_release" "$second"
if remote refs/tags/v0.7.4 >/dev/null 2>&1; then exit 1; fi
[[ $(remote refs/heads/main) == "$second" ]]
rm "$tmp/upload-failure"
publish "$second_release" "$second"
[[ $(remote refs/heads/main) == "$second_release" ]]
git switch -q --detach "$first_release"
publish "$first_release" "$first"
[[ $(remote refs/heads/main) == "$second_release" ]]
[[ $(remote refs/tags/v0.7.3) == "$first_release" && $(remote refs/tags/v0.7.4) == "$second_release" ]]
grep -Fq "$(sha256sum deploy/rsc-brain.sh | cut -d' ' -f1)  rsc-brain.sh" "$tmp/v0.7.3.notes"
publish "$first_release" "$first"
cp "$tmp/v0.7.3.release" "$tmp/valid"
for change in '.assets[0].digest="wrong"' '.isPrerelease=true' '.body="wrong"'; do
  jq "$change" "$tmp/valid" > "$tmp/v0.7.3.release"
  refuse '' publish "$first_release" "$first"
done
echo '{"isDraft":true,"targetCommitish":"other"}' > "$tmp/v0.7.3.release"
refuse 'targets another commit' publish "$first_release" "$first"
printf '{"databaseId":42,"assets":[],"isDraft":true,"targetCommitish":"%s"}\n' "$first_release" > "$tmp/v0.7.3.release"
touch "$tmp/upload-failure"
refuse '' publish "$first_release" "$first"
jq -e .isDraft "$tmp/v0.7.3.release" >/dev/null
rm "$tmp/upload-failure"
publish "$first_release" "$first"
publish "$first_release" "$first"

# The publish job starts from the tested merge, with only the bundle giving it the candidate.
git clone -q --depth 1 --branch main "file://$tmp/origin" "$tmp/runner"
git -C "$tmp/runner" fetch -q --depth 1 origin "$first"
git -C "$tmp/runner" checkout -q --detach FETCH_HEAD
git -C "$tmp/runner" fetch -q "$tmp/brain.bundle" refs/heads/ci-release
[[ $(git -C "$tmp/runner" rev-parse FETCH_HEAD) == "$first_release" ]]

git switch -q --detach "$second_release"
git commit -q --allow-empty -m 'Third change'
third=$(git rev-parse HEAD)
pr "$third" 62
git fetch -q --tags origin
third_release=$(prepare "$second_release")
[[ $(jq -r .version package.json) == 0.7.5 ]]
git --git-dir="$tmp/origin" tag v0.7.5 "$second_release"
refuse 'already points to another commit' publish "$third_release" "$third"

# A version selected while an older patch is in CI keeps both changelog sections.
git switch -q --detach "$first"
echo '{"version":"0.9.0"}' > package.json
printf '# Changelog\n\n## v0.9.0\n\nExplicit notes.\n\n## v0.7.2\n\nOld.\n' > CHANGELOG.md
git commit -qam 'Overlapping version choice'
overlap=$(git rev-parse HEAD)
pr "$overlap" 67
mv "$tmp/$first.json" "$tmp/late-association"
overlap_release=$(prepare "$first")
mv "$tmp/late-association" "$tmp/$first.json"
[[ $overlap_release != "$overlap" ]]
grep -Fq '## v0.7.3' CHANGELOG.md
grep -Fq 'Explicit notes.' CHANGELOG.md

git switch -q --detach "$second_release"
echo '{"version":"0.8.0"}' > package.json
echo '{"version":"0.8.0","packages":{"":{"version":"0.8.0"}}}' > package-lock.json
echo "export const VERSION = '0.8.0'" > src/core/version.ts
printf '# Changelog\n\n## v0.8.0\n\nExplicit notes.\n' > CHANGELOG.md
git commit -qam 'Choose 0.8.0'
inner=$(git rev-parse HEAD)
git commit -q --allow-empty -m 'Major feature'
explicit=$(git rev-parse HEAD)
pr "$explicit" 63
cp "$tmp/$explicit.json" "$tmp/$inner.json"
git push -q origin "$explicit:refs/heads/main"
[[ $(prepare "$second_release") == "$explicit" ]]
# A later PR can finish CI before the preceding rebase that chose 0.8.0.
git commit -q --allow-empty -m 'Small follow-up'
follow=$(git rev-parse HEAD)
pr "$follow" 64
mv "$tmp/$inner.json" "$tmp/late-rebase-association"
echo '+  "version": "0.8.0",' > "$tmp/pr-63.patch"
prepare "$explicit" >/dev/null
mv "$tmp/late-rebase-association" "$tmp/$inner.json"
[[ $(jq -r .version package.json) == 0.8.1 ]]
[[ $(grep -c '^## v0.8.0$' CHANGELOG.md) == 1 ]]
git switch -q --detach "$explicit"
publish "$explicit" "$explicit"
for expr in 'package.json .version' 'package-lock.json .version' 'package-lock.json .packages[""].version'; do
  read -r file field <<< "$expr"
  [[ $(git --git-dir="$tmp/origin" show "v0.8.0:$file" | jq -r "$field") == 0.8.0 ]]
done
git --git-dir="$tmp/origin" show v0.8.0:src/core/version.ts | grep -Fq "VERSION = '0.8.0'"
grep -Fq 'Explicit notes.' "$tmp/v0.8.0.notes"
echo '{"version":"0.7.0"}' > package.json
git commit -qam 'Invalid downgrade'
pr "$(git rev-parse HEAD)" 65
refuse 'Expected a version above' prepare "$explicit"
echo 'Publication checks passed.'
