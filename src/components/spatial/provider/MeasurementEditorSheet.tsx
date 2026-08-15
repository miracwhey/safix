/**
 * MeasurementEditorSheet — Maß-Editor leaf screen (Mockup 28 · Phase B · B-4 →
 * Phase C · C-3)
 *
 * Records a measurement correction for a scene element. Phase C makes it a
 * TWO-field editor — Breite + Höhe (Mockup 28) — so a wall correction can no
 * longer silently drop the height. A shared numeric keypad routes to whichever
 * field is focused; each field shows the scan reference + a live Δ delta.
 *
 * The save path calls `appendEditHistory(...)` with `command: 'set'` and the
 * REAL scene-graph node id (`baseNodeId`, C-3) so the audit trail is
 * node-attributable. Persistence stays best-effort here — the await-before-
 * close hardening is Block C-10's cross-cutting leaf-editor fix.
 */

import { useCallback, useMemo, useState } from 'react'

import BottomSheet from '../../ui/BottomSheet'
import { getSpatialSceneRepository } from '../../../lib/spatial/canonical/repository/registry'
import type { SpatialScene } from '../../../lib/spatial/canonical/repository/SpatialSceneRepository'
import { useHaptics } from '../../../hooks/useHaptics'

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

/** Which of the two measurement fields the keypad currently writes. */
type MeasureField = 'width' | 'height'

export interface MeasurementEditorSheetProps {
  open: boolean
  onClose: () => void
  scene: SpatialScene
  /** Node / element label shown in the subtitle (e.g. "Wand Nord · Bad"). */
  elementLabel?: string
  /**
   * Real scene-graph node id of the selected element — the audit `baseNodeId`
   * (C-3 hit-testing). Falls back to `elementLabel` when no node is selected.
   */
  baseNodeId?: string
  /** Current provider-override width in cm, or null when no override exists. */
  currentWidthCm: number | null
  /** Current provider-override height in cm, or null when no override exists. */
  currentHeightCm: number | null
  /**
   * Scan reference width in cm, or null when not available. When null the
   * scan-reference row + Δ delta are not rendered for the width field.
   */
  scanWidthCm: number | null
  /** Scan reference height in cm, or null when not available. */
  scanHeightCm: number | null
  /**
   * Variant layer id for the edit-history audit append.
   * Must be the role-correct `provider_*_annotations` variant id.
   */
  variantId: string
  /**
   * Called when the user confirms. A field left empty is reported as `null`
   * (the user corrected only the other dimension).
   */
  onSave: (widthCm: number | null, heightCm: number | null, reason: string) => void
}

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

/** Format cm value as "X,XX m" German notation. */
function formatM(cm: number): string {
  const m = cm / 100
  return m.toFixed(2).replace('.', ',') + ' m'
}

/** Signed delta string with + / − prefix, e.g. "Δ −4 cm". */
function formatDelta(valueCm: number, scanCm: number): string {
  const d = valueCm - scanCm
  if (Math.abs(d) < 0.5) return 'Δ 0 cm'
  const sign = d > 0 ? '+' : '−'
  return `Δ ${sign}${Math.abs(Math.round(d))} cm`
}

/** Parse a keypad string into a positive cm number, or null when empty/invalid. */
function parseCm(raw: string): number | null {
  const n = parseFloat(raw.replace(',', '.'))
  return Number.isFinite(n) && n > 0 ? n : null
}

/** Apply one keypad key to a raw input string. */
function applyKey(prev: string, key: string): string {
  if (key === 'backspace') return prev.slice(0, -1)
  if (key === ',' && prev.includes(',')) return prev
  if (key === ',' && prev === '') return '0,'
  if (prev.length >= 6) return prev // guard: max "9999,9"
  return prev + key
}

/** Initial keypad string for a cm value. */
function initialStr(cm: number | null): string {
  return cm != null ? String(Math.round(cm)) : ''
}

// ─────────────────────────────────────────────────────────────────────────────
// Module-level glyphs / sub-components (react-hooks/static-components rule)
// ─────────────────────────────────────────────────────────────────────────────

function BackspaceIcon() {
  return (
    <svg width="22" height="22" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path d="M9 5h11v14H9L3 12 9 5Z" stroke="currentColor" strokeWidth="1.7" strokeLinejoin="round" />
      <path d="M12 9.5 16 14M16 9.5 12 14" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" />
    </svg>
  )
}

/** One of the two measurement fields — tap to focus, keypad writes the focused one. */
function MeasureFieldCard({
  label,
  rawInput,
  parsedCm,
  scanCm,
  active,
  onActivate,
}: {
  label: string
  rawInput: string
  parsedCm: number | null
  scanCm: number | null
  active: boolean
  onActivate: () => void
}) {
  const deltaStr = parsedCm != null && scanCm != null ? formatDelta(parsedCm, scanCm) : null
  const deltaZero = parsedCm != null && scanCm != null && Math.abs(parsedCm - scanCm) < 0.5
  const deltaPositive = parsedCm != null && scanCm != null && parsedCm > scanCm

  return (
    <button
      type="button"
      onClick={onActivate}
      aria-label={`${label} bearbeiten`}
      aria-pressed={active}
      className={[
        'flex flex-col rounded-card border bg-white px-3 py-[11px] text-left transition',
        active
          ? 'border-[1.5px] border-brand shadow-[0_0_0_3px_rgba(37,99,235,0.12)]'
          : 'border-edge',
      ].join(' ')}
    >
      <p className="text-[10px] font-[700] uppercase tracking-[0.4px] text-ink-muted">{label}</p>
      <div className="mt-1 flex items-baseline gap-1">
        <span
          className={[
            'text-[27px] font-[800] leading-none tracking-tight',
            active ? 'text-brand-deep' : 'text-ink',
          ].join(' ')}
        >
          {rawInput || '—'}
        </span>
        {active && (
          <span
            className="mb-[2px] inline-block h-6 w-[2px] animate-pulse self-center rounded-[1px] bg-brand"
            aria-hidden="true"
          />
        )}
        <span className="text-[14px] font-[700] text-ink-muted">cm</span>
        <span className="ml-auto text-[12px] font-[600] text-ink-muted">
          {parsedCm != null ? formatM(parsedCm) : '—'}
        </span>
      </div>
      {scanCm != null && (
        <div className="mt-2 flex items-center gap-2 border-t border-edge pt-[7px]">
          <span className="text-[11px] text-ink-sub">
            Scan: <b className="font-[700] text-ink">{formatM(scanCm)}</b>
          </span>
          {deltaStr && (
            <span
              className={[
                'ml-auto rounded-chip px-[9px] py-[3px] text-[11px] font-[800]',
                deltaZero
                  ? 'bg-[#D1FAE5] text-ok'
                  : deltaPositive
                    ? 'bg-[#FEF3C7] text-warn'
                    : 'bg-[#E5EDFB] text-brand',
              ].join(' ')}
            >
              {deltaStr}
            </span>
          )}
        </div>
      )}
    </button>
  )
}

// ─────────────────────────────────────────────────────────────────────────────
// Component
// ─────────────────────────────────────────────────────────────────────────────

export function MeasurementEditorSheet({
  open,
  onClose,
  scene,
  elementLabel,
  baseNodeId,
  currentWidthCm,
  currentHeightCm,
  scanWidthCm,
  scanHeightCm,
  variantId,
  onSave,
}: MeasurementEditorSheetProps) {
  const haptics = useHaptics()

  const [widthInput, setWidthInput] = useState(() => initialStr(currentWidthCm))
  const [heightInput, setHeightInput] = useState(() => initialStr(currentHeightCm))
  const [activeField, setActiveField] = useState<MeasureField>('width')
  const [reason, setReason] = useState('')
  const [saving, setSaving] = useState(false)
  const [saveError, setSaveError] = useState<string | null>(null)

  // Reset the fields when the sheet re-opens — the host keeps it mounted and
  // toggles `open`, so without this a re-open for a different node would show
  // the previous node's values.
  const [prevOpen, setPrevOpen] = useState(open)
  if (open !== prevOpen) {
    setPrevOpen(open)
    if (open) {
      setWidthInput(initialStr(currentWidthCm))
      setHeightInput(initialStr(currentHeightCm))
      setActiveField('width')
      setReason('')
      setSaveError(null)
    }
  }

  const parsedWidth = useMemo(() => parseCm(widthInput), [widthInput])
  const parsedHeight = useMemo(() => parseCm(heightInput), [heightInput])
  const canSave = parsedWidth != null || parsedHeight != null

  // ── Keypad input — routes to the focused field ────────────────────────────

  const handleKey = useCallback(
    (key: string) => {
      haptics.selection()
      const setter = activeField === 'width' ? setWidthInput : setHeightInput
      setter((prev) => applyKey(prev, key))
    },
    [haptics, activeField],
  )

  // ── Save ──────────────────────────────────────────────────────────────────

  const handleSave = useCallback(async () => {
    if (!canSave || saving) return
    setSaving(true)
    setSaveError(null)

    // C-10: the audit append is AWAITED before close — a persistence failure
    // keeps the sheet open with a visible error instead of silently dropping
    // the correction (CLAUDE.md "no placeholder production logic in core flows").
    try {
      await getSpatialSceneRepository().appendEditHistory({
        sceneId: scene.id,
        variantId,
        baseNodeId: baseNodeId ?? elementLabel ?? 'unknown',
        overrideFields: {
          width_cm: parsedWidth,
          height_cm: parsedHeight,
          reason,
        },
        command: 'set',
        parametricSha256Before: scene.parametricSha256,
        parametricSha256After: null,
      })
      haptics.success()
      onSave(parsedWidth, parsedHeight, reason)
      onClose()
    } catch {
      setSaveError('Maß konnte nicht gespeichert werden. Bitte erneut versuchen.')
    } finally {
      setSaving(false)
    }
  }, [
    canSave,
    saving,
    parsedWidth,
    parsedHeight,
    reason,
    variantId,
    scene,
    baseNodeId,
    elementLabel,
    onSave,
    onClose,
    haptics,
  ])

  return (
    <BottomSheet
      open={open}
      onClose={onClose}
      maxWidth={480}
      hideHandle
      className="!px-0 !pt-0 !pb-0 !rounded-t-[26px]"
    >
      {/* Sheet handle */}
      <div className="mx-auto mb-1 mt-2 h-[5px] w-9 rounded-full bg-slate-900/20" aria-hidden="true" />

      {/* Header */}
      <div className="flex items-center justify-between border-b border-edge px-4 pb-3 pt-1.5">
        <div>
          <p className="text-[16px] font-[750] text-ink">Maß bearbeiten</p>
          {elementLabel && (
            <p className="mt-[1px] text-[11.5px] text-ink-muted">{elementLabel}</p>
          )}
        </div>
        <button
          type="button"
          onClick={onClose}
          aria-label="Schließen"
          className="flex h-7 w-7 items-center justify-center rounded-full bg-canvas text-ink-sub"
        >
          <svg width="12" height="12" viewBox="0 0 12 12" fill="none" aria-hidden="true">
            <path d="M3 3l6 6M9 3l-6 6" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
          </svg>
        </button>
      </div>

      {/* Body */}
      <div className="flex-1 overflow-y-auto px-4 pb-2 pt-3.5">
        {/* Two measurement fields — tap to focus, keypad writes the focused one */}
        <div className="flex flex-col gap-2.5">
          <MeasureFieldCard
            label="Breite"
            rawInput={widthInput}
            parsedCm={parsedWidth}
            scanCm={scanWidthCm}
            active={activeField === 'width'}
            onActivate={() => {
              haptics.selection()
              setActiveField('width')
            }}
          />
          <MeasureFieldCard
            label="Höhe"
            rawInput={heightInput}
            parsedCm={parsedHeight}
            scanCm={scanHeightCm}
            active={activeField === 'height'}
            onActivate={() => {
              haptics.selection()
              setActiveField('height')
            }}
          />
        </div>

        {/* Reason */}
        <div className="mt-3.5">
          <p className="mb-[6px] text-[11px] font-[700] text-ink-sub">
            Begründung für&apos;s Büro{' '}
            <span className="font-[500] text-ink-muted">· optional</span>
          </p>
          <textarea
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            placeholder="z.B. Wand ist nicht ganz gerade — an der schmalsten Stelle nachgemessen."
            rows={3}
            aria-label="Begründung für das Büro"
            className="w-full resize-none rounded-[10px] border border-edge bg-canvas px-3 py-[10px] text-[12.5px] text-ink placeholder:text-ink-muted focus:border-brand focus:outline-none focus:ring-[3px] focus:ring-brand/10"
          />
        </div>
      </div>

      {/* Numeric keypad — writes the focused field */}
      <div className="border-t border-edge bg-canvas px-2.5 pt-2">
        <div className="grid grid-cols-3 gap-1.5">
          {['1', '2', '3', '4', '5', '6', '7', '8', '9'].map((k) => (
            <button
              key={k}
              type="button"
              onClick={() => handleKey(k)}
              aria-label={k}
              className="flex h-[46px] items-center justify-center rounded-[11px] border border-edge bg-white text-[21px] font-[650] text-ink shadow-subtle active:scale-95 active:bg-canvas"
            >
              {k}
            </button>
          ))}
          <button
            type="button"
            onClick={() => handleKey(',')}
            aria-label="Komma"
            className="flex h-[46px] items-center justify-center rounded-[11px] bg-transparent text-[21px] font-[650] text-ink-sub active:scale-95"
          >
            ,
          </button>
          <button
            type="button"
            onClick={() => handleKey('0')}
            aria-label="0"
            className="flex h-[46px] items-center justify-center rounded-[11px] border border-edge bg-white text-[21px] font-[650] text-ink shadow-subtle active:scale-95 active:bg-canvas"
          >
            0
          </button>
          <button
            type="button"
            onClick={() => handleKey('backspace')}
            aria-label="Löschen"
            className="flex h-[46px] items-center justify-center rounded-[11px] bg-transparent text-ink-sub active:scale-95"
          >
            <BackspaceIcon />
          </button>
        </div>
      </div>

      {/* Footer CTA */}
      <div className="bg-canvas px-4 pb-[max(24px,env(safe-area-inset-bottom))] pt-2.5">
        {saveError && (
          <p className="mb-2 text-center text-[12px] font-[600] text-danger">{saveError}</p>
        )}
        <button
          type="button"
          onClick={() => void handleSave()}
          disabled={!canSave || saving}
          aria-label="Maß übernehmen"
          className={[
            'flex w-full items-center justify-center gap-2 rounded-[13px] py-3.5 text-[14.5px] font-[700] text-white transition',
            !canSave || saving
              ? 'cursor-not-allowed bg-ink-muted'
              : 'bg-brand shadow-brand-glow active:scale-[0.98]',
          ].join(' ')}
        >
          <svg width="15" height="15" viewBox="0 0 15 15" fill="none" aria-hidden="true">
            <path d="M3 8 6 11l6-7" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
          Maß übernehmen
        </button>
      </div>
    </BottomSheet>
  )
}
