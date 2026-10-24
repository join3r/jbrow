#!/bin/zsh
# Builds jbrow.app, quits the jbrow that's running (installed or `npm start`), installs the new
# app into /Applications and starts it. Your tabs, profiles and logins carry over: both use
# ~/Library/Application Support/jbrow. Instances started with JBROW_USER_DATA are left alone.
set -euo pipefail

cd "${0:A:h}/.."
APP_ID=sk.awantech.jbrow
DEST=/Applications/jbrow.app

echo "install: building"
npm run setup
# Just the .app; the DMG is only for handing jbrow to someone else (npm run dist).
npx electron-builder --mac --dir
BUILT=$(ls -d release/mac*/jbrow.app | head -1)
[[ -d $BUILT ]] || { echo "install: no jbrow.app in release/" >&2; exit 1 }

# Waits up to $2 seconds for process $1 to exit.
wait_for_exit() {
  for _ in {1..$(( $2 * 10 ))}; do
    kill -0 $1 2>/dev/null || return 0
    sleep 0.1
  done
  return 1
}

# Main jbrow processes: the installed app, a built one in release/, or Electron from a jbrow
# checkout (npm start / npm run dev). Helpers are left to exit with their app. A test instance
# with its own data (JBROW_USER_DATA) doesn't block the new app, so it keeps running.
jbrow_pids() {
  local pid cmd
  for pid in $(pgrep -f 'Contents/MacOS/(jbrow|Electron)' || true); do
    cmd=$(ps -o command= -p $pid 2>/dev/null) || continue
    case $cmd in
      "$DEST/Contents/MacOS/jbrow"|"$DEST/Contents/MacOS/jbrow "*) ;;
      */release/mac*/jbrow.app/Contents/MacOS/jbrow|*/release/mac*/jbrow.app/Contents/MacOS/jbrow\ *) ;;
      */jbrow*/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron|*/jbrow*/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron\ *) ;;
      *) continue ;;
    esac
    ps eww -o command= -p $pid 2>/dev/null | grep -q 'JBROW_USER_DATA=' && continue
    echo $pid
  done
}

echo "install: quitting jbrow"
# The installed app quits through AppleScript first, the way ⌘Q does.
installed=$(pgrep -f "^$DEST/Contents/MacOS/jbrow" | head -1 || true)
if [[ -n $installed ]]; then
  osascript -e "tell application id \"$APP_ID\" to quit" >/dev/null 2>&1 || true
  wait_for_exit $installed 10 || true
fi
for pid in $(jbrow_pids); do
  kill -TERM $pid 2>/dev/null || true
done
for pid in $(jbrow_pids); do
  wait_for_exit $pid 10 || { echo "install: jbrow ($pid) didn't quit, killing it"; kill -KILL $pid 2>/dev/null || true }
done

echo "install: installing into $DEST"
rm -rf "$DEST"
ditto "$BUILT" "$DEST"

echo "install: starting jbrow"
open "$DEST"
