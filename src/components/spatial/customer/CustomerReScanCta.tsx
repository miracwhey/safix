/**
 * Spatial V1.6 · Phase 3 · CustomerReScanCta
 *
 * Floating-pill on the Customer-Spatial-Detail header that lets the user
 * launch a fresh LiDAR scan that chains to the current one (B4-D7: new row,
 * parent preserved). Mockup 11 State 1 binding
 * (`~/.claude/plans/mockups/spatial-v16-customer/11-rescan-confirm.html`).
 *
 * Visibility rules:
 *   - Visible only when the underlying scan is owned by the customer
 *     (`scan.ownerType === 'customer'`). HW-shared scans cannot be re-scanned
 *     from this surface — the HW has their own capture pipeline.
 *   - Hidden when `lidarAvailable !== true`. Non-LiDAR devices (e.g. iPhone
 *     SE) cannot trigger a re-scan today; a Custom-Canvas-based "Raum neu
 *     beginnen" fallback is V1.6.1 polish (see §10 of the Phase-3 plan).
 *   - Hidden during `busy` from the parent pipeline so a partial flight
 *     doesn't queue a second confirm.
 *
 * Visual: blau-tinted glass, *same* weight as the Share-pill — never a
 * danger-red. The action is non-destructive.
 */

import { useCallback, useState } from 'react'

import CustomerReScanConfirmSheet from './CustomerReScanConfirmSheet'

export interface CustomerReScanCtaProps {
  /** True only for self-scans the customer authored. */
  ownerType: 'customer' | 'craftsman'
  /** Native LiDAR probe result from `useStartCustomerLidarScan`. `null` while
   *  the probe is still running — the pill stays hidden until we know. */
  lidarAvailable: boolean | null
  /** Fired after the user confirms. Caller wires this to the LiDAR pipeline
   *  with `parentScanId = <current scan id>`. */
  onConfirm: () => void
  /** True while the parent pipeline is in-flight. The pill collapses to a
   *  disabled busy-state and the sheet — if open — shows a busy CTA. */
  busy?: boolean
  className?: string
}

export default function CustomerReScanCta({
  ownerType,
  lidarAvailable,
  onConfirm,
  busy = false,
  className,
}: CustomerReScanCtaProps) {
  const [confirmOpen, setConfirmOpen] = useState(false)

  const handleTap = useCallback(() => {
    if (busy) return
    setConfirmOpen(true)
  }, [busy])

  const handleConfirm = useCallback(() => {
    setConfirmOpen(false)
    onConfirm()
  }, [onConfirm])

  if (ownerType !== 'customer') return null
  if (lidarAvailable !== true) return null

  return (
    <>
      <button
        type="button"
        onClick={handleTap}
        disabled={busy}
        aria-label="Aufmaß erneut scannen"
        aria-disabled={busy}
        aria-busy={busy}
        className={
          'flex h-9 items-center gap-1.5 rounded-full px-3 text-[13px] font-semibold transition focus:outline-none focus:ring-2 focus:ring-sky-300/60 active:scale-95 disabled:cursor-not-allowed disabled:opacity-60 ' +
          (className ?? '')
        }
        style={{
          background:
            'linear-gradient(180deg, rgba(56,128,255,0.22) 0%, rgba(37,99,235,0.18) 100%)',
          backdropFilter: 'blur(16px) saturate(180%)',
          WebkitBackdropFilter: 'blur(16px) saturate(180%)',
          border: '1px solid rgba(96,165,250,0.40)',
          boxShadow:
            '0 4px 12px rgba(37,99,235,0.25), inset 0 1px 0 rgba(255,255,255,0.18)',
          color: '#bfdbfe',
        }}
        data-testid="customer-rescan-cta"
      >
        <svg
          viewBox="0 0 24 24"
          width={14}
          height={14}
          fill="none"
          stroke="currentColor"
          strokeWidth={2.2}
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden
        >
          <path d="M3 12a9 9 0 0115-6.7L21 8M21 3v5h-5M21 12a9 9 0 01-15 6.7L3 16M3 21v-5h5" />
        </svg>
        Erneut scannen
      </button>
      <CustomerReScanConfirmSheet
        open={confirmOpen}
        onClose={() => setConfirmOpen(false)}
        onConfirm={handleConfirm}
        busy={busy}
      />
    </>
  )
}
