# jbrow

A browser that isn't there until you call it. Unpin it and it has no window: a hotkey brings it up
over whatever you're doing, and clicking into another app sends it away. It starts pinned, as a
regular window with a Dock icon, so the first launch looks like any other browser.

This is the first working version. The design behind it is in the jbrow Summon Lab artifact.

## Run it

```sh
npm install
npm install-scripts approve electron esbuild   # npm 11 skips install scripts until approved
node node_modules/electron/install.js          # if the Electron binary didn't download
npm start
```

## Install it

```sh
npm run dist        # builds release/jbrow-0.1.0-arm64.dmg and release/mac-arm64/jbrow.app
```

Or let `scripts/install.sh` (`npm run install-app`) do it all. It builds the app, quits the jbrow
that's running, whether installed or from `npm start`, installs the new one into Applications and
starts it. Instances running with `JBROW_USER_DATA` keep running.

Drag `jbrow.app` from the DMG (or `release/mac-arm64/`) into Applications, quit the jbrow you ran
from source and open the installed one. It uses the same tabs, profiles and logins. The app is
signed with the first Developer ID identity in your keychain. It's notarized only when
electron-builder finds Apple credentials in the environment (`APPLE_KEYCHAIN_PROFILE`, or
`APPLE_ID`, `APPLE_APP_SPECIFIC_PASSWORD` and `APPLE_TEAM_ID`). A copy you build yourself doesn't
need notarizing; one you send to someone else does. There are no automatic updates: run
`npm run dist` again and replace the app.

The installed app is locked down with Electron fuses (`electronFuses` in package.json). It can't be
run as Node or with `--inspect`, and local pages get only Chrome's rights. An HTML file you open in
jbrow can't read other files on your Mac. That's also why the UI lives outside `app.asar`
(`asarUnpack`): file:// pages can no longer read inside it.

Under **Default browser** in settings, **Make jbrow the default browser** asks macOS to switch. From
then on, links from other apps open in jbrow, which comes up on them. Each link opens in the
profile set for its app under **Apps**, otherwise in the default profile, and lands in that app's
section of the sidebar. HTML files opened with jbrow work the same way. Only the installed app can
be the default browser, not `npm start`.

Links you didn't click open quietly. If a link arrives with no click or key press in the last 2
seconds (a script, a build tool, an app opening something on its own), jbrow doesn't come up: the
thread opens in the background, muted, with a dot in the sidebar, and the menu bar item counts them
(`jb •2`). Right-click the menu bar item for **Show quiet links**, or just look at them; viewing a
thread clears its dot and unmutes it. Links that arrive while jbrow is up, or that launch it, open
as usual. Turn this off with **Quiet links** under **General** in settings.

To change the icon, edit `build/icon.svg` and run `npm run icon`.

If jbrow disappears a few seconds after you hide it, something is quitting apps that have no
open windows, which is jbrow's normal state. Vorssaint does this; add jbrow to its exceptions
(while developing, jbrow runs as **Electron**, bundle ID `com.github.Electron`). The log shows
`[jbrow] quitting` when it happens.

jbrow runs from the menu bar (**jb**) with no Dock icon. Quit it from the menu bar item's
right-click menu, ⌘Q, or Ctrl+C in the terminal.

These are the defaults; change any of them under **Shortcuts** in settings. ⌘1–9 and zoom stay fixed.

| Key | Does |
|---|---|
| ⌥Space | Show or hide jbrow with every thread |
| ⌥⇧Space | Show only the threads of the app you were in |
| ⌘T / ⇧⌘N | New tab / new tab in the next profile |
| Tab | In the address bar: switch the profile what you type opens in |
| ⌘1–9 | Jump to a thread |
| ⌃Tab | Previous tab |
| ⌘W | Close tab |
| ⇧⌘T | Reopen the last closed tab (again for the one before) |
| ⌘F | Find in page (Return / ⌘G next, ⇧Return / ⇧⌘G previous, Esc closes) |
| ⌘P | Print, or Save as PDF from the print dialog |
| ⌘L | Address bar |
| ⇧⌘P | Pin: a regular window with a Dock icon, which stays put when you click elsewhere |
| ⌘, | Settings |
| ⌥⌘I | DevTools for the page |

If another app already uses ⌥Space (Raycast does by default), jbrow shows a notification. Pick
another key under **Shortcuts** in settings; it takes effect right away.

The profile filter at the top of the sidebar shows each profile's color, the same color as the bar
on its tabs. A new tab says which profile it opens in and lets you switch; right-click **+** for a
new tab in a specific profile.

While you type in the address bar, Tab (⇧Tab goes back) switches the profile the address opens in; the
profile in the address bar changes to match. On a new tab the tab itself moves over. On a tab with a page,
the page stays where it is and what you typed opens in a new tab in the chosen profile.

Threads opened from an app with ⌥⇧Space get their own section in the sidebar, under the app's name
and icon (linked apps share one). Kept threads stay in Kept.

Right-click a tab to rename it, keep it, move it to a folder, open it in another profile, copy its
link or close it. Its close
button shows on hover. ⇧⌘T, or right-click **+** → **Reopen closed tab**, brings back the last 25
closed tabs one by one, in their old place with their back/forward history and any threads that were
under them. The list is kept only until jbrow quits.

Right-click a page for **Print…** and **Save as PDF…** (saved to ~/Downloads by default).

A site that asks for a username and password (HTTP basic or digest auth) gets a sign-in form in the
page area. jbrow doesn't store the password; Chromium remembers it until jbrow quits. If a page
crashes, or macOS kills it to free memory, the page area says so and offers **Reload** (or ⌘R), and
the tab is greyed out in the sidebar. A page that hangs gets **Wait** and **Reload**.

Kept can hold folders: hover the Kept heading and click the folder icon. Drag threads onto a folder,
click it to fold it away, and right-click it to rename, delete (its threads stay kept) or set its
**auto-file rules**. A thread about to be archived moves into the first folder whose rules match one of
its addresses instead of being archived. Rules are patterns like the private addresses ones.

Threads unseen for 3 days fall asleep: their pages unload and the sidebar shows them as one line
saying how many tabs, which sites and how long ago. Clicking one loads it again. A page that's playing
sound stays loaded, and kept threads never sleep.

Threads unseen for a week are archived (change both under **Threads** in settings, or turn them off):
their pages close and they leave the sidebar. Type in the address bar to find one and bring the
whole thread back. Archived threads are forgotten after 90 days.

Downloads go straight into ~/Downloads, renamed `name (1).ext` if the name is taken. Each one shows
as a small pie in the toolbar while it runs. Click it for the name, size, speed, time left, folder and
source, and to pause, resume or cancel it. A finished download turns into a check; open its details
to open the file or show it in Finder. Apps, installers and scripts only get Show in Finder, and every
download is quarantined, so Gatekeeper checks it as it would one from Safari or Chrome. A page that starts a
second download asks first, as in Chrome, and while jbrow is hidden it's simply blocked. Finished downloads leave the toolbar when jbrow hides or when you
close their details, and if one finishes while jbrow is hidden, you get a notification. A link that opens
a new tab only to start a download closes that tab again.

## Restyling sites with Claude

The wand icon in the toolbar restyles the site you're on. Type how it should look ("dark theme",
"hide the sidebar", "wider text column, bigger font") and press Return. jbrow sends Claude a
screenshot of the page, an outline of its DOM and the site's stylesheet so far, and inserts the
stylesheet Claude writes back into every page of that site (the hostname, without www) from the
moment each starts loading. Ask again to refine it; each request builds on the last. The wand turns
teal on a restyled site and pulses while Claude works, and the note on what changed shows at the
bottom of the sidebar. The wand's popover lists what you asked for and has **Undo last change**,
**Show the original** and **Remove all changes**. Settings lists every restyled site.

It runs Claude Code's `claude -p` with your Claude subscription, so install Claude Code and sign in
first (`claude`, then `/login`). jbrow finds `claude` in `~/.local/bin`, `/opt/homebrew/bin`,
`/usr/local/bin` or your login shell's PATH; set `restyle.claudePath` otherwise. Each run has no
tools, settings, CLAUDE.md or MCP servers, and jbrow leaves `ANTHROPIC_API_KEY` out of its
environment so it can't bill an API key instead. Because page text reaches Claude, a page could try
to talk it into CSS that sends what you type elsewhere (`input[value^=a] { background: url(…) }`),
so jbrow removes every `url()`, `image-set()` and `@import` that isn't a `data:` URL before using a
stylesheet, and says so when it does. Chromium parses the stylesheet first (in a blank page with no
network), and jbrow checks and inserts Chromium's own serialization of it, so escapes and odd line
endings can't hide a reference from the check. Pick the model under **Restyling** in settings;
Sonnet takes about 10 seconds. Styles are kept in `styles.json` next to `settings.json`.

## Settings

The settings screen (⌘, or the sliders icon) has a sidebar of sections: **General** (pinning, quiet links, the
default browser), **Profiles**, **Threads** (archiving), **Apps**, **Animation**, **Restyling**,
**Privacy** (private addresses, screen sharing) and **Shortcuts** (jbrow's own and extensions').
The search above the sections finds any setting or shortcut, and **Shortcuts** has its own search.
Changes apply right away. Private addresses: any address that contains
one of your patterns (`*` matches anything, e.g. `*.corp.example`) shows as **Private** in the
address bar, the tab list tooltips and the address suggestions until you click the address bar.
Page titles still show.

Everything is stored in `~/Library/Application Support/jbrow/settings.json`, written with defaults
on first run. Restart jbrow after editing the file by hand (menu bar item, **Restart jbrow**).

- `profiles`: names and colors. Each profile has its own logins, cookies and extensions. Manage them
  under **Profiles** in settings: rename one, change its color, add one, and right-click one to make
  it the default (`defaultProfile`, for links from other apps and for new tabs when nothing else
  decides) or delete it. Deleting closes its tabs and erases its logins, site data, extensions and
  site permissions.
- `appProfiles`: default profile per app bundle ID, for links from and new tabs in that app's view.
  Set it under **Apps** in settings.
- `linkedApps`: groups of bundle IDs that share one set of tabs for ⌥⇧Space. Under **Apps**,
  right-click an app to link or unlink it; its threads move along right away.
- `animation`: `style` (materialize, slide, scale, fade, off), `durationMs`, `ease` (spring, snappy, smooth).
- `unpackedExtensions`: extension folders to load per profile, e.g. Stem.
- `pinned`: a regular window with a Dock icon that opens at launch and stays when you click away
  (on by default). The pin in the toolbar and ⇧⌘P switch it, and jbrow remembers.
- `quietLinks`: open links you didn't click in the background (on by default).
- `hideFromScreenCapture`: keeps jbrow out of screen shares (on by default). While it's on, private
  addresses don't matter for streaming: nobody sees jbrow at all.
- `privateUrls`: the private address patterns.
- `pinnedExtensions`: IDs of extensions pinned to the toolbar.
- `shortcuts`: your keys for jbrow's own commands, e.g. `"newTab": "Command+Y"` (`""` removes one).
  Commands not listed use their defaults. Older settings files kept the summon keys under
  `hotkeys`; jbrow still reads those and writes them here the next time it saves settings.
- `extensionShortcuts`: your extension shortcuts per profile, extension and command (`""` removes one).
- `archiveAfterDays`: archive threads unseen this many days; 0 turns archiving off.
- `restyle`: `model` for restyling (a Claude model alias such as sonnet, opus or haiku) and
  `claudePath`, the claude command if jbrow doesn't find it on its own.

Tabs, folders and archived threads are in `tabs.json` next to it.

## Extensions

The puzzle icon lists the extensions of the current tab's profile. From there, **Add from folder…**
loads an unpacked extension into that profile and adds it to `unpackedExtensions` so it loads
again next launch (adding the same folder again reloads it), and **Chrome Web Store** opens the
store in that profile. Right-click an extension there and choose **Pin to toolbar** to keep its
button next to the puzzle icon (it shows whenever the current tab's profile has that extension);
right-click the pinned button to unpin it. Installed extensions update every 5 hours.

Extension keyboard shortcuts are under **Shortcuts** in settings. They work while jbrow is
open, for the profile of the tab you're on. Shortcuts an extension suggests apply on their own,
except ones jbrow already uses. Click a shortcut to record a new one.

See [docs/extension-checklist.md](docs/extension-checklist.md) for how your must-have extensions fare
and what jbrow patches to make them work.

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
CDP (`Page.captureScreenshot`). Use it for automated runs while you keep working:

```sh
JBROW_USER_DATA=/tmp/jb JBROW_BACKGROUND=1 npx electron . --show --remote-debugging-port=9333
```

`JBROW_ALLOW_CAPTURE=1` lets you screenshot the panel. `JBROW_NO_SHIMS=1` and
`JBROW_SHIM_SKIP=alarms,storage,browser` turn the extension shims off for comparison.

Layout: `src/main` (Electron main process: panel, tabs, profiles, hotkeys), `src/preload` (UI
bridge and extension shims), `src/ui` (the toolbar and sidebar), `src/shared` (thread logic both
sides use), `scripts/patch-deps.mjs` (fixes to electron-chrome-extensions).
The log is at `~/Library/Logs/jbrow/main.log` (menu bar item, **Show log file**).

## Not built yet

- Undo for archiving (reopening from the address bar is the way back for now).
- The sign-in form covers tabs only; basic auth in extension pages and sign-in popups still fails.
- Known rough edges: the native page view can't take part in the CSS animation, so a snapshot of
  the page animates in its place; and the panel opens at a fixed fraction of the screen.

## License

GPL-3.0, as required by electron-chrome-extensions.
