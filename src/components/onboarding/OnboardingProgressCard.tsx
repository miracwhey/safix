import { useEffect } from 'react'
import { Link } from 'react-router-dom'
import { logInfo, logWarning } from '../../lib/observability'
import type { OnboardingProgress } from '../../lib/onboarding/selectors'
import OnboardingStepRow from './OnboardingStepRow'

type Props = {
  progress: OnboardingProgress
}

/**
 * Displays an onboarding progress card for craftsmen.
 *
 * Shows:
 * - Overall progress bar and step count (e.g. 3/5)
 * - Ordered list of onboarding steps with status icons
 * - A discovery-blocked indicator when the profile basics are not yet complete
 * - A visible/discoverable indicator when profile is ready but payout is pending
 * - A CTA button pointing to the next required action
 *
 * Visibility is determined by profile readiness, NOT by Stripe/payout status.
 * Stripe is only required for payment-critical actions.
 *
 * Observability events emitted:
 * - `onboarding.viewed`              – on mount
 * - `onboarding.blocked`             – when discovery is blocked (profile incomplete)
 * - `onboarding.ready_for_activation`– when all steps are complete
 */
export default function OnboardingProgressCard({ progress }: Props) {
  const {
    steps,
    completedCount,
    totalCount,
    completionPercent,
    nextStep,
    isDiscoveryBlocked,
    isProfileReady,
    isPayoutReady,
    isComplete,
  } = progress

  // ── Observability ──────────────────────────────────────────────────────────
  useEffect(() => {
    logInfo('onboarding.viewed', {
      completedCount,
      totalCount,
      completionPercent,
      isDiscoveryBlocked,
      isProfileReady,
      isPayoutReady,
    })

    if (isDiscoveryBlocked) {
      logWarning('onboarding.blocked', {
        completedCount,
        totalCount,
        nextStepId: nextStep?.id,
      })
    }
    // Intentionally run only once on mount.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // CTA subtitle depends on whether the next step is about visibility or payments
  const ctaSubtitle =
    nextStep?.id === 'payout_setup'
      ? 'Zahlungsfunktionen freischalten'
      : 'Nach Abschluss wirst du für Kunden sichtbar'

  return (
    <div className="rounded-[28px] bg-blue-50 ring-1 ring-blue-200 shadow-[0_18px_40px_-28px_rgba(2,6,23,0.18)] overflow-hidden">
      {/* Progress bar */}
      <div className="h-1.5 w-full bg-blue-100">
        <div
          className="h-1.5 bg-blue-500 transition-all duration-500"
          style={{ width: `${completionPercent}%` }}
          role="progressbar"
          aria-valuenow={completionPercent}
          aria-valuemin={0}
          aria-valuemax={100}
        />
      </div>

      <div className="p-5">
        {/* Header row */}
        <div className="flex items-start gap-3">
          <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-2xl bg-blue-100 ring-1 ring-blue-200">
            <span className="text-[18px]">🚀</span>
          </div>
          <div className="min-w-0 flex-1">
            <div className="flex items-center justify-between gap-2">
              <div className="text-[11px] font-extrabold uppercase tracking-[0.22em] text-blue-600">
                Einrichtung
              </div>
              <div className="text-[12px] font-semibold text-blue-700">
                {completedCount}/{totalCount}
              </div>
            </div>
            <p className="mt-0.5 text-[13px] leading-snug text-slate-700">
              {isComplete
                ? 'Dein Profil ist vollständig und für Kunden sichtbar.'
                : isProfileReady
                  ? 'Du bist für Kunden sichtbar. Schließe die restlichen Schritte ab.'
                  : 'Schließe die Profileinrichtung ab, um von Kunden gefunden zu werden.'}
            </p>
          </div>
        </div>

        {/* Discovery-blocked indicator — only when profile basics are incomplete */}
        {isDiscoveryBlocked && (
          <div className="mt-3 rounded-xl bg-amber-500 px-4 py-3 shadow-[0_8px_20px_-12px_rgba(245,158,11,0.6)]">
            <div className="flex items-center gap-2">
              <span className="text-[16px]">🔒</span>
              <span className="text-[13px] font-bold text-white">
                Profil unvollständig
              </span>
            </div>
            <p className="mt-1 text-[12px] leading-snug text-amber-100">
              Kunden können dich noch nicht finden. Vervollständige dein Profil, um sichtbar zu werden.
            </p>
          </div>
        )}

        {/* Profile ready but payout pending — discoverable, payments not yet available */}
        {isProfileReady && !isPayoutReady && (
          <div className="mt-3 space-y-2">
            <div className="rounded-xl bg-emerald-500 px-4 py-3 shadow-[0_8px_20px_-12px_rgba(16,185,129,0.6)]">
              <div className="flex items-center gap-2">
                <span className="text-[16px]">✅</span>
                <span className="text-[13px] font-bold text-white">
                  Du bist sichtbar
                </span>
              </div>
              <p className="mt-1 text-[12px] leading-snug text-emerald-100">
                Kunden können dich finden und Anfragen senden.
              </p>
            </div>
            <div className="rounded-xl bg-amber-50 px-4 py-3 ring-1 ring-amber-200">
              <div className="flex items-center gap-2">
                <span className="text-[16px]">💳</span>
                <span className="text-[13px] font-semibold text-amber-800">
                  Auszahlung noch nicht eingerichtet
                </span>
              </div>
              <p className="mt-1 text-[12px] leading-snug text-amber-700">
                Angebote senden und Zahlungsaufforderungen erstellen ist ohne Stripe möglich. Schließe die Stripe-Einrichtung ab, um Auszahlungen zu empfangen.
              </p>
            </div>
          </div>
        )}

        {/* Steps list */}
        <div className="mt-4 divide-y divide-slate-100">
          {steps.map((step) => (
            <OnboardingStepRow key={step.id} step={step} />
          ))}
        </div>

        {/* Next-step CTA */}
        {nextStep && (
          <Link
            to={nextStep.navigationPath}
            className="mt-4 flex w-full flex-col items-center justify-center gap-1 rounded-2xl bg-blue-600 px-4 py-4 text-white shadow-[0_14px_30px_-18px_rgba(37,99,235,0.7)] transition hover:bg-blue-700 active:scale-[0.98]"
          >
            <span className="text-[15px] font-bold">{nextStep.title} →</span>
            <span className="text-[12px] font-medium text-blue-200">
              {ctaSubtitle}
            </span>
          </Link>
        )}
      </div>
    </div>
  )
}
