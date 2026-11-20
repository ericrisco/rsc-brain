#!/usr/bin/env bash
# Run from a fully fetched checkout after CI verifies a push to main.
set -euo pipefail

sha=${1:?expected the verified release SHA}
source=${2:?expected the original merge SHA}
[[ $(git rev-parse HEAD) == "$sha" ]]
if [[ $sha != "$source" ]]; then
  [[ $(git rev-parse HEAD^) == "$source" ]]
fi
tag="v$(jq -er .version package.json)"

tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT
awk -v tag="$tag" '/^## / { if (found) exit; found=($2==tag); next } found' CHANGELOG.md > "$tmp/notes"
if ! grep -q '[^[:space:]]' "$tmp/notes"; then
  echo "Missing release notes for $tag." >&2
  exit 1
fi
asset=deploy/rsc-brain.sh
digest=$(sha256sum "$asset" | cut -d' ' -f1)
printf '\nSHA-256\n\n    %s  rsc-brain.sh\n' "$digest" >> "$tmp/notes"

# Keep the candidate reachable while GitHub stages the release. Installations discover
# only vX.Y.Z tags. Publishing the completed draft creates that public tag at the verified SHA.
stage="refs/heads/ci-release/$sha"
remote_tag() { git ls-remote origin "refs/tags/$tag" "refs/tags/$tag^{}" | awk 'END { print $1 }'; }
check_tag() {
  local target
  target=$(remote_tag) || return 1
  if [[ -n $target && $target != "$sha" ]]; then
    echo "$tag already points to another commit." >&2
    return 1
  fi
}
view() { gh release view "$tag" --json databaseId,isDraft,isPrerelease,targetCommitish,assets,body > "$tmp/release"; }
has_asset() {
  jq -e --arg digest "sha256:$digest" 'any(.assets[]; .name == "rsc-brain.sh" and .digest == $digest)' "$tmp/release" >/dev/null
}
check_tag
if ! view; then
  if [[ $sha != "$source" ]]; then git push origin "$sha:$stage"; fi
  gh release create "$tag" --draft --target "$sha" --title "$tag" --notes-file "$tmp/notes"
  view
fi
if jq -e '.isDraft' "$tmp/release" >/dev/null; then
  if [[ $(jq -r .targetCommitish "$tmp/release") != "$sha" ]]; then
    echo "The draft for $tag targets another commit." >&2
    exit 1
  fi
  if ! has_asset; then
    gh release upload "$tag" "$asset" --clobber
    view
    has_asset
  fi
  check_tag
  # Let GitHub order releases by version when CI runs finish out of order.
  id=$(jq -er .databaseId "$tmp/release")
  jq -n --arg sha "$sha" --rawfile body "$tmp/notes" \
    '{target_commitish:$sha,body:$body,draft:false,prerelease:false,make_latest:"legacy"}' > "$tmp/publish.json"
  gh api --silent --method PATCH "repos/{owner}/{repo}/releases/$id" --input "$tmp/publish.json"
  view
fi
[[ $(remote_tag) == "$sha" ]]
has_asset
jq -e --rawfile notes "$tmp/notes" '
  (.isDraft == false and .isPrerelease == false) and ((.body | rtrimstr("\n")) == ($notes | rtrimstr("\n")))
' "$tmp/release" >/dev/null

# Fast-forward main when this is still its tip. Another PR may already be in CI;
# its own release includes the intervening patches. Never push over that PR.
if [[ $sha != "$source" ]]; then
  main_tip() { git ls-remote --exit-code origin refs/heads/main | cut -f1; }
  tip=$(main_tip)
  if [[ $tip == "$source" ]] && ! git push origin "$sha:refs/heads/main"; then
    tip=$(main_tip)
    [[ $tip != "$source" ]] || exit 1
  fi
fi

if [[ $(git ls-remote origin "$stage" | cut -f1) == "$sha" ]]; then
  git push --force-with-lease="$stage:$sha" origin ":$stage"
fi
