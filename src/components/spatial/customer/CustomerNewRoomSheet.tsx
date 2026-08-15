/**
 * Spatial · CAD Lane V1.5.1 · CustomerNewRoomSheet
 *
 * Two-state bottom sheet that drives the Customer-Self-Scan entry-point
 * (Mockup 05 `05-new-room-sheet.html`):
 *
 *   - **State 1 (`picker`)** — 2×2 grid of preset cards (Bad / Küche /
 *     Wohnzimmer / Schlafzimmer) plus, when wired by the caller, a
 *     "📐 Mit iPhone scannen"-tile (LiDAR · Phase 2) and a "✨ Leerer Raum"-
 *     tile (Custom-Canvas · Phase 3, B4-D3). Picking a preset pre-fills the
 *     editor's name + dimensions and transitions to State 2; the LiDAR and
 *     Custom-Canvas tiles fire callbacks and let the parent route the user
 *     to a dedicated capture / canvas surface (sibling sheets).
 *   - **State 2 (`editor`)** — name input, an animated dollhouse-preview
 *     box that reflects the live dimensions, three measure cards (width /
 *     length / height), and a ±10 cm / ±5 cm stepper on the active axis.
 *     The save CTA fires {@link createCustomerManualScene} and reports
 *     success / failure back to the caller.
 *
 * The component is layer-pure: it dispatches into the spatial workflow
 * and emits toasts. It owns its picker → editor → submitting state
 * internally; the caller only sees `open` + `onClose` + `onCreated` plus
 * the optional LiDAR + Custom-Canvas tap callbacks.
 */

import { useCallback, useEffect, useMemo, useState, type ReactElement } from 'react'

import BottomSheet from '../../ui/BottomSheet'
import { useToast } from '../../../hooks/useToast'
import {
  CUSTOMER_ROOM_PRESETS,
  CUSTOMER_ROOM_PRESET_KINDS,
  type CustomerRoomPresetKind,
} from '../../../lib/spatial/canonical/presets/presetCustomerRooms'
import {
  createCustomerManualScene,
  type CreateCustomerManualSceneSuccess,
} from '../../../lib/spatial/workflow/createCustomerManualScene'
import MeasureWithRulerSheet from './MeasureWithRulerSheet'

const HEIGHT_STEP_CM = 5
const FOOTPRINT_STEP_CM = 10
const MIN_AXIS_CM = 100
const MAX_AXIS_CM = 1500
const MIN_HEIGHT_CM = 200
const MAX_HEIGHT_CM = 400

type ActiveAxis = 'width' | 'length' | 'height'
type SheetState = 'picker' | 'editor'

export interface CustomerNewRoomSheetProps {
  open: boolean
  onClose: () => void
  /** Fired after the workflow successfully lands a new scene. */
  onCreated?: (result: CreateCustomerManualSceneSuccess) => void
  /** V1.6 Phase 2: when true, render the "📐 Mit iPhone scannen" LiDAR tile
   *  above the preset grid. null = probe still running (skeleton shown).
   *  false = hidden entirely (Manual + Custom-Canvas remain available).
   *  Wired by the calling screen from useStartCustomerLidarScan.lidarAvailable. */
  lidarAvailable?: boolean | null
  /** V1.6 Phase 2: fired when the user taps the LiDAR tile. The caller is
   *  responsible for the DSGVO-consent gate + navigation to the capture screen.
   *  Pass undefined to hide the tile (same effect as lidarAvailable=false). */
  onLidarTap?: () => void
  /** V1.6 Phase 3 (B4-D3): fired when the user taps the "Leerer Raum"-tile.
   *  The caller is responsible for opening a sibling `CustomerCustomCanvasSheet`
   *  (and closing this picker first). Pass undefined to hide the tile. */
  onCustomCanvasTap?: () => void
}

export default function CustomerNewRoomSheet({
  open,
  onClose,
  onCreated,
  lidarAvailable,
  onLidarTap,
  onCustomCanvasTap,
}: CustomerNewRoomSheetProps) {
  const toast = useToast()
  const [state, setState] = useState<SheetState>('picker')
  const [presetKind, setPresetKind] = useState<CustomerRoomPresetKind>('bath')
  const [name, setName] = useState('')
  const [widthCm, setWidthCm] = useState(220)
  const [lengthCm, setLengthCm] = useState(320)
  const [heightCm, setHeightCm] = useState(260)
  const [activeAxis, setActiveAxis] = useState<ActiveAxis>('width')
  const [submitting, setSubmitting] = useState(false)

  // Reset to picker every time the sheet (re-)opens so a previous draft
  // doesn't bleed into the next session. Pushed onto the microtask queue so
  // the state write doesn't fire synchronously inside the render-driven
  // effect (`react-hooks/set-state-in-effect`).
  useEffect(() => {
    if (!open) return
    let alive = true
    void Promise.resolve().then(() => {
      if (!alive) return
      setState('picker')
      setSubmitting(false)
    })
    return () => {
      alive = false
    }
  }, [open])

  const handlePick = useCallback((kind: CustomerRoomPresetKind) => {
    const preset = CUSTOMER_ROOM_PRESETS[kind]
    setPresetKind(kind)
    setName(preset.label)
    setWidthCm(Math.round(preset.defaultWidthM * 100))
    setLengthCm(Math.round(preset.defaultLengthM * 100))
    setHeightCm(Math.round(preset.defaultHeightM * 100))
    setActiveAxis('width')
    setState('editor')
  }, [])

  // Phase 3 (B4-D3) replaced the legacy "Individuell"-card (which silently
  // reused the Bath-preset dimensions — Caveat #3) with a dedicated
  // `CustomerCustomCanvasSheet`. The picker now fires `onCustomCanvasTap`
  // and the parent screen owns the sibling sheet — no editor-state branch
  // lives here for the Custom-Canvas path anymore.

  const handleSubmit = useCallback(async () => {
    if (submitting) return
    setSubmitting(true)
    const result = await createCustomerManualScene({
      presetKind,
      name: name.trim() || CUSTOMER_ROOM_PRESETS[presetKind].label,
      widthM: widthCm / 100,
      lengthM: lengthCm / 100,
      heightM: heightCm / 100,
    })
    setSubmitting(false)
    if (result.ok) {
      toast.success('Raum angelegt ✓')
      onCreated?.(result)
      onClose()
      return
    }
    toast.error(result.message || 'Raum konnte nicht angelegt werden.')
  }, [submitting, presetKind, name, widthCm, lengthCm, heightCm, toast, onCreated, onClose])

  const activeValueCm = activeAxis === 'width'
    ? widthCm
    : activeAxis === 'length'
      ? lengthCm
      : heightCm
  const activeStepCm = activeAxis === 'height' ? HEIGHT_STEP_CM : FOOTPRINT_STEP_CM
  const activeMinCm = activeAxis === 'height' ? MIN_HEIGHT_CM : MIN_AXIS_CM
  const activeMaxCm = activeAxis === 'height' ? MAX_HEIGHT_CM : MAX_AXIS_CM

  const adjustActive = useCallback((delta: number) => {
    const setter = activeAxis === 'width'
      ? setWidthCm
      : activeAxis === 'length'
        ? setLengthCm
        : setHeightCm
    setter((current) => clamp(current + delta, activeMinCm, activeMaxCm))
  }, [activeAxis, activeMinCm, activeMaxCm])

  const areaM2 = useMemo(
    () => (widthCm / 100) * (lengthCm / 100),
    [widthCm, lengthCm],
  )

  // Phase 4 · Ruler-tip overlay is rendered as a sibling sheet that visually
  // covers the EditorBody on first-run. Auto-skips via the persisted flag
  // (see MeasureWithRulerSheet), so returning customers never see it. The
  // callbacks are no-ops because the sheet persists its own flag internally.
  const showRulerTip = state === 'editor'

  return (
    <>
      <BottomSheet
        open={open}
        onClose={submitting ? () => undefined : onClose}
        maxWidth={460}
        className="!bg-slate-900/95 !text-white border border-white/10 backdrop-blur-2xl"
      >
        {state === 'picker' ? (
          <PickerBody
            onPick={handlePick}
            onClose={onClose}
            lidarAvailable={lidarAvailable}
            onLidarTap={onLidarTap}
            onCustomCanvasTap={onCustomCanvasTap}
          />
        ) : (
          <EditorBody
            name={name}
            setName={setName}
            presetLabel={CUSTOMER_ROOM_PRESETS[presetKind].label}
            widthCm={widthCm}
            lengthCm={lengthCm}
            heightCm={heightCm}
            areaM2={areaM2}
            activeAxis={activeAxis}
            setActiveAxis={setActiveAxis}
            activeValueCm={activeValueCm}
            activeStepCm={activeStepCm}
            onStepDelta={adjustActive}
            onBack={() => setState('picker')}
            onSubmit={() => void handleSubmit()}
            submitting={submitting}
          />
        )}
      </BottomSheet>

      {open && showRulerTip && (
        <MeasureWithRulerSheet open onDone={() => {}} onSkip={() => {}} />
      )}
    </>
  )
}

// ────────────────────────────────────────────────────────────────────────────
// Picker
// ────────────────────────────────────────────────────────────────────────────

function PickerBody({
  onPick,
  onClose,
  lidarAvailable,
  onLidarTap,
  onCustomCanvasTap,
}: {
  onPick: (kind: CustomerRoomPresetKind) => void
  onClose: () => void
  lidarAvailable?: boolean | null
  onLidarTap?: () => void
  onCustomCanvasTap?: () => void
}) {
  const showLidarTile = lidarAvailable !== false && onLidarTap !== undefined
  const lidarTileLoading = lidarAvailable === null
  const showCustomCanvasTile = onCustomCanvasTap !== undefined
  return (
    <>
      <SheetHeader title="Neuen Raum anlegen" subtitle="Vorlage wählen oder individuell" onClose={onClose} />

      {showLidarTile && (
        <>
          <div className="mt-2 text-[11px] font-semibold uppercase tracking-wider text-white/55">
            3D-Scan
          </div>
          {lidarTileLoading ? (
            <div
              aria-busy="true"
              aria-label="LiDAR-Verfügbarkeit wird geprüft"
              className="mt-3 h-[68px] animate-pulse rounded-2xl border border-white/10 bg-white/5"
            />
          ) : (
            <button
              type="button"
              onClick={onLidarTap}
              className="mt-3 flex w-full items-center gap-3 rounded-2xl border border-sky-400/30 bg-gradient-to-br from-sky-500/15 to-blue-600/10 p-3.5 text-left transition hover:border-sky-300/50 hover:from-sky-500/25 hover:to-blue-600/15 focus:outline-none focus:ring-2 focus:ring-sky-400/60"
            >
              <span aria-hidden className="grid h-11 w-11 place-items-center rounded-xl bg-sky-500/25 text-2xl">
                📐
              </span>
              <span className="flex-1">
                <span className="block text-sm font-bold text-white">Mit iPhone scannen</span>
                <span className="mt-0.5 block text-[11px] text-white/65">
                  iPhone Pro / iPad Pro — exakte Maße in 60 Sek
                </span>
              </span>
              <span aria-hidden className="text-white/40">
                <svg viewBox="0 0 24 24" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round">
                  <path d="M9 6l6 6-6 6" />
                </svg>
              </span>
            </button>
          )}
        </>
      )}

      <div className={`${showLidarTile ? 'mt-4' : 'mt-2'} text-[11px] font-semibold uppercase tracking-wider text-white/55`}>
        Vorlagen
      </div>
      <div className="mt-3 grid grid-cols-2 gap-2.5">
        {CUSTOMER_ROOM_PRESET_KINDS.map((kind) => {
          const preset = CUSTOMER_ROOM_PRESETS[kind]
          return (
            <button
              key={kind}
              type="button"
              onClick={() => onPick(kind)}
              className="flex flex-col gap-2 rounded-2xl border border-white/10 bg-white/5 p-3 text-left transition hover:border-white/20 hover:bg-white/10 focus:outline-none focus:ring-2 focus:ring-sky-400/60"
            >
              <div className="flex items-start justify-between">
                <PresetIcon kind={kind} />
                <span className="rounded-full bg-sky-500/20 px-2 py-0.5 text-[10px] font-semibold text-sky-200">
                  ~{preset.approxAreaM2} m²
                </span>
              </div>
              <div className="text-sm font-semibold text-white">{preset.label}</div>
            </button>
          )
        })}
      </div>

      {showCustomCanvasTile && (
        <button
          type="button"
          onClick={onCustomCanvasTap}
          className="mt-3 flex w-full items-center justify-center gap-2 rounded-2xl border border-dashed border-white/20 bg-transparent p-3 text-sm font-semibold text-white/80 transition hover:border-white/40 hover:bg-white/5 focus:outline-none focus:ring-2 focus:ring-sky-400/60"
        >
          <span aria-hidden className="text-base">✨</span>
          <span>Leerer Raum</span>
          <span aria-hidden className="text-[11px] font-normal text-white/55">
            · eigene Maße
          </span>
        </button>
      )}
    </>
  )
}

function PresetIcon({ kind }: { kind: CustomerRoomPresetKind }) {
  // Tiny line-art glyph per preset — mirrors the picker mockup. Each card has
  // its own SVG to make the picker feel less generic than identical icons.
  const path: Record<CustomerRoomPresetKind, ReactElement> = {
    bath: (
      <>
        <rect x="3" y="4" width="18" height="16" rx="2" />
        <circle cx="8" cy="10" r="2" />
        <rect x="13" y="9" width="6" height="9" rx="1" />
      </>
    ),
    kitchen: (
      <>
        <rect x="3" y="4" width="18" height="16" rx="2" />
        <path d="M3 12h18M9 4v8M15 12v8" />
      </>
    ),
    living: (
      <>
        <rect x="3" y="6" width="18" height="14" rx="2" />
        <path d="M3 14h18M7 14v-3M17 14v-3" />
      </>
    ),
    bedroom: (
      <>
        <rect x="3" y="10" width="18" height="10" rx="2" />
        <path d="M3 10V8a2 2 0 012-2h14a2 2 0 012 2v2" />
      </>
    ),
    // The Custom-Canvas tile sits outside the preset grid, so this icon is
    // never rendered today. Kept exhaustive for the Record<…> type guard.
    custom: (
      <>
        <rect x="4" y="4" width="16" height="16" rx="2" strokeDasharray="3 3" />
      </>
    ),
  }
  return (
    <div className="grid h-9 w-9 place-items-center rounded-xl bg-sky-500/20">
      <svg viewBox="0 0 24 24" className="h-[18px] w-[18px]" fill="none" stroke="#93c5fd" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
        {path[kind]}
      </svg>
    </div>
  )
}

// ────────────────────────────────────────────────────────────────────────────
// Editor
// ────────────────────────────────────────────────────────────────────────────

interface EditorBodyProps {
  name: string
  setName: (v: string) => void
  presetLabel: string
  widthCm: number
  lengthCm: number
  heightCm: number
  areaM2: number
  activeAxis: ActiveAxis
  setActiveAxis: (axis: ActiveAxis) => void
  activeValueCm: number
  activeStepCm: number
  onStepDelta: (delta: number) => void
  onBack: () => void
  onSubmit: () => void
  submitting: boolean
}

function EditorBody({
  name,
  setName,
  presetLabel,
  widthCm,
  lengthCm,
  heightCm,
  areaM2,
  activeAxis,
  setActiveAxis,
  activeValueCm,
  activeStepCm,
  onStepDelta,
  onBack,
  onSubmit,
  submitting,
}: EditorBodyProps) {
  return (
    <>
      <SheetHeader
        title={name || 'Neuer Raum'}
        subtitle={`Vorlage: ${presetLabel} · ~${areaM2.toFixed(1)} m²`}
        onBack={onBack}
        onClose={undefined}
      />

      <div className="mt-2 text-[11px] font-semibold uppercase tracking-wider text-white/55">
        Name
      </div>
      <input
        value={name}
        onChange={(e) => setName(e.target.value)}
        placeholder={`z.B. ${presetLabel}`}
        className="mt-2 w-full rounded-xl border border-white/10 bg-white/5 px-3 py-2.5 text-base font-semibold text-white placeholder-white/40 focus:border-sky-400 focus:outline-none focus:ring-2 focus:ring-sky-400/30"
      />

      <div className="mt-4 text-[11px] font-semibold uppercase tracking-wider text-white/55">
        Vorschau · ändert sich live
      </div>
      <PreviewBox widthCm={widthCm} lengthCm={lengthCm} heightCm={heightCm} activeAxis={activeAxis} />

      <div className="mt-4 text-[11px] font-semibold uppercase tracking-wider text-white/55">
        Grundfläche
      </div>
      <div className="mt-2 grid grid-cols-2 gap-2.5">
        <MeasureCard
          label="Breite"
          valueCm={widthCm}
          active={activeAxis === 'width'}
          onClick={() => setActiveAxis('width')}
        />
        <MeasureCard
          label="Länge"
          valueCm={lengthCm}
          active={activeAxis === 'length'}
          onClick={() => setActiveAxis('length')}
        />
      </div>

      <button
        type="button"
        onClick={() => setActiveAxis('height')}
        className={`mt-2.5 flex w-full items-center gap-3 rounded-xl border px-3 py-3 text-left transition ${
          activeAxis === 'height'
            ? 'border-sky-400/60 bg-sky-500/15'
            : 'border-white/10 bg-white/5 hover:bg-white/10'
        }`}
      >
        <div className="grid h-8 w-8 place-items-center rounded-lg bg-white/10">
          <svg viewBox="0 0 24 24" className="h-4 w-4 stroke-white/80" fill="none" strokeWidth="1.9">
            <path d="M12 3v18M5 6l7-3 7 3M5 18l7 3 7-3" />
          </svg>
        </div>
        <div className="flex-1 text-sm font-semibold text-white">Raumhöhe</div>
        <div className="text-sm font-semibold text-white">
          {heightCm}
          <span className="ml-0.5 text-[11px] text-white/55">cm</span>
        </div>
      </button>

      <div className="mt-4 flex items-center gap-3">
        <StepperButton onClick={() => onStepDelta(-activeStepCm)} disabled={submitting} sign="-" />
        <div className="flex flex-1 items-center justify-between rounded-2xl border border-white/10 bg-white/5 px-4 py-3">
          <span className="text-[11px] font-semibold uppercase tracking-wider text-white/55">
            {axisLabel(activeAxis)} · ±{activeStepCm} cm
          </span>
          <span className="text-base font-bold text-white">
            {activeValueCm}
            <span className="ml-0.5 text-[11px] text-white/55">cm</span>
          </span>
        </div>
        <StepperButton onClick={() => onStepDelta(activeStepCm)} disabled={submitting} sign="+" />
      </div>

      <button
        type="button"
        onClick={onSubmit}
        disabled={submitting}
        className="mt-4 w-full rounded-2xl bg-gradient-to-br from-sky-500 to-blue-600 px-4 py-3.5 text-sm font-bold text-white shadow-lg shadow-sky-900/40 transition hover:from-sky-400 hover:to-blue-500 disabled:opacity-60"
      >
        {submitting ? 'Wird angelegt…' : 'Raum anlegen'}
      </button>
    </>
  )
}

function MeasureCard({
  label,
  valueCm,
  active,
  onClick,
}: {
  label: string
  valueCm: number
  active: boolean
  onClick: () => void
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`flex flex-col gap-1 rounded-xl border px-3 py-3 text-left transition ${
        active ? 'border-sky-400/60 bg-sky-500/15' : 'border-white/10 bg-white/5 hover:bg-white/10'
      }`}
    >
      <span className="text-[11px] font-semibold uppercase tracking-wider text-white/55">{label}</span>
      <span className="text-xl font-bold text-white">
        {valueCm}
        <span className="ml-0.5 text-[11px] text-white/55">cm</span>
      </span>
      <span className="text-[10px] text-white/40">
        {active ? 'Unten anpassen ↓' : 'Tap zum Bearbeiten'}
      </span>
    </button>
  )
}

function PreviewBox({
  widthCm,
  lengthCm,
  heightCm,
  activeAxis,
}: {
  widthCm: number
  lengthCm: number
  heightCm: number
  activeAxis: ActiveAxis
}) {
  // Tiny dollhouse: scale the dimensions onto a fixed canvas so the box
  // grows/shrinks as the user steppers. The active axis pulses sky-blue so
  // the editor confirms the input visually.
  const scale = 0.18
  const boxW = clamp(widthCm * scale, 60, 220)
  const boxL = clamp(lengthCm * scale, 60, 180)
  const boxH = clamp(heightCm * scale, 30, 80)
  return (
    <div className="mt-2 grid h-[150px] place-items-center rounded-2xl border border-white/10 bg-gradient-to-br from-slate-800/60 to-slate-900/60">
      <div
        className="relative transition-all duration-300"
        style={{
          width: `${boxW}px`,
          height: `${boxL}px`,
          transform: 'perspective(700px) rotateX(48deg)',
        }}
      >
        <div className="absolute inset-0 rounded-md border border-sky-400/30 bg-sky-500/10" />
        <div
          className={`absolute bottom-full left-0 right-0 origin-bottom rounded-t-md border border-sky-400/40 ${
            activeAxis === 'height' ? 'border-sky-300 bg-sky-400/30' : 'bg-sky-500/15'
          }`}
          style={{ height: `${boxH}px`, transform: 'rotateX(-90deg)', transformOrigin: 'bottom' }}
        />
      </div>
    </div>
  )
}

function StepperButton({ onClick, disabled, sign }: { onClick: () => void; disabled: boolean; sign: '-' | '+' }) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className="grid h-12 w-12 place-items-center rounded-2xl border border-white/15 bg-gradient-to-b from-white/15 to-white/5 text-xl font-bold text-white shadow-md transition hover:from-white/25 hover:to-white/10 disabled:opacity-50"
      aria-label={sign === '+' ? 'Erhöhen' : 'Verringern'}
    >
      {sign}
    </button>
  )
}

function SheetHeader({
  title,
  subtitle,
  onBack,
  onClose,
}: {
  title: string
  subtitle?: string
  onBack?: () => void
  onClose?: () => void
}) {
  return (
    <div className="flex items-start gap-3">
      {onBack && (
        <button
          type="button"
          onClick={onBack}
          className="grid h-9 w-9 place-items-center rounded-xl bg-white/8 text-white/80 transition hover:bg-white/15"
          aria-label="Zurück"
        >
          <svg viewBox="0 0 24 24" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round">
            <path d="M15 6l-6 6 6 6" />
          </svg>
        </button>
      )}
      <div className="flex-1">
        <h3 className="text-base font-bold text-white">{title}</h3>
        {subtitle && <p className="mt-0.5 text-xs text-white/60">{subtitle}</p>}
      </div>
      {onClose && (
        <button
          type="button"
          onClick={onClose}
          className="grid h-8 w-8 place-items-center rounded-lg bg-white/8 text-white/70 transition hover:bg-white/15"
          aria-label="Schließen"
        >
          <svg viewBox="0 0 24 24" className="h-3.5 w-3.5" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round">
            <path d="M6 6l12 12M18 6L6 18" />
          </svg>
        </button>
      )}
    </div>
  )
}

// ────────────────────────────────────────────────────────────────────────────
// Helpers
// ────────────────────────────────────────────────────────────────────────────

function clamp(v: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, v))
}

function axisLabel(axis: ActiveAxis): string {
  if (axis === 'width') return 'Breite'
  if (axis === 'length') return 'Länge'
  return 'Höhe'
}
