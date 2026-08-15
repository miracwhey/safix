/**
 * Spatial Core · Block E2 · Top-Right Control Stack
 *
 * Stacked button column anchored to the top-right of `<SpatialViewer>`.
 * Three actions, ordered by frequency:
 *
 *   1. **Home** — reset camera to the initial bounds-fit pose. Double-tap
 *      triggers a focused fit (zoom-to-selection if a pin is highlighted).
 *   2. **Top-Down** — orthographic top-down with cardinal-angle snap
 *      (0/90/180/270°) via `snapHelpers`. Fires `useHaptics.selection()`
 *      on snap-acquire.
 *   3. **Layers** — toggle visibility of pins / measurements / section-cut
 *      (section is wired in E3). Persists per-screen, not per-scan, so the
 *      preference travels with the user's mental model.
 *
 * The buttons render outside the WebGL canvas (HTML overlay) so they get
 * the same focus/keyboard treatment as the rest of the app — important for
 * AppStore accessibility review.
 */

import { useCallback } from 'react'
import { useHaptics } from '../../../hooks/useHaptics'

export type SpatialLayer = 'pins' | 'measurements' | 'section'

export interface SpatialControlsState {
  /** When true, the camera is in orthographic top-down mode. */
  topDown: boolean
  /** Visible layers — `section` is wired to the E3 section-cut slider. */
  visibleLayers: ReadonlySet<SpatialLayer>
}

export interface SpatialControlsProps {
  state: SpatialControlsState
  onHome: () => void
  onToggleTopDown: () => void
  onToggleLayer: (layer: SpatialLayer) => void
  /** True when section-cut UI should be exposed (E3 wires it in). */
  sectionEnabled?: boolean
  className?: string
}

export function SpatialControls(props: SpatialControlsProps) {
  const haptics = useHaptics()

  const onHomeClick = useCallback(() => {
    haptics.light()
    props.onHome()
  }, [haptics, props])

  const onTopDownClick = useCallback(() => {
    haptics.selection()
    props.onToggleTopDown()
  }, [haptics, props])

  const onLayerClick = useCallback(
    (layer: SpatialLayer) => {
      haptics.selection()
      props.onToggleLayer(layer)
    },
    [haptics, props],
  )

  const visible = props.state.visibleLayers

  return (
    <div
      className={
        'pointer-events-none absolute right-3 top-3 flex flex-col gap-2 ' +
        (props.className ?? '')
      }
    >
      <ControlButton
        ariaLabel="Ansicht zurücksetzen"
        onClick={onHomeClick}
        title="Ansicht zurücksetzen"
      >
        <HomeIcon />
      </ControlButton>
      <ControlButton
        ariaLabel={props.state.topDown ? 'Perspektive zurücksetzen' : 'Draufsicht'}
        active={props.state.topDown}
        onClick={onTopDownClick}
        title="Draufsicht"
      >
        <TopDownIcon />
      </ControlButton>
      <div className="flex flex-col gap-1 rounded-md bg-neutral-900/80 p-1 backdrop-blur">
        <ControlButton
          ariaLabel="Pins ein-/ausblenden"
          active={visible.has('pins')}
          onClick={() => onLayerClick('pins')}
          compact
          title="Pins"
        >
          <PinIcon />
        </ControlButton>
        <ControlButton
          ariaLabel="Maße ein-/ausblenden"
          active={visible.has('measurements')}
          onClick={() => onLayerClick('measurements')}
          compact
          title="Maße"
        >
          <RulerIcon />
        </ControlButton>
        {props.sectionEnabled ? (
          <ControlButton
            ariaLabel="Schnitt ein-/ausblenden"
            active={visible.has('section')}
            onClick={() => onLayerClick('section')}
            compact
            title="Schnitt"
          >
            <SectionIcon />
          </ControlButton>
        ) : null}
      </div>
    </div>
  )
}

interface ControlButtonProps {
  ariaLabel: string
  active?: boolean
  compact?: boolean
  onClick: () => void
  title: string
  children: React.ReactNode
}

function ControlButton(props: ControlButtonProps) {
  const base =
    'pointer-events-auto flex items-center justify-center rounded-md text-neutral-100 ' +
    'shadow ring-1 ring-white/10 transition active:scale-95 focus-visible:outline-none ' +
    'focus-visible:ring-2 focus-visible:ring-emerald-400'
  const size = props.compact ? 'h-8 w-8' : 'h-10 w-10'
  const fill = props.active
    ? 'bg-emerald-500/80 hover:bg-emerald-500'
    : 'bg-neutral-900/70 hover:bg-neutral-800'
  return (
    <button
      type="button"
      aria-label={props.ariaLabel}
      aria-pressed={props.active ?? false}
      title={props.title}
      onClick={props.onClick}
      className={`${base} ${size} ${fill}`}
    >
      {props.children}
    </button>
  )
}

// ── Tiny inline icons — keep the chunk SVG-cost minimal. The whole control
// stack is part of the heavy lazy chunk anyway, so a few path strings here
// don't move the needle.

function HomeIcon() {
  return (
    <svg viewBox="0 0 20 20" fill="none" className="h-4 w-4" aria-hidden="true">
      <path
        d="M3 10 10 4l7 6v6a1 1 0 0 1-1 1h-3v-4H7v4H4a1 1 0 0 1-1-1v-6Z"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinejoin="round"
      />
    </svg>
  )
}

function TopDownIcon() {
  return (
    <svg viewBox="0 0 20 20" fill="none" className="h-4 w-4" aria-hidden="true">
      <rect x="3" y="3" width="14" height="14" rx="1" stroke="currentColor" strokeWidth="1.4" />
      <path d="M3 10h14M10 3v14" stroke="currentColor" strokeWidth="1.2" />
    </svg>
  )
}

function PinIcon() {
  return (
    <svg viewBox="0 0 20 20" fill="currentColor" className="h-3.5 w-3.5" aria-hidden="true">
      <path d="M10 2a5 5 0 0 0-5 5c0 3.5 5 11 5 11s5-7.5 5-11a5 5 0 0 0-5-5Zm0 7a2 2 0 1 1 0-4 2 2 0 0 1 0 4Z" />
    </svg>
  )
}

function RulerIcon() {
  return (
    <svg viewBox="0 0 20 20" fill="none" className="h-3.5 w-3.5" aria-hidden="true">
      <path
        d="M2 14 14 2l4 4L6 18l-4-4Z"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinejoin="round"
      />
      <path
        d="m6 13 1.5-1.5M9 10l1.5-1.5M12 7l1.5-1.5"
        stroke="currentColor"
        strokeWidth="1.2"
      />
    </svg>
  )
}

function SectionIcon() {
  return (
    <svg viewBox="0 0 20 20" fill="none" className="h-3.5 w-3.5" aria-hidden="true">
      <path d="M3 10h14M6 6h11M3 14h11" stroke="currentColor" strokeWidth="1.4" />
    </svg>
  )
}
