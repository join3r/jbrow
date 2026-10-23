import type { AnimMessage } from './types'

/** Control points of the show animation's curves. The UI moves with them; the window fades with them. */
export const EASE: Record<AnimMessage['ease'], [number, number, number, number]> = {
  spring: [0.34, 1.45, 0.64, 1],
  snappy: [0.2, 0.9, 0.2, 1],
  smooth: [0.45, 0, 0.2, 1],
}

export const cssEase = (ease: AnimMessage['ease']) => `cubic-bezier(${EASE[ease].join(',')})`

/** Progress of a CSS cubic-bezier at time `t` (0..1). Overshoots past 1 where the curve does. */
export function bezier([x1, y1, x2, y2]: [number, number, number, number], t: number): number {
  if (t <= 0) return 0
  if (t >= 1) return 1
  const at = (a: number, b: number, s: number) => 3 * a * s * (1 - s) ** 2 + 3 * b * s * s * (1 - s) + s ** 3
  // x(s) only grows, so bisect for the s where it reaches t.
  let lo = 0
  let hi = 1
  for (let i = 0; i < 24; i++) {
    const mid = (lo + hi) / 2
    if (at(x1, x2, mid) < t) lo = mid
    else hi = mid
  }
  return at(y1, y2, (lo + hi) / 2)
}
