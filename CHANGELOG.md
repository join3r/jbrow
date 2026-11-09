# Changelog

## Unreleased

- Security updates: Electron 44.10.2 (Chromium security fixes, and a block on the compromised
  eMudhra intermediate certificates), and adm-zip 0.6.1 for extensions from the Chrome Web Store.
- A page that fails to load says what went wrong, with Try again, instead of a white tab.
- Sites on your local network (Home Assistant, a router, a printer) load again: macOS now asks to
  let jbrow reach them. If you turned it off, the error page opens System Settings → Local Network.
- Open files and folders on your computer: type a path in the address bar (/Users/…, ~/Downloads)
  or pick files with File → Open File… (⌘O). A folder opens as a list of what's in it; click to go
  in, ⌘-click to open in a new tab.
- Always open a site in a profile from the address bar: the lock's menu has a row of profiles for
  the page's domain, and ⌥Return opens what you typed and keeps its domain in the profile it opens
  in. A pin after the profile's name shows a page is there by its site.
- Sites open sooner: jbrow connects ahead to the site the address bar completes to or you
  highlight, to the search engine as the address bar opens, and to a sleeping tab under the pointer.
  Never to private addresses; turn it off under Settings → Address bar → Connect ahead.
- Load ahead: while you type, the site the address bar completes to from your history loads in a
  hidden page, and Return shows it at once, with Back where it was. Never for private addresses or
  a page you've typed into; turn it off under Settings → Address bar.
- The address bar keeps the keyboard and what you typed when a page navigates on its own, in front
  or in a background tab, or a permission prompt comes up.
- The mini player moves to another corner when you switch to a window it covers out of the box.
- The welcome's Tabs step shows an old YouTube tab filing itself into the YouTube folder instead of
  archiving.

## 0.2.0

- Import from Chrome, Arc, Brave, Edge, Vivaldi, Chromium, Safari or Firefox: history, bookmarks,
  Arc's sidebar and, from the Chromium browsers on the Mac, site logins (cookies). Passwords stay in
  your password manager.
- A History page with trails, filters and search in the text of pages you visited. Pages you told
  it to forget stay forgotten, and private addresses show as Private. Delete on a highlighted
  history suggestion forgets it. A History button sits in the sidebar footer beside the pin.
- Drag a tab onto another in the sidebar to split them. Links get Open in background tab and Open
  in split view in their context menu.
- Hide the sidebar (⌘S) to give the page its room; pointing at the window's left edge slides it in.
- Start at login, in Settings → General.
- The mini player stays above the jbrow window and can move to another corner when it's in the way
  of a window you switch to.
- The welcome offers a YouTube folder in Kept that catches videos before they're archived.
- Split view: a pane's address suggestions cover its whole bar and stay inside the window.

## 0.1.1

- jbrow for Windows (x64 installer) and Linux (x64 AppImage and .deb). Keys that say ⌘ on the Mac
  are Ctrl there. ⌥⇧Space's tabs of the app you were in, opening links from each app in a profile of
  their own, and trackpad swipes need macOS and aren't on Windows and Linux yet.

## 0.1.0

The first public release. jbrow is a Chromium browser for macOS that stays out of the way until you
call it.

- Pinned, it's a regular window. Unpinned, it has no window: ⌥Space brings it up over whatever
  you're doing and clicking into another app sends it away. ⌥⇧Space shows only the tabs of the app
  you were in.
- A sidebar of tabs with pinned icons, Kept (with folders and auto-file rules) and Today. Unseen
  tabs fall asleep after 3 days and are archived after a week, with Undo and a searchable archive.
- Profiles with their own logins, cookies and extensions, each with a color. Tab in the address bar
  switches the profile what you type opens in, and links from each app can open in a profile of
  their own.
- Split view with up to 4 tabs side by side.
- Address bar suggestions from open tabs, your history, archived tabs and the search engine, and
  completion of sites you visit or popular ones.
- Extensions from the Chrome Web Store or a folder, with toolbar pinning, side panels, user scripts
  and keyboard shortcuts.
- Quiet links: links that arrive without a click open in the background, muted.
- Warnings before phishing and malware sites, checked on your Mac against downloaded lists.
- Restyling sites with Claude Code or Codex, if you turn it on.
- Downloads, PDFs, printing, find in page, zoom per site, trackpad swipe navigation, and USB, HID,
  serial and Bluetooth device choosers.
- A welcome that sets up the main choices on first launch.
- Updates itself from GitHub Releases.
