# Third-party notices

jbrow is licensed under GPL-3.0-only. It includes the software and data below, each under its own
license. Each npm package's full license text also ships with the app, in its folder inside
`jbrow.app/Contents/Resources/app.asar`.

## Electron and Chromium

jbrow runs on [Electron](https://www.electronjs.org/), which includes Chromium, Node.js and their
dependencies.

- Electron: MIT. Copyright (c) Electron contributors. Copyright (c) 2013-2020 GitHub Inc.
- Chromium and the other components Electron includes: many licenses, listed in full in
  `LICENSES.chromium.html`, which ships inside the app at
  `jbrow.app/Contents/Resources/LICENSES.chromium.html`. Electron's own license is next to it, in
  `LICENSE.electron.txt`.

## Libraries

| Package | License | Copyright |
|---|---|---|
| [electron-chrome-extensions](https://github.com/samuelmaddock/electron-browser-shell) 4.9.0 | GPL-3.0 (see below) | Samuel Maddock |
| [electron-chrome-web-store](https://github.com/samuelmaddock/electron-browser-shell) 0.13.0 | MIT | Samuel Maddock \<sam@samuelmaddock.com\> |
| [electron-updater](https://github.com/electron-userland/electron-builder) 6.8.10 | MIT | Copyright (c) 2015 Loopline Systems |
| builder-util-runtime 9.7.0 | MIT | Copyright (c) 2015 Loopline Systems |
| lazy-val 1.0.5 | MIT | Vladimir Krivosheev |
| debug 4.4.3 | MIT | Copyright (c) 2014-2017 TJ Holowaychuk; Copyright (c) 2018-2021 Josh Junon |
| ms 2.1.3 | MIT | Copyright (c) 2020 Vercel, Inc. |
| adm-zip 0.5.18 | MIT | Copyright (c) 2012 Another-D-Mention Software and other contributors |
| pbf 4.0.2 | BSD-3-Clause | Copyright (c) 2024, Mapbox |
| resolve-protobuf-schema 2.1.0 | MIT | Copyright (c) 2014 Mathias Buus |
| protocol-buffers-schema 3.6.1 | MIT | Copyright (c) 2014 Mathias Buus |
| sax 1.6.1 | BlueOak-1.0.0 | Isaac Z. Schlueter and contributors |
| fs-extra 10.1.0 | MIT | Copyright (c) 2011-2017 JP Richardson |
| jsonfile 6.2.1 | MIT | Copyright (c) 2012-2015, JP Richardson |
| universalify 2.0.1 | MIT | Copyright (c) 2017, Ryan Zimmerman |
| graceful-fs 4.2.11 | ISC | Copyright (c) 2011-2022 Isaac Z. Schlueter, Ben Noordhuis, and Contributors |
| js-yaml 4.3.2 | MIT | Copyright (C) 2011-2015 by Vitaly Puzrin |
| argparse 2.0.1 | Python-2.0 | Copyright (c) 2001-2020 Python Software Foundation |
| lodash.escaperegexp 4.1.2 | MIT | Copyright jQuery Foundation and other contributors; based on Underscore.js, copyright Jeremy Ashkenas, DocumentCloud and Investigative Reporters & Editors |
| lodash.isequal 4.5.0 | MIT | Copyright JS Foundation and other contributors; based on Underscore.js, copyright Jeremy Ashkenas, DocumentCloud and Investigative Reporters & Editors |
| semver 7.7.4 | ISC | Copyright (c) Isaac Z. Schlueter and Contributors |
| tiny-typed-emitter 2.1.0 | MIT | Copyright (c) 2020 Zurab Benashvili |
| @types/chrome 0.0.287, @types/filesystem 0.0.36, @types/filewriter 0.0.33, @types/har-format 1.2.16 | MIT | Copyright (c) Microsoft Corporation |

The `@types` packages are type definitions only. They come along as dependencies of
electron-chrome-web-store and contain no code that runs.

### electron-chrome-extensions

electron-chrome-extensions is dual licensed: under the GNU General Public License v3.0, or under a
Patron License for those who sponsor its author. jbrow uses it under the GPL-3.0, which is why jbrow
itself is GPL-3.0. jbrow patches it at build time (`scripts/patch-deps.mjs`); the patches are part
of jbrow's source. The license text is at <https://www.gnu.org/licenses/gpl-3.0.txt>.

### electron-chrome-web-store

electron-chrome-web-store's package.json says MIT and names Samuel Maddock as its author, but the
package ships no license file. The MIT text below applies to it with this notice:

Copyright (c) Samuel Maddock \<sam@samuelmaddock.com\>

### Other license texts

The MIT license text is below, once; it applies to every package marked MIT above, with that
package's copyright line. The ISC and BSD-3-Clause texts follow it. sax's Blue Oak Model License
1.0.0 is at <https://blueoakcouncil.org/license/1.0.0>, and argparse's Python Software Foundation
License 2.0 is at <https://docs.python.org/3/license.html>; both also ship in their packages.

## Data

### Popular sites

`src/main/top-sites.json`, the popular sites the address bar completes to, is built by
`scripts/top-sites.mjs` from:

- The [Chrome UX Report](https://developer.chrome.com/docs/crux) (CrUX) by Google, licensed under
  [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/), through the monthly top lists that
  [zakird/crux-top-lists](https://github.com/zakird/crux-top-lists) publishes. jbrow keeps each
  site's rank bucket and leaves sites out; that's the extent of the changes.
- The [Tranco list](https://tranco-list.eu/), for the order within a bucket. Victor Le Pochat, Tom
  Van Goethem, Samaneh Tajalizadehkhoob, Maciej Korczyński and Wouter Joosen, "Tranco: A
  Research-Oriented Top Sites Ranking Hardened Against Manipulation," Proceedings of the 26th
  Annual Network and Distributed System Security Symposium (NDSS 2019).
  <https://doi.org/10.14722/ndss.2019.23386>

Adult sites are left out using [The Block List Project](https://github.com/blocklistproject/Lists)'s
porn list. That list is only read at build time and isn't included.

### Phishing and malware lists

jbrow downloads the phishing and malware host lists from
[malware-filter](https://gitlab.com/malware-filter) at run time, every 12 hours. They aren't
included in the app. malware-filter builds them from OpenPhish, PhishTank and URLhaus; see
<https://gitlab.com/malware-filter/phishing-filter> and
<https://gitlab.com/malware-filter/urlhaus-filter> for their terms.

---

## MIT License

```
Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

## ISC License

```
Permission to use, copy, modify, and/or distribute this software for any
purpose with or without fee is hereby granted, provided that the above
copyright notice and this permission notice appear in all copies.

THE SOFTWARE IS PROVIDED "AS IS" AND THE AUTHOR DISCLAIMS ALL WARRANTIES
WITH REGARD TO THIS SOFTWARE INCLUDING ALL IMPLIED WARRANTIES OF
MERCHANTABILITY AND FITNESS. IN NO EVENT SHALL THE AUTHOR BE LIABLE FOR
ANY SPECIAL, DIRECT, INDIRECT, OR CONSEQUENTIAL DAMAGES OR ANY DAMAGES
WHATSOEVER RESULTING FROM LOSS OF USE, DATA OR PROFITS, WHETHER IN AN
ACTION OF CONTRACT, NEGLIGENCE OR OTHER TORTIOUS ACTION, ARISING OUT OF OR
IN CONNECTION WITH THE USE OR PERFORMANCE OF THIS SOFTWARE.
```

## BSD-3-Clause License (pbf)

```
Copyright (c) 2024, Mapbox
All rights reserved.

Redistribution and use in source and binary forms, with or without
modification, are permitted provided that the following conditions are met:

* Redistributions of source code must retain the above copyright notice, this
  list of conditions and the following disclaimer.

* Redistributions in binary form must reproduce the above copyright notice,
  this list of conditions and the following disclaimer in the documentation
  and/or other materials provided with the distribution.

* Neither the name of pbf nor the names of its
  contributors may be used to endorse or promote products derived from
  this software without specific prior written permission.

THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS "AS IS"
AND ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED TO, THE
IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR PURPOSE ARE
DISCLAIMED. IN NO EVENT SHALL THE COPYRIGHT HOLDER OR CONTRIBUTORS BE LIABLE
FOR ANY DIRECT, INDIRECT, INCIDENTAL, SPECIAL, EXEMPLARY, OR CONSEQUENTIAL
DAMAGES (INCLUDING, BUT NOT LIMITED TO, PROCUREMENT OF SUBSTITUTE GOODS OR
SERVICES; LOSS OF USE, DATA, OR PROFITS; OR BUSINESS INTERRUPTION) HOWEVER
CAUSED AND ON ANY THEORY OF LIABILITY, WHETHER IN CONTRACT, STRICT LIABILITY,
OR TORT (INCLUDING NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY OUT OF THE USE
OF THIS SOFTWARE, EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGE.
```
