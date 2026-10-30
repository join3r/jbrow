#!/bin/zsh
# Builds a release of the version in package.json and publishes it on GitHub Releases as
# v<version>. The Mac build is made here, signed and notarized: the DMG for new installs, and the
# zip and latest-mac.yml that installed jbrows update from (src/main/updates.ts). Pushing the tag
# has GitHub Actions build Windows (NSIS installer, latest.yml) and Linux (AppImage, .deb,
# latest-linux.yml) in .github/workflows/release.yml. Everything goes into a draft release, which
# is published once all three are on it, so nobody downloads or updates to half a release. Only
# builds made here and in that workflow update themselves.
#
# Needs: a clean tree pushed to GitHub with the test workflow green on it, a version that has no
# release yet and its section in CHANGELOG.md ("## <version>", which becomes the release notes),
# the Developer ID identity in your keychain, Apple credentials for notarizing (an App Store
# Connect API key in APPLE_API_KEY, APPLE_API_KEY_ID and APPLE_API_ISSUER, or
# APPLE_KEYCHAIN_PROFILE, or APPLE_ID, APPLE_APP_SPECIFIC_PASSWORD and APPLE_TEAM_ID) and the gh
# CLI signed in (or GH_TOKEN). Running it again after a failure picks up the same draft.
set -euo pipefail

cd "${0:A:h}/.."
VERSION=$(node -p 'require("./package.json").version')
TAG="v$VERSION"
REPO=join3r/jbrow
SHA=$(git rev-parse HEAD)

fail() { echo "release: $*" >&2; exit 1 }

[[ -z $(git status --porcelain) ]] || fail "the tree has uncommitted changes"
git fetch --quiet origin
[[ -n $(git branch -r --contains HEAD) ]] || fail "push $(git rev-parse --short HEAD) to GitHub first"
# Windows and Linux are built where they're tested, so they ship only when those tests pass.
[[ $(gh run list -R $REPO --workflow test.yml --commit $SHA --json conclusion --jq 'map(select(.conclusion == "success")) | length') -gt 0 ]] ||
  fail "the test workflow hasn't passed on $(git rev-parse --short HEAD) yet"
DRAFT=$(gh api "repos/$REPO/releases?per_page=100" --jq ".[] | select(.tag_name == \"$TAG\") | .draft")
[[ $DRAFT != false ]] || fail "$TAG is already released; bump the version in package.json"
NOTES=$(awk -v head="## $VERSION" '$0 == head { on = 1; next } /^## / && on { exit } on' CHANGELOG.md)
[[ -n ${NOTES//[[:space:]]/} ]] || fail "CHANGELOG.md has nothing under \"## $VERSION\""
# An update that isn't notarized installs, but a DMG that isn't won't open on anyone else's Mac.
[[ ( -n ${APPLE_API_KEY:-} && -n ${APPLE_API_KEY_ID:-} && -n ${APPLE_API_ISSUER:-} ) ||
  -n ${APPLE_KEYCHAIN_PROFILE:-} || ( -n ${APPLE_ID:-} && -n ${APPLE_APP_SPECIFIC_PASSWORD:-} && -n ${APPLE_TEAM_ID:-} ) ]] ||
  fail "no Apple credentials for notarizing (APPLE_API_KEY, APPLE_API_KEY_ID and APPLE_API_ISSUER, or APPLE_KEYCHAIN_PROFILE, or APPLE_ID, APPLE_APP_SPECIFIC_PASSWORD and APPLE_TEAM_ID)"
export GH_TOKEN=${GH_TOKEN:-$(gh auth token)}

# The draft comes first: builders that find no release each make one, and two at once make two.
if [[ -z $DRAFT ]]; then
  gh release create "$TAG" -R $REPO --draft --target $SHA --title "$VERSION" --notes "$NOTES" >/dev/null
fi
if ! git rev-parse -q --verify "refs/tags/$TAG" >/dev/null; then
  git tag -a "$TAG" -m "jbrow $VERSION"
fi
git push --quiet origin "$TAG"

echo "release: building $TAG"
rm -rf release
JBROW_RELEASE=1 npm run setup

echo "release: signing, notarizing and uploading the Mac build"
npx electron-builder --mac --publish always

echo "release: waiting for the Windows and Linux builds"
RUN=
for i in {1..60}; do
  RUN=$(gh run list -R $REPO --workflow release.yml --commit $SHA --json databaseId,headBranch \
    --jq "map(select(.headBranch == \"$TAG\")) | first | .databaseId // empty")
  [[ -n $RUN ]] && break
  sleep 5
done
[[ -n $RUN ]] || fail "the release workflow never started for $TAG"
gh run watch $RUN -R $REPO --exit-status >/dev/null ||
  fail "the Windows or Linux build failed: gh run view $RUN -R $REPO --log-failed. Rerun it, then this"

ASSETS=$(gh release view "$TAG" -R $REPO --json assets --jq '.assets[].name')
for file in latest-mac.yml latest.yml latest-linux.yml; do
  [[ $'\n'$ASSETS$'\n' == *$'\n'$file$'\n'* ]] || fail "$file is missing from the $TAG draft"
done
gh release edit "$TAG" -R $REPO --draft=false --latest --notes "$NOTES" >/dev/null

echo "release: done, https://github.com/$REPO/releases/tag/$TAG"
