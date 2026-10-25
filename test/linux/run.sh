#!/bin/sh
# Runs jbrow's tests on Linux in Docker, from macOS or anywhere else: `test/linux/run.sh [test args]`,
# e.g. `test/linux/run.sh e2e --repeat 3`. The checkout is copied in without node_modules, which
# lives in a Docker volume so later runs skip the install.
set -e
here=$(cd "$(dirname "$0")" && pwd)
repo=$(cd "$here/../.." && pwd)
docker build -q -t jbrow-linux-test "$here" >/dev/null
docker run --rm --init --shm-size=1g \
  -v "$repo":/src:ro -v jbrow-linux-node-modules:/work/node_modules \
  -e CI="${CI:-}" jbrow-linux-test sh -c '
    rsync -a --delete --exclude node_modules --exclude dist --exclude .test-build --exclude release /src/ /work/
    [ -e node_modules/.package-lock.json ] && cmp -s package-lock.json node_modules/.jbrow-lock || {
      npm ci --ignore-scripts && node node_modules/electron/install.js && node node_modules/esbuild/install.js && cp package-lock.json node_modules/.jbrow-lock
    }
    npm run build >/dev/null
    xvfb-run -a -s "-screen 0 1440x900x24" node test/run.mjs "$@"
  ' sh "$@"
