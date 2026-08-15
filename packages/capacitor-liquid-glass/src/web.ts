import { WebPlugin } from '@capacitor/core'
import type {
  LiquidGlassAvailability,
  LiquidGlassPlugin,
  PresentGlassOptions,
  RemoveGlassOptions,
  UpdateGlassOptions,
} from './definitions'

/**
 * Web stub. Native Liquid Glass surfaces are iOS-only — they render a real
 * `UIVisualEffectView` behind the (transparent) webview, which the web CSS
 * engine cannot do. On web the app falls back to the CSS `.glass` recipe
 * (see Obsidian `Design-System/Liquid-Glass.md`).
 *
 * Every method is an intentional no-op so shared layout code can call the
 * plugin unconditionally without platform branching.
 */
export class LiquidGlassWeb extends WebPlugin implements LiquidGlassPlugin {
  async isAvailable(): Promise<LiquidGlassAvailability> {
    return { available: false, liquidGlass: false }
  }

  async present(_options: PresentGlassOptions): Promise<void> {
    // no-op — web uses the CSS .glass recipe
  }

  async update(_options: UpdateGlassOptions): Promise<void> {
    // no-op
  }

  async remove(_options: RemoveGlassOptions): Promise<void> {
    // no-op
  }

  async removeAll(): Promise<void> {
    // no-op
  }
}
