import { Link } from 'react-router-dom'
import type { ProviderReadiness } from '../../lib/providers'

type ProviderReadinessCardProps = {
  readiness: ProviderReadiness
  /** Route the "Profil vervollständigen" CTA navigates to. */
  profileEditPath?: string
}

/**
 * Displays an onboarding status card when a craftsman's provider profile is
 * not yet complete enough to appear in customer discovery.
 *
 * - Lists each missing field so the provider knows exactly what to fix.
 * - Provides a direct link to the profile editing screen.
 *
 * Only render this component when readiness.isReady === false.
 */
export default function ProviderReadinessCard({
  readiness,
  profileEditPath = '/craftsman/profile/edit',
}: ProviderReadinessCardProps) {
  const { completionPercent, gaps } = readiness

  return (
    <div className="rounded-[28px] bg-amber-50 ring-1 ring-amber-200 shadow-[0_18px_40px_-28px_rgba(2,6,23,0.18)] overflow-hidden">
      {/* Progress bar */}
      <div className="h-1.5 w-full bg-amber-100">
        <div
          className="h-1.5 bg-amber-400 transition-all duration-500"
          style={{ width: `${completionPercent}%` }}
        />
      </div>

      <div className="p-5">
        {/* Header */}
        <div className="flex items-start gap-3">
          <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-2xl bg-amber-100 ring-1 ring-amber-200">
            <span className="text-[18px]">⚠️</span>
          </div>
          <div className="min-w-0 flex-1">
            <div className="text-[11px] font-extrabold uppercase tracking-[0.22em] text-amber-600">
              Profil unvollständig
            </div>
            <p className="mt-1 text-[13px] leading-snug text-slate-700">
              Bitte vervollständige dein Profil, bevor Kunden dich finden können.
            </p>
          </div>
        </div>

        {/* Missing fields list */}
        {gaps.length > 0 && (
          <ul className="mt-4 space-y-1.5">
            {gaps.map((gap) => (
              <li key={gap} className="flex items-center gap-2 text-[13px] text-slate-600">
                <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-amber-100 text-[10px] text-amber-700">
                  ✕
                </span>
                {gap}
              </li>
            ))}
          </ul>
        )}

        {/* CTA */}
        <Link
          to={profileEditPath}
          className="mt-5 flex w-full items-center justify-center rounded-2xl bg-amber-400 px-4 py-2.5 text-[13px] font-semibold text-white shadow-sm transition hover:bg-amber-500 active:scale-[0.98]"
        >
          Profil vervollständigen →
        </Link>
      </div>
    </div>
  )
}
