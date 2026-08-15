import { useState } from 'react'
import { subscribeRatings, getRatingByJobId } from '../../lib/ratings'
import { submitRatingWorkflow } from '../../lib/workflow'
import { useStoreSync } from '../../lib/reactive'
import { logError } from '../../lib/observability'

type Props = {
  jobId: string
  providerUserId: string
  customerUserId: string
}

const STAR_LABELS: Record<number, string> = {
  1: 'Mangelhaft',
  2: 'Ausreichend',
  3: 'Gut',
  4: 'Sehr gut',
  5: 'Ausgezeichnet',
}

export default function JobRatingCard({ jobId, providerUserId, customerUserId }: Props) {
  const [existingRating, setExistingRating] = useState(() => getRatingByJobId(jobId))
  const [hoveredScore, setHoveredScore] = useState<number>(0)
  const [selectedScore, setSelectedScore] = useState<number>(0)
  const [comment, setComment] = useState('')
  const [submitted, setSubmitted] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [isSubmitting, setIsSubmitting] = useState(false)

  useStoreSync([subscribeRatings], () => {
    setExistingRating(getRatingByJobId(jobId))
  })

  // Already rated – show the submitted rating
  if (existingRating) {
    return (
      <section className="relative overflow-hidden rounded-[28px] bg-white p-5 ring-1 ring-indigo-200/80 shadow-[0_18px_40px_-28px_rgba(2,6,23,0.28)]">
        <div className="pointer-events-none absolute left-0 top-0 h-full w-[3px] rounded-l-[28px] bg-gradient-to-b from-indigo-500 via-indigo-400 to-indigo-300" />

        <div className="flex items-center gap-2">
          <span className="text-[12px] font-semibold uppercase tracking-[0.18em] text-slate-400">
            Bewertung
          </span>
          <span className="inline-flex items-center rounded-full bg-indigo-50 px-2.5 py-0.5 text-[10px] font-bold tracking-[0.15em] text-indigo-700 ring-1 ring-indigo-100">
            ABGEGEBEN
          </span>
        </div>

        <div className="mt-3 flex items-center gap-3">
          <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-2xl bg-indigo-500 text-[20px]"
            style={{ boxShadow: '0 8px 20px -12px rgba(99,102,241,0.5)' }}>
            ⭐
          </div>
          <div>
            <p className="text-[16px] font-bold text-slate-800 leading-tight">
              {existingRating.ratingScore} / 5 · {STAR_LABELS[existingRating.ratingScore]}
            </p>
            {existingRating.ratingComment && (
              <p className="mt-0.5 text-[13px] text-slate-500 leading-snug">
                „{existingRating.ratingComment}"
              </p>
            )}
          </div>
        </div>
      </section>
    )
  }

  if (submitted) {
    return (
      <section className="relative overflow-hidden rounded-[28px] bg-white p-5 ring-1 ring-emerald-200/80 shadow-[0_18px_40px_-28px_rgba(2,6,23,0.28)]">
        <div className="pointer-events-none absolute left-0 top-0 h-full w-[3px] rounded-l-[28px] bg-gradient-to-b from-emerald-500 via-emerald-400 to-emerald-300" />
        <div className="flex items-center gap-2">
          <span className="text-[12px] font-semibold uppercase tracking-[0.18em] text-slate-400">
            Bewertung
          </span>
        </div>
        <div className="mt-3 flex items-center gap-3">
          <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-2xl bg-emerald-500 text-[20px]"
            style={{ boxShadow: '0 8px 20px -12px rgba(16,185,129,0.5)' }}>
            ✓
          </div>
          <p className="text-[15px] font-semibold text-slate-800">Vielen Dank für deine Bewertung!</p>
        </div>
      </section>
    )
  }

  async function handleSubmit() {
    if (selectedScore === 0) {
      setError('Bitte wähle eine Bewertung aus.')
      return
    }
    if (isSubmitting) return
    setError(null)
    setIsSubmitting(true)
    try {
      const result = await submitRatingWorkflow({
        jobId,
        providerUserId,
        customerUserId,
        ratingScore: selectedScore as 1 | 2 | 3 | 4 | 5,
        ratingComment: comment.trim() !== '' ? comment.trim() : undefined,
      })
      if (result) {
        setSubmitted(true)
      } else {
        logError('ui.rating_submit_failed', undefined, { jobId })
        setError('Bewertung konnte nicht gespeichert werden. Bitte versuche es erneut.')
      }
    } catch (err) {
      logError('ui.rating_submit_failed', err, { jobId })
      setError('Bewertung konnte nicht gespeichert werden. Bitte versuche es erneut.')
    } finally {
      setIsSubmitting(false)
    }
  }

  const displayScore = hoveredScore > 0 ? hoveredScore : selectedScore

  return (
    <section className="relative overflow-hidden rounded-[28px] bg-white p-5 ring-1 ring-indigo-200/80 shadow-[0_18px_40px_-28px_rgba(2,6,23,0.28)]">
      <div className="pointer-events-none absolute left-0 top-0 h-full w-[3px] rounded-l-[28px] bg-gradient-to-b from-indigo-500 via-indigo-400 to-indigo-300" />

      {/* Header */}
      <div className="flex items-center gap-2">
        <span className="text-[12px] font-semibold uppercase tracking-[0.18em] text-slate-400">
          Bewertung
        </span>
        <span className="inline-flex items-center rounded-full bg-indigo-50 px-2.5 py-0.5 text-[10px] font-bold tracking-[0.15em] text-indigo-700 ring-1 ring-indigo-100">
          AUSSTEHEND
        </span>
      </div>

      <div className="mt-3 flex items-start gap-3">
        <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-2xl bg-indigo-500 text-[20px]"
          style={{ boxShadow: '0 8px 20px -12px rgba(99,102,241,0.5)' }}>
          ⭐
        </div>
        <div className="flex-1">
          <p className="text-[15px] font-bold text-slate-800 leading-tight">
            Wie war deine Erfahrung?
          </p>
          <p className="mt-0.5 text-[12px] text-slate-500">
            Bewerte den Handwerker für diesen Auftrag.
          </p>
        </div>
      </div>

      {/* Star selector */}
      <div className="mt-4 flex items-center gap-1" role="group" aria-label="Sternebewertung">
        {[1, 2, 3, 4, 5].map((score) => (
          <button
            key={score}
            type="button"
            aria-label={`${score} Sterne`}
            className="text-[28px] transition-transform hover:scale-110 focus:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500 rounded"
            style={{ color: score <= displayScore ? '#F59E0B' : '#CBD5E1' }}
            onMouseEnter={() => setHoveredScore(score)}
            onMouseLeave={() => setHoveredScore(0)}
            onClick={() => setSelectedScore(score)}
          >
            ★
          </button>
        ))}
        {displayScore > 0 && (
          <span className="ml-2 text-[13px] font-semibold text-slate-600">
            {STAR_LABELS[displayScore]}
          </span>
        )}
      </div>

      {/* Comment */}
      <div className="mt-3">
        <textarea
          value={comment}
          onChange={(e) => setComment(e.target.value)}
          placeholder="Optionaler Kommentar (max. 500 Zeichen)…"
          maxLength={500}
          rows={3}
          className="w-full resize-none rounded-xl border border-slate-200 bg-slate-50 px-3 py-2 text-[13px] text-slate-700 placeholder-slate-400 focus:border-indigo-400 focus:bg-white focus:outline-none focus:ring-2 focus:ring-indigo-100 transition"
        />
      </div>

      {error && (
        <p className="mt-1 text-[12px] text-red-500">{error}</p>
      )}

      {/* Submit */}
      <button
        type="button"
        onClick={() => void handleSubmit()}
        disabled={isSubmitting}
        className="mt-3 w-full rounded-xl bg-indigo-600 px-4 py-2.5 text-[13px] font-semibold text-white shadow-sm hover:bg-indigo-700 active:scale-[0.98] transition focus:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500 disabled:opacity-60"
      >
        Bewertung abgeben
      </button>
    </section>
  )
}
