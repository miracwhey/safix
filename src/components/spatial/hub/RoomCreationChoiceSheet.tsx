/**
 * Spatial · Hub · RoomCreationChoiceSheet
 *
 * Bottom-sheet opened from the Spatial-Hub "+" button. Forks new-room creation:
 *
 *   - **Manuell anlegen** — builds a 2×2 footprint and lands the user straight
 *     in the editable Grundriss / 3D / Walk viewer. No LiDAR needed, so this
 *     row is ALWAYS available (it is the non-LiDAR device's primary path).
 *   - **Raum scannen** — the existing LiDAR room-scan flow. Degrades to a
 *     disabled row + hint when the device reports no LiDAR.
 *
 * Glass-sheet chrome mirrors {@link HubFilterSheet}. Host contract: render
 * conditionally (`{open && <RoomCreationChoiceSheet … />}`) so no transient
 * state leaks across opens. The host closes the sheet in its choose-handlers
 * before kicking off the async workflow (double-tap guard).
 */

import { useEffect, useRef } from 'react'
import { X, PencilRuler, ScanLine, ChevronRight } from 'lucide-react'

import { useFocusTrap } from '../../../lib/spatial/hooks/useFocusTrap'

export interface RoomCreationChoiceSheetProps {
  /** Manual 2×2 → optimistic editable multi-mode viewer. Always available. */
  onChooseManuell: () => void
  /** LiDAR room scan (existing flow). */
  onChooseScan: () => void
  /** Device LiDAR availability — `null` = still probing. Scan row disabled when `false`. */
  lidarAvailable: boolean | null
  /** A create workflow is already running — guards against double-create. */
  busy?: boolean
  onClose: () => void
}

const SHEET_GLASS: React.CSSProperties = {
  background: 'rgba(250,250,253,0.84)',
  backdropFilter: 'blur(64px) saturate(185%)',
  WebkitBackdropFilter: 'blur(64px) saturate(185%)',
  boxShadow: '0 -1px 0 rgba(255,255,255,0.6) inset, 0 -16px 50px rgba(15,23,42,0.18)',
}

export function RoomCreationChoiceSheet({
  onChooseManuell,
  onChooseScan,
  lidarAvailable,
  busy = false,
  onClose,
}: RoomCreationChoiceSheetProps) {
  const panelRef = useRef<HTMLDivElement>(null)
  useFocusTrap(panelRef, true)

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [onClose])

  const noLidar = lidarAvailable === false

  return (
    <div
      className="fixed inset-0 z-50 flex items-end justify-center"
      style={{ background: 'rgba(0,0,0,0.20)', backdropFilter: 'blur(3px)' }}
      onClick={onClose}
      role="presentation"
    >
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="room-creation-title"
        tabIndex={-1}
        onClick={(e) => e.stopPropagation()}
        className="flex w-full max-w-[460px] flex-col rounded-t-[30px] px-4 pb-[max(16px,env(safe-area-inset-bottom))] pt-2.5 outline-none"
        style={SHEET_GLASS}
      >
        <div aria-hidden="true" className="mx-auto mb-2 h-1 w-10 rounded-full bg-slate-900/15" />

        <div className="flex items-start justify-between">
          <div>
            <h2 id="room-creation-title" className="text-[19px] font-bold text-slate-900">
              Raum anlegen
            </h2>
            <p className="mt-0.5 text-[12.5px] text-slate-500">
              Manuell zeichnen oder vor Ort scannen
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Schließen"
            className="-mr-1 -mt-0.5 shrink-0 rounded-full p-1.5 text-slate-400 hover:bg-slate-900/5 hover:text-slate-600 active:scale-90"
          >
            <X className="size-5" />
          </button>
        </div>

        <div className="mt-4 flex flex-col gap-2.5">
          <ChoiceRow
            icon={<PencilRuler size={20} />}
            title="Manuell anlegen"
            subtitle="2D-Grundriss zeichnen — ohne Scan, direkt in Grundriss / 3D / Walk"
            onClick={onChooseManuell}
            disabled={busy}
            tone="brand"
          />
          <ChoiceRow
            icon={<ScanLine size={20} />}
            title="Raum scannen"
            subtitle={
              noLidar
                ? 'Benötigt iPad Pro / iPhone Pro mit LiDAR'
                : 'Mit LiDAR vor Ort aufnehmen'
            }
            onClick={onChooseScan}
            disabled={busy || noLidar}
            tone="neutral"
          />
        </div>

        {noLidar && (
          <p className="mt-3 rounded-[10px] bg-[#FEF3C7] px-3 py-2 text-[11.5px] leading-snug text-[#92400E]">
            Dein Gerät hat kein LiDAR — leg den Raum manuell an und zeichne den
            Grundriss direkt in 3D.
          </p>
        )}
      </div>
    </div>
  )
}

function ChoiceRow({
  icon,
  title,
  subtitle,
  onClick,
  disabled,
  tone,
}: {
  icon: React.ReactNode
  title: string
  subtitle: string
  onClick: () => void
  disabled: boolean
  tone: 'brand' | 'neutral'
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className="flex items-center gap-3 rounded-[16px] border border-slate-200 bg-white/80 px-3.5 py-3.5 text-left shadow-subtle transition active:scale-[0.99] disabled:cursor-not-allowed disabled:opacity-50"
    >
      <span
        className={
          'flex h-11 w-11 shrink-0 items-center justify-center rounded-[12px] ' +
          (tone === 'brand' ? 'bg-[#EEF2FB] text-brand' : 'bg-slate-100 text-slate-500')
        }
      >
        {icon}
      </span>
      <span className="min-w-0 flex-1">
        <span className="block text-[14px] font-bold text-slate-900">{title}</span>
        <span className="mt-0.5 block text-[11.5px] leading-snug text-slate-500">
          {subtitle}
        </span>
      </span>
      <ChevronRight size={18} className="shrink-0 text-slate-300" />
    </button>
  )
}
