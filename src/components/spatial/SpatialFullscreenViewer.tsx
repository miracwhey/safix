/**
 * Spatial · L2-E · V-03 Fullscreen-Viewer
 *
 * Read-only Präsentations-Modus für `<SpatialViewer>` als React-Portal
 * außerhalb der AppShell. Eingesetzt aus dem `CraftsmanPresalesDetailScreen`
 * Quick-Actions-Strip ("3D-Fullscreen").
 *
 * Verhalten:
 *   * Mount: Capacitor `ScreenOrientation.lock({orientation: 'landscape'})` nur
 *     auf iOS — Web/Android wird der Lock-Call übersprungen (Capacitor wirft
 *     sonst auf nicht-unterstützten Platforms).
 *   * Unmount: `ScreenOrientation.unlock()` (idempotent best-effort, swallow
 *     Fehler — der User hat den Modal schon verlassen).
 *   * Escape-Key + Capacitor `App.backButton` schließen den Modal.
 *   * `SpatialQuickLookButton iconOnly` rechts unten, wenn `usdzUrl` vorhanden
 *     ist — AR Quick Look bleibt der primäre iOS-Off-Ramp.
 *   * Modal lebt in einem React-Portal an `document.body`, so dass AppShell-
 *     Padding/Safe-Area-Inset-Logik den Viewport nicht beschneidet.
 *
 * Caveats:
 *   * `props.mode` ist hartcodiert auf `'view'` — Edit-Pfade sind im
 *     Fullscreen blockiert (kein Pin-Editor-Sheet).
 *   * `chromelessMode={true}` versteckt die Top-Right `SpatialControls` —
 *     Section-Cut-Slider bleibt damit ebenfalls aus.
 */

import { useCallback, useEffect } from 'react'
import { createPortal } from 'react-dom'
import { Capacitor } from '@capacitor/core'
import { registerBackInterceptor } from '../../lib/native/backButton'
import { ScreenOrientation } from '@capacitor/screen-orientation'
import { X } from 'lucide-react'

import { SpatialViewer } from './SpatialViewer'
import { SpatialQuickLookButton } from './SpatialQuickLookButton'
import { useImmersiveStatusBar } from '../../hooks/useImmersiveStatusBar'
import { logError } from '../../lib/observability'
import type { RoomScene } from '../../lib/spatial/canonical/types/scene-graph'

export interface SpatialFullscreenViewerProps {
  /** Pflicht: glb-URL des aktuellen Aufmaßes. */
  gltfUrl: string
  /** Optional: USDZ-Storage-Path für AR Quick Look (iOS). */
  usdzStoragePath?: string | null
  /** Optional: hydratierter Parametric-RoomScene (V-04 MeasurementLines-Pfad). */
  roomScene?: RoomScene | null
  /** Anzeige-Titel oben links (z. B. Aufmaß-Titel). */
  title?: string
  /** Schließt den Modal — Host re-mounted/unmounted per `{open && <Modal/>}`. */
  onClose: () => void
}

const IS_IOS = Capacitor.getPlatform() === 'ios'
const IS_NATIVE = Capacitor.isNativePlatform()

export function SpatialFullscreenViewer(props: SpatialFullscreenViewerProps) {
  const { gltfUrl, usdzStoragePath, roomScene, title, onClose } = props

  // ── Native Status-Bar in Overlay-Mode während Fullscreen offen ist ─────────
  useImmersiveStatusBar()

  // ── Escape-Key schließt den Modal ──────────────────────────────────────────
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [onClose])

  // ── Android Hardware-Back schließt den Modal ───────────────────────────────
  // Registriert über den zentralen Back-Koordinator (LIFO), damit der offene
  // Viewer den Druck konsumiert und NICHT zusätzlich die App-Navigation feuert.
  useEffect(() => {
    if (!IS_NATIVE) return
    return registerBackInterceptor(() => {
      onClose()
      return true
    })
  }, [onClose])

  // ── Landscape-Lock auf iOS (Capacitor Plugin) ──────────────────────────────
  useEffect(() => {
    if (!IS_IOS) return
    let unlocked = false
    void (async () => {
      try {
        await ScreenOrientation.lock({ orientation: 'landscape' })
      } catch (err) {
        // Lock kann auf nicht-LiDAR iPads / unkonfigurierten iPhones fehlschlagen
        // — der Modal bleibt offen, User dreht das Gerät manuell.
        logError('spatial.fullscreen.orientation_lock_failed', err)
      }
    })()
    return () => {
      if (unlocked) return
      unlocked = true
      void (async () => {
        try {
          await ScreenOrientation.unlock()
        } catch (err) {
          logError('spatial.fullscreen.orientation_unlock_failed', err)
        }
      })()
    }
  }, [])

  const handleBackdropClick = useCallback(
    (e: React.MouseEvent<HTMLDivElement>) => {
      // Backdrop-Tap schließt — Innerer Card hat stopPropagation auf onClick.
      if (e.target === e.currentTarget) onClose()
    },
    [onClose],
  )

  const target = typeof document !== 'undefined' ? document.body : null
  if (!target) return null

  return createPortal(
    <div
      className="fixed inset-0 z-[60] flex flex-col bg-black"
      role="dialog"
      aria-modal="true"
      aria-label={title ? `${title} · Vollbild` : '3D-Vollbild'}
      onClick={handleBackdropClick}
    >
      {/* Top-Bar: Close + optional Titel */}
      <div className="pointer-events-none absolute inset-x-0 top-0 z-10 flex items-start justify-between gap-3 px-4 pb-3 pt-[max(12px,env(safe-area-inset-top))]">
        <div className="pointer-events-auto max-w-[60%] rounded-[12px] bg-black/55 px-3 py-1.5 text-[13px] font-semibold text-white shadow-[0_2px_8px_rgba(0,0,0,0.35)] backdrop-blur">
          {title ?? '3D-Vorschau'}
        </div>
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation()
            onClose()
          }}
          aria-label="Vollbild schließen"
          className="pointer-events-auto flex h-10 w-10 items-center justify-center rounded-full bg-black/65 text-white shadow-[0_2px_8px_rgba(0,0,0,0.4)] backdrop-blur transition active:scale-95"
        >
          <X size={20} aria-hidden="true" />
        </button>
      </div>

      {/* Viewer-Layer: fullbleed */}
      <div className="relative flex-1" onClick={(e) => e.stopPropagation()}>
        <SpatialViewer
          gltfUrl={gltfUrl}
          mode="view"
          roomScene={roomScene}
          chromelessMode
          className="h-full w-full !rounded-none"
        />
      </div>

      {/* Bottom-Right: AR Quick Look (nur iOS + USDZ vorhanden) */}
      {usdzStoragePath && (
        <div className="pointer-events-none absolute bottom-0 right-0 z-10 px-4 pb-[max(16px,env(safe-area-inset-bottom))]">
          <div className="pointer-events-auto" onClick={(e) => e.stopPropagation()}>
            <SpatialQuickLookButton usdzStoragePath={usdzStoragePath} iconOnly />
          </div>
        </div>
      )}
    </div>,
    target,
  )
}
