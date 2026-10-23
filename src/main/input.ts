import { execFile } from 'node:child_process'

// kCGEventSourceStateHIDSystemState; kCGEventLeftMouseDown, kCGEventRightMouseDown, kCGEventKeyDown,
// kCGEventOtherMouseDown. Mouse moves and scrolls don't count: they aren't asking for anything.
const SCRIPT = `ObjC.import('CoreGraphics');
Math.min(...[1, 3, 10, 25].map((t) => $.CGEventSourceSecondsSinceLastEventType(1, t)))`

/**
 * Seconds since the last click or key press anywhere, via CoreGraphics from a JavaScript for
 * Automation one-liner. Takes about 30–50 ms and needs no permissions. Null if it fails.
 */
export function secondsSinceInput(): Promise<number | null> {
  return new Promise((resolve) => {
    execFile('/usr/bin/osascript', ['-l', 'JavaScript', '-e', SCRIPT], { timeout: 1000 }, (error, stdout) => {
      const seconds = Number.parseFloat(stdout)
      if (error || !Number.isFinite(seconds)) {
        console.error('[input] osascript failed:', error ?? stdout)
        resolve(null)
      } else resolve(seconds)
    })
  })
}
