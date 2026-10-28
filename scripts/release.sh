#!/bin/zsh
# Builds a release of the version in package.json, signed and notarized, and publishes it on
# GitHub Releases as v<version>: the DMG for new installs, and the zip and latest-mac.yml that
# installed jbrows update from (src/main/updates.ts). Only builds made here update themselves.
#
# Needs: a clean tree pushed to GitHub, a version that has no release yet and its section in
# CHANGELOG.md ("## <version>", which becomes the release notes), the Developer ID
# identity in your keychain, Apple credentials for notarizing (APPLE_KEYCHAIN_PROFILE, or APPLE_ID,
# APPLE_APP_SPECIFIC_PASSWORD and APPLE_TEAM_ID) and the gh CLI signed in (or GH_TOKEN).
set -euo pipefail

cd "${0:A:h}/.."
VERSION=$(node -p 'require("./package.json").version')
TAG="v$VERSION"

fail() { echo "release: $*" >&2; exit 1 }

[[ -z $(git status --porcelain) ]] || fail "the tree has uncommitted changes"
git fetch --quiet origin
[[ -n $(git branch -r --contains HEAD) ]] || fail "push $(git rev-parse --short HEAD) to GitHub first"
if gh release view "$TAG" >/dev/null 2>&1; then
  fail "$TAG is already released; bump the version in package.json"
fi
NOTES=$(awk -v head="## $VERSION" '$0 == head { on = 1; next } /^## / && on { exit } on' CHANGELOG.md)
[[ -n ${NOTES//[[:space:]]/} ]] || fail "CHANGELOG.md has nothing under \"## $VERSION\""
# An update that isn't notarized installs, but a DMG that isn't won't open on anyone else's Mac.
[[ -n ${APPLE_KEYCHAIN_PROFILE:-} || ( -n ${APPLE_ID:-} && -n ${APPLE_APP_SPECIFIC_PASSWORD:-} && -n ${APPLE_TEAM_ID:-} ) ]] ||
  fail "no Apple credentials for notarizing (APPLE_KEYCHAIN_PROFILE, or APPLE_ID, APPLE_APP_SPECIFIC_PASSWORD and APPLE_TEAM_ID)"
export GH_TOKEN=${GH_TOKEN:-$(gh auth token)}

echo "release: building $TAG"
rm -rf release
JBROW_RELEASE=1 npm run setup

if ! git rev-parse -q --verify "refs/tags/$TAG" >/dev/null; then
  git tag -a "$TAG" -m "jbrow $VERSION"
fi
git push --quiet origin "$TAG"

echo "release: signing, notarizing and publishing $TAG"
npx electron-builder --mac --publish always
gh release edit "$TAG" --notes "$NOTES" >/dev/null

echo "release: done, https://github.com/join3r/jbrow/releases/tag/$TAG"
