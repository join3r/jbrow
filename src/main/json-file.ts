import { renameSync, writeFileSync } from 'node:fs'

/** Writes a file whole or not at all: a crash mid-write leaves the old one, not half of the new. */
export function writeAtomic(file: string, data: string) {
  writeFileSync(`${file}.tmp`, data)
  renameSync(`${file}.tmp`, file)
}

/**
 * Moves a file that couldn't be read out of the way, so the next save doesn't overwrite what's
 * in it: a hand edit with a typo is still there to fix.
 */
export function setAside(file: string) {
  try {
    renameSync(file, `${file}.bad-${Date.now()}`)
  } catch {}
}
