/**
 * Spatial · DimensionMeasureBar (manual footprint edit)
 *
 * Non-modal replacement for {@link DimensionInputSheet}. The device test of the
 * modal sheet showed it covered the floorplan you were trying to measure — so
 * this is a thin bottom bar with NO scrim: a `pointer-events-none` wrapper with
 * a `pointer-events-auto` inner bar, so taps around it still reach the 2D
 * Grundriss (select another wall, slide the mid-bar) while the bar stays open.
 *
 * The device test of the stacked RIEGEL (all three dimensions at once) showed it
 * was too tall and covered the floorplan — so this is now a compact 3-TAB
 * segmented control: a `role="tablist"` header (Länge / Höhe / Dicke) over a
 * single active panel; the other two panels stay MOUNTED (`hidden`) so their
 * inputs keep their state and the test/a11y selectors keep resolving. Each panel
 * is a single row: a coarse slider (Regler) + an exact tap-to-type field
 * (cm-genau). "Höhe für alle Wände" lives in the Höhe panel; "Ecke einfügen"
 * is global and splits the selected wall at its midpoint (L/U shapes).
 *
 * Every change applies LIVE via `onApply` (the host writes the store and
 * throttles the blob persist), so the floorplan updates as you step — no
 * "Übernehmen" button. Length is a footprint-first corner cascade; height/
 * thickness are footprint-safe dims.
 *
 * Draft state is seeded ONCE from the wall (the host keys the bar on the
 * selected wall id), never re-bound to the live wall — so a live length-apply
 * that reshapes the wall doesn't fight the user's finger. A mid-bar slide of THIS
 * wall never changes its own length (it translates), so the seeded length stays
 * correct for the selected wall.
 */
import { useCallback, useId, useRef, useState, type KeyboardEvent } from 'react'
import { Scissors, X } from 'lucide-react'

import {
  SHEET_GLASS,
  clamp,
  distance,
  LENGTH_MIN_M,
  LENGTH_MAX_M,
  HEIGHT_MIN_M,
  HEIGHT_MAX_M,
  THICKNESS_MIN_CM,
  THICKNESS_MAX_CM,
} from './dimensionFieldConfig'
import type { DimensionInputSheetValues } from './DimensionInputSheet'
import type { Wall } from '../../../lib/spatial/canonical/types/geometry'

export interface DimensionMeasureBarProps {
  /** The currently selected wall — seeds the draft (host keys on its id). */
  wall: Wall
  /** Apply handler, called LIVE on every change. Host writes store + throttles persist. */
  onApply: (values: DimensionInputSheetValues) => void
  /** Split the selected wall at its midpoint → adds a corner for L/U shapes. */
  onSplitWall?: () => void
  /** Close the bar (deselect the wall). */
  onClose: () => void
  /**
   * Extra CSS length added BELOW the bar (on top of the safe-area inset), to lift
   * it clear of a host's bottom navigation. Provider/fullscreen leaves the
   * default `'0px'` (bar sits at the screen edge); the customer hub passes its
   * bottom-nav clearance so the bar floats just above the tab bar, not cut off.
   */
  bottomGapCss?: string
}

type DimKey = 'length' | 'height' | 'thickness'

/** Maß-Zeile: Regler (grob) + tippbares Feld (exakt, cm-genau) — beide gehen über denselben onChange-Pfad. */
function CompactDimRow({
  id,
  label,
  unitLabel,
  value,
  min,
  max,
  step,
  decimals,
  valid,
  onChange,
}: {
  id: string
  label: string
  unitLabel: string
  value: number
  min: number
  max: number
  step: number
  decimals: number
  valid: boolean
  onChange: (raw: string) => void
}) {
  return (
    <div className="flex items-center gap-2.5">
      {/* Regler (grob) zuerst — nimmt die Breite; eigener accessible name, damit er
          getByLabelText nicht mit dem gleichnamigen Feld kollidiert. */}
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={Number.isFinite(value) ? clamp(value, min, max) : min}
        onChange={(e) => onChange(e.target.value)}
        aria-label={`${label} grob einstellen`}
        className="min-w-0 flex-1"
        style={{ accentColor: valid ? '#2563EB' : '#fb7185' }}
      />
      {/* exaktes tippbares Feld — der aktive Tab benennt die Dimension, daher
          trägt das Feld nur ein aria-label (kein sichtbares Inline-Label). */}
      <div
        className={[
          'flex w-[100px] shrink-0 items-center gap-1 rounded-[10px] bg-white/[0.05] px-2 py-1 ring-1',
          valid ? 'ring-white/12' : 'ring-rose-400/60',
        ].join(' ')}
      >
        <input
          id={id}
          type="number"
          inputMode="decimal"
          step={step}
          min={min}
          max={max}
          aria-label={label}
          value={Number.isFinite(value) ? value.toFixed(decimals) : ''}
          onChange={(e) => onChange(e.target.value)}
          className="w-full flex-1 bg-transparent text-right text-[15px] font-semibold tabular-nums text-white outline-none [appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none"
        />
        <span className="text-[12px] font-semibold text-white/55">{unitLabel}</span>
      </div>
    </div>
  )
}

const TABS: readonly { key: DimKey; label: string }[] = [
  { key: 'length', label: 'Länge' },
  { key: 'height', label: 'Höhe' },
  { key: 'thickness', label: 'Dicke' },
]

export function DimensionMeasureBar({
  wall,
  onApply,
  onSplitWall,
  onClose,
  bottomGapCss = '0px',
}: DimensionMeasureBarProps) {
  const baseId = useId()
  const lengthId = useId()
  const heightId = useId()
  const thicknessId = useId()

  // Pure UI state: which dimension's panel is visible. No reset effect needed —
  // the host keys the bar on wall.id, so a wall change remounts and `active`
  // returns to 'length' naturally.
  const [active, setActive] = useState<DimKey>('length')

  const [lengthM, setLengthM] = useState(() =>
    clamp(wall.length_m ?? distance(wall.start_point, wall.end_point), LENGTH_MIN_M, LENGTH_MAX_M),
  )
  const [heightM, setHeightM] = useState(() => clamp(wall.height_m, HEIGHT_MIN_M, HEIGHT_MAX_M))
  const [thicknessCm, setThicknessCm] = useState(() =>
    clamp(Math.round((wall.thickness_m ?? 0.15) * 100), THICKNESS_MIN_CM, THICKNESS_MAX_CM),
  )
  const [applyAll, setApplyAll] = useState(false)

  const lengthValid =
    Number.isFinite(lengthM) && lengthM >= LENGTH_MIN_M && lengthM <= LENGTH_MAX_M
  const heightValid =
    Number.isFinite(heightM) && heightM >= HEIGHT_MIN_M && heightM <= HEIGHT_MAX_M
  const thicknessValid =
    Number.isFinite(thicknessCm) &&
    thicknessCm >= THICKNESS_MIN_CM &&
    thicknessCm <= THICKNESS_MAX_CM

  // Apply the merged draft live. Skips out-of-range values (the orchestrator
  // further validates geometry; an invalid length there just no-ops, no spam).
  const push = useCallback(
    (next: { l?: number; h?: number; tcm?: number; all?: boolean }) => {
      // Length is a footprint-first corner cascade. On a NON-length edit
      // (height/thickness/applyAll → next.l undefined) carry the wall's LIVE
      // length (the `wall` prop re-subscribes to the store), NEVER the
      // once-seeded draft: otherwise an interleaved mid-bar slide of a NEIGHBOUR
      // that re-shaped this wall would be reverted when the stale seed re-applies
      // setEdgeLength. The length field's own edits (next.l set) still win.
      const l = next.l ?? wall.length_m ?? distance(wall.start_point, wall.end_point)
      // Same live-carry rule for height/thickness: a neighbour drag or an
      // "apply height to all" can reshape THIS wall's height/thickness in the
      // store between renders. On a non-edit of those fields, carry the wall's
      // LIVE value, never the once-seeded draft, or we'd revert the live change.
      const h = next.h ?? wall.height_m ?? heightM
      const tcm =
        next.tcm ?? (wall.thickness_m != null ? Math.round(wall.thickness_m * 100) : thicknessCm)
      const all = next.all ?? applyAll
      if (
        !(Number.isFinite(l) && l >= LENGTH_MIN_M && l <= LENGTH_MAX_M) ||
        !(Number.isFinite(h) && h >= HEIGHT_MIN_M && h <= HEIGHT_MAX_M) ||
        !(Number.isFinite(tcm) && tcm >= THICKNESS_MIN_CM && tcm <= THICKNESS_MAX_CM)
      ) {
        return
      }
      onApply({ lengthM: l, heightM: h, thicknessM: tcm / 100, applyHeightToAllWalls: all })
    },
    [wall, heightM, thicknessCm, applyAll, onApply],
  )

  const onLength = useCallback(
    (raw: string) => {
      const p = parseFloat(raw.replace(',', '.'))
      if (Number.isNaN(p)) return
      setLengthM(p)
      push({ l: p })
    },
    [push],
  )
  const onHeight = useCallback(
    (raw: string) => {
      const p = parseFloat(raw.replace(',', '.'))
      if (Number.isNaN(p)) return
      setHeightM(p)
      push({ h: p })
    },
    [push],
  )
  const onThickness = useCallback(
    (raw: string) => {
      const p = parseFloat(raw.replace(',', '.'))
      if (Number.isNaN(p)) return
      setThicknessCm(p)
      push({ tcm: p })
    },
    [push],
  )
  const onApplyAll = useCallback(
    (checked: boolean) => {
      setApplyAll(checked)
      push({ all: checked })
    },
    [push],
  )

  const tabId = (k: DimKey) => `${baseId}-tab-${k}`
  const panelId = (k: DimKey) => `${baseId}-panel-${k}`

  // WAI-ARIA tabs pattern: roving tabindex needs Arrow/Home/End to move focus
  // between tabs (the two non-selected tabs are tabIndex=-1, so without this a
  // keyboard / iOS Full-Keyboard / switch user could never reach them).
  const tabRefs = useRef<Record<DimKey, HTMLButtonElement | null>>({
    length: null,
    height: null,
    thickness: null,
  })
  const onTabKeyDown = useCallback((e: KeyboardEvent<HTMLButtonElement>, index: number) => {
    let next = index
    if (e.key === 'ArrowRight') next = (index + 1) % TABS.length
    else if (e.key === 'ArrowLeft') next = (index - 1 + TABS.length) % TABS.length
    else if (e.key === 'Home') next = 0
    else if (e.key === 'End') next = TABS.length - 1
    else return
    e.preventDefault()
    const key = TABS[next].key
    setActive(key)
    tabRefs.current[key]?.focus()
  }, [])

  return (
    <div
      className="pointer-events-none absolute inset-x-0 bottom-0 z-30 px-3"
      style={{ paddingBottom: `calc(max(10px, env(safe-area-inset-bottom)) + ${bottomGapCss})` }}
    >
      <div
        className="pointer-events-auto mx-auto w-full max-w-[420px] rounded-[18px] px-3 py-2 text-white"
        style={{ ...SHEET_GLASS, textShadow: '0 1px 2px rgba(0,0,0,0.35)' }}
      >
        {/* Header: Segmented-Tabs (Maß wählen) + Close */}
        <div className="flex items-center gap-2">
          <div
            role="tablist"
            aria-label="Maß wählen"
            className="flex flex-1 gap-0.5 rounded-[12px] bg-white/[0.06] p-0.5 ring-1 ring-white/10"
          >
            {TABS.map((t, i) => {
              const selected = active === t.key
              return (
                <button
                  key={t.key}
                  ref={(el) => {
                    tabRefs.current[t.key] = el
                  }}
                  type="button"
                  role="tab"
                  id={tabId(t.key)}
                  aria-selected={selected}
                  aria-controls={panelId(t.key)}
                  tabIndex={selected ? 0 : -1}
                  onClick={() => setActive(t.key)}
                  onKeyDown={(e) => onTabKeyDown(e, i)}
                  className={[
                    'flex-1 rounded-[10px] px-2 py-1.5 text-[12px] font-bold uppercase tracking-[0.3px] transition',
                    selected ? 'bg-white/15 text-white' : 'text-white/55 hover:text-white/80',
                  ].join(' ')}
                >
                  {t.label}
                </button>
              )
            })}
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Maße schließen"
            className="-mr-1 shrink-0 rounded-full p-1.5 text-white/60 hover:bg-white/10 hover:text-white active:scale-90"
          >
            <X className="size-[18px]" />
          </button>
        </div>

        {/* Panels — alle gemountet, inaktive `hidden` (State + Selektoren bleiben). */}
        <div className="mt-2">
          <div
            role="tabpanel"
            id={panelId('length')}
            hidden={active !== 'length'}
          >
            <CompactDimRow
              id={lengthId}
              label="Länge"
              unitLabel="m"
              value={lengthM}
              min={LENGTH_MIN_M}
              max={LENGTH_MAX_M}
              step={0.01}
              decimals={2}
              valid={lengthValid}
              onChange={onLength}
            />
          </div>

          <div
            role="tabpanel"
            id={panelId('height')}
            hidden={active !== 'height'}
          >
            <CompactDimRow
              id={heightId}
              label="Höhe"
              unitLabel="m"
              value={heightM}
              min={HEIGHT_MIN_M}
              max={HEIGHT_MAX_M}
              step={0.01}
              decimals={2}
              valid={heightValid}
              onChange={onHeight}
            />
            {/* "Höhe für alle Wände" — raises the whole room height in one edit. */}
            <label className="mt-2 flex cursor-pointer items-center gap-2 rounded-[10px] bg-white/[0.05] px-2.5 py-1.5 ring-1 ring-white/12">
              <input
                type="checkbox"
                checked={applyAll}
                onChange={(e) => onApplyAll(e.target.checked)}
                className="size-4 shrink-0 accent-blue-500"
              />
              <span className="text-[11px] leading-snug text-white/75">
                <span className="font-semibold text-white">Höhe für alle Wände</span>
                <span className="ml-1 text-white/55">— Raumhöhe, nicht nur diese Wand.</span>
              </span>
            </label>
          </div>

          <div
            role="tabpanel"
            id={panelId('thickness')}
            hidden={active !== 'thickness'}
          >
            <CompactDimRow
              id={thicknessId}
              label="Dicke"
              unitLabel="cm"
              value={thicknessCm}
              min={THICKNESS_MIN_CM}
              max={THICKNESS_MAX_CM}
              step={0.5}
              decimals={1}
              valid={thicknessValid}
              onChange={onThickness}
            />
          </div>
        </div>

        {/* Split → adds a corner so an L/U shape can be formed by sliding a half.
            Global (outside the panels) so it's reachable from every tab. */}
        {onSplitWall && (
          <button
            type="button"
            onClick={onSplitWall}
            className="mt-2 flex w-full items-center justify-center gap-1.5 rounded-[10px] bg-white/[0.06] py-1.5 text-[12px] font-semibold text-white/85 ring-1 ring-white/12 transition active:scale-[0.98] hover:bg-white/[0.1]"
          >
            <Scissors className="size-[14px]" aria-hidden="true" />
            Ecke einfügen (Wand teilen)
          </button>
        )}
      </div>
    </div>
  )
}
