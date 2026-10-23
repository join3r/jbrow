import { app } from 'electron'

/**
 * JBROW_BACKGROUND=1 runs jbrow without getting in your way, for automated runs (tests, a
 * Claude session checking a change over CDP) while you keep working. The panel "shows" off
 * screen and never takes focus, there's no Dock icon or menu bar item, the global hotkeys stay
 * with the jbrow you use, and no notifications pop up. Pages still render and take input
 * over CDP.
 */
export const BACKGROUND = !!process.env.JBROW_BACKGROUND

if (BACKGROUND) {
  // An off-screen window counts as occluded, and Chromium stops painting occluded windows.
  app.commandLine.appendSwitch('disable-backgrounding-occluded-windows')
  app.commandLine.appendSwitch('disable-renderer-backgrounding')
}
