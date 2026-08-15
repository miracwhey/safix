import { useMemo } from 'react'
import { Link } from 'react-router-dom'
import { deriveProviderReputation } from '../../lib/ratings/selectors'
import { deriveProviderTrustFlags, deriveProviderTrustStatus } from '../../lib/trust/trustSelectors'
import type { ProviderTrustFlag, ProviderTrustStatus } from '../../lib/trust/trustTypes'
import type { Rating } from '../../lib/ratings/types'
import type { Job } from '../../lib/jobs/types'
import type { Dispute } from '../../lib/disputes/types'
import { ACTIVE_DISPUTE_STATUSES } from '../../lib/disputes/stateMachine'
import ProviderTrustStatusBadge from './ProviderTrustStatusBadge'

type TrustEntry = {
  providerUserId: string
  status: ProviderTrustStatus
  flags: ProviderTrustFlag[]
  averageRating: number
  ratingCount: number
}

type Props = {
  ratings: Rating[]
  jobs: Job[]
  disputes: Dispute[]
}

function getActionLinks(flags: ProviderTrustFlag[]): Array<{ label: string; to: string; color: string }> {
  const links: Array<{ label: string; to: string; color: string }> = []
  for (const flag of flags) {
    if (flag.kind === 'repeated_disputes') {
      links.push({
        label: 'Streitfälle →',
        to: '/craftsman/disputes',
        color: 'bg-rose-50 text-rose-700 ring-rose-200',
      })
    } else if (flag.kind === 'payout_not_ready') {
      links.push({
        label: 'Finanzen →',
        to: '/craftsman/finance',
        color: 'bg-blue-50 text-blue-700 ring-blue-200',
      })
    }
  }
  return links
}

function getSeverityStyle(status: ProviderTrustStatus): { container: string; accentBar: string } {
  switch (status) {
    case 'restricted':
      return {
        container: 'bg-white ring-rose-200/80',
        accentBar: 'bg-gradient-to-b from-rose-500 via-rose-400 to-rose-300',
      }
    case 'watch':
      return {
        container: 'bg-white ring-amber-200/70',
        accentBar: 'bg-gradient-to-b from-amber-500 via-amber-400 to-amber-300',
      }
    default:
      return {
        container: 'bg-white ring-slate-200/70',
        accentBar: 'bg-gradient-to-b from-slate-400 via-slate-300 to-slate-200',
      }
  }
}

/**
 * Operator-facing trust visibility panel.
 *
 * Derives trust flags from ratings, jobs, and disputes. Surfaces providers
 * with concerning signals and includes action links to resolution surfaces.
 *
 * Only shows providers with at least a 'watch' status (excludes trusted providers).
 *
 * Note: payoutReady and onboardingCompleted are not available from the current
 * stores — those signals require a provider profile store that is not yet wired.
 * Dispute counts and completed job counts are derived from the jobs+disputes stores.
 */
export default function OperatorTrustPanel({ ratings, jobs, disputes }: Props) {
  const trustEntries = useMemo<TrustEntry[]>(() => {
    // Map job IDs to their craftsman's provider user ID for dispute attribution.
    // craftsmanUserId is the Supabase auth user ID, which equals rating.providerUserId.
    const jobIdToProviderUserId = new Map<string, string>()
    for (const job of jobs) {
      if (job.craftsmanUserId != null) {
        jobIdToProviderUserId.set(job.id, job.craftsmanUserId)
      }
    }

    const providerIds = [...new Set(ratings.map((r) => r.providerUserId))]

    return providerIds
      .map((providerUserId): TrustEntry => {
        const reputation = deriveProviderReputation(providerUserId, ratings)

        const openDisputeCount = disputes.filter(
          (d) =>
            ACTIVE_DISPUTE_STATUSES.has(d.status) &&
            jobIdToProviderUserId.get(d.jobId) === providerUserId
        ).length

        const totalDisputeCount = disputes.filter(
          (d) => jobIdToProviderUserId.get(d.jobId) === providerUserId
        ).length

        const completedJobsCount = jobs.filter(
          (j) => j.craftsmanUserId === providerUserId && j.status === 'completed'
        ).length

        const flags = deriveProviderTrustFlags({
          providerUserId,
          averageRating: reputation.averageRating,
          ratingCount: reputation.ratingCount,
          // payout and onboarding state not available — provider profile store not wired
          payoutReady: true,
          onboardingCompleted: true,
          openDisputeCount,
          totalDisputeCount,
          completedJobsCount,
        })
        const status = deriveProviderTrustStatus(flags)

        return {
          providerUserId,
          status,
          flags,
          averageRating: reputation.averageRating,
          ratingCount: reputation.ratingCount,
        }
      })
      .filter((entry) => entry.status !== 'trusted' && entry.flags.length > 0)
      .sort((a, b) => {
        const order: Record<ProviderTrustStatus, number> = { restricted: 0, watch: 1, trusted: 2 }
        return order[a.status] - order[b.status]
      })
  }, [ratings, jobs, disputes])

  if (trustEntries.length === 0) {
    return (
      <div className="rounded-[24px] bg-emerald-50 p-4 ring-1 ring-emerald-200 text-center">
        <div className="text-[20px]">✅</div>
        <p className="mt-1 text-[13px] font-semibold text-emerald-700">
          Keine Trust-Risiken erkannt
        </p>
        <p className="text-[11px] text-emerald-600">
          Alle bewerteten Anbieter liegen im akzeptablen Bereich.
        </p>
      </div>
    )
  }

  return (
    <div className="space-y-2">
      {trustEntries.map((entry) => {
        const style = getSeverityStyle(entry.status)
        const actionLinks = getActionLinks(entry.flags)
        return (
          <div
            key={entry.providerUserId}
            className={`relative overflow-hidden rounded-[24px] p-4 ring-1 shadow-[0_12px_28px_-20px_rgba(2,6,23,0.22)] ${style.container}`}
          >
            <div
              className={`pointer-events-none absolute left-0 top-0 h-full w-[3px] rounded-l-[24px] ${style.accentBar}`}
            />

            <div className="flex items-start gap-3">
              <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-2xl bg-slate-100 ring-1 ring-slate-200">
                <span className="text-[18px] leading-none">🛡️</span>
              </div>

              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-2">
                  <ProviderTrustStatusBadge status={entry.status} compact />
                  {entry.ratingCount > 0 && (
                    <span className="text-[11px] text-slate-500">
                      Ø {entry.averageRating.toFixed(1)} ({entry.ratingCount} Bewertungen)
                    </span>
                  )}
                </div>

                <p className="mt-1 text-[11px] font-medium text-slate-400 font-mono truncate">
                  {entry.providerUserId}
                </p>

                <ul className="mt-2 space-y-1">
                  {entry.flags.map((flag) => (
                    <li
                      key={flag.kind}
                      className="text-[11px] leading-snug text-slate-600"
                    >
                      {flag.severity === 'high' ? '🔴' : flag.severity === 'medium' ? '🟡' : '⚪'}{' '}
                      {flag.label}
                    </li>
                  ))}
                </ul>

                {actionLinks.length > 0 && (
                  <div className="mt-2.5 flex flex-wrap gap-1.5">
                    {actionLinks.map((link) => (
                      <Link
                        key={link.to}
                        to={link.to}
                        className={`inline-flex items-center rounded-xl px-2.5 py-1.5 text-[11px] font-bold ring-1 transition-transform duration-200 active:scale-[0.97] ${link.color}`}
                      >
                        {link.label}
                      </Link>
                    ))}
                  </div>
                )}
              </div>
            </div>
          </div>
        )
      })}
    </div>
  )
}
