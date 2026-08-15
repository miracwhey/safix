# @fixup/capacitor-liquid-glass

Native iOS **Liquid Glass** surfaces for FixUp's Capacitor app.

## Why native

Real Apple Liquid Glass (refraction, lensing, live specular highlights) is a
native render material — UIKit/SwiftUI. The WKWebView CSS engine can only do
`backdrop-filter: blur()`; SVG-displacement refraction (`backdrop-filter:
url()`) does **not** work in Safari/WKWebView. So genuine glass for FixUp's
chrome (tab bar, nav bar, sheets) has to be rendered natively.

This plugin renders a real `UIVisualEffectView` **behind** the webview; the
web page is transparent where the glass should show through.

- **iOS 26+** → `UIGlassEffect` (true Liquid Glass)
- **iOS 16–25** → `UIBlurEffect` system material (graceful fallback)
- **Web** → no-op; the app uses the CSS `.glass` recipe instead
  (see Obsidian `Design-System/Liquid-Glass.md`)

## API

```ts
import { LiquidGlass } from '@fixup/capacitor-liquid-glass'

const { available, liquidGlass } = await LiquidGlass.isAvailable()

await LiquidGlass.present({
  id: 'tab-bar',
  rect: el.getBoundingClientRect(),  // CSS px == UIKit points
  style: 'regular',                  // 'regular' | 'clear'
  cornerRadius: 28,
  tintColor: '#2563EB',              // optional
  interactive: true,                 // iOS 26 only
})

await LiquidGlass.update({ id: 'tab-bar', rect: el.getBoundingClientRect() })
await LiquidGlass.remove({ id: 'tab-bar' })
await LiquidGlass.removeAll()
```

`present` is idempotent — call it again with the same `id` to reconfigure.

## Integration (host app — external steps)

These are **active steps**, run them deliberately:

1. Add the dependency to the app `package.json`:
   `"@fixup/capacitor-liquid-glass": "file:packages/capacitor-liquid-glass"`
2. `npm install`
3. `npx cap sync ios`
4. **Make the webview transparent** so the glass behind it is visible — set
   the Capacitor `backgroundColor` to a fully transparent value and, in the
   iOS bridge, `webView.isOpaque = false` + clear `backgroundColor` /
   `scrollView.backgroundColor`. Without this the glass stays hidden behind an
   opaque webview.
5. In the web layout, render a transparent placeholder element and feed its
   `getBoundingClientRect()` into `present` / `update`.

## Status

**v0.1.0** — glass-view primitive (`present` / `update` / `remove` /
`removeAll` / `isAvailable`). Higher-level surfaces (native glass tab bar with
event bridge) build on top of this primitive in a later version.

> The iOS-26 path targets the iOS 26 SDK (Xcode 26). Confirm the
> `UIGlassEffect.Style` case names against the SDK when first building.
