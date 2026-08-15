/**
 * Spatial · V1.6.1 Hub-Refactor · CustomerRoomPickerPopover
 *
 * Liquid-Glass v3 Popover für das ⋯-Menü im Customer-3D-Hub. Bindet sich an
 * Mockup 02 v8 (`spatial-v151/02-spatial-hub.html` State 3 · "Räume
 * wechseln"). Ersetzt die alte Scan-Card-Liste — der Hub ist jetzt 100%
 * 3D-Surface, und die Multi-Scan-Navigation läuft über dieses Popover.
 *
 * Mockup-bindung (00-INDEX V1.5.1):
 *   - Glass v3: linear-gradient(180deg, rgba(255,255,255,0.08), rgba(255,255,255,0.03))
 *   - blur(120px) saturate(260%) für popover (= "blur-strong")
 *   - inset 0 1px 0 rgba(255,255,255,0.32) top-highlight
 *   - Active-Row: white-pill (rgba(255,255,255,0.95))
 *   - Footer: "Neuen Raum anlegen"-CTA mit Brand-tinted icon
 *
 * Anchor: ⋯-Menu-Pill (top-right floating). Popover öffnet sich darunter
 * mit absoluter Positionierung (top: 12, right: 14) — der Hub-Screen
 * positioniert es als sibling der ⋯-Pill.
 *
 * Daten-Modell: zeigt SCANS als Räume, mit display-name aus
 * `roomLabelForScan()` (category-Label oder fallback "Raum {seq}"). Die
 * eigentliche `scan_rooms`-Tabelle wird in einer separaten Welle (V1.6.2)
 * eingebunden — V1.5.1 hat regelmäßig 1 Room pro Scan, also reicht der
 * Scan-Level für jetzt. Multi-Room-Scans (1 Scan, mehrere `scan_rooms`-
 * Einträge) sind seltene Edge-Case in V1.6.0; wir surface'n sie später.
 */

import { useCallback, useEffect, useRef } from 'react'

import type { Scan } from '../../../lib/spatial/types'
import { buildRoomLabels } from './customerRoomLabels'

export interface CustomerRoomPickerPopoverProps {
  open: boolean
  scans: ReadonlyArray<Scan>
  activeScanId: string | null
  onSelect: (scanId: string) => void
  onAddRoom: () => void
  onClose: () => void
}

function formatRelativeDate(ts: number): string {
  try {
    return new Intl.DateTimeFormat('de-DE', {
      day: '2-digit',
      month: 'short',
    }).format(new Date(ts))
  } catch {
    return ''
  }
}

export default function CustomerRoomPickerPopover({
  open,
  scans,
  activeScanId,
  onSelect,
  onAddRoom,
  onClose,
}: CustomerRoomPickerPopoverProps) {
  const rootRef = useRef<HTMLDivElement | null>(null)

  // Click-outside via `click` (bubble-phase) statt `pointerdown` (capture)
  // — gleiche Lesson wie ToolBar: zwei UI-Änderungen für einen Tap
  // vermeiden. Tap auf einen anderen Pill schließt das Popover sauber
  // nach dem Click-Event des anderen Pill.
  useEffect(() => {
    if (!open) return
    const onClick = (event: MouseEvent) => {
      const root = rootRef.current
      if (!root) return
      const target = event.target as Node | null
      if (target && root.contains(target)) return
      onClose()
    }
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose()
    }
    document.addEventListener('click', onClick)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('click', onClick)
      document.removeEventListener('keydown', onKey)
    }
  }, [open, onClose])

  const labels = buildRoomLabels(scans)

  const handleSelect = useCallback(
    (scanId: string) => {
      onSelect(scanId)
      onClose()
    },
    [onSelect, onClose],
  )

  if (!open) return null

  return (
    <div
      ref={rootRef}
      role="dialog"
      aria-label="Räume wechseln"
      className="pointer-events-auto absolute z-[65] w-[280px] max-w-[calc(100vw-28px)] p-2"
      style={{
        top: 'calc(max(env(safe-area-inset-top), 16px) + 52px)',
        right: 14,
        borderRadius: 22,
        background:
          'linear-gradient(180deg, rgba(255,255,255,0.08) 0%, rgba(255,255,255,0.03) 100%)',
        backdropFilter: 'blur(120px) saturate(260%)',
        WebkitBackdropFilter: 'blur(120px) saturate(260%)',
        border: '1px solid rgba(255,255,255,0.14)',
        boxShadow:
          '0 28px 56px rgba(0,0,0,0.6), inset 0 1px 0 rgba(255,255,255,0.32), inset 0 -1px 0 rgba(255,255,255,0.04)',
      }}
    >
      <div
        className="px-3 pb-1.5 pt-2 text-[9.5px] font-bold uppercase tracking-[0.12em] text-white/55"
        id="customer-room-picker-header"
      >
        Räume wechseln
      </div>
      <ul role="listbox" aria-labelledby="customer-room-picker-header">
        {[...scans]
          .sort((a, b) => b.createdAt - a.createdAt)
          .map(scan => {
            const isActive = scan.id === activeScanId
            const ownerSubtitle =
              scan.ownerType === 'customer'
                ? scan.parentScanId != null
                  ? 'Erneuter Scan'
                  : 'Selbst erstellt'
                : 'Vom HW geteilt'
            const subtitle = `${ownerSubtitle} · ${formatRelativeDate(scan.createdAt)}`
            return (
              <li key={scan.id}>
                <button
                  type="button"
                  role="option"
                  aria-selected={isActive}
                  onClick={() => handleSelect(scan.id)}
                  className="flex w-full items-center gap-[11px] rounded-[14px] px-3 py-2.5 text-left transition active:scale-[0.99]"
                  style={{
                    background: isActive ? 'rgba(255,255,255,0.95)' : 'transparent',
                    color: isActive ? '#0f1525' : 'rgba(255,255,255,0.88)',
                    boxShadow: isActive
                      ? '0 4px 12px rgba(0,0,0,0.22), inset 0 1px 0 rgba(255,255,255,0.92)'
                      : undefined,
                  }}
                >
                  <span
                    className="flex h-[22px] w-[22px] flex-shrink-0 items-center justify-center"
                    aria-hidden
                    style={{ opacity: isActive ? 1 : 0.75 }}
                  >
                    <svg
                      viewBox="0 0 22 22"
                      width={20}
                      height={20}
                      fill="none"
                      stroke="currentColor"
                      strokeWidth={1.7}
                      strokeLinecap="round"
                      strokeLinejoin="round"
                    >
                      <rect x="3" y="3" width="16" height="16" rx="1.5" />
                      <path d="M3 11h16M11 3v16" />
                    </svg>
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-[13.5px] font-bold leading-[1.15]">
                      {labels[scan.id] ?? 'Raum'}
                    </span>
                    <span
                      className="mt-[1px] block truncate text-[10.5px] leading-[1.2]"
                      style={{ opacity: isActive ? 0.68 : 0.6 }}
                    >
                      {subtitle}
                    </span>
                  </span>
                  {isActive && (
                    <span aria-hidden className="flex-shrink-0">
                      <svg
                        viewBox="0 0 24 24"
                        width={16}
                        height={16}
                        fill="none"
                        stroke="currentColor"
                        strokeWidth={2.4}
                        strokeLinecap="round"
                        strokeLinejoin="round"
                      >
                        <polyline points="20 6 9 17 4 12" />
                      </svg>
                    </span>
                  )}
                </button>
              </li>
            )
          })}
      </ul>

      <div
        aria-hidden
        className="my-1.5"
        style={{ height: 1, background: 'rgba(255,255,255,0.12)', marginInline: 12 }}
      />

      <button
        type="button"
        onClick={() => {
          onClose()
          onAddRoom()
        }}
        className="flex w-full items-center gap-[11px] rounded-[14px] px-3 py-2.5 text-left text-[#93c5fd] transition active:scale-[0.99]"
      >
        <span
          className="flex h-[26px] w-[26px] flex-shrink-0 items-center justify-center rounded-[9px]"
          style={{ background: 'rgba(37,99,235,0.24)' }}
          aria-hidden
        >
          <svg
            viewBox="0 0 24 24"
            width={14}
            height={14}
            fill="none"
            stroke="#93c5fd"
            strokeWidth={2.4}
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <path d="M12 5v14M5 12h14" />
          </svg>
        </span>
        <span className="text-[13.5px] font-bold leading-[1.1]">
          Neuen Raum anlegen
        </span>
      </button>
    </div>
  )
}
