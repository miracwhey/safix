/**
 * Spatial V1.6 · Phase 2 · CaptureDsgvoConsentSheet
 *
 * One-time DSGVO consent gate before the first LiDAR capture (PRIV-D1, locked
 * 2026-05-26). Mounted by the Customer-Spatial-Hub / NewRoomSheet when the
 * persisted consent flag is missing.
 *
 * Legal gate: ESC + backdrop-click are DISABLED. The user must actively pick
 * "Verstanden" or "Abbrechen" — passive dismiss could be argued as implicit
 * consent in a future audit. Mockup 07 baseline.
 *
 * Mockup binding: `~/.claude/plans/mockups/spatial-v16-customer/07-dsgvo-consent.html`
 */

import { useEffect, useRef } from 'react'
import BottomSheet from '../../ui/BottomSheet'
import { recordCustomerLidarConsent } from '../../../hooks/customerLidarConsent'

export interface CaptureDsgvoConsentSheetProps {
  open: boolean
  /** Fired when the user accepts. The hook persists localStorage AND fires this
   *  so the caller can re-invoke the scan flow (or update local React state). */
  onConsented: () => void
  /** Fired when the user declines. Caller closes the sheet and stays on the
   *  previous surface (NewRoomSheet / Hub). NO consent is persisted. */
  onCancel: () => void
}

export default function CaptureDsgvoConsentSheet({
  open,
  onConsented,
  onCancel,
}: CaptureDsgvoConsentSheetProps) {
  const primaryButtonRef = useRef<HTMLButtonElement>(null)

  // Auto-focus the primary CTA when the sheet opens — accessibility (sighted
  // keyboard users) + reduces a-double-tap-needed UX friction on mobile.
  useEffect(() => {
    if (!open) return
    let alive = true
    void Promise.resolve().then(() => {
      if (alive) primaryButtonRef.current?.focus()
    })
    return () => { alive = false }
  }, [open])

  const handleAccept = () => {
    recordCustomerLidarConsent()
    onConsented()
  }

  return (
    <BottomSheet
      open={open}
      // Legal gate: backdrop-click must NOT dismiss. BottomSheet's onClose is
      // called for both ESC and backdrop — pointing it to a no-op means neither
      // path passively dismisses. The cancel CTA is the only exit alongside
      // accept.
      onClose={() => undefined}
      maxWidth={460}
      className="!bg-slate-900/95 !text-white border border-white/10 backdrop-blur-2xl"
    >
      <div aria-labelledby="dsgvo-title">
        <h3 id="dsgvo-title" className="text-base font-bold text-white">
          Bevor du scannst
        </h3>
        <p className="mt-1 text-xs text-white/65">
          Was wir mit deinem 3D-Aufmaß machen
        </p>

        <ul className="mt-4 space-y-2.5 rounded-2xl border border-white/10 bg-white/[0.04] p-4">
          <ConsentBullet>
            Dein Scan wird <strong className="font-semibold text-white">verschlüsselt gespeichert</strong>.
          </ConsentBullet>
          <ConsentBullet>
            Nur du und ggf. der von dir <strong className="font-semibold text-white">beauftragte Handwerker</strong> können den Scan sehen.
          </ConsentBullet>
          <ConsentBullet>
            Wir scannen <strong className="font-semibold text-white">nur Räume</strong> — bitte keine Personen oder Außenbereiche aufnehmen.
          </ConsentBullet>
          <ConsentBullet>
            Du kannst den Scan <strong className="font-semibold text-white">jederzeit löschen</strong> — wir entfernen dann alle Kopien.
          </ConsentBullet>
        </ul>

        <div className="mt-5 flex flex-col gap-2.5">
          <button
            ref={primaryButtonRef}
            type="button"
            onClick={handleAccept}
            className="w-full rounded-2xl bg-gradient-to-br from-sky-500 to-blue-600 px-4 py-3.5 text-sm font-bold text-white shadow-lg shadow-sky-900/40 transition hover:from-sky-400 hover:to-blue-500 focus:outline-none focus:ring-2 focus:ring-sky-300/60"
          >
            Verstanden, jetzt scannen
          </button>
          <button
            type="button"
            onClick={onCancel}
            className="w-full rounded-2xl border border-white/10 bg-white/[0.04] px-4 py-3 text-sm font-semibold text-white/80 transition hover:bg-white/[0.08]"
          >
            Abbrechen
          </button>
        </div>
      </div>
    </BottomSheet>
  )
}

function ConsentBullet({ children }: { children: React.ReactNode }) {
  return (
    <li className="flex items-start gap-2.5 text-[13px] leading-relaxed text-white/80">
      <span
        aria-hidden
        className="mt-0.5 grid h-4 w-4 shrink-0 place-items-center rounded-full bg-emerald-500/25 text-emerald-300"
      >
        <svg viewBox="0 0 24 24" className="h-2.5 w-2.5" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round">
          <polyline points="20 6 9 17 4 12" />
        </svg>
      </span>
      <span>{children}</span>
    </li>
  )
}
