# jbrow

A browser that isn't there until you call it. Unpin it and it has no window: a hotkey brings it up
over whatever you're doing, and clicking into another app sends it away. It starts pinned, as a
regular window with a Dock icon, so the first launch looks like any other browser. Underneath it's
Chromium (through Electron), with profiles, Chrome Web Store extensions and a sidebar of tabs.

## Download and install

Download the DMG from [the latest release](https://github.com/join3r/jbrow/releases/latest), open it
and drag `jbrow.app` into Applications. Then open jbrow from Applications.

jbrow updates itself. It checks GitHub Releases 30 seconds after launch and every 4 hours, and
downloads a newer release in the background. A downloaded update installs when you quit jbrow.
Without a quit, it installs on its own once nobody would notice: jbrow has been hidden for 10
minutes and the Mac untouched for 2, or jbrow is showing and the Mac has been untouched for 30, with
nothing downloading, playing sound or in picture-in-picture and no question on screen. jbrow then
restarts and comes back as it was, hidden or showing, with its tabs.

**Updates** under **General** in settings shows the version, says where an update stands and has
**Check now** or **Restart to update**. Turn **Update jbrow on its own** off there to check only
when you ask. The menu bar item has **Restart to update to 0.2.1** once one is ready, and the app
menu has **Check for Updates…**.

## Requirements

- A Mac with Apple Silicon (M1 or later). Releases are built for arm64 only.
- macOS 13 Ventura or later.

## First run

The first launch opens with a welcome over the whole window. It shows what jbrow does and asks what
matters most from the start: whether jbrow stays **pinned** (a regular window, as it starts) or turns
**ethereal** (no window until its key, gone on click-away), the two keys and the animation, the look,
profiles and which profile apps' links open in, sleeping and archiving tabs, quiet links, the search
engine and privacy switches. A little Mac on the first steps acts out pinned and ethereal. Each choice
applies right away, except pinning, which waits for **Start browsing** so the window doesn't start
hiding halfway through. **Skip and keep the defaults** leaves everything as it is.

The welcome shows until it's been through or skipped once (`welcomed` in `settings.json`). Bring it
back any time with **Help → Welcome to jbrow**, the menu bar item's **Welcome to jbrow** or **Show
the welcome** under **General** in settings. Then Esc closes it.

⌥Space shows and hides jbrow. Raycast and Alfred may already use ⌥Space; if another app has it,
jbrow shows a notification. Pick another key under **Shortcuts** in settings, which takes effect
right away.

A fresh install has one profile, **Personal**, with no app rules and no linked apps. Add profiles
under **Profiles** in settings and send apps' links to them under **Apps**: for example a Work
profile that Slack and Teams open their links in, with VS Code and Terminal linked so they share
one set of tabs for ⌥⇧Space.

## Using jbrow

Under **Default browser** in settings, **Make jbrow the default browser** asks macOS to switch. From
then on, links from other apps open in jbrow, which comes up on them. Each link opens in the
profile set for its app under **Apps**, otherwise in the default profile, and lands in that app's
section of the sidebar. HTML files opened with jbrow work the same way.

Links you didn't click open quietly. If a link arrives with no click or key press in the last 2
seconds (a script, a build tool, an app opening something on its own), jbrow doesn't come up: the
tab opens in the background, muted, with a dot in the sidebar, and the menu bar item counts them
(`jb •2`). Right-click the menu bar item for **Show quiet links**, or just look at them; viewing a
tab clears its dot and unmutes it. Links that arrive while jbrow is up, or that launch it, open
as usual. Turn this off with **Quiet links** under **General** in settings.

If jbrow disappears a few seconds after you hide it, something is quitting apps that have no
open windows, which is jbrow's normal state. Utilities that quit idle apps do this, Vorssaint for
one. Add jbrow to the utility's exceptions. The log shows `[jbrow] quitting` when it happens.

Unpinned, jbrow runs from the menu bar (**jb**) with no Dock icon. Quit it from the menu bar item's
right-click menu or with ⌘Q. While downloads are running or paused, ⌘Q and the
menu bar item's **Quit jbrow** and **Restart jbrow** ask first (**Quit jbrow? 2 downloads are in
progress and will be cancelled.**), bringing jbrow up if it's hidden. Quits from outside jbrow don't
ask, since nobody may be there to answer: `kill`, macOS logging out
or shutting down, the Dock icon's Quit, or a utility that quits idle apps.

While jbrow's window is in front, the macOS menu bar has jbrow's menus (File, Edit, View, History,
Window, Help) with its commands and your keys for them.

These are the defaults; change any of them under **Shortcuts** in settings. ⌘1–9 and zoom stay fixed.

| Key | Does |
|---|---|
| ⌥Space | Show or hide jbrow with every tab |
| ⌥⇧Space | Show only the tabs of the app you were in |
| ⌘T / ⇧⌘N | New tab / new tab in the next profile |
| Tab | In the address bar: switch the profile what you type opens in |
| ⌘1–9 | Jump to a tab |
| ⌃Tab | Previous tab |
| ⌘W | Close tab, or settings while it's showing |
| ⌘D | Split view: a new tab beside this one (again for up to 4) |
| ⌃⌘← / ⌃⌘→ | Focus the pane on the left / right of a split |
| ⌘R / ⇧⌘R | Reload / reload without the cache (or ⇧-click the reload button) |
| ⇧⌘T | Reopen the last closed tab (again for the one before) |
| ⌘F | Find in page (Return / ⌘G next, ⇧Return / ⇧⌘G previous, Esc closes) |
| ⌘P | Print, or Save as PDF from the print dialog |
| ⌘L | Address bar |
| ⇧⌘P | Pin: a regular window with a Dock icon, which stays put when you click elsewhere |
| ⌘, | Settings |
| ⌥⌘I | DevTools for the page |

Swipe two fingers left or right on the trackpad to go back or forward, as in Chrome: an arrow
slides in from the edge and fills in once letting go will navigate. A swipe only navigates when
nothing under the pointer can scroll further that way, so carousels, maps and wide tables scroll as
usual (swipe again at their edge to navigate), and not over an iframe. jbrow follows macOS's
**Swipe between pages** setting (Trackpad → More Gestures): two fingers, three fingers, both or
off.

Drag the window's edges to resize it and its top edge or the row above the tabs to move it. jbrow keeps both in settings.json,
so the window comes back the same after a restart. Unpinned, it keeps a size and place for each
display and comes up on the display the pointer is on; pinned, it comes back where you left it, like
any window. **Reset size and position** under **General** in settings goes back to the default, 72% by
78% of the screen, centered.

Showing and hiding animate the whole window with the live page in it: it moves, grows and fades
(the style, duration and feel are under **Animation** in settings), and a playing video keeps playing
through it. A native page can't be scaled without laying itself out again, so scale and materialize
grow the window's edges around content that already has its final size instead of shrinking the
content. Materialize also blurs the UI and, with a stylesheet that's gone once the window is in place,
the page.

**Whimsy**, also under **Animation** and off until you turn it on, adds some play to the sidebar: new
tabs pop in, closed ones vanish in a puff, rows glide to their new places, the tab you switch to hops,
and finished downloads throw confetti. Reduce motion in macOS turns it off.


The profile filter at the top of the sidebar shows each profile's color, the same color as the bar
on its tabs. A new tab says which profile it opens in and lets you switch; right-click **+** for a
new tab in a specific profile.

The address bar is the top of the page's card: back, reload, the profile, the lock, the address
(its site bright, the rest dimmed), the wand and the profile's pinned extensions. It takes the page's
color, so bar and page read as one: the color across the top of the page when that's a single color,
else the page's theme-color, else jbrow's own. While you type it turns jbrow's own again, so what you
type never looks like part of the page. ⌘F finds in the page right there, in place of the address. The
window-wide buttons (downloads, sound, pin and settings) sit at the foot of the sidebar.

While you type in the address bar, Tab (⇧Tab goes back) switches the profile the address opens in; the
profile in the address bar changes to match, and the foot of the suggestions says which profile Tab goes to next. On a new tab the tab itself moves over. On a tab with a page,
the page stays where it is and what you typed opens in a new tab in the chosen profile.

Click the profile's name in the address bar to move the tab itself to another profile: the page loads
again there, with that profile's logins and cookies, and keeps its back and forward. With two
profiles it goes to the other one; with more, a menu lists them by color and name. Clicking it while
you type does what Tab does.

The address bar suggests, as you type, matching open tabs, pages from your history, archived tabs
and the search engine's suggestions. History is per profile, so it follows the profile what you type
opens in (Tab switches it, and the suggestions change with it). Pages whose site starts with what you
typed come first, then by frecency: how often you visit and how recently. Pages already open in a tab
show only as that tab. Typing the start of a site you visit completes it in place, as in Chrome: `git`
becomes `github.com` with `hub.com` selected, so Return goes there, typing on replaces it and
Backspace removes it. It doesn't complete while an open tab matches what you typed, so Return still
switches to the tab you're naming. Sites you haven't been to complete too, from a list of popular
sites worldwide and in Slovakia that ships with jbrow (`youtu` becomes `youtube.com`), but your
history always comes first. Three letters only complete to one of the top thousand sites; four or
more to any on the list. The list comes from the Chrome UX Report and Tranco, with adult sites left
out. Arrow to a history row and press ⇧Delete (or click its × on hover)
to remove it from the history. Private addresses show as **Private** in the suggestions and are never
completed. History is kept in `visits.json` next to `settings.json`: the address, title, number of
visits and last visit of each page, up to 5000 pages per profile, forgotten after 90 days.

Search suggestions come from the search engine you pick under **General** in settings (Google,
DuckDuckGo, Bing, Brave, Kagi, Ecosia, or a custom address with `%s`; a custom one gets no
suggestions). They're fetched without cookies, a moment after you stop typing. Because what you type
goes to the search engine, nothing that looks like an address (a dot before a domain, a port, a path,
a scheme) or matches a private address pattern is sent. Turn them off under **General**.

The sidebar is a flat list of tabs, as in Arc: pinned icons at the top, then Kept, then Today. New
tabs go to the top of Today, newest first (or to the bottom, oldest first, with **Tabs → New tabs → Open
at** in settings or in the welcome). A tab opened from a page (a link opened in a new tab, ⌘-click,
a script's `window.open`) is a tab of its own right beside the one it came from: above it with new tabs
at the top, below it with new tabs at the bottom. Several opened from the same tab line up in the order
they opened. Popups a page asks for with a size (a sign-in, a payment, a Proxmox console) are tabs
too; one that closes itself closes its tab and takes you back to the page that opened it. A kept or pinned tab stays as it was and never collects the tabs opened from it: those go
where new tabs go. When a new tab lands outside what the sidebar shows, the sidebar scrolls to it.

Tabs opened from an app with ⌥⇧Space get their own section in the sidebar, under the app's name and
icon (linked apps share one), and tabs opened from those go to the top of the same section. Kept tabs
stay in Kept.

Pinned tabs sit at the top of the sidebar as icons only. Right-click a tab → **Pin to top**, or drag
it onto the icons. They share one row and get smaller as you pin more; drag the line under them down
for another row (double-click it for one row again). Drag the icons to reorder them, or drag one into
the list to unpin it. Pinned tabs count as kept, so they never archive; they show whichever app the
sidebar is narrowed to, and ⌘1–9 reach them first. Their pages load when jbrow starts and stay loaded,
while kept tabs unseen for the **Summarize** time unload theirs (keeping their full row). Switch
either under **Tabs** → **Keep loaded** in settings (`keepLoaded` in `settings.json`).

Kept and pinned tabs remember the page they were kept on, as Arc's pinned tabs do. Once one goes
somewhere else, its row shows a slash before the title, and its favicon turns into an arrow on hover:
click it to go back to the pinned page. A pinned icon goes back when you click it while you're on it.
Right-click for **Back to pinned page**, or **Pin this page here** to keep the tab on the page it's on
now. ⌘W (or the row's ×) on a kept or pinned tab closes only its page: the tab stays where you put
it, back on its pinned page for when you next open it, and focus moves to a tab outside Kept. To
take it out of the sidebar, right-click it → **Delete**. A kept tab whose page is closed and back
on its pinned page has no ×.

Right-click a tab to rename it, pin it, keep it, move it to a folder, open it in another profile, copy its
link, close it or, for a kept tab, delete it. Its close
button shows on hover. ⇧⌘T, or right-click **+** → **Reopen closed tab**, brings back the last 25
closed tabs one by one, in their old place with their back/forward history. The list is kept only until jbrow quits.

**Split view** shows up to 4 tabs side by side, as in Arc. ⌘D opens a new tab to the right of the one
you're on, in its profile, and puts you in the address bar. As in Arc, a split is one row in the
sidebar, its tabs side by side, where the first of them comes: ⌘D on a kept tab keeps the new tab
right after it, so the split stays in Kept, while on a pinned tab the pinned icon stays and the new tab
goes to the top of Today. To split with a
tab you already have, right-click it and choose **Open in split view**. Drag the gap between two
panes to resize them. Each pane has its own address bar on top of its page, with back, reload, its
profile, the address and the pinned extensions of its profile, so two panes in different profiles show
each their own; the × at its end takes the pane out of the split. Click another pane's address to type
there, or its puzzle for its extensions. In a narrow pane the bar folds: reload, the profile's name, the
rest of the address and all but one extension go, and the puzzle still lists them. The focused pane has a
thin ring, and your keys (reload, find, zoom, ⌘L, DevTools) act on it; click a pane or use ⌃⌘←/→ to focus another. A tab whose split partners
show elsewhere (a pinned icon, or a profile filtered out) has a split icon instead (hover it to see the
other tabs), and the panes on screen besides the focused one are lightly highlighted. Opening any of them shows the whole split with that one focused.
⌘W closes the focused pane, and the tab left alone fills the page area again. Right-click a tab in a
split for **Separate tabs**, or **Take out of split view** with 3 or more. Splits are saved with your
tabs; archiving or closing a tab takes it out of its split.

A page with unsaved changes asks before it goes, as in Chrome: closing its tab (⌘W, the close
button, the tab's menu) or going elsewhere asks **Leave site?**, and reloading asks **Reload site?**.
Pages only get to ask once you've clicked or typed in them. Tabs jbrow closes on its own, many at
once, don't ask: tabs falling asleep or being archived, deleting a profile, quitting. A page that
asks while jbrow is hidden stays where it is.

Right-click a page for **Print…** and **Save as PDF…** (saved to ~/Downloads by default). The same menu
opens a link in a new tab, in the background or in another profile, saves or copies a link, image or
video, copies an image, searches for or looks up selected text, and offers spelling suggestions in text
fields (or **Add to dictionary**).

PDFs open in Chromium's PDF viewer, from the web or from your Mac; a PDF sent as an attachment or
linked with `download` downloads instead, as in Chrome. The address bar shows the PDF's own address.
The viewer's download button saves the file into ~/Downloads, its print button and ⌘P print it, and ⌘F
finds text in it (the file name in the viewer's toolbar counts as a match too). On a PDF the page menu
has **Save PDF** in place of **Save as PDF…**, which saves the file itself, or **Show in Finder** for a
PDF on your Mac.

A site that asks for a USB, HID or serial device (WebUSB, WebHID, Web Serial) or a Bluetooth device (Web
Bluetooth) gets a chooser under the address bar: "*site* wants to connect to a USB device", with the
devices the Mac has. Devices plugged in or out while it's open come and go, and Bluetooth devices
appear as they're found. Click one to connect it; the site sees that device and no other. Esc, the
close button or a click anywhere else cancels, and the page's request fails. The chooser belongs to its
tab: switching tabs hides it until you're back, and leaving the page closes it. A USB, HID or serial
device with a serial number stays allowed for that site in that profile, in `permissions.json`, until
**Reset site permissions** in the page menu or the site calls `forget()`; one without a serial number
is allowed until jbrow quits, so a second one of its kind isn't allowed too. Bluetooth devices are
allowed for the page only. Extension pages get no chooser. Bluetooth, and
Web Serial (which also lists Bluetooth serial ports), need macOS's Bluetooth permission: the first time,
macOS asks whether jbrow may use Bluetooth, and jbrow waits for the answer.

Tabs keep their back and forward history (the last 50 pages) across restarts, sleep and archiving, in
`history.json` next to `tabs.json`, along with each page's scroll position and form contents.

A video or page that goes fullscreen fills the whole display jbrow is on, menu bar and Dock included,
without a Space of its own. For the first 4 seconds a notice above the page names the site and says
Press Esc to exit, so a page can't pass itself off as macOS. Esc, hiding jbrow or switching tabs brings it
back into the panel.

⌘+, ⌘− and ⌘0 zoom in Chrome's steps (90%, 100%, 110%, 125%…), every tab of a site together. Under
**Appearance** in settings, pick the default zoom for sites you haven't zoomed and whether each site's
zoom is remembered across restarts (on by default, kept in `zoom` in `settings.json`); zoomed sites are
listed there with **Reset**.

A site that asks for a username and password (HTTP basic or digest auth) gets a sign-in form in the
page area. Pages outside tabs get the same form on top of them, in their own window: an extension's
popup (which grows to fit the form and shrinks back after) and extension pop-out windows. Extension options pages open as tabs and use the tab's form. A page with
no window on screen gets a small **Sign in** window of its own; closing it cancels. Cancel or Esc
fails the request, as before. jbrow doesn't store the password; Chromium remembers it until jbrow
quits, and other pages waiting on the same site get the same answer. If a page
crashes, or macOS kills it to free memory, the page area says so and offers **Reload** (or ⌘R), and
the tab is greyed out in the sidebar. A page that hangs gets **Wait** and **Reload**.

A page that came over plain http has a red warning icon left of the address; click it for why that
matters. The same icon, or the lock on https pages, has **Clear cookies and site data**, which signs
you out of that site in that profile (cookies of its parent domain and subdomains included) and
reloads the page.

jbrow warns before a tab opens a site known for phishing or malware: the page doesn't load, and
**Deceptive site ahead** or **Dangerous site ahead** takes its place, with **Back to safety** and,
under Details, a way past it until jbrow quits. Redirects are checked too. The lists are
malware-filter's phishing and malware hosts (built from OpenPhish, PhishTank and URLhaus, with popular
sites left out), downloaded every 12 hours into `blocklists/` next to `settings.json`; the addresses
you visit never leave your Mac. Downloads and pages inside frames aren't checked. Turn it off under
**Privacy** in settings, which also shows how big the lists are and when they last updated.

Kept is the top of the sidebar, above Today. Drag a tab there (or onto the line under it) to
keep it, and onto Today's heading or a tab outside Kept to stop keeping it. Drag kept tabs and folders
up and down to arrange them: a line shows where they'll go, and tabs can sit above folders. Kept can
hold folders: right-click the sidebar away from a tab for **New folder**, or use **Move to folder →
New folder** on a tab. Drag tabs or other folders onto the middle of a folder to put them inside it,
click it to fold it away, and right-click it to rename, delete (its tabs stay kept) or set its
**auto-file rules**. A tab about to be archived moves into the first folder whose rules match its
address instead of being archived. Rules are patterns like the private addresses ones.

Tabs unseen for 3 days fall asleep: their pages unload and the sidebar shows them with a line
saying which site and how long ago. Clicking one loads it again. A page that's playing sound stays
loaded, and kept tabs never sleep.

Tabs unseen for a week are archived (change both under **Tabs** in settings, or turn them off): their
pages close and they leave the sidebar. The bottom of the sidebar then says **Archived 3 tabs** with
**Undo**, which puts exactly those tabs back where they were (same place and app section, back and
forward included) and gives them the full time again before archiving. Archiving that happens
while jbrow is hidden shows the notice the next time you open it; it goes away when you hide jbrow after
it's been on screen for a few seconds at a time, or with its ×.

The **N archived** line at the very bottom of the sidebar opens **Archived** in settings: every
archived tab with its site and when it was archived, newest first under Today, Yesterday, This
week and then by month, and on hover **Restore** (back into the sidebar as seen now) and **Forget**.
The search above it finds tabs by name, title or address (every word has to match), and next to
it you can narrow the list by site, by when it was archived (today, the last 7 or 30 days, older, or
between two dates) and by profile. Just type, or press ⌘F, to search; ↑↓ move through the list and
Return (or a double-click) opens a tab. Select tabs with the box by each one, ⌘-click, Space or
⇧↑↓ (⇧-click selects a run, the box at the top everything that matches, ⌘A too) to **Restore** or
**Forget** them together. Forgetting more than one asks first, and so does restoring more than 10.
Long lists show more as you scroll. Typing in the address bar finds archived tabs too and brings them
back. Archived tabs are forgotten after 90 days.


Downloads go straight into ~/Downloads, renamed `name (1).ext` if the name is taken. Each one shows
as a small pie at the foot of the sidebar while it runs. Click it for the name, size, speed, time left, folder and
source, and to pause, resume or cancel it. A finished download turns into a check; open its details
to open the file or show it in Finder. Apps, installers and scripts only get Show in Finder, and every
download is quarantined, so Gatekeeper checks it as it would one from Safari or Chrome. A page that starts a
second download asks first, as in Chrome, and while jbrow is hidden it's simply blocked. Finished downloads leave the sidebar when jbrow hides or when you
close their details, and if one finishes while jbrow is hidden, you get a notification. A link that opens
a new tab only to start a download closes that tab again.

## Restyling sites with Claude

Restyling is off until you turn on **Restyle sites** under **Restyling** in settings, which you can
only do with Claude Code or Codex installed (jbrow looks for them each time settings opens). Then the
wand icon in the address bar restyles the site you're on; it's hidden while restyling is off or the agent
you picked isn't installed. Turned off, saved styles stop applying until you turn it on again. Type how it should look ("dark theme",
"hide the sidebar", "wider text column, bigger font") and press Return. jbrow sends Claude a
screenshot of the page, an outline of its DOM, the colors and fonts on screen and the site's
stylesheet so far, and inserts the stylesheet Claude settles on into every page of that site (the
hostname, without www) from the moment each starts loading. Claude works on the live page with three
tools jbrow serves it over a local MCP server: **inspect** (what selectors match, with computed
colors, contrast, fonts, spacing and position), **outline** (any part of the DOM in detail) and
**preview** (puts a stylesheet on the page and returns a screenshot, or a full-resolution close-up,
plus selectors that match nothing, text with too little contrast, bars now over a video or image and
sideways scrolling). It previews, critiques and fixes until it's happy, usually two to four times,
so you see the page change while it works. Codex, if you pick it in settings, works the same way
with the same tools. Ask
again to refine it; each request builds on the last. The wand turns
teal on a restyled site and pulses while Claude works, and the note on what changed shows at the
bottom of the sidebar. The wand's popover lists what you asked for and has **Undo last change**,
**Show the original** and **Remove all changes**. Settings lists every restyled site.

It runs Claude Code's `claude -p` with your Claude subscription, so install Claude Code and sign in
first (`claude`, then `/login`). jbrow finds `claude` in `~/.local/bin`, `/opt/homebrew/bin`,
`/usr/local/bin` or your login shell's PATH; set `restyle.claudePath` otherwise. Each run has no
tools but jbrow's, and no settings, CLAUDE.md, plugins or MCP servers of yours, and jbrow leaves `ANTHROPIC_API_KEY` out of its
environment so it can't bill an API key instead. Because page text reaches Claude, a page could try
to talk it into CSS that sends what you type elsewhere (`input[value^=a] { background: url(…) }`),
so jbrow removes every `url()`, `image-set()` and `@import` that isn't a `data:` URL before using a
stylesheet, and says so when it does. Chromium parses the stylesheet first (in a blank page with no
network), and jbrow checks and inserts Chromium's own serialization of it, so escapes and odd line
endings can't hide a reference from the check. Pick the model under **Restyling** in settings;
a request takes about 15 to 60 seconds. Styles are kept in `styles.json` next to `settings.json`.

## Settings

The settings screen (⌘, or the sliders icon) has a sidebar of sections: **General** (pinning and the window's size, search engine and
search suggestions, quiet links, the default browser), **Profiles**, **Tabs** (archiving), **Archived**, **Apps**, **Animation**, **Restyling**,
**Privacy** (private addresses, dangerous sites, clearing browsing data, screen sharing) and **Shortcuts** (jbrow's own and extensions').
The search above the sections finds any setting or shortcut, and **Shortcuts** has its own search.
Changes apply right away. Private addresses: any address that contains
one of your patterns (`*` matches anything, e.g. `*.corp.example`) shows as **Private** in the
address bar, the tab list tooltips and the address suggestions until you click the address bar.
Page titles still show.

**Browsing data** under **Privacy** clears history, cookies and site data, cached images and files, or
any mix of them, in one profile or all of them, after asking. Extensions keep their own data (Bitwarden stays signed in),
and tabs stay open. There's no time range: Electron can only clear everything.

Settings are stored in `~/Library/Application Support/jbrow/settings.json`, written with defaults
on first run. The menu bar item's **Open settings.json** opens it. Restart jbrow after editing the file by hand (menu bar item, **Restart jbrow**).

- `profiles`: names and colors. Each profile has its own logins, cookies and extensions. Manage them
  under **Profiles** in settings: rename one, change its color, add one, and right-click one to make
  it the default (`defaultProfile`, for links from other apps and for new tabs when nothing else
  decides) or delete it. Deleting closes its tabs and erases its logins, site data, extensions and
  site permissions.
- `appProfiles`: default profile per app bundle ID, for links from and new tabs in that app's view.
  Set it under **Apps** in settings.
- `linkedApps`: groups of bundle IDs that share one set of tabs for ⌥⇧Space. Under **Apps**,
  right-click an app to link or unlink it; its tabs move along right away.
- `animation`: `style` (materialize, slide, scale, fade, off), `durationMs`, `ease` (spring, snappy, smooth).
- `whimsy`: playful animations in the sidebar and toolbar (default `false`).
- `panel`: the window's default size as a fraction of the screen (`widthFraction`, `heightFraction`),
  where you left the unpinned window on each display (`displays`, by macOS display ID, relative to
  the display's usable area) and where you left the pinned one (`pinned`, in screen coordinates).
- `unpackedExtensions`: extension folders to load per profile, such as one you're writing.
- `pinned`: a regular window with a Dock icon that opens at launch and stays when you click away
  (on by default). The pin at the foot of the sidebar and ⇧⌘P switch it, and jbrow remembers.
- `quietLinks`: open links you didn't click in the background (on by default).
- `searchUrl`: the search engine's address, `%s` where the query goes. Pick one under **General**.
- `searchSuggestions`: ask the search engine for suggestions as you type (on by default).
- `hideFromScreenCapture`: keeps jbrow out of screen shares and screenshots (off by default; **Screen
  sharing** under **Privacy**). While it's on, private addresses don't matter for streaming: nobody
  sees jbrow at all.
- `privateUrls`: the private address patterns.
- `dangerousSites`: warn before opening sites on the phishing and malware lists (on by default).
- `pinnedExtensions`: IDs of extensions pinned to the toolbar.
- `shortcuts`: your keys for jbrow's own commands, e.g. `"newTab": "Command+Y"` (`""` removes one).
  Commands not listed use their defaults. Older settings files kept the summon keys under
  `hotkeys`; jbrow still reads those and writes them here the next time it saves settings.
- `extensionShortcuts`: your extension shortcuts per profile, extension and command (`""` removes one).
- `archiveAfterDays`: archive tabs unseen this many days; 0 turns archiving off.
- `zoom`: `defaultPercent`, `remember`, and `sites`, each zoomed site (hostname without www) with its zoom in percent.
- `sidePanelWidth`: width of an extension's side panel in pixels; dragging its edge sets it.
- `restyle`: `enabled`, whether restyling is on; `model` for restyling (a Claude model alias such as sonnet, opus or haiku) and
  `claudePath`, the claude command if jbrow doesn't find it on its own.

Tabs, folders and archived tabs are in `tabs.json` next to it, and the browsing history in `visits.json`.
Extensions' side panel options are in `side-panel.json` and their user scripts in `user-scripts.json`.

## Extensions

The puzzle icon lists the extensions of the current tab's profile. From there, **Add from folder…**
loads an unpacked extension into that profile and adds it to `unpackedExtensions` so it loads
again next launch (adding the same folder again reloads it), and **Chrome Web Store** opens the
store in that profile. Right-click an extension there and choose **Pin to toolbar** to keep its
button next to the puzzle icon (it shows whenever the current tab's profile has that extension);
right-click the pinned button to unpin it. Installed extensions update every 5 hours.

An extension with a side panel (`chrome.sidePanel`) shows it to the right of the page: right-click
its button and choose **Open side panel**, or just click the button if the extension asks for that,
as many do. Drag the gap left of the panel to resize it. Its header shows a close button on hover;
right-click the header to switch to another extension's panel, reload or inspect it. A panel the
extension opened for one tab stays with that tab; otherwise it shows next to every tab of that
profile until you close it.

A tab an extension opened, as automation extensions do, has that extension's icon faintly on its
favicon. While an extension works in a page (clicking and reading it through `chrome.debugger`), the
icon is solid with a ring in the profile's color, and that tab doesn't sleep or archive. Extensions also see the tabs
without a page (asleep, or not opened since launch) as Chrome's discarded tabs; one an extension
reaches for loads in the background.

Extensions can run user scripts (`chrome.userScripts`, for user script managers): scripts they
register run in matching pages and are kept across restarts. Chrome also wants you to switch on
**Allow user scripts** for each such extension; jbrow doesn't ask, the permission is enough.

Extension keyboard shortcuts are under **Shortcuts** in settings. They work while jbrow is
open, for the profile of the tab you're on, in an extension's side panel, and inside an extension's
popup or pop-out window. There they go to that window's profile and act on
the tab the popup opened for, or else the active tab. Shortcuts an extension suggests apply on their
own, except ones jbrow already uses. Click a shortcut to record a new one.

In a popup or pop-out window, your keys for **Close tab** (⌘W) close the window, **Reload** and
**Reload without the cache** reload its page, and **Developer tools for the page** opens its
DevTools; ⌘= / ⌘- / ⌘0 zoom it. **New tab**, **New tab in the next profile** and **Settings** bring
up jbrow and do what they do there. Every other key goes to the page.

See [docs/extension-checklist.md](docs/extension-checklist.md) for how common extensions fare and
what jbrow patches to make them work.

## Not built yet

- A username and password asked of an extension's service worker has no page to ask in; jbrow
  doesn't ask and the request fails.

## Privacy

jbrow has no telemetry, sends no crash reports and has no account. On its own, without you opening
a page, it contacts:

- **Your search engine's suggestion service**, with what you type in the address bar, a moment after
  you stop typing. Google by default. Nothing that looks like an address or matches a private
  address pattern is sent. Turn this off with **Suggest searches as you type** under **General**.
- **malware-filter.gitlab.io**, every 12 hours, to download the phishing and malware lists. The
  addresses you visit are checked on your Mac and never sent. Turn this off with **Dangerous
  sites** under **Privacy**.
- **GitHub Releases**, 30 seconds after launch and every 4 hours, to check for a new jbrow. Turn
  **Update jbrow on its own** off under **General** and it checks only when you click **Check now**.
- **The Chrome Web Store**, when you install an extension and every 5 hours to update the ones you
  have.

Favicons come from each site itself, through the tab's own profile, not from a favicon service.
Restyling sends the page to Claude Code or Codex, and only once you turn it on and ask.

To make the Chrome Web Store offer **Add to Chrome**, jbrow tells sites it's Chrome: its user agent
is Chrome's, with Electron's and jbrow's names taken out. Google sign-in is the one place it sends
Electron's own user agent, since Google refuses sign-in from a browser that claims to be Chrome and
isn't. jbrow isn't a Google product and isn't affiliated with Google.

Everything jbrow keeps is in `~/Library/Application Support/jbrow`: settings, tabs, history,
profiles with their cookies and logins, extensions and favicons. Its log is
`~/Library/Logs/jbrow/main.log`. Deleting the first folder resets jbrow.

## Reporting a bug

Open an issue on [GitHub Issues](https://github.com/join3r/jbrow/issues). **Report a Bug…** in the
menu bar item's right-click menu, or in the **Help** menu, opens a new one with the template. Say
which macOS and which jbrow (Settings → **General** → **Updates**) you have, what you did, and what
happened. Attach the log: **Show log file** in the menu bar item's right-click menu shows
`main.log` in Finder. The log can hold addresses you visited, so look through it first.

## License

jbrow is free software under the [GNU General Public License v3.0](https://www.gnu.org/licenses/gpl-3.0.html)
(GPL-3.0-only), as electron-chrome-extensions requires. The software it includes and the data it
ships with, and their licenses, are listed in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
