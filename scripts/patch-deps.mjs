// Fixes in node_modules that haven't landed upstream yet. Runs before every build, is safe to
// run twice, and fails the build if a library update changed the code these patches expect.
import { readFileSync, writeFileSync } from 'node:fs'

const patches = [
  {
    file: 'node_modules/electron-chrome-extensions/dist/cjs/index.js',
    why: 'native messaging: frame by byte length, not string length (breaks on non-ASCII, e.g. Slovak text in D.Bridge)',
    find: `    const buffer = Buffer.alloc(4 + message.length);
    buffer.writeUInt32LE(message.length, 0);
    buffer.write(message, 4);`,
    replace: `    const byteLength = Buffer.byteLength(message);
    const buffer = Buffer.alloc(4 + byteLength);
    buffer.writeUInt32LE(byteLength, 0);
    buffer.write(message, 4);`,
  },
  {
    file: 'node_modules/electron-chrome-extensions/dist/cjs/index.js',
    why: 'native messaging: buffer stdout so messages split across chunks, or several in one chunk, still parse',
    find: `    this.receive = (data) => {
      const length = data.readUInt32LE(0);
      const message = JSON.parse(data.subarray(4, 4 + length).toString());
      d7("receive: %s", message);
      if (this.keepAlive && this.sender) {
        this.sender.send(\`crx-native-msg-\${this.connectionId}\`, message);
      } else {
        this.resolveResponse?.(message);
      }
    };`,
    replace: `    this.receive = (data) => {
      this.inbox = this.inbox ? Buffer.concat([this.inbox, data]) : data;
      while (this.inbox.length >= 4) {
        const length = this.inbox.readUInt32LE(0);
        if (this.inbox.length < 4 + length) break;
        const message = JSON.parse(this.inbox.subarray(4, 4 + length).toString());
        this.inbox = this.inbox.subarray(4 + length);
        d7("receive: %s", message);
        if (this.keepAlive && this.sender) {
          this.sender.send(\`crx-native-msg-\${this.connectionId}\`, message);
        } else {
          this.resolveResponse?.(message);
        }
      }
    };`,
  },
  {
    file: 'node_modules/electron-chrome-extensions/dist/chrome-extension-api.preload.js',
    why: "don't freeze chrome: it breaks Chromium's lazily created APIs and extensions that attach helpers to it (SponsorBlock)",
    find: `      delete globalThis.electron;
      Object.freeze(chrome);`,
    replace: `      delete globalThis.electron;
      /* jbrow: chrome is left unfrozen, see scripts/patch-deps.mjs */`,
  },
  {
    file: 'node_modules/electron-chrome-extensions/dist/chrome-extension-api.preload.js',
    why: "lock each replaced API instead: Chromium re-creates its own runtime/tabs/storage later unless they can't be redefined",
    find: `        Object.defineProperty(chrome, apiName, {
          value: api.factory(baseApi),
          enumerable: true,
          configurable: true
        });`,
    replace: `        Object.defineProperty(chrome, apiName, {
          value: api.factory(baseApi),
          enumerable: true,
          configurable: false,
          writable: false
        });`,
  },
  {
    file: 'node_modules/electron-chrome-extensions/dist/chrome-extension-api.preload.js',
    why: "managed storage isn't local storage: Bitwarden applies whatever it finds there as policy (jbrow's shim makes it empty)",
    find: `              managed: local,
              sync: local`,
    replace: `              managed: base && base.managed,
              sync: local`,
  },
  ...['cjs/browser-action.js', 'esm/browser-action.mjs'].flatMap((file) => [
    {
      file: `node_modules/electron-chrome-extensions/dist/${file}`,
      why: "an extension button's per-tab icon, badge and title win over its defaults, as in Chrome (Bitwarden's icon stayed locked after unlocking)",
      find: `const info = { ...tabInfo, ...action };`,
      replace: `const info = { ...action, ...tabInfo };`,
    },
    {
      file: `node_modules/electron-chrome-extensions/dist/${file}`,
      why: '<browser-action-list> follows its partition: it kept asking the session it started with for updates, so icon and badge changes never arrived',
      find: `      attributeChangedCallback(name, oldValue, newValue) {
        if (oldValue === newValue) return;
        if (this.isConnected) {`,
      replace: `      attributeChangedCallback(name, oldValue, newValue) {
        if (oldValue === newValue) return;
        if (name === "partition" && this.observing) {
          browserAction.removeObserver(oldValue || DEFAULT_PARTITION);
          browserAction.addObserver(newValue || DEFAULT_PARTITION);
        }
        if (this.isConnected) {`,
    },
    {
      file: `node_modules/electron-chrome-extensions/dist/${file}`,
      why: "<browser-action-list> waits for a partition before asking for its state. Without one it asked the UI's own session, which has no extensions, and when that answer came after jbrow had given it a profile's partition it logged \"failed to update\" naming the profile, as if that one had failed",
      find: `        this.fetchState = async () => {
          try {`,
      replace: `        this.fetchState = async () => {
          /* jbrow: no partition yet, see scripts/patch-deps.mjs */
          if (!this.partition) return;
          try {`,
    },
  ]),
  {
    file: 'node_modules/electron-chrome-extensions/dist/chrome-extension-api.preload.js',
    why: 'events answer hasListener/hasListeners instead of throwing "Method not implemented" (SideHN checks cookies.onChanged)',
    find: `        addListener(callback) {
          electron.addExtensionListener(extensionId, this.name, callback);
        }
        removeListener(callback) {
          electron.removeExtensionListener(extensionId, this.name, callback);
        }
        getRules(ruleIdentifiers, callback) {
          throw new Error("Method not implemented.");
        }
        hasListener(callback) {
          throw new Error("Method not implemented.");
        }`,
    replace: `        addListener(callback) {
          (this.callbacks ??= new Set()).add(callback);
          electron.addExtensionListener(extensionId, this.name, callback);
        }
        removeListener(callback) {
          this.callbacks?.delete(callback);
          electron.removeExtensionListener(extensionId, this.name, callback);
        }
        getRules(ruleIdentifiers, callback) {
          throw new Error("Method not implemented.");
        }
        hasListener(callback) {
          return !!this.callbacks?.has(callback);
        }`,
  },
  {
    file: 'node_modules/electron-chrome-extensions/dist/chrome-extension-api.preload.js',
    why: 'see above',
    find: `        hasListeners() {
          throw new Error("Method not implemented.");
        }`,
    replace: `        hasListeners() {
          return !!this.callbacks?.size;
        }`,
  },
  {
    file: 'node_modules/electron-chrome-extensions/dist/cjs/index.js',
    why: "let jbrow add items (pin to toolbar) to an extension button's right-click menu",
    find: `    menu.popup({
      x: Math.floor(anchorRect.x),
      y: Math.floor(anchorRect.y + anchorRect.height)
    });`,
    replace: `    this.ctx.emit("jbrow-action-context-menu", { menu, extensionId });
    menu.popup({
      x: Math.floor(anchorRect.x),
      y: Math.floor(anchorRect.y + anchorRect.height)
    });`,
  },
  {
    file: 'node_modules/electron-chrome-extensions/dist/cjs/index.js',
    why: "a page context menu click tells the extension which submenu it came from: Bitwarden picks fill, copy username or copy password by parentMenuItemId, which was always -1, so its items did nothing",
    find: `        click: () => {
          this.onClicked(extension.id, props.id, webContents2, params);
        }`,
    replace: `        click: () => {
          const parentId = props.parentId === \`group\${extension.id}\` ? void 0 : props.parentId;
          this.onClicked(extension.id, props.id, webContents2, params, parentId);
        }`,
  },
  {
    file: 'node_modules/electron-chrome-extensions/dist/cjs/index.js',
    why: 'see above; also names the frame that was clicked instead of -1',
    find: `  onClicked(extensionId, menuItemId, webContents2, params) {`,
    replace: `  onClicked(extensionId, menuItemId, webContents2, params, parentMenuItemId) {`,
  },
  {
    file: 'node_modules/electron-chrome-extensions/dist/cjs/index.js',
    why: 'see above',
    find: `      frameId: -1,
      // TODO: match frameURL with webFrameMain in Electron 12`,
    replace: `      frameId: params?.frame && !params.frame.isDestroyed?.() ? getFrameId(params.frame) : 0,`,
  },
  {
    file: 'node_modules/electron-chrome-extensions/dist/cjs/index.js',
    why: 'see above',
    find: `      parentMenuItemId: -1,
      // TODO`,
    replace: `      parentMenuItemId,`,
  },
  {
    file: 'node_modules/electron-chrome-extensions/dist/cjs/index.js',
    why: "native messaging: a host ends with the page or service worker that opened it. It outlived both, so every extension reload or worker restart left one more running; Stem's stale hosts took turns knocking the live one off Stem's socket",
    // The patch below inserts lines into this one's output, so its replace never matches whole again
    applied: `/* jbrow: the host ends with its opener, see scripts/patch-deps.mjs */`,
    find: `        application
      );
      this.hostMap[connectionId] = host;
    };`,
    replace: `        application
      );
      this.hostMap[connectionId] = host;
      /* jbrow: the host ends with its opener, see scripts/patch-deps.mjs */
      const sender = event.sender;
      const workers = this.ctx.session.serviceWorkers;
      const gone = () => {
        try {
          this.disconnectNative(event, connectionId);
        } catch (error) {
          d7("disconnect after opener went: %s", error);
        }
      };
      const stopped = ({ versionId, runningStatus }) => {
        if (versionId === sender.versionId && runningStatus === "stopped") gone();
      };
      if (event.type === "frame") sender.once("destroyed", gone);
      else workers.on("running-status-changed", stopped);
      const destroy = host.destroy.bind(host);
      host.destroy = () => {
        if (event.type === "frame") sender.off("destroyed", gone);
        else workers.off("running-status-changed", stopped);
        destroy();
      };
    };`,
  },
  {
    file: 'node_modules/electron-chrome-extensions/dist/cjs/index.js',
    why: "native messaging: an open host keeps the service worker that opened it running, as in Chrome, and ends when its extension unloads. Electron stopped the worker after 30 idle seconds, the patch above then ended its host, and nothing woke the worker again, so Stem lost the browser for good. A worker kept running never reports stopped, even after a reload, hence the unload",
    find: `      const destroy = host.destroy.bind(host);
      host.destroy = () => {`,
    replace: `      /* jbrow: an open host keeps its service worker running, see scripts/patch-deps.mjs */
      let task = event.type === "frame" ? undefined : sender.startTask?.();
      const extensions = this.ctx.session.extensions ?? this.ctx.session;
      const unloaded = (_event, extension) => {
        if (extension.id === event.extension.id) gone();
      };
      extensions.on("extension-unloaded", unloaded);
      const destroy = host.destroy.bind(host);
      host.destroy = () => {
        extensions.off("extension-unloaded", unloaded);
        task?.end();
        task = undefined;`,
  },
  {
    file: 'node_modules/electron-chrome-extensions/dist/cjs/index.js',
    why: "windows: describe a window afresh each time. The library kept the first description, made when the window was added and before its tabs had details, so windows.get and getAll (populate) answered with no tabs until the window was resized, and Stem saw 0 open tabs",
    find: `  getWindowDetails(win) {
    if (this.ctx.store.windowDetailsCache.has(win.id)) {
      return this.ctx.store.windowDetailsCache.get(win.id);
    }
    const details = this.createWindowDetails(win);
    return details;
  }`,
    replace: `  getWindowDetails(win) {
    /* jbrow: never answer from the cache, see scripts/patch-deps.mjs */
    return this.createWindowDetails(win);
  }`,
  },
  // Tabs without a page (asleep, or not opened since launch) have no WebContents, so the library
  // knew nothing of them. jbrow's hooks (tabHooks in src/main/index.ts) list them as discarded tabs,
  // as Chrome does, and load one when an extension reaches for it.
  {
    file: 'node_modules/electron-chrome-extensions/dist/cjs/index.js',
    why: "pageless tabs: a window's tabs include jbrow's tabs without a page",
    find: `      }).map((tab) => this.ctx.store.tabDetailsCache.get(tab.id)).filter(Boolean),
      incognito: !this.ctx.session.isPersistent(),`,
    replace: `      }).map((tab) => this.ctx.store.tabDetailsCache.get(tab.id)).filter(Boolean).concat(
        /* jbrow: pageless tabs, see scripts/patch-deps.mjs */
        (this.ctx.store.impl.pagelessTabs?.() ?? []).filter((tab) => tab.windowId === win.id)
      ),
      incognito: !this.ctx.session.isPersistent(),`,
  },
  {
    file: 'node_modules/electron-chrome-extensions/dist/cjs/index.js',
    why: "pageless tabs: jbrow's window is listed even when none of the profile's tabs has a page, so an extension opens tabs there and doesn't make a window of its own",
    find: `  getAll(event) {
    return Array.from(this.ctx.store.windows).map(this.getWindowDetails.bind(this));
  }`,
    replace: `  getAll(event) {
    /* jbrow: pageless tabs, see scripts/patch-deps.mjs */
    const main = this.ctx.store.impl.mainWindow?.();
    const windows = new Set(this.ctx.store.windows);
    if (main && !main.isDestroyed()) windows.add(main);
    return Array.from(windows).map(this.getWindowDetails.bind(this));
  }`,
  },
  {
    file: 'node_modules/electron-chrome-extensions/dist/cjs/index.js',
    why: 'pageless tabs: tabs.query answers with them too',
    find: `    const filteredTabs = Array.from(this.ctx.store.tabs).map(this.getTabDetails.bind(this)).filter((tab) => {`,
    replace: `    /* jbrow: pageless tabs, see scripts/patch-deps.mjs */
    const filteredTabs = Array.from(this.ctx.store.tabs).map(this.getTabDetails.bind(this)).concat(this.ctx.store.impl.pagelessTabs?.() ?? []).filter((tab) => {`,
  },
  {
    file: 'node_modules/electron-chrome-extensions/dist/cjs/index.js',
    why: "pageless tabs: a tab's earlier IDs reach its page once it has one, jbrow's window is found by ID, and wakeTabById loads a pageless tab",
    find: `  getWindowById(windowId) {
    return Array.from(this.windows).find(
      (window) => !window.isDestroyed() && window.id === windowId
    );
  }`,
    replace: `  getWindowById(windowId) {
    /* jbrow: pageless tabs, see scripts/patch-deps.mjs */
    const main = this.impl.mainWindow?.();
    return Array.from(this.windows).find(
      (window) => !window.isDestroyed() && window.id === windowId
    ) ?? (main && !main.isDestroyed() && main.id === windowId ? main : void 0);
  }
  wakeTabById(tabId) {
    return this.getTabById(tabId) ?? this.impl.tabFor?.(tabId, true);
  }`,
  },
  {
    file: 'node_modules/electron-chrome-extensions/dist/cjs/index.js',
    why: "pageless tabs: a tab's earlier IDs reach its page (see getWindowById)",
    find: `  getTabById(tabId) {
    return Array.from(this.tabs).find((tab) => !tab.isDestroyed() && tab.id === tabId);
  }`,
    replace: `  getTabById(tabId) {
    return Array.from(this.tabs).find((tab) => !tab.isDestroyed() && tab.id === tabId) ?? this.impl.tabFor?.(tabId, false);
  }`,
  },
  {
    file: 'node_modules/electron-chrome-extensions/dist/cjs/index.js',
    why: "pageless tabs: tabs.get answers for a tab without a page as Chrome's discarded tab, and doesn't load it. Bitwarden calls it on every https tab each time its service worker starts, which woke every sleeping tab",
    find: `  get(event, tabId) {
    const tab = this.ctx.store.getTabById(tabId);
    if (!tab) return { id: _TabsAPI.TAB_ID_NONE };`,
    applied: `  get(event, tabId) {
    /* jbrow: pageless tabs, see scripts/patch-deps.mjs */`,
    replace: `  get(event, tabId) {
    /* jbrow: pageless tabs, see scripts/patch-deps.mjs */
    const tab = this.ctx.store.getTabById(tabId);
    if (!tab) return this.ctx.store.impl.pagelessTab?.(tabId) ?? { id: _TabsAPI.TAB_ID_NONE };`,
  },
  {
    file: 'node_modules/electron-chrome-extensions/dist/cjs/index.js',
    why: 'pageless tabs: tabs.get no longer loads the tab (a checkout patched when it did)',
    find: `  get(event, tabId) {
    /* jbrow: pageless tabs, see scripts/patch-deps.mjs */
    const tab = this.ctx.store.wakeTabById(tabId);
    if (!tab) return { id: _TabsAPI.TAB_ID_NONE };`,
    replace: `  get(event, tabId) {
    /* jbrow: pageless tabs, see scripts/patch-deps.mjs */
    const tab = this.ctx.store.getTabById(tabId);
    if (!tab) return this.ctx.store.impl.pagelessTab?.(tabId) ?? { id: _TabsAPI.TAB_ID_NONE };`,
  },
  {
    file: 'node_modules/electron-chrome-extensions/dist/cjs/index.js',
    why: 'pageless tabs: tabs.reload loads the tab',
    find: `    const reloadProperties = typeof arg1 === "object" ? arg1 : typeof arg2 === "object" ? arg2 : {};
    const tab = tabId ? this.ctx.store.getTabById(tabId) : this.ctx.store.getActiveTabOfCurrentWindow();`,
    replace: `    const reloadProperties = typeof arg1 === "object" ? arg1 : typeof arg2 === "object" ? arg2 : {};
    /* jbrow: pageless tabs, see scripts/patch-deps.mjs */
    const tab = tabId ? this.ctx.store.wakeTabById(tabId) : this.ctx.store.getActiveTabOfCurrentWindow();`,
  },
  {
    file: 'node_modules/electron-chrome-extensions/dist/cjs/index.js',
    why: 'pageless tabs: tabs.update loads the tab',
    find: `    const updateProperties = (typeof arg1 === "object" ? arg1 : arg2) || {};
    const tab = tabId ? this.ctx.store.getTabById(tabId) : this.ctx.store.getActiveTabOfCurrentWindow();`,
    replace: `    const updateProperties = (typeof arg1 === "object" ? arg1 : arg2) || {};
    /* jbrow: pageless tabs, see scripts/patch-deps.mjs */
    const tab = tabId ? this.ctx.store.wakeTabById(tabId) : this.ctx.store.getActiveTabOfCurrentWindow();`,
  },
  {
    file: 'node_modules/electron-chrome-extensions/dist/cjs/index.js',
    why: 'pageless tabs: tabs.remove closes one without loading it',
    find: `      const tab = this.ctx.store.getTabById(tabId);
      if (tab) this.ctx.store.removeTab(tab);
      this.onRemoved(tabId);`,
    replace: `      const tab = this.ctx.store.getTabById(tabId);
      if (tab) this.ctx.store.removeTab(tab);
      /* jbrow: pageless tabs, see scripts/patch-deps.mjs */
      else this.ctx.store.impl.removePagelessTab?.(tabId);
      this.onRemoved(tabId);`,
  },
  {
    file: 'node_modules/electron-chrome-extensions/dist/cjs/index.js',
    why: 'tabs.create tells jbrow which extension asked, so the tab can show it was opened by that extension',
    find: `    const tab = await this.ctx.store.createTab({ ...details, url });`,
    replace: `    /* jbrow: the extension that asked, see scripts/patch-deps.mjs */
    const tab = await this.ctx.store.createTab({ ...details, url }, event.extension);`,
  },
  {
    file: 'node_modules/electron-chrome-extensions/dist/cjs/index.js',
    why: 'tabs.create tells jbrow which extension asked (see TabsAPI.create)',
    find: `  async createTab(details) {
    if (typeof this.impl.createTab !== "function") {
      throw new Error("createTab is not implemented");
    }
    if (!details.windowId) {
      details.windowId = this.lastFocusedWindowId;
    }
    const result = await this.impl.createTab(details);`,
    replace: `  async createTab(details, extension) {
    if (typeof this.impl.createTab !== "function") {
      throw new Error("createTab is not implemented");
    }
    if (!details.windowId) {
      details.windowId = this.lastFocusedWindowId;
    }
    const result = await this.impl.createTab(details, extension);`,
  },
  {
    file: 'node_modules/electron-chrome-web-store/dist/cjs/browser/index.js',
    why: "extension updates: a failed check is logged, not left unhandled. It runs each time jbrow becomes active, and offline (or just after wake) its fetch timed out into a \"jbrow hit an error: fetch failed\" notification",
    find: `  lastUpdateCheck = Date.now();
  void updateExtensions(session);`,
    replace: `  lastUpdateCheck = Date.now();
  updateExtensions(session).catch((error) => console.warn("[extensions] update check failed:", error?.cause?.code ?? error?.message ?? error));`,
  },
]

let applied = 0
for (const p of patches) {
  const src = readFileSync(p.file, 'utf8')
  if (src.includes(p.applied ?? p.replace)) continue
  if (!src.includes(p.find)) {
    console.error(`patch-deps: can't apply "${p.why}" to ${p.file}. The library changed; update scripts/patch-deps.mjs.`)
    process.exit(1)
  }
  writeFileSync(p.file, src.replace(p.find, p.replace))
  applied++
}
if (applied) console.log(`patch-deps: applied ${applied} patch(es)`)
