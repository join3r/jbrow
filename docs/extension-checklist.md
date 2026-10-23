# Extension checklist

Your must-have extensions, tested in jbrow's Personal profile. "Automated" is what I could check
from the command line on 2026-10-22. "By hand" is what only real use can tell.

Install them all into a profile with `npm start -- --install-extensions=personal` (or `work`), or
from the jb menu bar item: right-click, **Install test extensions**.

| Extension | Automated result | Test by hand |
|---|---|---|
| **D.Bridge 2** | Native messaging works: the page handshake reaches D.Launcher's host (`dBridge2Nm`), which starts and answers. | Sign something on slovensko.sk with your eID. |
| **uBlock Origin Lite** | Service worker runs with 6 rulesets enabled (uBlock filters, EasyList, EasyPrivacy, Peter Lowe's, badware, URLhaus). Trackers are blocked; Google ad and analytics scripts are replaced with uBlock's harmless stand-ins, as in Chrome. | Browse a news site. Check that the popup opens and the per-site toggle works. |
| **Bitwarden** | Installs; service worker runs; every API it asks for is present. | Unlock, fill a login, save a new login, use a passkey, copy a password. Desktop-app unlock goes through native messaging (`com.8bit.bitwarden`), which the D.Bridge test shows working. |
| **SponsorBlock** | Service worker runs. It crashed before the fixes below. | Watch a YouTube video with a known sponsor segment. |
| **Enhancer for YouTube** | Service worker runs. | Open YouTube and use its controls. Its commands have no keys until you assign them under Settings → Extension shortcuts. |
| **Video Speed Controller** | Works: S and D change the speed on YouTube. It did nothing until the content script shim below. | Change the speed with its in-page keys (S and D). |
| **Consent-O-Matic** | Service worker runs; opened its welcome page on first install. | Visit a few sites with cookie banners. |
| **Canvas Blocker** | Service worker runs. Electron warns that `notifications` and `contextMenus` are unknown permissions, but the library provides both. | Check a canvas fingerprinting test page. |
| **SideHN** | Service worker runs. One error: a `declarativeNetRequest` rule that rewrites request headers (`modifyHeaders`) throws "Method not implemented". | Open a page that's on HN. The sidebar should show; the logged-in view probably won't. |
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

**`src/preload/extension-shims.ts`** runs in every extension context before the library:

1. `browser` now points at `chrome`. Chromium has its own `browser` object without the library's
   APIs, and uBlock Origin Lite prefers `browser`. This was why it crashed.
2. `chrome.storage.sync` and `managed` map to local storage. Settings don't sync to your Chrome.
3. `chrome.alarms`, which Electron doesn't have, is implemented on timers.
4. `chrome.runtime.getContexts` lists extension pages in jbrow's own windows (action popups,
   pop-out windows). Electron leaves them out ("Unexpected view type found: 0" in the log), so
   Bitwarden thought nothing of it was open or focused, and its vault timeout could lock or log
   out while you were signing in through the pop-out.

**`src/main/content-shim.ts`** covers content scripts, which no preload reaches. Their
`chrome.storage` has no `sync` area either ('"sync" is not available in this instance of Chrome'),
so Video Speed Controller never got its settings and never attached to videos. Before an extension
from the Web Store loads, jbrow writes `jbrow-content-shim.js` into its folder and lists it first in
each isolated-world content script, pointing `sync` and `managed` at local storage. Updates get it
too. Unpacked folders such as Stem are left alone, since they're your own source.

**`src/main/commands.ts`** implements `chrome.commands`. The library reads a manifest's commands
but leaves every shortcut empty and never fires `onCommand`. jbrow takes your shortcut from
settings, or else the manifest's `suggested_key` (`mac`, then `default`, where Ctrl means ⌘),
and drops a suggestion that clashes with jbrow's own keys or another command's. It matches key
presses in the panel against the active tab's profile and sends `onCommand` with that tab.
`_execute_action` opens the popup. Commands marked `global` go through `globalShortcut`.

These are worth sending upstream to electron-browser-shell once they've proven themselves.

## Known gaps

- Extension shortcuts work only while jbrow's panel has focus, not inside an extension's popup or pop-out window.
- `chrome.sidePanel`, `chrome.idle` and `chrome.userScripts` are missing.
- `declarativeNetRequest` header rewriting (`modifyHeaders`) fails.
- Extension service workers stop after about 30 seconds idle and wake on events, as in Chrome.
