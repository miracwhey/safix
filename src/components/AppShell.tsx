import type { CSSProperties, ReactNode } from 'react'
import BottomNav, { type BottomNavItem } from './BottomNav'

type Props = {
  active?: BottomNavItem
  header?: ReactNode
  children: ReactNode
  className?: string
  mainStyle?: CSSProperties
  /** Optional extra classes for `<main>`. Used by surfaces that scroll
   *  internally and want to hide the browser scrollbar (e.g. Reels feed),
   *  or to apply screen-specific layout helpers without overriding
   *  `mainStyle` semantics. */
  mainClassName?: string
  /** If true, content fills full viewport height without bottom padding */
  immersive?: boolean
  /** @deprecated variant is no longer supported — use immersive instead */
  bottomNavVariant?: string
  hideBottomNav?: boolean
  /**
   * Opt out of the global iOS safe-area top inset on <main>.
   * Use when the screen renders its own top spacing (e.g. own header band
   * or a `pt-[max(...,env(safe-area-inset-top))]` wrapper) and would
   * otherwise be double-padded.
   */
  noSafeTop?: boolean
}

export default function AppShell({
  active,
  header,
  children,
  className = '',
  mainStyle,
  mainClassName,
  immersive = false,
  hideBottomNav = false,
  noSafeTop = false,
}: Props) {
  // Single source of truth for the iOS top frame.
  // - header is fixed and applies its own safe-area inset → suppress here
  //   to avoid double padding.
  // - immersive screens (e.g. Reels) manage their own layout end-to-end.
  // - noSafeTop is for screens that render their own
  //   `pt-[max(56px,env(safe-area-inset-top))]` wrapper.
  const ownsTopInset = !header && !immersive && !noSafeTop

  const mainClasses = [
    immersive ? 'min-h-[100svh]' : '',
    immersive
      ? ''
      : 'pb-[var(--bottom-nav-h)]',
    ownsTopInset
      ? 'pt-[max(48px,calc(env(safe-area-inset-top,0px)+8px))]'
      : '',
    'animate-fadeIn',
    mainClassName ?? '',
  ]
    .filter(Boolean)
    .join(' ')

  return (
    // Inner scroll container (Block 3 scroll-twofer): the app scrolls INSIDE
    // this element, not on the body. The previous `min-h-[calc(100dvh+1px)]`
    // deliberately forced body scrollability so the native WKScrollView
    // rubber-band kicked in — which also made the whole app rubber-band on
    // top of inner message scrollers. Now the root is exactly viewport-high,
    // the body never overflows on AppShell screens, and overscroll cannot
    // chain out of this container (`overscroll-contain`). iOS momentum
    // scrolling comes from `.app-shell-scroll` (-webkit-overflow-scrolling).
    // `data-app-scroll` is the contract for scroll consumers: PersistentTabs
    // per-tab scroll restore and useThreadAutoScroll resolve the container
    // via this attribute.
    //
    // Height contract (keep consistent across the app):
    //   • this scroll ROOT is exactly `100dvh` — tracks the iOS dynamic
    //     browser-chrome so it never over- or under-shoots the visible area.
    //   • inner sections that must never overflow use `100svh` (smallest
    //     viewport) on purpose — do NOT "fix" those to dvh.
    //   • never use bare `100vh` (largest viewport) for a full-height surface:
    //     it overshoots on iOS while the chrome is shown.
    // `overflow-x-hidden` is the single global guard against horizontal
    // page-scroll: any child that escapes its `max-w` wrapper or sets a fixed
    // width wider than the viewport is clipped here instead of scrolling the
    // whole app sideways at 320px. Fixed/portaled overlays (header, nav,
    // sheets) are position:fixed and escape this clip — unaffected.
    <div
      data-app-scroll
      className={`app-shell-scroll h-[100dvh] overflow-x-hidden overflow-y-auto overscroll-contain ${className}`}
    >
      {header ? <div className="fixed inset-x-0 top-0 z-30">{header}</div> : null}

      <main className={mainClasses} style={mainStyle}>
        {children}
      </main>

      {hideBottomNav ? null : (
        <BottomNav active={active} immersive={immersive} />
      )}
    </div>
  )
}
