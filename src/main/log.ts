import { app, Notification } from 'electron'
import { appendFileSync, mkdirSync, renameSync, statSync } from 'node:fs'
import path from 'node:path'
import { format } from 'node:util'
import { BACKGROUND } from './background'

let file: string | null = null

/**
 * Mirrors console output to ~/Library/Logs/jbrow/main.log, and keeps jbrow running after an
 * unexpected error instead of showing Electron's crash dialog. Call before anything else.
 */
export function setupLogging() {
  const dir = app.getPath('logs')
  mkdirSync(dir, { recursive: true })
  file = path.join(dir, 'main.log')
  try {
    // Keep one previous log around; start fresh once it passes 5 MB.
    if (statSync(file).size > 5 * 1024 * 1024) renameSync(file, `${file}.1`)
  } catch {}
  write('info', [`---- jbrow ${app.getVersion()} started, pid ${process.pid}`])

  for (const level of ['log', 'info', 'warn', 'error'] as const) {
    const original = console[level].bind(console)
    console[level] = (...args: unknown[]) => {
      original(...args)
      write(level, args)
    }
  }

  let lastNotice = 0
  const onError = (kind: string) => (error: unknown) => {
    console.error(`[${kind}]`, error)
    // One notification a minute at most, so a looping error doesn't spam.
    if (Date.now() - lastNotice > 60_000 && app.isReady() && !BACKGROUND) {
      lastNotice = Date.now()
      const message = error instanceof Error ? error.message : String(error)
      new Notification({ title: 'jbrow hit an error', body: `${message}\nDetails are in ~/Library/Logs/jbrow/main.log` }).show()
    }
  }
  process.on('uncaughtException', onError('uncaught exception'))
  process.on('unhandledRejection', onError('unhandled rejection'))
}

function write(level: string, args: unknown[]) {
  if (!file) return
  try {
    appendFileSync(file, `${new Date().toISOString()} ${level.padEnd(5)} ${format(...args)}\n`)
  } catch {}
}

export const logPath = () => file
