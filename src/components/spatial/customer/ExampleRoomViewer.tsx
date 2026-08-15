/**
 * Spatial · V1.6.1 · Customer Beispiel-Raum-Viewer
 *
 * Wraps the existing `<CanonicalSceneRoot>` with the Mockup-03-v3 chrome:
 *   - Glass top-nav with Back + Title + Meta + Close
 *   - Floating hint pill (orbit / pinch hint)
 *   - Bottom info sheet (eyebrow + 4 Maß-Cells + 2 CTAs)
 *
 * The viewer is lazy-loaded by the parent screen so the Three.js bundle only
 * ships when a customer actually opens an example. The 3D content lives in
 * <CanonicalSceneRoot> exactly as in `/dev/spatial-poc` — no separate renderer
 * path. Section-controls + camera-switcher are hidden because the example is
 * a "look-and-feel demo", not an edit surface.
 *
 * Wording-Lock (binding · Mockup 03 v3 + Decisions D-5):
 *   - Title prefix "Beispiel-Raum" — never "Tutorial" / "Demo"
 *   - Primary CTA "Als Projekt anlegen" routes the customer to the New-Room sheet
 *   - Secondary CTA "Selbst messen" routes to the LiDAR start (or new-room
 *     picker when the parent has no LiDAR available)
 */

import { useEffect, useMemo, type ReactElement } from 'react'
import { ChevronLeft, Maximize, X } from 'lucide-react'

import {
  buildExampleRoom,
  EXAMPLE_ROOMS_BY_KIND,
  type ExampleRoomKind,
} from '../../../lib/spatial/canonical/presets/exampleRooms'
import { useCanonicalSceneStore } from '../../../lib/spatial/canonical/store/sceneStore'
import { SpatialSceneErrorBoundary } from '../SpatialSceneErrorBoundary'
import { CanonicalSceneRoot } from '../three/canonical/CanonicalSceneRoot'

export interface ExampleRoomViewerProps {
  kind: ExampleRoomKind
  /** Back to the picker (or wherever the parent wants the user to land). */
  onBack: () => void
  /** Hard-close the demo and return to the Hub. */
  onClose: () => void
  /** Primary CTA — "Als Projekt anlegen" (D-5 wording lock). */
  onCreateProject: () => void
  /** Secondary CTA — "Selbst messen". The parent handles LiDAR / picker fallback. */
  onMeasureSelf: () => void
}

export default function ExampleRoomViewer({
  kind,
  onBack,
  onClose,
  onCreateProject,
  onMeasureSelf,
}: ExampleRoomViewerProps): ReactElement {
  // Memoise the RoomScene per `kind` so re-renders of the surrounding chrome
  // never re-trigger the canonical store hydration.
  const scene = useMemo(() => buildExampleRoom(kind), [kind])
  const meta = EXAMPLE_ROOMS_BY_KIND[kind]

  // Derive the four Maß-Cells from the bounds + ceiling height — no fabricated
  // numbers per feedback_html_mockup_design_lessons (#8 "Keine Platzhalter-Zahlen").
  const dims = useMemo(() => deriveDims(scene), [scene])

  // Viewer-local store cleanup. The canonical scene store is module-global;
  // <CanonicalSceneRoot> hydrates it on mount but never resets it on unmount.
  // Without this cleanup a stale `resolved` scene can briefly leak into the
  // next consumer (e.g. the Hub) before its own hydration re-fills the store.
  // Scope kept local on purpose: other CanonicalSceneRoot hosts (VerifySheet,
  // EditModeViewerHost, PoC screen) own their own store-write cadence and
  // depend on the existing "hydrate on mount, do not touch on unmount" model.
  useEffect(() => {
    return () => {
      useCanonicalSceneStore.setState({ scene: null, resolved: null })
    }
  }, [])

  return (
    <div
      className="relative h-[100dvh] w-full overflow-hidden bg-gradient-to-br from-[#1e3a5f] via-[#14253d] to-[#0a1525] text-white"
      data-testid="example-room-viewer"
      data-room-kind={kind}
    >
      {/* 3D canvas — full-bleed. Wrapped in a SceneErrorBoundary so a WebGL
          context-loss (older device, Capacitor WebKit quirk) does not blank
          the route — Maß-Cells + chrome stay usable below. */}
      <SpatialSceneErrorBoundary context="ExampleRoomViewer">
        <CanonicalSceneRoot
          scene={scene}
          className="absolute inset-0 h-full w-full"
          cameraSwitcher={false}
          sectionControls={false}
        />
      </SpatialSceneErrorBoundary>

      {/* atmospheric radial-glow overlay (matches mockup 03 v3 scene gradient) */}
      <div
        aria-hidden
        className="pointer-events-none absolute inset-0"
        style={{
          background:
            'radial-gradient(ellipse at 50% 30%, rgba(99,179,237,0.18) 0%, transparent 60%)',
        }}
      />

      {/* Top-nav glass pill */}
      <header
        className="absolute left-4 right-4 top-[max(env(safe-area-inset-top),16px)] z-30 flex h-[52px] items-center gap-3 rounded-[26px] border border-white/18 bg-[rgba(15,21,37,0.45)] px-3.5 shadow-[0_12px_30px_rgba(0,0,0,0.3)] backdrop-blur-2xl backdrop-saturate-200"
        data-testid="example-room-viewer-topnav"
      >
        <button
          type="button"
          onClick={onBack}
          aria-label="Zurück zur Übersicht"
          className="grid h-8 w-8 place-items-center rounded-full bg-white/14 text-white transition hover:bg-white/22"
        >
          <ChevronLeft size={16} aria-hidden />
        </button>
        <div className="flex-1 leading-tight">
          <div className="text-[15px] font-semibold text-white">
            {meta.title.split(' · ')[0]} · Beispiel-Raum
          </div>
          <div className="text-[12px] text-white/55">
            {meta.approxAreaM2} m² · {meta.hotspots} Hotspots
          </div>
        </div>
        <button
          type="button"
          onClick={onClose}
          aria-label="Demo schließen"
          className="grid h-8 w-8 place-items-center rounded-full bg-white/14 text-white transition hover:bg-white/22"
        >
          <X size={16} aria-hidden />
        </button>
      </header>

      {/* Interaction-hint pill (mockup 03 v3 .hint-bubble) */}
      <div
        className="absolute left-4 right-4 top-[calc(max(env(safe-area-inset-top),16px)+72px)] z-30 flex items-center gap-2.5 rounded-2xl border border-white/16 bg-[rgba(15,21,37,0.65)] px-3.5 py-2.5 text-[13px] text-white/88 backdrop-blur-xl backdrop-saturate-150"
        data-testid="example-room-viewer-hint"
      >
        <Maximize size={16} className="shrink-0 text-sky-300" aria-hidden />
        <span>Drehen · Pinch zum Zoomen — nur Anschauen.</span>
      </div>

      {/* Bottom info sheet */}
      <section
        className="absolute bottom-0 left-0 right-0 z-30 rounded-t-[28px] border-t border-white/18 bg-[rgba(15,21,37,0.78)] px-5 pb-[max(env(safe-area-inset-bottom),28px)] pt-3 shadow-[0_-20px_50px_rgba(0,0,0,0.4)] backdrop-blur-2xl backdrop-saturate-200"
        data-testid="example-room-viewer-sheet"
      >
        <div
          aria-hidden
          className="mx-auto mb-3 h-[5px] w-11 rounded-[3px] bg-white/30"
        />
        <div className="mb-1 flex items-center gap-1.5 text-[10px] font-bold uppercase tracking-[0.12em] text-sky-300">
          <span aria-hidden className="h-1.5 w-1.5 rounded-full bg-sky-400" />
          Maße des Beispiel-Raums
        </div>
        <h2 className="text-[19px] font-bold leading-tight tracking-tight">
          {meta.title}
        </h2>
        <p className="mt-1 text-[13.5px] leading-snug text-white/72">
          Dreh den Raum und schau dir an, wie wir ein Aufmaß darstellen.
        </p>

        <ul
          aria-label="Maße"
          className="mt-3 grid grid-cols-2 gap-2"
        >
          {dims.map(cell => (
            <li
              key={cell.label}
              className="rounded-xl border border-white/12 bg-white/[0.08] px-3 py-2.5"
              data-testid={`example-room-measure-${cell.label.toLowerCase()}`}
            >
              <div className="text-[10px] font-semibold uppercase tracking-wider text-white/50">
                {cell.label}
              </div>
              <div className="font-sf-display text-[17px] font-bold leading-tight text-white">
                {cell.value}
              </div>
            </li>
          ))}
        </ul>

        <div className="mt-3.5 flex gap-2.5">
          <button
            type="button"
            onClick={onCreateProject}
            className="flex flex-1 items-center justify-center gap-2 rounded-2xl bg-white px-3.5 py-3 text-[13.5px] font-semibold text-slate-900 shadow-[0_6px_18px_rgba(0,0,0,0.2)] transition active:scale-[0.98]"
            data-testid="example-room-cta-create"
          >
            Als Projekt anlegen
          </button>
          <button
            type="button"
            onClick={onMeasureSelf}
            className="flex flex-1 items-center justify-center gap-2 rounded-2xl border border-white/20 bg-white/12 px-3.5 py-3 text-[13.5px] font-semibold text-white transition active:scale-[0.98]"
            data-testid="example-room-cta-measure"
          >
            Selbst messen
          </button>
        </div>
      </section>
    </div>
  )
}

interface DimensionCell {
  label: string
  value: string
}

function deriveDims(scene: ReturnType<typeof buildExampleRoom>): DimensionCell[] {
  const width = scene.bounds_max.x - scene.bounds_min.x
  const depth = scene.bounds_max.z - scene.bounds_min.z
  const height = scene.ceiling.height_m
  return [
    { label: 'Breite', value: formatMeters(width) },
    { label: 'Tiefe', value: formatMeters(depth) },
    { label: 'Höhe', value: formatMeters(height) },
    { label: 'Fläche', value: `${scene.computed_area_m2.toFixed(1)} m²` },
  ]
}

function formatMeters(value: number): string {
  // 2.20 m · 2-decimal precision matches Mockup 03 v3 (Tiefe 0.90 m / Höhe 2.20 m)
  return `${value.toFixed(2)} m`
}
