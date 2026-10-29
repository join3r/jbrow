import type { UrlBarStyle } from '../../shared/types'
import { columnsLayout } from './columns'
import type { LayoutHost, SuggestLayout } from './layout'
import { previewLayout } from './preview'

/** Each address bar layout by its prefs.urlBarStyle id. */
export const LAYOUTS: Record<UrlBarStyle, (host: LayoutHost) => SuggestLayout> = {
  columns: columnsLayout,
  preview: previewLayout,
}

/** How settings and the welcome offer the layouts: a picture, a name and a line about each. */
export const URL_BAR_LAYOUTS: { id: UrlBarStyle; name: string; about: string }[] = [
  { id: 'columns', name: 'Columns', about: 'Where Return goes on top, searches under it, then history and your tabs side by side.' },
  { id: 'preview', name: 'Preview', about: 'One list of everything, with what jbrow knows about the highlighted page beside it.' },
]
/** A layout's picture, relative to the UI page: light or dark. scripts/urlbar-shots.mjs takes them. */
export const layoutPicture = (id: UrlBarStyle, dark = false) => `img/urlbar-${id}${dark ? '-dark' : ''}.png`
/**
 * A layout's picture as markup, the dark one while jbrow is dark. The appearance setting sets
 * nativeTheme.themeSource, which prefers-color-scheme follows, so this goes with jbrow's own choice.
 */
export const layoutPictureHtml = (id: UrlBarStyle) =>
  `<picture><source srcset="${layoutPicture(id, true)}" media="(prefers-color-scheme: dark)"><img src="${layoutPicture(id)}" alt=""></picture>`
