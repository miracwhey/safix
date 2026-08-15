/**
 * Spatial · Canonical · Three · SectionControlPanel (Zwischen-Latte · B-5)
 *
 * HTML overlay for the section controls (Mockup 44): the horizontal cut
 * slider and the ceiling-cutaway toggle. Sibling of the `<Canvas>`, so it
 * uses plain DOM + Tailwind; state lives in the canonical scene store
 * (`sectionSliderY` / `cutawaySetting`).
 */

import { type ReactElement } from 'react'

import { useCanonicalSceneStore } from '../../../../lib/spatial/canonical/store/sceneStore.ts'

interface SectionControlPanelProps {
  className?: string
}

/** Default slice height when the cut is first switched on (mid-wall). */
const DEFAULT_SLICE_Y = 1.5

export function SectionControlPanel({ className }: SectionControlPanelProps): ReactElement {
  const resolved = useCanonicalSceneStore((s) => s.resolved)
  const sectionSliderY = useCanonicalSceneStore((s) => s.sectionSliderY)
  const setSectionSliderY = useCanonicalSceneStore((s) => s.setSectionSliderY)
  const cutawaySetting = useCanonicalSceneStore((s) => s.cutawaySetting)
  const setCutawaySetting = useCanonicalSceneStore((s) => s.setCutawaySetting)

  const maxHeight = resolved?.ceiling?.height_m ?? 3
  const sliceOn = sectionSliderY !== null
  const ceilingOff =
    cutawaySetting === 'remove_ceiling' ||
    cutawaySetting === 'remove_ceiling_and_high_walls'

  return (
    <div
      className={
        className ??
        'pointer-events-auto absolute bottom-4 right-4 z-10 flex w-56 flex-col gap-3 ' +
          'rounded-2xl border border-white/15 bg-black/55 p-4 text-white shadow-lg backdrop-blur-md'
      }
    >
      {/* Ceiling cutaway */}
      <label className="flex items-center justify-between text-sm font-medium">
        Decke ausblenden
        <input
          type="checkbox"
          checked={ceilingOff}
          onChange={(e) => setCutawaySetting(e.target.checked ? 'remove_ceiling' : 'none')}
          aria-label="Decke ausblenden"
        />
      </label>

      {/* Horizontal section slice */}
      <label className="flex items-center justify-between text-sm font-medium">
        Horizontalschnitt
        <input
          type="checkbox"
          checked={sliceOn}
          onChange={(e) =>
            setSectionSliderY(e.target.checked ? Math.min(DEFAULT_SLICE_Y, maxHeight) : null)
          }
          aria-label="Horizontalschnitt"
        />
      </label>

      {sliceOn && (
        <div className="flex flex-col gap-1">
          <span className="text-xs text-white/70">
            Schnitthöhe: {(sectionSliderY ?? 0).toFixed(2)} m
          </span>
          <input
            type="range"
            min={0}
            max={maxHeight}
            step={0.01}
            value={sectionSliderY ?? 0}
            onChange={(e) => setSectionSliderY(Number(e.target.value))}
            aria-label="Schnitthöhe"
          />
        </div>
      )}
    </div>
  )
}
