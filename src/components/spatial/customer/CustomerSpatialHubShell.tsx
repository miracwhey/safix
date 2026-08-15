/**
 * Spatial · V1.6.1 Hub-Refactor · CustomerSpatialHubShell
 *
 * Container für den Customer-Full-Bleed-3D-Hub. Bindet sich an Mockup 02 v8
 * (`spatial-v151/02-spatial-hub.html`):
 *   - Voll-3D-Scene als Hintergrund (`sceneSlot`, z-0)
 *   - Floating Liquid-Glass v3 Chrome (Back / Title / ⋯ / Tabs / Room-Info /
 *     ViewMode-Switcher / Tool-Morph) als absolut positionierte Pills
 *   - Native Bottom-Tab-Bar bleibt unter dem 3D-Scene (AppShell-Owned)
 *
 * Layout-Lessons aus V1.6.0 (Device-Test 2026-05-27):
 *   - `AppShell` darf NICHT noch ein Top-Safe-Area-Padding draufpacken
 *     (Hub-Screen muss `noSafeTop` setzen) — sonst kommt der Hub doppelt
 *     bewegt und der obere Bereich bleibt weiß abgeschnitten.
 *   - Hardcoded `pt-[88px]` skaliert nicht über Notch + Dynamic-Island
 *     hinweg. Container nutzt `max(88px, env(safe-area-inset-top)+56px)`.
 *   - CTA und Tool-Bar sind separate Slots — CTA wird über die Tool-Bar
 *     gestaffelt, NICHT übereinander gelegt.
 *   - `min-h-[100dvh]` (Capacitor-WebView), nicht `100vh` (mobile-chrome-
 *     leakage).
 *
 * Reusable Layout-Primitive: kein eigenes Header-State-Layer, kein
 * Tool-Bar-Layer-Layout; die Pills werden vom Hub-Screen frei positioniert
 * (jeder Slot legt sich selbst an seine target-position fest).
 */

import type { ReactNode } from 'react'

export interface CustomerSpatialHubShellProps {
  /** Center slot of the top-bar — typically the tab-pill row. */
  tabs?: ReactNode
  /** Top-right floating cluster (⋯-Menu + ViewMode-Switcher stacked). */
  topRight?: ReactNode
  /** Top-left floating cluster (Back-Pill + Title-Pill). */
  topLeft: ReactNode
  /**
   * Floating overlays innerhalb des 3D-Scene-Stacks. Wird typischerweise für
   * die Room-Info-Pill (links unter den Tabs) verwendet. Die Pills sind
   * `pointer-events-auto` über dem Scene-Layer.
   */
  floatingOverlay?: ReactNode
  /** Body slot — wird NUR bei Empty-State sichtbar (überlagert die 3D-Scene). */
  emptyState?: ReactNode
  /** Bottom-right Floating CTA (z.B. "+ Neuer Raum"). */
  cta?: ReactNode
  /** Bottom Tool-Morph-Bar (Mockup 02 v8 Single-Container-Morph). */
  toolBar?: ReactNode
  /** 3D-Scene-Slot (`<SpatialViewer fullBleed>`). */
  sceneSlot?: ReactNode
  /**
   * Wenn `true` wird die Scene leicht abgedunkelt — verwendet wenn ein
   * Modal/Sheet darüber offen ist, damit der 3D-Bereich nicht ablenkt.
   */
  dimmed?: boolean
}

export default function CustomerSpatialHubShell({
  tabs,
  topRight,
  topLeft,
  floatingOverlay,
  emptyState,
  cta,
  toolBar,
  sceneSlot,
  dimmed = false,
}: CustomerSpatialHubShellProps) {
  return (
    /* R7-A: data-swipe-nav-skip markiert die ganze Hub-Shell als
       immersive Surface — useSwipeNavigation ignoriert touchstart/touchend
       die hier landen. Belt + suspenders gegen Tab-Switch-Leak. */
    <div data-swipe-nav-skip className="relative min-h-[100dvh] overflow-hidden text-white">
      {/* 3D-Scene-Layer — der eigentliche Hub-Inhalt. Mockup 02 v8 maximiert
          den verfügbaren 3D-Platz und legt die Pills floating drüber. */}
      <div
        aria-hidden={sceneSlot == null}
        className="absolute inset-0 z-0"
        style={
          sceneSlot == null
            ? {
                background:
                  'radial-gradient(ellipse at 30% 10%, rgba(99,179,237,0.35) 0%, transparent 55%),' +
                  'radial-gradient(ellipse at 75% 70%, rgba(168,85,247,0.25) 0%, transparent 60%),' +
                  'radial-gradient(ellipse at 50% 100%, rgba(37,99,235,0.20) 0%, transparent 50%),' +
                  'linear-gradient(180deg, #1e3a5f 0%, #14253d 50%, #0a1525 100%)',
              }
            : undefined
        }
      >
        {sceneSlot}
      </div>

      {/* Vignette über dem Scene-Layer damit Glass-Pills lesbar bleiben
          auch bei hellem glb-Background (Mockup 02 v8 nutzt eine eigene
          ::after-radial-vignette im scene-bg). */}
      <div
        aria-hidden
        className="pointer-events-none absolute inset-0 z-[1]"
        style={{ background: 'rgba(0,0,0,0.28)' }}
      />

      {dimmed && (
        <div
          aria-hidden
          className="pointer-events-none absolute inset-0 z-[5]"
          style={{ background: 'rgba(0,0,0,0.42)' }}
        />
      )}

      {/* Top-Bar Floating Cluster — drei Slots in einer Row. Safe-Area
          wird hier ALLEIN gelöst (Hub-Screen setzt `noSafeTop` an AppShell). */}
      <header
        className="pointer-events-none absolute inset-x-0 top-0 z-30 flex items-start justify-between gap-2 px-3"
        style={{ paddingTop: 'max(env(safe-area-inset-top), 16px)' }}
      >
        <div className="pointer-events-auto flex flex-shrink-0 items-center">{topLeft}</div>
        <div className="pointer-events-auto flex flex-1 items-center justify-center">{tabs}</div>
        <div className="pointer-events-auto flex flex-shrink-0 items-center">{topRight}</div>
      </header>

      {/* Floating Overlay-Stack (Room-Info-Pill etc.) zwischen Top-Chrome
          und Bottom-Chrome — wird vom Hub-Screen frei positioniert. */}
      {floatingOverlay && (
        <div className="pointer-events-none absolute inset-0 z-20">
          {floatingOverlay}
        </div>
      )}

      {/* Empty-State liegt ÜBER der 3D-Scene und unter dem Chrome.
          Container hat eigene Safe-Area-Logik weil er als Fullscreen-Overlay
          rendert (3D-Scene ist auf Empty-State leer/Gradient). */}
      {emptyState && (
        <div
          className="pointer-events-none absolute inset-0 z-10 flex items-center justify-center px-4"
          style={{
            paddingTop: 'max(env(safe-area-inset-top), 16px)',
            paddingBottom: 'max(env(safe-area-inset-bottom), 112px)',
          }}
        >
          <div className="pointer-events-auto mx-auto w-full max-w-[420px]">
            {emptyState}
          </div>
        </div>
      )}

      {/* Bottom Tool-Morph-Bar (Mockup 02 v8 Single-Container-Morph) — sitzt
          über der nativen Bottom-Tab-Bar aber unter der CTA. R10 (2026-05-28):
          Offset von +24 auf +16 reduziert damit der Walk-Mode-Joystick darüber
          mehr Headroom hat (Joystick: bottom:200 in WalkController). */}
      {toolBar && (
        <div
          className="pointer-events-none absolute inset-x-0 z-30 px-3"
          style={{
            bottom: 'calc(var(--bottom-nav-h, 96px) + 16px)',
          }}
        >
          <div className="pointer-events-auto">{toolBar}</div>
        </div>
      )}

      {/* Floating CTA (bottom-right) — wird ÜBER die Tool-Bar gestaffelt
          damit beide gleichzeitig sichtbar bleiben. Wenn keine Tool-Bar
          gerendert wird, rückt die CTA an die Tool-Bar-Position runter. */}
      {cta && (
        <div
          className="pointer-events-none absolute inset-x-0 z-40 flex justify-end px-4"
          style={{
            bottom: toolBar
              ? 'calc(var(--bottom-nav-h, 96px) + 88px)'
              : 'calc(var(--bottom-nav-h, 96px) + 24px)',
          }}
        >
          <div className="pointer-events-auto">{cta}</div>
        </div>
      )}
    </div>
  )
}
