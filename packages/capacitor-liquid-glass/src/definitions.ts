/**
 * @fixup/capacitor-liquid-glass — type definitions.
 *
 * Native iOS Liquid Glass surfaces rendered *behind* the Capacitor webview, so
 * they show through wherever the web page is transparent. On iOS 26 this is
 * true Liquid Glass (`UIGlassEffect`); on iOS 16–25 it falls back to a
 * `UIBlurEffect` system material.
 *
 * On web every method is a no-op (see web.ts) — the app falls back to the CSS
 * `.glass` recipe documented in Obsidian `Design-System/Liquid-Glass.md`.
 */

/** `regular` = standard frosted Liquid Glass. `clear` = lighter, more transparent. */
export type GlassStyle = 'regular' | 'clear'

/** Rect in CSS pixels / UIKit points (1:1) — origin at the top-left of the screen. */
export interface GlassRect {
  x: number
  y: number
  width: number
  height: number
}

export interface PresentGlassOptions {
  /** Stable id — calling `present` again with the same id reconfigures that surface. */
  id: string
  /** Where the glass sits — typically a web placeholder's `getBoundingClientRect()`. */
  rect: GlassRect
  /** Default `regular`. */
  style?: GlassStyle
  /** Rounded-corner radius in points. Default 0. */
  cornerRadius?: number
  /** Optional `#RRGGBB` / `#RRGGBBAA` tint. iOS 26 tints the glass; older iOS tints the blur's content view. */
  tintColor?: string
  /** iOS 26 only — the glass reacts to touches passing through. Default false. */
  interactive?: boolean
}

export interface UpdateGlassOptions {
  id: string
  /** New position/size — pass on scroll or layout changes. */
  rect?: GlassRect
  cornerRadius?: number
}

export interface RemoveGlassOptions {
  id: string
}

export interface LiquidGlassAvailability {
  /** True on every iOS device — a native blur surface can always be shown. */
  available: boolean
  /** True on iOS 26+ — real Liquid Glass (`UIGlassEffect`). Otherwise `UIBlurEffect` fallback. */
  liquidGlass: boolean
}

export interface LiquidGlassPlugin {
  /** Reports whether native glass is available and whether it is true Liquid Glass. */
  isAvailable(): Promise<LiquidGlassAvailability>
  /** Add (or reconfigure) a native glass surface behind the webview. */
  present(options: PresentGlassOptions): Promise<void>
  /** Move/resize an existing surface — cheap, safe to call on scroll/layout changes. */
  update(options: UpdateGlassOptions): Promise<void>
  /** Remove one surface by id. */
  remove(options: RemoveGlassOptions): Promise<void>
  /** Remove every surface this plugin created. */
  removeAll(): Promise<void>
}
