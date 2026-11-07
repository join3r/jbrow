import { execFile } from 'node:child_process'

// kCGEventSourceStateHIDSystemState; kCGEventLeftMouseDown, kCGEventRightMouseDown and
// kCGEventOtherMouseDown for a click, kCGEventKeyDown for a key press. Mouse moves and scrolls
// don't count: they aren't asking for anything.
const SCRIPT = `ObjC.import('CoreGraphics');
const since = (t) => $.CGEventSourceSecondsSinceLastEventType(1, t);
JSON.stringify({ click: Math.min(since(1), since(3), since(25)), key: since(10) })`

/** Seconds since the last click and since the last key press, anywhere. */
export interface LastInput {
  click: number
  key: number
}

/**
 * The last click and key press anywhere, via CoreGraphics from a JavaScript for Automation
 * one-liner. Takes about 30–50 ms and needs no permissions. Null if it fails.
 */
export function lastInput(): Promise<LastInput | null> {
  return new Promise((resolve) => {
    execFile('/usr/bin/osascript', ['-l', 'JavaScript', '-e', SCRIPT], { timeout: 1000 }, (error, stdout) => {
      let input: LastInput | null = null
      try {
        const parsed = JSON.parse(stdout) as LastInput
        if (Number.isFinite(parsed.click) && Number.isFinite(parsed.key)) input = parsed
      } catch {}
      if (error || !input) console.error('[input] osascript failed:', error ?? stdout)
      resolve(error ? null : input)
    })
  })
}

/** Seconds since the last click or key press anywhere. Null if it fails. */
export async function secondsSinceInput(): Promise<number | null> {
  const input = await lastInput()
  return input && Math.min(input.click, input.key)
}
