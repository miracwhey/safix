/**
 * Centralised own/peer bubble side-styling — single source of truth.
 *
 * Before this helper, every bubble component (text, image, video, document,
 * voice + the legacy inline path + the tombstone) re-implemented its own
 * `isOwnBubble ? 'items-end' : 'items-start'` wrapper and ad-hoc tone/radius
 * branches, which had drifted apart (own bubbles were white in some, blue in
 * others; only text carried a directional corner). This collapses the rules so
 * a message's sender side is unambiguous and identical across all three thread
 * surfaces:
 *   • own  → brand-blue fill, right-aligned, tail at the top-right
 *   • peer → surface-white, left-aligned, tail at the top-left
 *
 * Failed/rose states stay component-local (they own bespoke palettes); this
 * helper covers the normal + pending tone only.
 */

/** Column-wrapper cross-axis alignment: own → right edge, peer → left edge. */
export function bubbleAlignClass(isOwnBubble: boolean): string {
  return isOwnBubble ? 'items-end' : 'items-start'
}

/**
 * Directional corner radius. The BOTTOM corner on the sender's side is squared
 * (`rounded-b*-md`) so the integral tail spur attaches flush there (bottom-right
 * for own, bottom-left for peer). Continuation bubbles (same sender, stacked)
 * drop the squared corner since they carry no tail.
 */
export function bubbleRadiusClass(isOwnBubble: boolean, isContinuation = false): string {
  if (isOwnBubble) {
    return isContinuation ? 'rounded-2xl' : 'rounded-2xl rounded-br-none'
  }
  return isContinuation ? 'rounded-2xl' : 'rounded-2xl rounded-bl-none'
}

/**
 * Normal + pending-state bubble fill/text/ring tone. Own bubbles are
 * brand-blue on every surface; peer bubbles are surface-white with the v5
 * elevation shadow + hairline ring.
 */
export function bubbleToneClass(isOwnBubble: boolean): string {
  return isOwnBubble
    ? 'bg-blue-600 text-white'
    : 'bg-white text-slate-900 ring-1 ring-slate-200/80 shadow-[0_1px_2px_rgba(15,23,42,0.06),0_8px_20px_-10px_rgba(15,23,42,0.22)]'
}

/** Which top corner the tail hangs from. */
export function bubbleTailSide(isOwnBubble: boolean): 'left' | 'right' {
  return isOwnBubble ? 'right' : 'left'
}
