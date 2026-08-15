import { useEffect, useState } from 'react'
import { Flag } from 'lucide-react'
import { subscribeRatings, getRatingsByProviderUserId, getRecentRatings } from '../../lib/ratings'
import { useStoreSync } from '../../lib/reactive'
import { getSession, subscribeSession } from '../../lib/session'
import ReportUserSheet from '../moderation/ReportUserSheet'

type Props = {
  providerUserId: string
  /** Maximum number of recent reviews to display (default: 3). */
  limit?: number
}

function formatRelativeDate(createdAt: number): string {
  const diffMs = Date.now() - createdAt
  const diffDays = Math.floor(diffMs / (1000 * 60 * 60 * 24))
  if (diffDays === 0) return 'Heute'
  if (diffDays === 1) return 'Gestern'
  if (diffDays < 7) return `vor ${diffDays} Tagen`
  const weeks = Math.floor(diffDays / 7)
  if (diffDays < 30) return `vor ${weeks} Woche${weeks === 1 ? '' : 'n'}`
  const months = Math.floor(diffDays / 30)
  if (diffDays < 365) return `vor ${months} Monat${months === 1 ? '' : 'en'}`
  const years = Math.floor(diffDays / 365)
  return `vor ${years} Jahr${years === 1 ? '' : 'en'}`
}

function StarRow({ score }: { score: number }) {
  return (
    <span className="flex items-center gap-0.5" aria-label={`${score} von 5 Sternen`}>
      {[1, 2, 3, 4, 5].map((s) => (
        <span
          key={s}
          className="text-[12px] leading-none"
          style={{ color: s <= score ? '#F59E0B' : '#CBD5E1' }}
          aria-hidden
        >
          ★
        </span>
      ))}
    </span>
  )
}

export default function RecentReviewsCard({ providerUserId, limit = 3 }: Props) {
  const [reviews, setReviews] = useState(() =>
    getRecentRatings(providerUserId, getRatingsByProviderUserId(providerUserId), limit)
  )

  useStoreSync([subscribeRatings], () => {
    setReviews(
      getRecentRatings(providerUserId, getRatingsByProviderUserId(providerUserId), limit)
    )
  })

  const [currentUserId, setCurrentUserId] = useState<string | null>(
    () => getSession().user?.id ?? null,
  )
  useEffect(() => {
    return subscribeSession(() => {
      setCurrentUserId(getSession().user?.id ?? null)
    })
  }, [])
  // Apple-1.2: single hoisted report sheet, keyed by the target reviewer.
  const [reportTarget, setReportTarget] = useState<{ userId: string; reviewId: string } | null>(
    null,
  )

  // Empty state is owned by ProviderReputationBadge — don't double-render
  if (reviews.length === 0) return null

  return (
    <section className="relative overflow-hidden rounded-[28px] bg-white p-5 ring-1 ring-slate-200/70 shadow-[0_2px_12px_-4px_rgba(2,6,23,0.08)]">
      <div className="pointer-events-none absolute left-0 top-0 h-full w-[3px] rounded-l-[28px] bg-gradient-to-b from-slate-400 via-slate-300 to-slate-200" />

      {/* Header */}
      <div className="flex items-center gap-2">
        <span className="text-[11px] font-semibold uppercase tracking-[0.18em] text-slate-400">
          Neueste Bewertungen
        </span>
        <span className="inline-flex items-center rounded-full bg-slate-100 px-2.5 py-0.5 text-[10px] font-bold tracking-[0.15em] text-slate-500">
          {reviews.length}
        </span>
      </div>

      <ul className="mt-4 space-y-4">
        {reviews.map((review) => {
          const canReport =
            !!review.customerUserId && review.customerUserId !== currentUserId
          return (
            <li key={review.id} className="space-y-1">
              <div className="flex items-center justify-between gap-2">
                <StarRow score={review.ratingScore} />
                <div className="flex shrink-0 items-center gap-2">
                  <span className="text-[11px] text-slate-400">
                    {formatRelativeDate(review.createdAt)}
                  </span>
                  {canReport ? (
                    <button
                      type="button"
                      onClick={() =>
                        setReportTarget({ userId: review.customerUserId, reviewId: review.id })
                      }
                      className="inline-flex items-center text-slate-300 transition active:text-rose-600"
                      aria-label="Bewertung melden"
                    >
                      <Flag size={12} aria-hidden />
                    </button>
                  ) : null}
                </div>
              </div>
              {review.ratingComment ? (
                <p className="text-[13px] leading-snug text-slate-600">
                  „{review.ratingComment}"
                </p>
              ) : (
                <p className="text-[12px] italic text-slate-400">Kein Kommentar</p>
              )}
            </li>
          )
        })}
      </ul>

      {reportTarget ? (
        <ReportUserSheet
          targetUserId={reportTarget.userId}
          targetLabel="Bewertung"
          contextType="review"
          contextId={reportTarget.reviewId}
          onClose={() => setReportTarget(null)}
        />
      ) : null}
    </section>
  )
}
