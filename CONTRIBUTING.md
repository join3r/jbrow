# Contributing to jbrow

How to run jbrow from source, test it, build it and publish a release. For what jbrow does, see
[README.md](README.md).

jbrow ships for macOS on Apple Silicon only. CI also runs the tests on Windows and Linux, to keep the
code portable, but nothing is built or released for them.

## Run it from source

```sh
npm install
npm install-scripts approve electron esbuild   # npm 11 skips install scripts until approved
node node_modules/electron/install.js          # if the Electron binary didn't download
npm start
```

From source, jbrow runs as **Electron**, bundle ID `com.github.Electron`. A utility that quits idle
apps needs that in its exceptions too, as it needs jbrow's for the installed app. Ctrl+C in the
terminal quits it, without asking about running downloads.

Only the installed app can be the default browser, not `npm start`.

## Developing

```sh
npm run dev                      # JBROW_DEBUG=1: panel and focus logging
npm start -- --show              # summon on launch
npm start -- --install-extensions=personal
npm run typecheck
```

`JBROW_USER_DATA=/some/dir` runs a second jbrow with its own tabs, profiles, extensions and log, so
it doesn't touch your real data (add `--remote-debugging-port=9333` to inspect extensions over CDP).
`JBROW_BACKGROUND=1` keeps such a jbrow out of your way while it runs: its window is invisible,
click-through and pushed off screen, it never takes focus, and it has no Dock icon, menu bar item,
global hotkeys or notifications. Pages still load and render, so drive it and take screenshots over
CDP (`Page.captureScreenshot`). The window's own animation can't be seen there, since the window
stays transparent, but `JBROW_DEBUG=1` logs how long each show waited for the first frames and how
many frames each animation got, with the longest gap. Off screen, macOS gives the window no display
to draw on now and then, and a show can wait the full 150 ms for the UI. Use it for automated runs
while you keep working:

```sh
JBROW_USER_DATA=/tmp/jb JBROW_BACKGROUND=1 npx electron . --show --remote-debugging-port=9333
```

`--remote-debugging-port` (and `--remote-debugging-pipe`) work only from source. A packaged jbrow
refuses to start with either, since a debugging port hands every profile's cookies and pages to
whoever connects.

`JBROW_ALLOW_CAPTURE=1` lets you screenshot the panel. `JBROW_NO_SHIMS=1` and
`JBROW_SHIM_SKIP=alarms,storage,browser,rulesets` turn the extension shims off for comparison (`idle`,
`sidePanel` and `userScripts` work there too).

Don't add `session.webRequest` listeners: one is enough to switch off every extension's
`declarativeNetRequest` rules in that session. Request rewrites jbrow needs go in its own extension
(`src/main/jbrow-extension.ts`) as rules.

Layout: `src/main` (Electron main process: panel, tabs, profiles, hotkeys), `src/preload` (UI
bridge and extension shims), `src/ui` (the address bars and sidebar), `src/shared` (sidebar logic both
sides use), `scripts/patch-deps.mjs` (fixes to electron-chrome-extensions).
The log is at `~/Library/Logs/jbrow/main.log` (menu bar item, **Show log file**).

When running from source, or with `JBROW_DEBUG=1`, the menu bar item's right-click menu also has
**Install test extensions** and **Open UI DevTools**, and `--install-extensions=<profile>` works.
Packaged builds have none of them.

To change the icon, edit `build/icon.svg` and run `npm run icon`.

`npm run top-sites` rebuilds `src/main/top-sites.json`, the popular sites the address bar completes
to, from the Chrome UX Report and Tranco, leaving adult sites out. See
[THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) for the sources.

Tabs saved by an older jbrow, while tabs nested in threads, come out of their threads on the first
start: each takes its thread's app section, and a kept thread's tabs stay kept right after its first
tab, in the same folder (a pinned thread's go to the bottom of Kept). A settings file from before
the welcome counts as having seen it.

## Test extensions

**Install test extensions** (or `npm start -- --install-extensions=personal`, with any profile's
id) installs the extensions in [docs/extension-checklist.md](docs/extension-checklist.md) from the
Chrome Web Store into that profile. The checklist says what's been checked for each, what to try by
hand, and what jbrow patches to make them work.

## Tests

```sh
npm test                               # build, then unit and end-to-end tests
npm run test:unit                      # unit tests only, no Electron
node test/run.mjs e2e tabs split       # end-to-end files whose names contain "tabs" or "split"
node test/run.mjs --repeat 5           # everything five times, to catch flaky tests
npm run test:linux                     # the same on Linux, in Docker (test/linux)
```

Unit tests (`test/unit`) run on Node's test runner, with `test/mocks/electron.ts` in place of
Electron. End-to-end tests (`test/e2e`) start the built app with `JBROW_BACKGROUND=1`, each in its
own user data folder, and drive it over CDP (`test/e2e/harness.ts`), so they run next to the jbrow
you use. They never touch the internet: pages come from a local server. On Linux each jbrow gets
its own Xvfb display, since X11 hands keyboard focus to whichever window asked last. CI runs it all
on macOS, Windows and Linux (`.github/workflows/test.yml`); run that workflow by hand with
**repeat** set to run every test several times.

## Build and install it

```sh
npm run dist        # builds release/jbrow-<version>-arm64.dmg and release/mac-arm64/jbrow.app
```

Or let `scripts/install.sh` (`npm run install-app`) do it all. It builds the app, quits the jbrow
that's running, whether installed or from `npm start`, installs the new one into Applications and
starts it. Instances running with `JBROW_USER_DATA` keep running.

Drag `jbrow.app` from the DMG (or `release/mac-arm64/`) into Applications, quit the jbrow you ran
from source and open the installed one. It uses the same tabs, profiles and logins.

Builds made on your Mac (`npm run dist`, `npm run install-app`) and `npm start` never update: the
release would replace your build. Settings says so.

### Signing and notarization

The app is signed with the first Developer ID identity in your keychain. It's notarized only when
electron-builder finds Apple credentials in the environment (`APPLE_KEYCHAIN_PROFILE`, or
`APPLE_ID`, `APPLE_APP_SPECIFIC_PASSWORD` and `APPLE_TEAM_ID`). A copy you build yourself doesn't
need notarizing; one you send to someone else does.

### Electron fuses

The installed app is locked down with Electron fuses (`electronFuses` in package.json). It can't be
run as Node or with `--inspect`, and local pages get only Chrome's rights. An HTML file you open in
jbrow can't read other files on your Mac. That's also why the UI lives outside `app.asar`
(`asarUnpack`): file:// pages can no longer read inside it.

## Publishing a release

1. Bump `version` in package.json.
2. Write that version's section in [CHANGELOG.md](CHANGELOG.md), under a `## <version>` heading.
   `scripts/release.sh` uses everything between that heading and the next `## ` as the GitHub
   release notes, and stops if the section is missing or empty.
3. Commit and push, then:

```sh
npm run release
```

`scripts/release.sh` checks the tree is clean and pushed, that the version has no release yet and
that CHANGELOG.md has its section. It builds with `JBROW_RELEASE=1` (what makes a build update
itself), tags `v<version>`, then signs, notarizes and publishes the DMG, the zip and
`latest-mac.yml` to GitHub Releases, and sets the release notes from CHANGELOG.md. It needs the
Apple credentials above and the `gh` CLI signed in (or `GH_TOKEN`). Every release has to be signed
with the same Developer ID, or installed copies refuse the update.

## License

By contributing, you agree that your contribution is licensed under GPL-3.0-only, as jbrow is.
