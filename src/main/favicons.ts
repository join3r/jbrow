import { app, type Session } from 'electron'
import { createHash } from 'node:crypto'
import { mkdirSync, readdirSync, statSync, unlinkSync } from 'node:fs'
import { readFile, stat, writeFile } from 'node:fs/promises'
import path from 'node:path'

/**
 * Favicons, fetched the way a browser does: through the tab's own profile session, so the
 * site's cookies go along and Cross-Origin-Resource-Policy doesn't apply. The UI loads them as
 * jbrow-icon: URLs and the bytes are kept on disk, so an icon still shows offline, after a
 * restart, or once you're signed out.
 */
export const ICON_SCHEME = 'jbrow-icon'

/** How long a saved icon is used before it's fetched again. A failed fetch keeps the old one. */
const FRESH_MS = 7 * 24 * 60 * 60 * 1000
/** Icons nothing has asked for in this long are deleted at launch. */
const KEEP_MS = 90 * 24 * 60 * 60 * 1000
const MAX_BYTES = 1024 * 1024

const dir = () => path.join(app.getPath('userData'), 'favicons')

/** What the UI shows for a page's favicon. Icons that aren't on the web (data: and such) stay as they are. */
export function faviconUrl(profileId: string, url: string): string {
  if (!/^https?:/i.test(url)) return url
  return `${ICON_SCHEME}://icon/?${new URLSearchParams({ p: profileId, u: url })}`
}

interface Icon {
  type: string
  body: Buffer
}

/** A saved icon is its content type, a newline, then its bytes. */
async function readSaved(file: string): Promise<{ icon: Icon; fresh: boolean } | null> {
  try {
    const [data, info] = await Promise.all([readFile(file), stat(file)])
    const nl = data.indexOf(10)
    if (nl < 0) return null
    return { icon: { type: data.subarray(0, nl).toString(), body: data.subarray(nl + 1) }, fresh: Date.now() - info.mtimeMs < FRESH_MS }
  } catch {
    return null
  }
}

async function download(sess: Session, url: string): Promise<Icon | null> {
  try {
    const res = await sess.fetch(url)
    const type = res.headers.get('content-type')?.split(';')[0].trim().toLowerCase() ?? ''
    if (!res.ok || !type.startsWith('image/')) return null
    const body = Buffer.from(await res.arrayBuffer())
    return body.length && body.length <= MAX_BYTES ? { type, body } : null
  } catch {
    return null
  }
}

/** Serves jbrow-icon: URLs on the UI's session. sessionFor gives a profile's session, or null for one that's gone. */
export function handleFavicons(ui: Session, sessionFor: (profileId: string) => Session | null) {
  mkdirSync(dir(), { recursive: true })
  prune()
  const pending = new Map<string, Promise<Icon | null>>()

  const load = async (profileId: string, url: string): Promise<Icon | null> => {
    const file = path.join(dir(), createHash('sha1').update(`${profileId}\n${url}`).digest('hex'))
    const saved = await readSaved(file)
    if (saved?.fresh) return saved.icon
    const sess = sessionFor(profileId)
    const icon = sess && (await download(sess, url))
    if (!icon) return saved?.icon ?? null
    await writeFile(file, Buffer.concat([Buffer.from(`${icon.type}\n`), icon.body])).catch(() => {})
    return icon
  }

  ui.protocol.handle(ICON_SCHEME, async (req) => {
    const params = new URL(req.url).searchParams
    const profileId = params.get('p') ?? ''
    const url = params.get('u') ?? ''
    if (!/^https?:/i.test(url)) return new Response(null, { status: 400 })
    const key = `${profileId}\n${url}`
    let job = pending.get(key)
    if (!job) {
      job = load(profileId, url).finally(() => pending.delete(key))
      pending.set(key, job)
    }
    const icon = await job
    return icon ? new Response(new Uint8Array(icon.body), { headers: { 'content-type': icon.type } }) : new Response(null, { status: 404 })
  })
}

function prune() {
  try {
    for (const name of readdirSync(dir())) {
      const file = path.join(dir(), name)
      if (Date.now() - statSync(file).mtimeMs > KEEP_MS) unlinkSync(file)
    }
  } catch (error) {
    console.error('[favicons] could not clean up saved icons:', error)
  }
}
