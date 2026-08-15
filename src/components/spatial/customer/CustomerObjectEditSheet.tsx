/**
 * Spatial · V1.6.1 R13 · CustomerObjectEditSheet
 *
 * Floating bottom-sheet zum Bearbeiten eines gerade gesetzten Objekts in der
 * Wand (Tür / Fenster / Heizung / Steckdose / …). Pattern: Smart-Defaults
 * direkt beim Tap, dann Sliders zum Feintunen. Live-Preview in 3D — jeder
 * Slider-Drag mutiert die Scene sofort, debouncter Persist-Push.
 *
 * Layout-Lessons (V1.6.1 Mockups + WallEditSheet R11-C):
 *   - Liquid-Glass dark + warmer Akzent (matched HubScreen Liquid-Glass v3)
 *   - Drag-handle oben, Header mit Object-Type + Wand-Label (z.B. "Tür · Nord 1")
 *   - 2-3 Sliders je nach Tool-Type, Numeric-Badge zeigt aktuellen Wert
 *   - Bottom-Row: "Löschen" (destruktiv, links) + "Fertig" (primary, rechts)
 *
 * UX-Convention:
 *   - Drag schließt Sheet OHNE löschen → Save-State bleibt
 *   - "Löschen" entfernt das Objekt aus der Wand (mit RPC-Sync)
 *   - "Fertig" schließt das Sheet nur (Persist ist debounced via parent)
 *   - Esc-Key analog "Fertig"
 *
 * Phase 1: Tür only. Phase 2 klont Pattern für Fenster/Heizung/Elektro mit
 * eigenem Slider-Set + Defaults (z.B. height_from_floor für Heizung).
 */

import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react'

import type { DinWarning } from '../../../lib/spatial/canonical/validator/wallObjectDinValidator'
import { SegmentedTabs, tabPanelProps } from '../ui/SegmentedTabs'
import { OBJECT_FIELD_TABS, isObjectSheetTabbed } from './objectFieldConfig'

export type CustomerObjectToolKind = 'door' | 'window' | 'heating' | 'electrical' | 'fusebox'

/** Slider-Konfiguration pro Tool-Type. Werte in CM für intuitive Inputs. */
export interface ObjectSliderConfig {
  /** Position vom Wand-Anfang. */
  positionCm: { min: number; max: number; step: number }
  /** Breite (entlang der Wand). */
  widthCm: { min: number; max: number; step: number }
  /** Höhe (vertikal). */
  heightCm: { min: number; max: number; step: number }
  /** Bodenabstand (Unterkante zum Boden). */
  offsetFromFloorCm: { min: number; max: number; step: number; show: boolean }
}

/**
 * Tool-Type-Defaults gemäß DIN/VDE für deutsche Wohnungen.
 *   - Tür: DIN 18101 — 86 × 198,5 cm, Bodenkante 0
 *   - Fenster: DIN 4172 — 100 × 125 cm, Brüstung 90 cm
 *   - (Heizung/Elektro: Phase 2)
 */
// eslint-disable-next-line react-refresh/only-export-components
export const OBJECT_DEFAULTS_CM: Record<
  CustomerObjectToolKind,
  { widthCm: number; heightCm: number; offsetFromFloorCm: number }
> = {
  door: { widthCm: 86, heightCm: 198, offsetFromFloorCm: 0 },
  window: { widthCm: 100, heightCm: 125, offsetFromFloorCm: 90 },
  heating: { widthCm: 60, heightCm: 160, offsetFromFloorCm: 15 },
  electrical: { widthCm: 12, heightCm: 10, offsetFromFloorCm: 30 },
  fusebox: { widthCm: 30, heightCm: 40, offsetFromFloorCm: 140 },
}

// eslint-disable-next-line react-refresh/only-export-components
export const OBJECT_SLIDER_CONFIGS: Record<CustomerObjectToolKind, ObjectSliderConfig> = {
  door: {
    positionCm: { min: 0, max: 1000, step: 1 },
    widthCm: { min: 70, max: 110, step: 1 },
    heightCm: { min: 180, max: 220, step: 1 },
    offsetFromFloorCm: { min: 0, max: 0, step: 1, show: false },
  },
  window: {
    positionCm: { min: 0, max: 1000, step: 1 },
    widthCm: { min: 60, max: 200, step: 5 },
    heightCm: { min: 60, max: 200, step: 5 },
    offsetFromFloorCm: { min: 60, max: 180, step: 5, show: true },
  },
  heating: {
    positionCm: { min: 0, max: 1000, step: 1 },
    widthCm: { min: 40, max: 200, step: 5 },
    heightCm: { min: 40, max: 200, step: 5 },
    offsetFromFloorCm: { min: 10, max: 150, step: 5, show: true },
  },
  electrical: {
    positionCm: { min: 0, max: 1000, step: 1 },
    widthCm: { min: 8, max: 50, step: 1 },
    heightCm: { min: 8, max: 50, step: 1 },
    offsetFromFloorCm: { min: 20, max: 120, step: 5, show: true },
  },
  fusebox: {
    positionCm: { min: 0, max: 1000, step: 1 },
    widthCm: { min: 20, max: 80, step: 1 },
    heightCm: { min: 20, max: 80, step: 1 },
    offsetFromFloorCm: { min: 80, max: 185, step: 5, show: true },
  },
}

const TOOL_LABELS: Record<CustomerObjectToolKind, string> = {
  door: 'Tür',
  window: 'Fenster',
  heating: 'Heizung',
  electrical: 'Steckdose',
  fusebox: 'Sicherungskasten',
}

export interface CustomerObjectEditSheetValue {
  /** Position auf der Wand (Mittelpunkt des Objekts), entlang start→end. */
  positionAlongWallM: number
  /** Breite des Objekts. */
  widthM: number
  /** Höhe des Objekts. */
  heightM: number
  /** Bodenabstand (Unterkante zum Boden). 0 für Tür. */
  offsetFromFloorM: number
}

export interface CustomerObjectEditSheetProps {
  open: boolean
  toolKind: CustomerObjectToolKind | null
  /**
   * Überschreibt das Tool-Default-Label im Header. Nötig für Elektro-Subtypen:
   * `toolKind='electrical'` deckt Steckdose UND Schalter ab, das Default-Label
   * ist aber „Steckdose" — bei einem Schalter würde der Header sonst falsch
   * „Steckdose" zeigen. Der Aufrufer leitet das echte Label aus der
   * `object.category` ab (light_switch → „Schalter").
   */
  headerLabelOverride?: string
  /** Wand-Label für Header (z.B. "Nord 1"). */
  wallLabel?: string
  /** Wand-Länge in Metern, begrenzt position-slider. */
  wallLengthM?: number
  /** Wand-Höhe in Metern, begrenzt height + offset (offset+height ≤ wallH). */
  wallHeightM?: number
  /** Aktuelle Werte des Objekts (für Slider-Bind). */
  value: CustomerObjectEditSheetValue
  /** Live-Mutation während des Slider-Drags (debounced persist in parent). */
  onChange: (next: CustomerObjectEditSheetValue) => void
  /** Save-Hinweis (z.B. "Speichert..." / "Gespeichert"). Optional. */
  saveHint?: string
  /**
   * Harte Geometrie-Kollision (Overlap) der letzten Slider-Änderung. Wenn
   * gesetzt, wurde die Änderung NICHT übernommen — der Slider springt auf die
   * letzte gültige Pose zurück und das Sheet zeigt den Konflikt rot an.
   */
  conflict?: string | null
  /** DIN/VDE-Soft-Hinweise zur aktuellen Pose (nicht blockierend). */
  dinWarnings?: DinWarning[]
  /** Persistente Lösch-Aktion mit Confirm. */
  onDelete: () => void
  /** Sheet schließen (Persist ist bereits debounced via onChange erfolgt). */
  onClose: () => void
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value))
}

function formatM(m: number): string {
  return `${m.toFixed(2).replace('.', ',')} m`
}

function formatCm(cm: number): string {
  return `${Math.round(cm)} cm`
}

/**
 * Hilfsfunktion: position-slider-max abhängig von wandLänge + Objekt-Breite.
 * Objekt-Mittelpunkt muss innerhalb [widthM/2, wallLengthM - widthM/2] liegen
 * damit das Objekt nicht aus der Wand rausragt.
 */
function clampPositionAlongWall(
  positionM: number,
  widthM: number,
  wallLengthM: number,
): number {
  const halfW = widthM / 2
  return clamp(positionM, halfW, Math.max(halfW, wallLengthM - halfW))
}

export default function CustomerObjectEditSheet({
  open,
  toolKind,
  headerLabelOverride,
  wallLabel,
  wallLengthM,
  wallHeightM,
  value,
  onChange,
  saveHint,
  conflict,
  dinWarnings,
  onDelete,
  onClose,
}: CustomerObjectEditSheetProps) {
  const [confirmDelete, setConfirmDelete] = useState(false)
  const deleteResetTimer = useRef<number | null>(null)
  // Which slider group is visible when the sheet splits into two tabs (4-field
  // kinds). Harmless to persist across reopen — every kind opens on 'place'.
  const [activeTab, setActiveTab] = useState<'place' | 'size'>('place')
  const tabsId = useId()

  // Esc schließt das Sheet.
  useEffect(() => {
    if (!open) return
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose()
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [open, onClose])

  useEffect(() => {
    if (open) return
    // setState off the synchronous render tick — same Pattern wie andere
    // Sheets im Customer-Hub (CustomerWallEditSheet useEffect). Also reset the
    // tab to 'place' so a reopen (the Hub mounts this sheet permanently and only
    // toggles `open`) doesn't reappear on the 'Größe' tab from the last edit.
    let alive = true
    void Promise.resolve().then(() => {
      if (!alive) return
      setConfirmDelete(false)
      setActiveTab('place')
    })
    return () => {
      alive = false
    }
  }, [open])

  useEffect(() => {
    return () => {
      if (deleteResetTimer.current) {
        clearTimeout(deleteResetTimer.current)
        deleteResetTimer.current = null
      }
    }
  }, [])

  const config = useMemo(
    () => (toolKind ? OBJECT_SLIDER_CONFIGS[toolKind] : null),
    [toolKind],
  )

  const handleSliderChange = useCallback(
    (field: keyof CustomerObjectEditSheetValue, valueCm: number) => {
      if (!config) return
      const next: CustomerObjectEditSheetValue = { ...value }
      if (field === 'widthM') {
        next.widthM = valueCm / 100
        if (wallLengthM !== undefined) {
          next.positionAlongWallM = clampPositionAlongWall(
            value.positionAlongWallM,
            next.widthM,
            wallLengthM,
          )
        }
      } else if (field === 'heightM') {
        next.heightM = valueCm / 100
        if (wallHeightM !== undefined) {
          const maxTop = wallHeightM - next.heightM
          next.offsetFromFloorM = clamp(value.offsetFromFloorM, 0, Math.max(0, maxTop))
        }
      } else if (field === 'offsetFromFloorM') {
        next.offsetFromFloorM = valueCm / 100
        if (wallHeightM !== undefined) {
          const maxTop = wallHeightM - next.heightM
          next.offsetFromFloorM = clamp(next.offsetFromFloorM, 0, Math.max(0, maxTop))
        }
      } else if (field === 'positionAlongWallM') {
        next.positionAlongWallM = valueCm / 100
        if (wallLengthM !== undefined) {
          next.positionAlongWallM = clampPositionAlongWall(
            next.positionAlongWallM,
            value.widthM,
            wallLengthM,
          )
        }
      }
      onChange(next)
    },
    [config, value, wallLengthM, wallHeightM, onChange],
  )

  const handleDeleteClick = useCallback(() => {
    if (!confirmDelete) {
      setConfirmDelete(true)
      // Reset confirm-state nach 3s wenn nicht bestätigt — verhindert
      // accidental-Delete bei späterem Reopen.
      if (deleteResetTimer.current) clearTimeout(deleteResetTimer.current)
      deleteResetTimer.current = window.setTimeout(() => {
        setConfirmDelete(false)
        deleteResetTimer.current = null
      }, 3000)
      return
    }
    if (deleteResetTimer.current) {
      clearTimeout(deleteResetTimer.current)
      deleteResetTimer.current = null
    }
    onDelete()
  }, [confirmDelete, onDelete])

  if (!open || !toolKind || !config) return null

  const toolLabel = headerLabelOverride ?? TOOL_LABELS[toolKind]
  const headerLabel = wallLabel ? `${toolLabel} · ${wallLabel}` : toolLabel

  // Position-Slider-Range dynamisch berechnet: cm-Skala bis wallLength*100
  // mit Margin vor / nach für die Objekt-Breite.
  const positionMaxCm =
    wallLengthM !== undefined
      ? Math.max(0, Math.round((wallLengthM - value.widthM) * 100))
      : config.positionCm.max
  const positionValueCm = Math.round(
    Math.max(0, value.positionAlongWallM * 100 - (value.widthM * 100) / 2),
  )

  // Heights respektieren wall-height (offset+height ≤ wandhöhe).
  const heightMaxCm =
    wallHeightM !== undefined
      ? Math.min(
          config.heightCm.max,
          Math.max(config.heightCm.min, Math.round((wallHeightM - value.offsetFromFloorM) * 100)),
        )
      : config.heightCm.max
  const offsetMaxCm =
    wallHeightM !== undefined
      ? Math.min(
          config.offsetFromFloorCm.max,
          Math.max(0, Math.round((wallHeightM - value.heightM) * 100)),
        )
      : config.offsetFromFloorCm.max

  const positionRow = (
    <SliderRow
      label="Position"
      valueLabel={
        wallLengthM !== undefined
          ? `${formatCm(positionValueCm)} · ${formatM(value.positionAlongWallM)} ab Wand-Anfang`
          : formatM(value.positionAlongWallM)
      }
      min={0}
      max={positionMaxCm}
      step={config.positionCm.step}
      value={positionValueCm}
      onChange={(cm) => {
        const centerM = (cm + value.widthM * 100 / 2) / 100
        if (wallLengthM !== undefined) {
          const clamped = clampPositionAlongWall(centerM, value.widthM, wallLengthM)
          onChange({ ...value, positionAlongWallM: clamped })
        } else {
          onChange({ ...value, positionAlongWallM: centerM })
        }
      }}
    />
  )
  const widthRow = (
    <SliderRow
      label="Breite"
      valueLabel={formatCm(value.widthM * 100)}
      min={config.widthCm.min}
      max={config.widthCm.max}
      step={config.widthCm.step}
      value={Math.round(value.widthM * 100)}
      onChange={(cm) => handleSliderChange('widthM', cm)}
    />
  )
  const heightRow = (
    <SliderRow
      label="Höhe"
      valueLabel={formatCm(value.heightM * 100)}
      min={config.heightCm.min}
      max={heightMaxCm}
      step={config.heightCm.step}
      value={Math.round(value.heightM * 100)}
      onChange={(cm) => handleSliderChange('heightM', cm)}
    />
  )
  const offsetRow = (
    <SliderRow
      label="Über Boden"
      valueLabel={formatCm(value.offsetFromFloorM * 100)}
      min={config.offsetFromFloorCm.min}
      max={offsetMaxCm}
      step={config.offsetFromFloorCm.step}
      value={Math.round(value.offsetFromFloorM * 100)}
      onChange={(cm) => handleSliderChange('offsetFromFloorM', cm)}
    />
  )

  const tabbed = isObjectSheetTabbed(config)

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="customer-object-edit-title"
      className="fixed inset-x-0 bottom-0 z-[60] flex justify-center px-3 pb-3 pointer-events-none"
    >
      <div
        className="relative w-full max-w-[440px] rounded-3xl px-5 pb-5 pt-4 text-white shadow-2xl pointer-events-auto"
        style={{
          background:
            'linear-gradient(180deg, rgba(20,28,48,0.92) 0%, rgba(15,21,37,0.96) 100%)',
          backdropFilter: 'blur(48px) saturate(220%)',
          WebkitBackdropFilter: 'blur(48px) saturate(220%)',
          border: '1px solid rgba(255,255,255,0.14)',
          paddingBottom: 'calc(env(safe-area-inset-bottom, 0px) + 1rem)',
        }}
      >
        {/* Drag-handle */}
        <button
          type="button"
          aria-label="Schließen"
          onClick={onClose}
          onPointerUp={(e) => {
            if (e.pointerType !== 'mouse') onClose()
          }}
          className="mx-auto mb-2 block h-1 w-10 rounded-full bg-white/24"
        />

        {/* Header */}
        <div className="flex items-start gap-3">
          <div className="flex-1 min-w-0">
            <h2
              id="customer-object-edit-title"
              className="text-[16px] font-bold leading-tight"
            >
              {headerLabel}
            </h2>
            {saveHint && (
              <p className="mt-0.5 text-[11px] text-white/55">{saveHint}</p>
            )}
          </div>
          <button
            type="button"
            aria-label="Schließen"
            onClick={onClose}
            onPointerUp={(e) => {
              if (e.pointerType !== 'mouse') onClose()
            }}
            className="flex h-7 w-7 items-center justify-center rounded-full bg-white/8 text-white/75 transition active:scale-95 hover:bg-white/16"
          >
            <svg viewBox="0 0 24 24" width={12} height={12} fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
              <path d="M6 6l12 12 M18 6l-12 12" />
            </svg>
          </button>
        </div>

        {/* Sliders — flach (3 Felder) ODER 2 Tabs (4 Felder, „Über Boden" sichtbar),
            sonst wird das Sheet zu hoch und deckt den Grundriss zu. */}
        {tabbed ? (
          <div className="mt-4">
            <SegmentedTabs
              tabs={OBJECT_FIELD_TABS}
              value={activeTab}
              onChange={setActiveTab}
              ariaLabel="Eigenschaft wählen"
              idBase={tabsId}
            />
            {/* Beide Panels bleiben gemountet (inaktives nur `hidden`), damit die
                Cross-Field-Clamps in handleSliderChange über Tab-Wechsel hinweg
                wirken und die Live-3D-Mutation/Konflikt-Revert unberührt bleibt. */}
            <div className="mt-3 space-y-3" {...tabPanelProps(tabsId, 'place', activeTab)}>
              {positionRow}
              {offsetRow}
            </div>
            <div className="mt-3 space-y-3" {...tabPanelProps(tabsId, 'size', activeTab)}>
              {widthRow}
              {heightRow}
            </div>
          </div>
        ) : (
          <div className="mt-4 space-y-3">
            {positionRow}
            {widthRow}
            {heightRow}
          </div>
        )}

        {/* DIN/Konflikt-Hinweise — Konflikt (hart, rot) gewinnt vor Soft-Warns (amber) */}
        {conflict ? (
          <div className="mt-4 rounded-2xl border border-rose-400/30 bg-rose-500/12 px-3.5 py-2.5">
            <p className="text-[12px] font-semibold leading-snug text-rose-200">{conflict}</p>
          </div>
        ) : dinWarnings && dinWarnings.length > 0 ? (
          <div className="mt-4 space-y-1.5 rounded-2xl border border-amber-300/25 bg-amber-400/10 px-3.5 py-2.5">
            {dinWarnings.map((w) => (
              <div key={w.code} className="flex items-start gap-2">
                <span className="mt-[3px] inline-flex shrink-0 items-center rounded-md bg-amber-300/18 px-1.5 py-0.5 text-[9px] font-bold uppercase tracking-wide text-amber-200/90">
                  {w.dinRef}
                </span>
                <p className="text-[11.5px] font-medium leading-snug text-amber-100/90">{w.message}</p>
              </div>
            ))}
          </div>
        ) : null}

        {/* Buttons */}
        <div className="mt-5 flex items-center gap-2">
          <button
            type="button"
            onClick={handleDeleteClick}
            onPointerUp={(e) => {
              if (e.pointerType !== 'mouse') handleDeleteClick()
            }}
            className={
              'flex-1 rounded-full px-4 py-3 text-[14px] font-semibold transition active:scale-[0.98] ' +
              (confirmDelete
                ? 'bg-rose-600/90 text-white shadow-lg shadow-rose-900/40'
                : 'bg-white/[0.06] text-white/82 hover:bg-white/[0.12]')
            }
          >
            {confirmDelete ? 'Wirklich löschen?' : 'Löschen'}
          </button>
          <button
            type="button"
            onClick={onClose}
            onPointerUp={(e) => {
              if (e.pointerType !== 'mouse') onClose()
            }}
            className="flex-1 rounded-full px-4 py-3 text-[14px] font-bold transition active:scale-[0.98]"
            style={{
              background: 'linear-gradient(135deg, #2563EB 0%, #1d4ed8 100%)',
              boxShadow: '0 6px 16px rgba(37,99,235,0.42), inset 0 1px 0 rgba(255,255,255,0.26)',
            }}
          >
            Fertig
          </button>
        </div>
      </div>
    </div>
  )
}

/** Standardisierte Slider-Row: Label · Wert · Track. */
function SliderRow({
  label,
  valueLabel,
  min,
  max,
  step,
  value,
  onChange,
}: {
  label: string
  valueLabel: string
  min: number
  max: number
  step: number
  value: number
  onChange: (next: number) => void
}) {
  return (
    <div>
      <div className="mb-1 flex items-baseline justify-between">
        <span className="text-[12px] font-semibold tracking-tight text-white/82">{label}</span>
        <span className="text-[12px] font-mono text-white/64">{valueLabel}</span>
      </div>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
        className="customer-object-slider w-full"
        style={{
          accentColor: '#2563EB',
        }}
      />
    </div>
  )
}
