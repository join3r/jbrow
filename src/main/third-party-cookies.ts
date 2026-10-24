import { app } from 'electron'

/**
 * Chromium's switch for blocking third-party cookies, as Safari and Brave do. Electron has no API
 * for it, so it holds for every profile from launch until quit, with no exceptions per site:
 * Chromium keeps those (and storage-access grants) in content settings Electron doesn't have.
 * Extensions lose their sites' cookies too, which Chrome exempts them from.
 */
const SWITCH = 'test-third-party-cookie-phaseout'

/** Call before the app is ready. */
export const blockThirdPartyCookies = () => app.commandLine.appendSwitch(SWITCH)

/** Whether this run blocks them, which a changed setting only alters after a restart. */
export const thirdPartyCookiesBlocked = () => app.commandLine.hasSwitch(SWITCH)
