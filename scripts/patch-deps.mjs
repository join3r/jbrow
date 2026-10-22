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
