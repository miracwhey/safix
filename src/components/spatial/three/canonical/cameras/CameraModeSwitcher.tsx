/**
 * Spatial · Canonical · Cameras · CameraModeSwitcher (Zwischen-Latte · B-4)
 *
 * HTML overlay that switches the canonical renderer's camera mode — the
 * control surface for the four `CameraMode`s mounted by `CanonicalSceneRoot`
 * (Mockup 44). It is a sibling of the `<Canvas>`, NOT an in-canvas object,
 * so it can use normal DOM + Tailwind.
 *
 * AR-Compare is a permanently-disabled stub in V1 (no RealityKit bridge yet
 * — `ARCompareController` only renders a marker plane); the button shows a
 * "bald" affordance so the mode is visibly planned, not missing.
 *
 * State lives in the canonical scene store (`cameraMode` / `setCameraMode`),
 * so any sibling panel stays in sync without prop drilling.
 */

import { type ReactElement } from 'react'

import { useCanonicalSceneStore } from '../../../../../lib/spatial/canonical/store/sceneStore.ts'
import type { CameraMode } from '../../../../../lib/spatial/canonical/types/camera.ts'

interface ModeEntry {
  mode: CameraMode
  label: string
  enabled: boolean
}

const MODES: readonly ModeEntry[] = [
  { mode: 'dollhouse', label: 'Übersicht', enabled: true },
  { mode: 'floorplan', label: 'Grundriss', enabled: true },
  { mode: 'walk', label: 'Begehen', enabled: true },
  { mode: 'ar_compare', label: 'AR', enabled: false },
]

interface CameraModeSwitcherProps {
  /** Extra positioning classes on the wrapper (default: top-centre overlay). */
  className?: string
}

export function CameraModeSwitcher({ className }: CameraModeSwitcherProps): ReactElement {
  const cameraMode = useCanonicalSceneStore((s) => s.cameraMode)
  const setCameraMode = useCanonicalSceneStore((s) => s.setCameraMode)

  return (
    <div
      role="radiogroup"
      aria-label="Kamera-Modus"
      className={
        className ??
        'pointer-events-auto absolute left-1/2 top-4 z-10 flex -translate-x-1/2 ' +
          'gap-0.5 rounded-full border border-white/15 bg-black/45 p-1 ' +
          'shadow-lg backdrop-blur-md'
      }
    >
      {MODES.map((entry) => {
        const active = entry.mode === cameraMode
        return (
          <button
            key={entry.mode}
            type="button"
            role="radio"
            aria-checked={active}
            aria-label={entry.enabled ? entry.label : `${entry.label} · bald verfügbar`}
            disabled={!entry.enabled}
            onClick={() => entry.enabled && setCameraMode(entry.mode)}
            className={[
              'rounded-full px-3.5 py-1.5 text-sm font-medium transition-colors',
              active ? 'bg-white text-neutral-900' : 'text-white/85',
              entry.enabled
                ? 'hover:bg-white/15 active:scale-[0.97]'
                : 'cursor-not-allowed text-white/35',
            ].join(' ')}
          >
            {entry.label}
            {!entry.enabled && <span className="ml-1 text-[10px] uppercase opacity-70">bald</span>}
          </button>
        )
      })}
    </div>
  )
}
