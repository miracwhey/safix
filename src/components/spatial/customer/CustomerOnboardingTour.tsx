/**
 * Spatial V1.6 · Phase 4 · CustomerOnboardingTour
 *
 * 4-step bottom-sheet tour that runs on a customer's first visit to the
 * Spatial-Hub. Mockup 08 binding.
 *
 * UX contract (locked decisions):
 *   - **Step 1** (Was ist 3D-Aufmaß): Skip-Button HIDDEN, ESC + backdrop
 *     do NOT dismiss (hard gate per B4-D8 + TBD #4). The user must tap
 *     "Weiter" to progress.
 *   - **Step 2-4**: Skip-Button visible top-right. ESC + backdrop count
 *     as Skip — both close the tour and persist the seen-flag, so a
 *     drive-by close is not penalised by a re-open on next mount.
 *   - **Step 4 CTA** "Los geht's" sets the persisted flag and closes.
 *     Re-open the Hub later → no tour.
 *
 * Persistence is centralised via `useSpatialFirstRunFlag`. The Hub mounts
 * the tour gated on the same flag so the visibility decision is owned by
 * the screen, not split across two sources of truth.
 *
 * Wording-lock: outcome-first language (what the customer gets), never
 * tech jargon. Step 3 explicitly says "Geht auch ohne Pro-iPhone" so
 * non-LiDAR users feel included.
 */

import { useCallback, useState } from 'react'

import BottomSheet from '../../ui/BottomSheet'

const STORAGE_KEY = 'spatial-customer-onboarding-seen-v1'

export { STORAGE_KEY as ONBOARDING_TOUR_STORAGE_KEY }

type StepId = 1 | 2 | 3 | 4

interface StepCopy {
  eyebrow: string
  headline: string
  body: string
  illustration: 'room' | 'paths' | 'ruler' | 'share'
}

const STEPS: Record<StepId, StepCopy> = {
  1: {
    eyebrow: 'Schritt 1 von 4',
    headline: 'Dein Raum in 3D',
    body: 'Mit einem 3D-Aufmaß sieht dein Handwerker jede Wand, Tür und Heizung — ohne dass er vorbeikommen muss.',
    illustration: 'room',
  },
  2: {
    eyebrow: 'Schritt 2 von 4',
    headline: '3 Wege — du wählst',
    body: 'iPhone-Scan (1–2 Min), Vorlage (30 Sek) oder leerer Raum (2–3 Min). Du entscheidest, was passt.',
    illustration: 'paths',
  },
  3: {
    eyebrow: 'Schritt 3 von 4',
    headline: 'Geht auch ohne Pro-iPhone',
    body: 'Kein LiDAR? Kein Problem. Du gibst die Maße per Zollstock ein, wir bauen das 3D-Modell.',
    illustration: 'ruler',
  },
  4: {
    eyebrow: 'Schritt 4 von 4',
    headline: 'Der Handwerker sieht‘s wie du',
    body: 'Wir teilen 3D, Maße und Notizen. Er kann nichts ändern — du bleibst Besitzer.',
    illustration: 'share',
  },
}

export interface CustomerOnboardingTourProps {
  open: boolean
  /** Fired when the tour completes via "Los geht's" CTA on Step 4, or
   *  when Skip / ESC / backdrop is used on Step 2-4. Caller persists the
   *  flag via `useSpatialFirstRunFlag.markSeen()` AND closes the tour. */
  onDone: () => void
}

export default function CustomerOnboardingTour({
  open,
  onDone,
}: CustomerOnboardingTourProps) {
  const [step, setStep] = useState<StepId>(1)

  const handleNext = useCallback(() => {
    setStep((prev) => (prev < 4 ? ((prev + 1) as StepId) : prev))
  }, [])

  const handleBack = useCallback(() => {
    setStep((prev) => (prev > 1 ? ((prev - 1) as StepId) : prev))
  }, [])

  const handleSkip = useCallback(() => {
    // Reset for the next reuse (if any) and signal done. The parent
    // resets the open prop AND persists the flag.
    setStep(1)
    onDone()
  }, [onDone])

  const handleFinish = useCallback(() => {
    setStep(1)
    onDone()
  }, [onDone])

  // ESC + backdrop close routes here. Step 1 hard-gates dismissal —
  // a no-op disables both paths. Step 2-4 count it as a Skip.
  const handleClose = useCallback(() => {
    if (step === 1) return
    handleSkip()
  }, [step, handleSkip])

  const copy = STEPS[step]
  const skipVisible = step > 1
  const isFinal = step === 4

  return (
    <BottomSheet
      open={open}
      onClose={handleClose}
      maxWidth={460}
      className="!bg-slate-900/95 !text-white border border-white/10 backdrop-blur-2xl"
    >
      <div aria-labelledby="onboarding-tour-title">
        <div className="flex items-start justify-between">
          <span className="text-[11px] font-semibold uppercase tracking-widest text-sky-300/80">
            {copy.eyebrow}
          </span>
          {skipVisible ? (
            <button
              type="button"
              onClick={handleSkip}
              className="rounded-full px-2.5 py-1 text-[11px] font-semibold text-white/55 transition hover:bg-white/5 hover:text-white/80 focus:outline-none focus:ring-2 focus:ring-sky-400/60"
            >
              Überspringen
            </button>
          ) : (
            <span aria-hidden className="text-[11px] text-transparent">
              {/* placeholder keeps header height stable between steps */}
              Überspringen
            </span>
          )}
        </div>

        <div className="mt-4 grid h-[180px] place-items-center overflow-hidden rounded-2xl border border-white/10 bg-gradient-to-br from-slate-800/60 to-slate-900/70">
          <TourIllustration kind={copy.illustration} />
        </div>

        <h2
          id="onboarding-tour-title"
          className="mt-5 text-[22px] font-bold leading-tight tracking-tight text-white"
        >
          {copy.headline}
        </h2>
        <p className="mt-2 text-[13.5px] leading-relaxed text-white/70">
          {copy.body}
        </p>

        <div
          className="mt-5 flex items-center justify-center gap-2"
          role="tablist"
          aria-label="Tour-Fortschritt"
        >
          {([1, 2, 3, 4] as const).map((dot) => (
            <span
              key={dot}
              aria-hidden
              className={`h-1.5 rounded-full transition-all ${
                dot === step
                  ? 'w-6 bg-sky-400'
                  : dot < step
                    ? 'w-1.5 bg-sky-400/60'
                    : 'w-1.5 bg-white/15'
              }`}
            />
          ))}
        </div>

        <div className="mt-5 flex items-center gap-2">
          {step > 1 && (
            <button
              type="button"
              onClick={handleBack}
              className="rounded-2xl border border-white/10 bg-white/[0.04] px-4 py-3 text-sm font-semibold text-white/80 transition hover:bg-white/[0.08]"
            >
              Zurück
            </button>
          )}
          <button
            type="button"
            onClick={isFinal ? handleFinish : handleNext}
            className={`flex-1 rounded-2xl px-4 py-3.5 text-sm font-bold text-white shadow-lg transition focus:outline-none focus:ring-2 focus:ring-sky-300/60 ${
              isFinal
                ? 'bg-gradient-to-br from-emerald-500 to-emerald-600 shadow-emerald-900/40 hover:from-emerald-400 hover:to-emerald-500'
                : 'bg-gradient-to-br from-sky-500 to-blue-600 shadow-sky-900/40 hover:from-sky-400 hover:to-blue-500'
            }`}
          >
            {isFinal ? "Los geht's" : 'Weiter'}
          </button>
        </div>
      </div>
    </BottomSheet>
  )
}

function TourIllustration({ kind }: { kind: StepCopy['illustration'] }) {
  // Inline SVG stand-ins keep the bundle cost flat. A production designer
  // can swap each to a Lottie animation later (existing pipeline in
  // ScanCoachingOverlay shows the SVG→Lottie path).
  switch (kind) {
    case 'room':
      return (
        <svg viewBox="0 0 200 140" className="h-full w-full" aria-hidden>
          <path d="M30 100 L100 50 L170 100 L170 130 L30 130 Z" fill="none" stroke="#60a5fa" strokeWidth="2" />
          <path d="M100 50 L100 100" stroke="#60a5fa" strokeWidth="1" strokeDasharray="4 3" />
          <circle cx="70" cy="115" r="4" fill="#a78bfa" />
          <circle cx="120" cy="115" r="4" fill="#22d3ee" />
          <circle cx="150" cy="120" r="4" fill="#ef4444" />
        </svg>
      )
    case 'paths':
      return (
        <svg viewBox="0 0 240 120" className="h-full w-full" aria-hidden>
          {[
            { x: 10, label: 'Scan', color: '#60a5fa' },
            { x: 90, label: 'Vorlage', color: '#34d399' },
            { x: 170, label: 'Leer', color: '#fbbf24' },
          ].map((tile) => (
            <g key={tile.label}>
              <rect x={tile.x} y={20} width={60} height={80} rx={10} fill="none" stroke={tile.color} strokeWidth="2" />
              <text x={tile.x + 30} y={70} fill={tile.color} fontSize="11" fontWeight="bold" textAnchor="middle">
                {tile.label}
              </text>
            </g>
          ))}
        </svg>
      )
    case 'ruler':
      return (
        <svg viewBox="0 0 220 100" className="h-full w-full" aria-hidden>
          <rect x="20" y="40" width="180" height="20" rx="3" fill="#fbbf24" />
          {Array.from({ length: 10 }).map((_, i) => (
            <line key={i} x1={20 + i * 20} y1={40} x2={20 + i * 20} y2={50} stroke="#0f172a" strokeWidth="2" />
          ))}
          <text x="110" y="80" fill="#fbbf24" fontSize="11" fontWeight="bold" textAnchor="middle">
            Zollstock
          </text>
        </svg>
      )
    case 'share':
      return (
        <svg viewBox="0 0 240 120" className="h-full w-full" aria-hidden>
          <rect x="20" y="20" width="70" height="80" rx="10" fill="none" stroke="#60a5fa" strokeWidth="2" />
          <rect x="150" y="20" width="70" height="80" rx="10" fill="none" stroke="#a78bfa" strokeWidth="2" />
          <path d="M95 60 L145 60" stroke="#94a3b8" strokeWidth="2" strokeDasharray="4 3" />
          <path d="M140 55 L150 60 L140 65" fill="none" stroke="#94a3b8" strokeWidth="2" />
          <text x="55" y="115" fill="#60a5fa" fontSize="10" textAnchor="middle">Du</text>
          <text x="185" y="115" fill="#a78bfa" fontSize="10" textAnchor="middle">Handwerker</text>
        </svg>
      )
  }
}
