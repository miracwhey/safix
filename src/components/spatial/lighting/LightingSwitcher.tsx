/**
 * Spatial · Lighting · LightingSwitcher (Mockup 43 V4)
 *
 * Dual-mode lighting control for the 3D viewer:
 *   - Quick-Pill (collapsed · default) — floating, shows the active preset.
 *   - Switcher-Sheet (expanded) — two Apple Inset-Grouped lists (Tag ·
 *     Abend & Studio). Tap-to-apply: tapping a row applies the preset and
 *     closes the sheet. No Fertig button, no toast — the scene + pill ARE the
 *     feedback (Mockup 43 §1).
 *
 * Controlled component: the host wires `presetId` / `onApply` to
 * `useLightingPreset`. Positioning of the pill is the host's concern — pass a
 * `className` (the host viewer is `relative`; the pill is `absolute`).
 */

import { useRef, useState } from 'react'

import {
  lightingPresetsBySection,
  resolveLightingPreset,
  type LightingPreset,
} from '../../../lib/spatial/canonical/lighting/presets.ts'
import { useFocusTrap } from '../../../lib/spatial/hooks/useFocusTrap'

export interface LightingSwitcherProps {
  presetId: string
  onApply: (presetId: string) => void
  /** Restore the default preset (Mockup 43 §3 "Standard"). */
  onResetDefault?: () => void
  /** Positioning classes for the Quick-Pill (e.g. "absolute right-4 top-4"). */
  className?: string
}

export function LightingSwitcher({ presetId, onApply, onResetDefault, className }: LightingSwitcherProps) {
  const [sheetOpen, setSheetOpen] = useState(false)
  const [announce, setAnnounce] = useState('')
  // Tap-to-apply must fire once per sheet session — a fast double-tap on two
  // rows would otherwise both call onApply (Mockup 43 §7.13).
  const appliedRef = useRef(false)
  const preset = resolveLightingPreset(presetId)

  const openSheet = () => {
    appliedRef.current = false
    setSheetOpen(true)
  }

  const applyPreset = (id: string) => {
    if (appliedRef.current) return
    appliedRef.current = true
    onApply(id)
    setAnnounce(`Lichtquelle gewechselt zu ${resolveLightingPreset(id).displayName}`)
    setSheetOpen(false)
  }

  return (
    <>
      <QuickPill preset={preset} expanded={sheetOpen} onClick={openSheet} className={className} />
      {sheetOpen && (
        <SwitcherSheet
          activeId={preset.id}
          onApply={applyPreset}
          onResetDefault={
            onResetDefault
              ? () => {
                  if (appliedRef.current) return
                  appliedRef.current = true
                  onResetDefault()
                  setSheetOpen(false)
                }
              : undefined
          }
          onClose={() => setSheetOpen(false)}
        />
      )}
      <span className="sr-only" role="status" aria-live="polite">
        {announce}
      </span>
    </>
  )
}

// ─────────────────────────────────────────────────────────────────────────────
// Quick-Pill
// ─────────────────────────────────────────────────────────────────────────────

function QuickPill({
  preset,
  expanded,
  onClick,
  className,
}: {
  preset: LightingPreset
  expanded: boolean
  onClick: () => void
  className?: string
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={`Lichtquelle wechseln · aktuell ${preset.displayName}`}
      aria-expanded={expanded}
      className={[
        'flex items-center gap-2 rounded-[15px] py-2 pl-2 pr-3 text-left text-white',
        'active:scale-[0.97] transition',
        className ?? '',
      ].join(' ')}
      style={{
        background: 'rgba(15,18,28,0.54)',
        backdropFilter: 'blur(42px) saturate(165%)',
        WebkitBackdropFilter: 'blur(42px) saturate(165%)',
      }}
    >
      <HdriDisc preset={preset} size={30} />
      <span className="flex min-w-0 flex-col leading-tight">
        <span className="truncate text-[13px] font-bold">{preset.displayName}</span>
        <span className="truncate text-[11px] font-medium text-white/70">{preset.moodLine}</span>
      </span>
    </button>
  )
}

// ─────────────────────────────────────────────────────────────────────────────
// Switcher-Sheet
// ─────────────────────────────────────────────────────────────────────────────

function SwitcherSheet({
  activeId,
  onApply,
  onResetDefault,
  onClose,
}: {
  activeId: string
  onApply: (id: string) => void
  onResetDefault?: () => void
  onClose: () => void
}) {
  const panelRef = useRef<HTMLDivElement>(null)
  useFocusTrap(panelRef, true)

  return (
    <div
      className="fixed inset-0 z-50 flex items-end justify-center"
      style={{ background: 'rgba(0,0,0,0.20)', backdropFilter: 'blur(3px)' }}
      onClick={onClose}
      role="presentation"
    >
      <div
        ref={(node) => {
          panelRef.current = node
          node?.focus()
        }}
        tabIndex={-1}
        role="dialog"
        aria-modal="true"
        aria-labelledby="lighting-switcher-title"
        onClick={(e) => e.stopPropagation()}
        onKeyDown={(e) => {
          if (e.key === 'Escape') onClose()
        }}
        className="flex max-h-[72dvh] w-full max-w-[460px] flex-col rounded-t-[30px] px-4 pb-[max(18px,env(safe-area-inset-bottom))] pt-2.5 outline-none"
        style={{
          background: 'rgba(250,250,253,0.82)',
          backdropFilter: 'blur(64px) saturate(185%)',
          WebkitBackdropFilter: 'blur(64px) saturate(185%)',
          boxShadow: '0 -1px 0 rgba(255,255,255,0.6) inset, 0 -16px 50px rgba(15,23,42,0.18)',
        }}
      >
        <div aria-hidden="true" className="mx-auto mb-2 h-1 w-10 rounded-full bg-slate-900/15" />

        <div className="flex items-start justify-between">
          <div>
            <h2 id="lighting-switcher-title" className="text-[19px] font-bold text-slate-900">
              Lichtquelle
            </h2>
            <p className="text-[13px] font-medium text-blue-600">
              {resolveLightingPreset(activeId).displayName} · aktiv
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Schließen"
            className="-mr-1 -mt-0.5 rounded-full p-1.5 text-slate-400 active:scale-90 hover:bg-slate-900/5 hover:text-slate-600"
          >
            <svg viewBox="0 0 20 20" className="size-5" fill="currentColor">
              <path d="M10 8.586 6.707 5.293 5.293 6.707 8.586 10l-3.293 3.293 1.414 1.414L10 11.414l3.293 3.293 1.414-1.414L11.414 10l3.293-3.293-1.414-1.414L10 8.586Z" />
            </svg>
          </button>
        </div>

        <div className="mt-2 flex-1 overflow-y-auto overscroll-contain">
          <PresetGroup
            label="Tag"
            sectionLabelId="lighting-section-day"
            presets={lightingPresetsBySection('day')}
            activeId={activeId}
            onApply={onApply}
          />
          <PresetGroup
            label="Abend & Studio"
            sectionLabelId="lighting-section-studio"
            presets={lightingPresetsBySection('evening-studio')}
            activeId={activeId}
            onApply={onApply}
          />
        </div>

        {/* Action row — Standard restore + Phase-2-locked default-save */}
        <div className="mt-3 flex gap-2">
          <button
            type="button"
            onClick={onResetDefault}
            disabled={!onResetDefault}
            className="flex-1 rounded-xl bg-white/70 py-2 text-[13px] font-semibold text-slate-700 ring-1 ring-slate-900/10 active:scale-[0.98] disabled:opacity-50"
          >
            Standard
          </button>
          <button
            type="button"
            disabled
            aria-disabled="true"
            aria-label="Als Standard für diesen Raum speichern · bald verfügbar"
            title="Bald verfügbar"
            className="flex-1 rounded-xl bg-white/40 py-2 text-[13px] font-semibold text-slate-400"
          >
            🔒 Als Standard speichern
          </button>
        </div>
      </div>
    </div>
  )
}

function PresetGroup({
  label,
  sectionLabelId,
  presets,
  activeId,
  onApply,
}: {
  label: string
  sectionLabelId: string
  presets: LightingPreset[]
  activeId: string
  onApply: (id: string) => void
}) {
  return (
    <div className="mt-3">
      <h3 id={sectionLabelId} className="mb-1.5 px-1 text-[11.5px] font-semibold text-slate-500">
        {label}
      </h3>
      <div
        role="radiogroup"
        aria-labelledby={sectionLabelId}
        className="overflow-hidden rounded-2xl bg-white/70 ring-1 ring-inset ring-slate-900/10"
      >
        {presets.map((preset, index) => (
          <PresetRow
            key={preset.id}
            preset={preset}
            active={preset.id === activeId}
            firstInGroup={index === 0}
            onApply={onApply}
          />
        ))}
      </div>
    </div>
  )
}

function PresetRow({
  preset,
  active,
  firstInGroup,
  onApply,
}: {
  preset: LightingPreset
  active: boolean
  firstInGroup: boolean
  onApply: (id: string) => void
}) {
  return (
    <button
      type="button"
      role="radio"
      aria-checked={active}
      aria-label={`${preset.displayName} · ${preset.moodLine}${active ? ' · aktiv' : ''}`}
      onClick={() => !active && onApply(preset.id)}
      className={[
        'flex w-full items-center gap-3 px-3 py-2 text-left transition active:bg-blue-600/[0.07]',
        !firstInGroup ? 'border-t border-slate-900/[0.07]' : '',
        active ? 'bg-blue-600/5' : '',
      ].join(' ')}
    >
      <HdriDisc preset={preset} size={34} />
      <span className="flex min-w-0 flex-1 flex-col leading-tight">
        <span className="truncate text-[14.5px] font-semibold text-slate-900">
          {preset.displayName}
        </span>
        <span className="truncate text-[11.5px] font-medium text-slate-500">{preset.moodLine}</span>
      </span>
      {active ? (
        <span className="flex size-[21px] shrink-0 items-center justify-center rounded-full bg-blue-600">
          <svg viewBox="0 0 20 20" className="size-3" fill="#fff">
            <path d="M8.143 14.6 3.5 9.957l1.414-1.414 3.229 3.228 6.943-6.942 1.414 1.414z" />
          </svg>
        </span>
      ) : (
        <span aria-hidden="true" className="size-[21px] shrink-0" />
      )}
    </button>
  )
}

// ─────────────────────────────────────────────────────────────────────────────
// HDRI preview disc
// ─────────────────────────────────────────────────────────────────────────────

function HdriDisc({ preset, size }: { preset: LightingPreset; size: number }) {
  const [failed, setFailed] = useState(false)
  return (
    <span
      className="relative shrink-0 overflow-hidden rounded-full ring-1 ring-inset ring-white/40"
      style={{ width: size, height: size }}
    >
      {failed ? (
        <span
          aria-hidden="true"
          className="block size-full"
          style={{
            background: `radial-gradient(circle at 32% 30%, ${preset.sunColor} 0%, rgba(120,130,150,0.85) 100%)`,
          }}
        />
      ) : (
        <img
          src={preset.thumbnailUrl}
          alt=""
          loading="lazy"
          onError={() => setFailed(true)}
          className="size-full object-cover"
        />
      )}
    </span>
  )
}
