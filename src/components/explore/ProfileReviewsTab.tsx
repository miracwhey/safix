import { useEffect, useState } from 'react'
import { BadgeCheck, Flag, Star } from 'lucide-react'
import {
  fetchProviderReviews,
  fetchCompletedJobIds,
  type ProviderReviewRow,
  type RatingDistributionBucket,
} from '../../lib/ratings/ratingDistributionService'
import { getSession, subscribeSession } from '../../lib/session'
import ReportUserSheet from '../moderation/ReportUserSheet'

type Props = {
  providerUserId: string
  ratingDistribution: RatingDistributionBucket[]
  /** Pre-computed sum of all rating counts (ratings.count). */
  ratingCount: number
  /** Pre-computed average rating (e.g. from trust projection). */
  averageRating: number
  /** Highlight pill when ≥ 5 customers re-booked the provider. */
  wouldHireAgainCount: number
}

/**
 * Stimmen-Tab — Rating-Summary, Histogramm 5→1 und Review-Liste mit
 * „✓ Verifiziertes Projekt"-Badges für Reviews, deren Job auf
 * `jobs.status='completed'` resolvebar ist.
 */
export default function ProfileReviewsTab({
  providerUserId,
  ratingDistribution,
  ratingCount,
  averageRating,
  wouldHireAgainCount,
}: Props) {
  const [reviews, setReviews] = useState<ProviderReviewRow[]>([])
  const [verifiedJobIds, setVerifiedJobIds] = useState<Set<string>>(new Set())
  const [loading, setLoading] = useState(true)
  const [lastSeenProviderId, setLastSeenProviderId] = useState(providerUserId)
  const [currentUserId, setCurrentUserId] = useState<string | null>(
    () => getSession().user?.id ?? null,
  )
  useEffect(() => {
    return subscribeSession(() => {
      setCurrentUserId(getSession().user?.id ?? null)
    })
  }, [])

  // Prop-Drift-Sync ohne setState-in-effect: wenn der Provider wechselt
  // (selten — der Tab unmounted/remounted bei Tab-Switch), Reset während
  // des Renders. React-Pattern „Adjusting State on Prop Change".
  if (providerUserId !== lastSeenProviderId) {
    setLastSeenProviderId(providerUserId)
    setReviews([])
    setVerifiedJobIds(new Set())
    setLoading(true)
  }

  useEffect(() => {
    let cancelled = false

    void (async () => {
      const list = await fetchProviderReviews(providerUserId, 50)
      if (cancelled) return
      setReviews(list)
      const jobIds = list.map((r) => r.jobId).filter(Boolean)
      const completed = await fetchCompletedJobIds(jobIds)
      if (cancelled) return
      setVerifiedJobIds(completed)
      setLoading(false)
    })()

    return () => {
      cancelled = true
    }
  }, [providerUserId])

  const maxBucket = Math.max(1, ...ratingDistribution.map((b) => b.count))
  const showRebookHighlight = wouldHireAgainCount >= 5

  return (
    <div className="space-y-4 px-4 pb-4 pt-4">
      {/* Summary */}
      <section className="rounded-card bg-white p-4 ring-1 ring-edge">
        <div className="flex items-start gap-4">
          <div className="flex flex-col items-center">
            <span className="text-[34px] font-bold leading-none text-ink">
              {ratingCount > 0 ? averageRating.toFixed(1) : '–'}
            </span>
            <StarRow score={Math.round(averageRating)} />
            <span className="mt-1 text-[11px] text-ink-muted">
              {ratingCount} {ratingCount === 1 ? 'Bewertung' : 'Bewertungen'}
            </span>
          </div>
          <div className="flex-1 space-y-1">
            {ratingDistribution.map((bucket) => (
              <div key={bucket.stars} className="flex items-center gap-2">
                <span className="w-3 text-right text-[11px] tabular-nums text-ink-muted">
                  {bucket.stars}
                </span>
                <Star size={11} className="text-amber-400" fill="currentColor" aria-hidden />
                <span className="relative h-1.5 flex-1 overflow-hidden rounded-full bg-canvas">
                  <span
                    className="absolute inset-y-0 left-0 rounded-full bg-amber-400"
                    style={{ width: `${(bucket.count / maxBucket) * 100}%` }}
                  />
                </span>
                <span className="w-6 text-right text-[11px] tabular-nums text-ink-muted">
                  {bucket.count}
                </span>
              </div>
            ))}
          </div>
        </div>

        {showRebookHighlight ? (
          <div className="mt-3 rounded-card bg-emerald-50 px-3 py-2 text-[12px] font-medium text-emerald-700 ring-1 ring-emerald-100">
            {wouldHireAgainCount}× wieder gebucht — überdurchschnittlich
          </div>
        ) : null}
      </section>

      {/* Reviews */}
      {loading ? (
        <p className="text-[13px] text-ink-muted">Lade Bewertungen …</p>
      ) : reviews.length === 0 ? (
        <p className="text-[13px] text-ink-muted">Noch keine Bewertungen.</p>
      ) : (
        <ul className="space-y-3">
          {reviews.map((review) => (
            <ReviewCard
              key={review.id}
              review={review}
              verified={verifiedJobIds.has(review.jobId)}
              currentUserId={currentUserId}
            />
          ))}
        </ul>
      )}
    </div>
  )
}

function ReviewCard({
  review,
  verified,
  currentUserId,
}: {
  review: ProviderReviewRow
  verified: boolean
  currentUserId: string | null
}) {
  const [showReport, setShowReport] = useState(false)
  const dateStr = formatRelativeDate(review.createdAt)
  const displayName = review.reviewerDisplayName ?? 'Kunde'
  const initial = displayName[0]?.toUpperCase() ?? 'K'
  // Hide the report action on the viewer's own review — the DB
  // reports_no_self_report CHECK would reject a self-report.
  const canReport = !!review.customerUserId && review.customerUserId !== currentUserId

  return (
    <li className="rounded-card bg-white p-3.5 ring-1 ring-edge">
      <div className="mb-2 flex items-center gap-2">
        <div className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-slate-100 text-[11px] font-semibold text-slate-600">
          {initial}
        </div>
        <span className="flex-1 text-[13px] font-medium text-ink">{displayName}</span>
        <span className="text-[11px] text-ink-muted">{dateStr}</span>
      </div>
      <StarRow score={review.ratingScore} />
      {review.ratingComment ? (
        <p className="mt-1.5 text-[13px] leading-relaxed text-ink-sub">{review.ratingComment}</p>
      ) : null}
      <div className="mt-2 flex items-center gap-2">
        {verified ? (
          <div className="inline-flex items-center gap-1 rounded-full bg-emerald-50 px-2 py-[2px] text-[10px] font-semibold text-emerald-700 ring-1 ring-emerald-100">
            <BadgeCheck size={11} aria-hidden />
            <span>Verifiziertes Projekt</span>
          </div>
        ) : null}
        {canReport ? (
          <button
            type="button"
            onClick={() => setShowReport(true)}
            className="ml-auto inline-flex items-center gap-1 text-[11px] text-ink-muted transition active:text-rose-600"
            aria-label="Bewertung melden"
          >
            <Flag size={11} aria-hidden />
            <span>Bewertung melden</span>
          </button>
        ) : null}
      </div>
      {showReport ? (
        <ReportUserSheet
          targetUserId={review.customerUserId}
          targetLabel={displayName}
          contextType="review"
          contextId={review.id}
          onClose={() => setShowReport(false)}
        />
      ) : null}
    </li>
  )
}

function StarRow({ score }: { score: number }) {
  return (
    <span className="inline-flex items-center gap-0.5" aria-label={`${score} von 5 Sternen`}>
      {[1, 2, 3, 4, 5].map((s) => (
        <Star
          key={s}
          size={12}
          className={s <= score ? 'text-amber-400' : 'text-slate-300'}
          fill={s <= score ? 'currentColor' : 'none'}
          aria-hidden
        />
      ))}
    </span>
  )
}

function formatRelativeDate(createdAt: number): string {
  const diffMs = Date.now() - createdAt
  const diffDays = Math.floor(diffMs / (1000 * 60 * 60 * 24))
  if (diffDays <= 0) return 'Heute'
  if (diffDays === 1) return 'Gestern'
  if (diffDays < 7) return `vor ${diffDays} Tagen`
  if (diffDays < 30) {
    const weeks = Math.floor(diffDays / 7)
    return `vor ${weeks} Woche${weeks === 1 ? '' : 'n'}`
  }
  if (diffDays < 365) {
    const months = Math.floor(diffDays / 30)
    return `vor ${months} Monat${months === 1 ? '' : 'en'}`
  }
  const years = Math.floor(diffDays / 365)
  return `vor ${years} Jahr${years === 1 ? '' : 'en'}`
}
