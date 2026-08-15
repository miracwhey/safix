/**
 * Spatial · V1.6 Phase 1d · CustomerMultiScanPicker
 *
 * Glass dropdown that lets the customer switch which scan drives the hub's
 * full-bleed 3D background when they have more than one scan. Mockup 10
 * reference (`spatial-v16-customer/10-multi-scan-picker.html`):
 *
 *   - Collapsed pill: brand square icon + name (e.g. "Wohnzimmer") +
 *     meta line ("3 Scans · vor 2 Std").
 *   - Expanded card: same pill on top + scrollable scan list with
 *     active-marker + per-row meta. Footer "+ Neuen Scan starten" CTA.
 *
 * Persistence is owned upstream — this component is a controlled UI
 * surface. The hub passes `activeScanId` + `onSelect` from
 * `useCustomerSpatialMultiScan` so a switch writes through to localStorage.
 *
 * Phase 1d scope:
 *   - Switch active scan via tap.
 *   - Footer CTA fires `onAddScan` (the hub opens `<CustomerNewRoomSheet>`).
 *   - No quality-pill yet (Phase 2 adds `quality_score` + `quality_label`
 *     columns; once present, the pill renders inline per Mockup 10).
 *
 * Hidden when `scans.length < 2` (one-scan customers see no picker), so the
 * hub keeps a single-scan dropdown out of view.
 */

import { useCallback, useEffect, useRef, useState } from 'react'

import type { Scan } from '../../../lib/spatial/types'

export interface CustomerMultiScanPickerProps {
  scans: ReadonlyArray<Scan>
  activeScanId: string | null
  onSelect: (scanId: string) => void
  /** Optional "+ Neuen Scan starten" CTA. When omitted, the footer is hidden. */
  onAddScan?: () => void
  className?: string
}

function formatRelative(ts: number): string {
  const deltaMs = Math.max(0, Date.now() - ts)
  const minutes = Math.floor(deltaMs / 60_000)
  if (minutes < 1) return 'gerade eben'
  if (minutes < 60) return `vor ${minutes} Min`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `vor ${hours} Std`
  const days = Math.floor(hours / 24)
  if (days < 7) return `vor ${days} Tag${days === 1 ? '' : 'en'}`
  try {
    return new Intl.DateTimeFormat('de-DE', {
      day: '2-digit',
      month: 'short',
    }).format(new Date(ts))
  } catch {
    return ''
  }
}

function scanDisplayName(scan: Scan): string {
  if (scan.ownerType === 'customer') return 'Eigenes Aufmaß'
  return 'Aufmaß vom Handwerker'
}

function scanOwnerSubtitle(scan: Scan): string {
  // Phase 3 (B4-D7): when a customer scan was created as a re-scan of a
  // previous one, surface "Erneuter Scan" instead of the plain "Selbst
  // erstellt" so the picker reads the chain at a glance without a v2/v3
  // versioning badge. HW-shared scans keep the "Freigegeben" label since
  // re-scan chaining is currently customer-only.
  if (scan.ownerType === 'customer') {
    return scan.parentScanId != null ? 'Erneuter Scan' : 'Selbst erstellt'
  }
  return 'Freigegeben'
}

export default function CustomerMultiScanPicker({
  scans,
  activeScanId,
  onSelect,
  onAddScan,
  className,
}: CustomerMultiScanPickerProps) {
  const [open, setOpen] = useState(false)
  const rootRef = useRef<HTMLDivElement | null>(null)

  // Click-outside + Escape collapses the dropdown. Only attached while open
  // so a static collapsed pill doesn't subscribe globally.
  useEffect(() => {
    if (!open) return
    const onPointer = (event: PointerEvent) => {
      const root = rootRef.current
      if (!root) return
      const target = event.target as Node | null
      if (target && root.contains(target)) return
      setOpen(false)
    }
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false)
    }
    document.addEventListener('pointerdown', onPointer, true)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('pointerdown', onPointer, true)
      document.removeEventListener('keydown', onKey)
    }
  }, [open])

  const active =
    scans.find(s => s.id === activeScanId) ??
    [...scans].sort((a, b) => b.createdAt - a.createdAt)[0] ??
    null

  const handleSelect = useCallback(
    (scanId: string) => {
      if (scanId !== activeScanId) onSelect(scanId)
      setOpen(false)
    },
    [activeScanId, onSelect],
  )

  if (scans.length < 2 || !active) return null

  return (
    <div
      ref={rootRef}
      className={
        'relative w-full max-w-[420px] text-white ' + (className ?? '')
      }
      data-testid="customer-multi-scan-picker"
    >
      <button
        type="button"
        onClick={() => setOpen(prev => !prev)}
        className="flex w-full items-center gap-2.5 rounded-2xl px-3.5 py-2.5 text-left transition active:scale-[0.99]"
        style={{
          background: 'rgba(20,28,48,0.62)',
          backdropFilter: 'blur(28px) saturate(180%)',
          WebkitBackdropFilter: 'blur(28px) saturate(180%)',
          border: '1px solid rgba(255,255,255,0.14)',
          boxShadow:
            '0 8px 22px rgba(0,0,0,0.40), inset 0 1px 0 rgba(255,255,255,0.16)',
        }}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls="customer-multi-scan-list"
      >
        <span
          className="flex h-6 w-6 flex-shrink-0 items-center justify-center rounded-lg"
          style={{
            background: 'linear-gradient(135deg, #2563EB 0%, #1d4ed8 100%)',
            boxShadow:
              '0 3px 8px rgba(37,99,235,0.42), inset 0 1px 0 rgba(255,255,255,0.28)',
          }}
          aria-hidden
        >
          <svg
            viewBox="0 0 24 24"
            width={13}
            height={13}
            fill="none"
            stroke="white"
            strokeWidth={1.8}
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <path d="M3 12 12 3l9 9 M5 10v10h14V10" />
          </svg>
        </span>
        <span className="min-w-0 flex-1">
          <span className="block truncate text-[13.5px] font-semibold leading-tight">
            {scanDisplayName(active)}
          </span>
          <span className="block truncate text-[11px] text-white/60">
            {scans.length} Scans · {formatRelative(active.createdAt)}
          </span>
        </span>
        <svg
          viewBox="0 0 24 24"
          width={16}
          height={16}
          fill="none"
          stroke={open ? '#93c5fd' : 'rgba(255,255,255,0.60)'}
          strokeWidth={2}
          strokeLinecap="round"
          strokeLinejoin="round"
          style={{
            transform: open ? 'rotate(180deg)' : 'rotate(0deg)',
            transition: 'transform 0.2s cubic-bezier(0.4, 0.0, 0.2, 1)',
          }}
          aria-hidden
        >
          <path d="m6 9 6 6 6-6" />
        </svg>
      </button>

      {open && (
        <div
          id="customer-multi-scan-list"
          role="listbox"
          aria-label="Aktiven Scan wählen"
          className="absolute left-0 right-0 z-50 mt-2 overflow-hidden rounded-2xl"
          style={{
            background: 'rgba(20,28,48,0.78)',
            backdropFilter: 'blur(28px) saturate(180%)',
            WebkitBackdropFilter: 'blur(28px) saturate(180%)',
            border: '1px solid rgba(255,255,255,0.14)',
            boxShadow:
              '0 24px 60px rgba(0,0,0,0.55), inset 0 1px 0 rgba(255,255,255,0.16)',
          }}
        >
          <ul className="max-h-[260px] overflow-y-auto">
            {[...scans]
              .sort((a, b) => b.createdAt - a.createdAt)
              .map(scan => {
                const isActive = scan.id === activeScanId
                return (
                  <li key={scan.id}>
                    <button
                      type="button"
                      role="option"
                      aria-selected={isActive}
                      onClick={() => handleSelect(scan.id)}
                      className="flex w-full items-center gap-2.5 px-3.5 py-3 text-left transition active:bg-white/5"
                      style={{
                        background: isActive
                          ? 'linear-gradient(90deg, rgba(37,99,235,0.16) 0%, rgba(37,99,235,0.04) 100%)'
                          : 'transparent',
                        borderBottom: '0.5px solid rgba(255,255,255,0.06)',
                      }}
                    >
                      <span
                        className="flex h-7 w-7 flex-shrink-0 items-center justify-center rounded-lg"
                        style={{
                          background: isActive
                            ? 'linear-gradient(135deg, #2563EB 0%, #1d4ed8 100%)'
                            : 'rgba(96,165,250,0.14)',
                          border: isActive
                            ? undefined
                            : '1px solid rgba(96,165,250,0.22)',
                          boxShadow: isActive
                            ? '0 3px 8px rgba(37,99,235,0.45)'
                            : undefined,
                        }}
                        aria-hidden
                      >
                        <svg
                          viewBox="0 0 24 24"
                          width={13}
                          height={13}
                          fill="none"
                          stroke={isActive ? 'white' : '#60a5fa'}
                          strokeWidth={1.8}
                          strokeLinecap="round"
                          strokeLinejoin="round"
                        >
                          <path d="M3 12 12 3l9 9 M5 10v10h14V10" />
                        </svg>
                      </span>
                      <span className="min-w-0 flex-1">
                        <span className="flex items-center gap-1.5">
                          <span className="truncate text-[13px] font-semibold">
                            {scanDisplayName(scan)}
                          </span>
                          {isActive && (
                            <span
                              className="rounded-md px-1.5 py-0.5 text-[9px] font-extrabold uppercase tracking-wider"
                              style={{
                                background: 'rgba(96,165,250,0.18)',
                                border: '1px solid rgba(96,165,250,0.35)',
                                color: '#93c5fd',
                              }}
                            >
                              Aktiv
                            </span>
                          )}
                        </span>
                        <span className="block truncate text-[10.5px] text-white/55">
                          {scanOwnerSubtitle(scan)} ·{' '}
                          {formatRelative(scan.createdAt)}
                        </span>
                      </span>
                    </button>
                  </li>
                )
              })}
          </ul>
          {onAddScan && (
            <button
              type="button"
              onClick={() => {
                setOpen(false)
                onAddScan()
              }}
              className="block w-full px-3.5 py-3 text-left text-[12.5px] font-bold transition active:bg-white/5"
              style={{
                background:
                  'linear-gradient(180deg, rgba(37,99,235,0.10) 0%, rgba(37,99,235,0.20) 100%)',
                borderTop: '0.5px solid rgba(96,165,250,0.22)',
                color: '#93c5fd',
              }}
            >
              + Neuen Scan starten
            </button>
          )}
        </div>
      )}
    </div>
  )
}
