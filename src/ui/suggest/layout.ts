import type { SiteInfoReply } from '../../shared/types'
import type { Item, SuggestModel, VisitItem } from './model'

/**
 * A way of laying out the address bar's suggestions, picked with prefs.urlBarStyle.
 *
 * ui.ts keeps the address bar itself: focus, typing, the inline completion, the requests to main
 * and their answers, Escape, and what picking an item does. Each time something changes it builds
 * a SuggestModel (model.ts) and hands it to the layout to draw into #suggest; each key pressed in
 * the address bar goes to the layout first. A layout keeps its own selection, which starts in the
 * text (nothing selected, Return does model.goal) whenever reset() is called.
 *
 * To add a layout:
 * - Write a factory in its own file here (see columns.ts) returning a SuggestLayout, and put it
 *   in LAYOUTS in layouts.ts under its UrlBarStyle id, with a name and picture in URL_BAR_LAYOUTS.
 * - Put its CSS in its own file next to it, e.g. src/ui/suggest/preview.css, scoped to
 *   `.suggest[data-layout='<id>']`, and link it in src/ui/index.html. build.mjs copies every .css
 *   in this folder; suggest.css has what all layouts share (the box, the footer, keycaps, tiles).
 * - Mark each item's element with class `sg`, `data-kind="<item.kind>"` and its title in an
 *   element with class `sg-t`, and the selected one with class `hi`. test/e2e/omnibox.test.ts
 *   reads those.
 * - Use only the theme's tokens (--accent, --accent-soft, --ink, --muted, --line, --surface,
 *   --hover), so it works in light and dark and every theme, and masks nothing itself: the model's
 *   text is already masked for private addresses. Show an item's shownUrl, never its url.
 * - A layout that needs main or the focus (preview asks about sites, and has a search field of its
 *   own) gets a LayoutHost from its factory.
 */
export interface SuggestLayout {
  /** Starts over with nothing selected. Called when the bar gets focus and whenever the text changes. */
  reset(): void
  /**
   * Draws the model and the selection into `box`. Called with a fresh model as answers arrive
   * from main and after every move, so it must keep the selection on the same item (by key)
   * when that's still there, and on a sensible neighbour when it isn't.
   */
  render(box: HTMLElement, model: SuggestModel): void
  /**
   * A key pressed in the address bar while the suggestions show, or in a field of the layout's
   * own inside the box (preview's search field), which ui.ts passes here the same way.
   */
  key(e: KeyInput, model: SuggestModel): Outcome
  /** A click inside the box. */
  click(target: HTMLElement, model: SuggestModel): Outcome
  /** Main's answer to a LayoutHost.askSite. Returns whether to render again. */
  siteInfo?(reply: SiteInfoReply): boolean
}

/** What ui.ts does for a layout that needs more than drawing. */
export interface LayoutHost {
  /** Asks main about the site behind a page; the answer comes back through siteInfo(). */
  askSite(url: string, profile: string | undefined, seq: number): void
  /** Puts focus back in the address bar's text from a field in the box, keeping its caret. */
  focusText(): void
}

/** The parts of a KeyboardEvent a layout looks at. */
export type KeyInput = Pick<KeyboardEvent, 'key' | 'shiftKey' | 'metaKey' | 'ctrlKey' | 'altKey'>

/**
 * What a key or click came to. `none` leaves the key to the address bar (its caret, Tab switching
 * profiles); anything else stops the key's default. `moved` asks for a render. `pick` does what
 * Return does with the item; null means what's typed, as it's typed. With `open` it opens the
 * item's page somewhere else instead: a new tab, the next profile, or split view beside the active
 * tab (an open tab itself goes there). `copy` puts the item's address on the clipboard. `forget`
 * takes a history page out of the history.
 */
export type Outcome =
  | { do: 'none' }
  | { do: 'moved' }
  | { do: 'pick'; item: Item | null; open?: OpenIn }
  | { do: 'copy'; item: Item }
  | { do: 'forget'; item: VisitItem }
export type OpenIn = 'tab' | 'profile' | 'split'
