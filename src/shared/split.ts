import type { Split } from './types'

/** The most tabs one split view shows side by side, as in Arc. */
export const MAX_PANES = 4
/** The gap between panes, which you drag to resize them. Must match --pane-gap in src/ui/ui.css. */
export const PANE_GAP = 8
/** The strip above each pane's page that holds its close button. Must match --pane-head in src/ui/ui.css. */
export const PANE_HEAD = 24
/** Dragging a divider stops short of making a pane narrower than this. */
export const MIN_PANE = 200

/**
 * Where each pane of a split sits in a page area `width` wide: its left edge and width. Main
 * places the pages with it and the UI draws the gaps and the focus ring, so both round the same.
 */
export function paneSpans(width: number, sizes: number[]): { x: number; width: number }[] {
  const room = Math.max(0, width - PANE_GAP * (sizes.length - 1))
  const total = sizes.reduce((a, b) => a + b, 0) || 1
  let sum = 0
  const edges = [0, ...sizes.map((s) => Math.round((room * (sum += s)) / total))]
  return sizes.map((_, i) => ({ x: edges[i] + i * PANE_GAP, width: edges[i + 1] - edges[i] }))
}

/**
 * Sizes after dragging the divider right of pane `i` to `x` in the page area: only the two panes
 * beside it change, and neither gets narrower than MIN_PANE (or half of what they share).
 */
export function dragDivider(width: number, sizes: number[], i: number, x: number): number[] {
  const spans = paneSpans(width, sizes)
  const [a, b] = [spans[i], spans[i + 1]]
  if (!a || !b) return sizes
  const pair = a.width + b.width
  const min = Math.min(MIN_PANE, pair / 2)
  const left = Math.min(pair - min, Math.max(min, x - a.x - PANE_GAP / 2))
  const share = sizes[i] + sizes[i + 1]
  const next = [...sizes]
  next[i] = (share * left) / pair
  next[i + 1] = share - next[i]
  return next
}

/** The split a tab is in, if any. */
export const splitOf = (splits: Split[], id: string | null | undefined) => (id ? splits.find((s) => s.tabs.includes(id)) : undefined)
