/**
 * Spatial Core · Block G.1 · First-Time Scan Coaching Overlay
 *
 * Apple Measure-app pattern: a single full-screen overlay shown to a user
 * before their first scan, with the three "make a good scan" hints +
 * a "verstanden" CTA. Persisted in localStorage so it only fires once.
 *
 * The overlay is intentionally not a BottomSheet — first-time guidance
 * is meant to take the whole screen so the user reads it rather than
 * dismissing it as a popup.
 */

import { useCallback, useState } from 'react'

const STORAGE_KEY = 'spatial:scan-coaching-seen-v1'

const TIPS: { eyebrow: string; copy: string }[] = [
  {
    eyebrow: '1. Bewege langsam',
    copy: 'Bewege das Gerät gleichmäßig — schnelle Bewegungen verschlechtern die Erkennung.',
  },
  {
    eyebrow: '2. Erfasse alle Wände 360°',
    copy: 'Drehe Dich einmal komplett, damit der Raum geschlossen wird.',
  },
  {
    eyebrow: '3. Halte 1 m Abstand',
    copy: 'LiDAR misst optimal zwischen 1 m und 5 m Entfernung — nicht zu nah an die Wand gehen.',
  },
]

export interface ScanCoachingOverlayProps {
  /** Force the overlay open (e.g. from a "Tipps anzeigen" link). */
  forceOpen?: boolean
  /** Triggered when the user dismisses the overlay. */
  onDismiss?: () => void
}

export function ScanCoachingOverlay(props: ScanCoachingOverlayProps) {
  // Lazy initial state — keeps the open decision a pure derivation of
  // localStorage at mount time, avoiding the setState-in-effect cascade.
  const [open, setOpen] = useState<boolean>(() => {
    if (typeof window === 'undefined') return false
    if (props.forceOpen) return true
    return !window.localStorage.getItem(STORAGE_KEY)
  })

  const onDismiss = useCallback(() => {
    setOpen(false)
    if (typeof window !== 'undefined') {
      window.localStorage.setItem(STORAGE_KEY, String(Date.now()))
    }
    props.onDismiss?.()
  }, [props])

  if (!open) return null

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Tipps für einen guten Scan"
      className="fixed inset-0 z-50 flex items-center justify-center bg-neutral-900/80 px-6"
    >
      <div className="w-full max-w-md rounded-2xl bg-white p-6 shadow-2xl">
        <DeviceIllustration />
        <h2 className="mt-4 text-center text-lg font-semibold text-neutral-900">
          So gelingt der erste Raumscan
        </h2>
        <ul className="mt-4 space-y-3">
          {TIPS.map(tip => (
            <li key={tip.eyebrow} className="flex flex-col">
              <span className="text-[11px] font-semibold uppercase tracking-wide text-emerald-700">
                {tip.eyebrow}
              </span>
              <span className="text-sm text-neutral-700">{tip.copy}</span>
            </li>
          ))}
        </ul>
        <button
          type="button"
          onClick={onDismiss}
          className="mt-6 w-full rounded-md bg-emerald-600 px-4 py-3 text-sm font-semibold text-white hover:bg-emerald-700"
        >
          Verstanden
        </button>
      </div>
    </div>
  )
}

/** Inline minimal device-with-arc illustration — keeps the chunk SVG cost
 *  near-zero. Replace with a hand-illustrated asset in V1.5. */
function DeviceIllustration() {
  return (
    <svg
      viewBox="0 0 200 120"
      className="mx-auto h-24"
      role="img"
      aria-label="Gerät, das langsam um einen Raum schwenkt"
    >
      <rect
        x="78"
        y="20"
        width="44"
        height="80"
        rx="6"
        fill="#0f172a"
        stroke="#1e293b"
        strokeWidth="2"
      />
      <rect x="86" y="28" width="28" height="56" rx="3" fill="#10b981" opacity="0.25" />
      <path
        d="M30 90 Q100 30 170 90"
        fill="none"
        stroke="#10b981"
        strokeWidth="2"
        strokeDasharray="4 4"
      />
      <circle cx="30" cy="90" r="3" fill="#10b981" />
      <circle cx="170" cy="90" r="3" fill="#10b981" />
    </svg>
  )
}

