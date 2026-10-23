# Extension checklist

Your must-have extensions, tested in jbrow's Personal profile. "Automated" is what I could check
from the command line on 2026-10-22. "By hand" is what only real use can tell.

Install them all into a profile with `npm start -- --install-extensions=personal` (or `work`), or
from the jb menu bar item: right-click, **Install test extensions**.

| Extension | Automated result | Test by hand |
|---|---|---|
| **D.Bridge 2** | Native messaging works: the page handshake reaches D.Launcher's host (`dBridge2Nm`), which starts and answers. | Sign something on slovensko.sk with your eID. |
| **uBlock Origin Lite** | Service worker runs with 6 rulesets enabled (uBlock filters, EasyList, EasyPrivacy, Peter Lowe's, badware, URLhaus). Trackers are blocked; Google ad and analytics scripts are replaced with uBlock's harmless stand-ins, as in Chrome. Checked again on 2026-10-23: until then none of its rules applied, because of jbrow's own request listener (see below), and Google Analytics loaded for real. | Browse a news site. Check that the popup opens and the per-site toggle works. |
| **Bitwarden** | Installs; service worker runs; every API it asks for is present. The inline menu (its icon in login fields) shows, and opens its list. The toolbar icon follows lock and unlock. | Unlock, fill a login from the field icon, save a new login, use a passkey, copy a password. If it was installed before onInstalled worked (below), the field icon is off: Bitwarden → Settings → Autofill → **Show autofill suggestions on form fields**. Desktop-app unlock goes through native messaging (`com.8bit.bitwarden`), which the D.Bridge test shows working. |
| **SponsorBlock** | Service worker runs. It crashed before the fixes below. | Watch a YouTube video with a known sponsor segment. |
| **Enhancer for YouTube** | Service worker runs. | Open YouTube and use its controls. Its commands have no keys until you assign them under Settings → Extension shortcuts. |
| **Video Speed Controller** | Works: S and D change the speed on YouTube. It did nothing until the content script shim below. | Change the speed with its in-page keys (S and D). |
| **Consent-O-Matic** | Service worker runs; opened its welcome page on first install. | Visit a few sites with cookie banners. |
| **Canvas Blocker** | Service worker runs. Electron warns that `notifications` and `contextMenus` are unknown permissions, but the library provides both. | Check a canvas fingerprinting test page. |
| **SideHN** | Works: on a page opened with `?hnid=`, the sidebar loads the HN thread, and with an HN login cookie the frame's request carries it (its `modifyHeaders` rule sets `Cookie`, `Sec-Fetch-*` and `Referer`). Its "Method not implemented" error was `cookies.onChanged.hasListener`, not the header rule. | Log in to HN, open a story link from HN and check that the sidebar shows you logged in and lets you vote and reply. |
| **Stem** (yours, unpacked) | Not tested. Open a Personal tab, then puzzle icon → **Add from folder…** and pick its folder. It has a native messaging host (`com.stem.browser`), which should work the same way D.Bridge does. | Whatever Stem does in Chrome. |

## What jbrow had to fix

Electron plus `electron-chrome-extensions` didn't run most of these out of the box. The fixes live
in these places:

**`scripts/patch-deps.mjs`** patches the library in `node_modules` on every build:

1. The library froze the `chrome` object, which broke Chromium's lazily created APIs and
   SponsorBlock. It now locks only the APIs it replaces, so Chromium can't overwrite them but
   other properties can still be added.
2. Native messaging sized messages by string length instead of bytes, so any non-ASCII text
   (Slovak diacritics) would corrupt the stream.
3. Native messaging assumed every message arrives in a single chunk. Large replies (signed
   documents) would fail to parse.
4. An extension button's right-click menu emits `jbrow-action-context-menu` so jbrow can add
   **Pin to toolbar** to it.
5. `<browser-action-list>` asked for updates only from the session it started with, before jbrow
   gave it the profile's partition, so a new icon or badge never arrived. It now follows its
   `partition`.
6. An extension button let its defaults win over what was set for the tab. Bitwarden sets its
   locked and unlocked icons per tab, so the icon stayed locked after unlocking.
7. Pages got local storage as `chrome.storage.managed` (see the shim's storage item below).
8. Events answer `hasListener` and `hasListeners` instead of throwing "Method not implemented".
   SideHN calls `cookies.onChanged.hasListener` first thing, so it never set up its login rule.

**`src/preload/extension-shims.ts`** runs in every extension context before the library:

1. `browser` now points at `chrome`. Chromium has its own `browser` object without the library's
   APIs, and uBlock Origin Lite prefers `browser`. This was why it crashed.
2. `chrome.storage.sync` maps to local storage. Settings don't sync to your Chrome. `managed`, which
   holds an administrator's policy, is empty and read-only, as in a Chrome nobody manages. It
   used to be local storage too, and Bitwarden applied everything in it, vault data included, as
   policy.
3. `chrome.alarms`, which Electron doesn't have, is implemented on timers.
4. `chrome.runtime.getContexts` lists extension pages in jbrow's own windows (action popups,
   pop-out windows). Electron leaves them out ("Unexpected view type found: 0" in the log), so
   Bitwarden thought nothing of it was open or focused, and its vault timeout could lock or log
   out while you were signing in through the pop-out.
5. `chrome.idle`, `chrome.sidePanel` and `chrome.userScripts`, for extensions whose manifest asks
   for them. They call the main process (below) over the library's own message channel, and their
   events come back through its router, which wakes a stopped service worker.
6. Static `declarativeNetRequest` rulesets that the manifest turns on are turned on. Chrome
   indexes them at install; Electron's loader doesn't, and Chromium skips a ruleset without an
   index, so SideHN's header rules never applied. Enabling them through the API builds the index.
   The service worker does this once per extension version, and only while no ruleset is on, so
   one the extension turned off stays off. It remembers that in the extension's own storage, under
   `jbrow.enabledRulesets`.

**`src/main/installed.ts`** stands in for `chrome.runtime.onInstalled`, which Electron never
fires. Bitwarden turns its inline menu on, and shows its welcome page, only on install, so the
icon in login fields never appeared. Each extension service worker asks the main process as it
starts: "install" for an extension jbrow hasn't seen whose storage is empty, "update" when its
version changed. The shim fires the event once the worker's script has run, as Chrome does. Versions
seen are in `jbrow-extension-versions.json` in the profile's partition folder. Extensions
installed earlier have stored data, so they get neither.

**`src/main/content-shim.ts`** covers content scripts, which no preload reaches. Their
`chrome.storage` has no `sync` area either ('"sync" is not available in this instance of Chrome'),
so Video Speed Controller never got its settings and never attached to videos. Before an extension
from the Web Store loads, jbrow writes `jbrow-content-shim.js` into its folder and lists it first in
each isolated-world content script, pointing `sync` at local storage. Updates get it
too. Unpacked folders such as Stem are left alone, since they're your own source. `managed` is
empty here as well.

**`src/main/jbrow-extension.ts`** is jbrow's own extension, loaded into every profile. Electron
already enforces `declarativeNetRequest` (blocking, redirects, header rewriting, every condition and
priority) through Chromium's code, but only for sessions with no `session.webRequest` listener: with
one, every request goes through Electron's own proxy and no extension rule applies. jbrow had one,
to send Google sign-in the real user agent, so uBlock Origin Lite blocked nothing and SideHN's
header rules did nothing. That rewrite is now a rule in jbrow's extension, so jbrow must not add
`session.webRequest` listeners again. The extension has no toolbar button and doesn't show in the
puzzle menu.

**`src/main/commands.ts`** implements `chrome.commands`. The library reads a manifest's commands
but leaves every shortcut empty and never fires `onCommand`. jbrow takes your shortcut from
settings, or else the manifest's `suggested_key` (`mac`, then `default`, where Ctrl means ⌘),
and drops a suggestion that clashes with jbrow's own keys or another command's. It matches key
presses in the panel and side panel against the active tab's profile and sends `onCommand` with
that tab. Key presses in jbrow's other windows (action popups, pop-outs, popups pages open) match
against that window's profile; a popup's commands act on the tab it opened for, the others' on the
active tab. Chrome would pass a pop-out its own tab instead, which is rarely what the command wants.
`_execute_action` opens the popup. Commands marked `global` go through `globalShortcut`.

**`src/main/idle.ts`** implements `chrome.idle` with Electron's `powerMonitor`. Electron 44
exposes Chromium's own `chrome.idle` too (its `queryState` works); jbrow's replaces it so both the
query and `onStateChanged` come from the same reading. While an extension with the `idle` permission
is loaded, jbrow checks every second against that extension's detection interval (60 s unless it
sets one, at least 15 s) and sends `active`, `idle` or `locked` when the state changes.

**`src/main/side-panel.ts`** implements `chrome.sidePanel`: `setOptions` and `getOptions` (global
or per tab), `setPanelBehavior` and `getPanelBehavior`, `open`, `close`, `onOpened`, `onClosed`, and
the manifest's `side_panel.default_path`. The panel is a page of the extension's profile to the
right of the tab, under a header drawn by jbrow's UI. `openPanelOnActionClick` makes the
extension's button toggle the panel instead of opening its popup, and the button's right-click menu
gets **Open side panel**, as in Chrome. Global options and the button behavior are kept in
`side-panel.json`; which panels are open is not, as in Chrome.

**`src/main/user-scripts.ts`** and **`src/preload/user-scripts.ts`** implement `chrome.userScripts`:
`register`, `update`, `unregister`, `getScripts`, `configureWorld`, `getWorldConfigurations`,
`resetWorldConfiguration` and `execute`, with Chrome's checks (duplicate IDs, IDs starting with
`_`, bad match patterns, missing files). Registrations are kept in `user-scripts.json`. A preload in
every page asks for the page's scripts before any of the page's own scripts run and runs them at
`document_start` (as soon as the page has its root element), `document_end` or `document_idle`, in
the extension's USER_SCRIPT world (isolated from the page, one per `worldId`) or in the page's
MAIN world. `matches`, `excludeMatches`, `includeGlobs` and `excludeGlobs` apply, and scripts only
run on sites the extension has host permissions for. A world configured with `messaging: true`
gets `chrome.runtime.sendMessage`, delivered to `runtime.onUserScriptMessage` with its answer. A
page's CSP doesn't stop either world.

These are worth sending upstream to electron-browser-shell once they've proven themselves.

## Known gaps

- HTTP sign-in (basic or digest auth) works in action popups, pop-out windows and options pages, but
  not for requests from a service worker, which has no page to show the form in.
- Escape doesn't close an extension's popup as in Chrome: jbrow sees keys before the page does, so
  it can't tell whether the popup used Escape itself. Click away or press ⌘W.
- ⌘W in a pop-out whose page holds you back with "unsaved changes" leaves the window open without
  asking. In a side panel, reload, zoom and DevTools keys act on the tab, not the panel's page.
- In popups and pop-outs only jbrow's close, reload, zoom, DevTools, new tab and settings keys work;
  ⌘L, ⌘F, back, forward, print and ⌘1–9 go to the page. The HTTP sign-in sheet takes no shortcuts.
- User scripts with `allFrames` reach frames inside a page only in the MAIN world, and only once
  the frame has loaded: frames get no preload, so USER_SCRIPT-world scripts don't run there at all.
- User scripts get `chrome.runtime.sendMessage` but not `connect`. A world's `csp` from
  `configureWorld` is handed to Electron but hasn't been tested.
- jbrow doesn't ask you to **Allow user scripts** per extension, as Chrome does; the permission is enough.
- `chrome.sidePanel.open` doesn't need a click first, as it does in Chrome. Side panel pages count
  as POPUP in `runtime.getContexts`, not SIDE_PANEL.
- While a popover or the suggestions cover the page, an open side panel shows dimmed under them.
- Static rulesets are turned on from the extension's service worker, so an extension that has rulesets
  but no service worker keeps them off.
- Extension service workers stop after about 30 seconds idle and wake on events, as in Chrome.
