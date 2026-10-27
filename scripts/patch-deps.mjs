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
]

let applied = 0
for (const p of patches) {
  const src = readFileSync(p.file, 'utf8')
  if (src.includes(p.replace)) continue
  if (!src.includes(p.find)) {
    console.error(`patch-deps: can't apply "${p.why}" to ${p.file}. The library changed; update scripts/patch-deps.mjs.`)
    process.exit(1)
  }
  writeFileSync(p.file, src.replace(p.find, p.replace))
  applied++
}
if (applied) console.log(`patch-deps: applied ${applied} patch(es)`)
