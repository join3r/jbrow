# jbrow

A browser that isn't there until you call it. No window by default: a hotkey brings it up over
whatever you're doing, and clicking into another app sends it away.

This is the first working version. The design behind it is in the jbrow Summon Lab artifact.

## Run it

```sh
npm install
npm install-scripts approve electron esbuild   # npm 11 skips install scripts until approved
node node_modules/electron/install.js          # if the Electron binary didn't download
npm start
```

If jbrow disappears a few seconds after you hide it, something is quitting apps that have no
open windows, which is jbrow's normal state. Vorssaint does this; add jbrow to its exceptions
(while developing, jbrow runs as **Electron**, bundle ID `com.github.Electron`). The log shows
`[jbrow] quitting` when it happens.

jbrow runs from the menu bar (**jb**) with no Dock icon. Quit it from the menu bar item's
right-click menu, ⌘Q, or Ctrl+C in the terminal.

| Key | Does |
|---|---|
| ⌥Space | Show or hide jbrow with every thread |
| ⌥⇧Space | Show only the threads of the app you were in |
| ⌘T / ⇧⌘N | New tab / new tab in the other profile |
| Tab | In the address bar: switch the profile what you type opens in |
| ⌘1–9 | Jump to a thread |
| ⌃Tab | Previous tab |
| ⌘W | Close tab |
| ⌘L | Address bar |
| ⇧⌘P | Pin: a regular window with a Dock icon, which stays put when you click elsewhere |
| ⌘, | Settings |
| ⌥⌘I | DevTools for the page |

If another app already uses ⌥Space (Raycast does by default), jbrow shows a notification. Change
`hotkeys` in settings.json and restart.

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
button shows on hover.

Kept can hold folders: hover the Kept heading and click the folder icon. Drag threads onto a folder,
click it to fold it away, and right-click it to rename, delete (its threads stay kept) or set its
**auto-file rules**. A thread about to be archived moves into the first folder whose rules match one of
its addresses instead of being archived. Rules are patterns like the private addresses ones.

Threads unseen for 3 days fall asleep: their pages unload and the sidebar shows them as one line
saying how many tabs, which sites and how long ago. Clicking one loads it again. A page that's playing
sound stays loaded, and kept threads never sleep.

Threads unseen for a week are archived (change both under Archiving in settings, or turn them off):
their pages close and they leave the sidebar. Type in the address bar to find one and bring the
whole thread back. Archived threads are forgotten after 90 days.

## Settings

The settings screen (⌘, or the sliders icon) covers the summon animation, archiving, apps, private
addresses, screen sharing and extension shortcuts, and changes there apply right away. Private addresses: any address that contains
one of your patterns (`*` matches anything, e.g. `*.corp.example`) shows as **Private** in the
address bar, the tab list tooltips and the address suggestions until you click the address bar.
Page titles still show.

Everything is stored in `~/Library/Application Support/jbrow/settings.json`, written with defaults
on first run. Restart jbrow after editing the file by hand (menu bar item, **Restart jbrow**).

- `profiles`: names and colors. Each profile has its own logins, cookies and extensions.
- `appProfiles`: default profile per app bundle ID, for links from and new tabs in that app's view.
  Set it under **Apps** in settings.
- `linkedApps`: groups of bundle IDs that share one set of tabs for ⌥⇧Space. Under **Apps**,
  right-click an app to link or unlink it; its threads move along right away.
- `animation`: `style` (materialize, slide, scale, fade, off), `durationMs`, `ease` (spring, snappy, smooth).
- `unpackedExtensions`: extension folders to load per profile, e.g. Stem.
- `hideFromScreenCapture`: keeps jbrow out of screen shares (on by default). While it's on, private
  addresses don't matter for streaming: nobody sees jbrow at all.
- `privateUrls`: the private address patterns.
- `pinnedExtensions`: IDs of extensions pinned to the toolbar.
- `extensionShortcuts`: your extension shortcuts per profile, extension and command (`""` removes one).
- `archiveAfterDays`: archive threads unseen this many days; 0 turns archiving off.

Tabs, folders and archived threads are in `tabs.json` next to it.

## Extensions

The puzzle icon lists the extensions of the current tab's profile. From there, **Add from folder…**
loads an unpacked extension into that profile and adds it to `unpackedExtensions` so it loads
again next launch (adding the same folder again reloads it), and **Chrome Web Store** opens the
store in that profile. Right-click an extension there and choose **Pin to toolbar** to keep its
button next to the puzzle icon (it shows whenever the current tab's profile has that extension);
right-click the pinned button to unpin it. Installed extensions update every 5 hours.

Extension keyboard shortcuts are under **Extension shortcuts** in settings. They work while jbrow is
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
`JBROW_ALLOW_CAPTURE=1` lets you screenshot the panel. `JBROW_NO_SHIMS=1` and
`JBROW_SHIM_SKIP=alarms,storage,browser` turn the extension shims off for comparison.

Layout: `src/main` (Electron main process: panel, tabs, profiles, hotkeys), `src/preload` (UI
bridge and extension shims), `src/ui` (the toolbar and sidebar), `src/shared` (thread logic both
sides use), `scripts/patch-deps.mjs` (fixes to electron-chrome-extensions).
The log is at `~/Library/Logs/jbrow/main.log` (menu bar item, **Show log file**).

## Not built yet

- Opening links from other apps (needs a packaged app that declares itself a browser), including
  the quiet background opening for links you didn't click.
- Undo for archiving (reopening from the address bar is the way back for now).
- Settings screen entries for hotkeys and profiles; those are settings.json only.
- PiP when hiding a playing video.
- Known rough edges: the native page view can't take part in the CSS animation, so a snapshot of
  the page animates in its place; and the panel opens at a fixed fraction of the screen.

## License

GPL-3.0, as required by electron-chrome-extensions.
