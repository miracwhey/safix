import { useState } from 'react'
import { getFeedbackByJobId, subscribeFeedback, submitJobFeedback } from '../../lib/feedback'
import type { JobFeedback } from '../../lib/feedback'
import { useStoreSync } from '../../lib/reactive'

const MAX_NOTE_LENGTH = 140

type Props = {
  jobId: string
  craftsmanUserId: string
}

function ThankYouView({ feedback }: { feedback: JobFeedback }) {
  return (
    <section className="relative overflow-hidden rounded-[28px] bg-white p-5 ring-1 ring-emerald-200/80 shadow-[0_18px_40px_-28px_rgba(2,6,23,0.14)]">
      <div className="pointer-events-none absolute left-0 top-0 h-full w-[3px] rounded-l-[28px] bg-gradient-to-b from-emerald-500 via-emerald-400 to-emerald-300" />

      <div className="flex items-center gap-3">
        <div
          className="flex h-10 w-10 shrink-0 items-center justify-center rounded-2xl bg-emerald-500"
          style={{ boxShadow: '0 8px 20px -12px rgba(16,185,129,0.5)' }}
        >
          <span className="text-[18px] leading-none">
            {feedback.wouldHireAgain ? '👍' : '👎'}
          </span>
        </div>
        <div>
          <div className="text-[15px] font-semibold text-slate-900">
            Vielen Dank für dein Feedback!
          </div>
          <div className="mt-0.5 text-[13px] text-slate-500">
            {feedback.wouldHireAgain
              ? 'Du würdest wieder buchen – das stärkt das Vertrauen.'
              : 'Dein Feedback wurde gespeichert.'}
          </div>
        </div>
      </div>

      {feedback.note ? (
        <div className="mt-3 rounded-2xl bg-slate-50 px-4 py-3">
          <p className="text-[13px] italic leading-relaxed text-slate-600">
            „{feedback.note}"
          </p>
        </div>
      ) : null}
    </section>
  )
}

export default function CustomerFeedbackCard({ jobId, craftsmanUserId }: Props) {
  function getExisting() {
    return getFeedbackByJobId(jobId)
  }

  const [existing, setExisting] = useState<JobFeedback | undefined>(getExisting)
  const [wouldHireAgain, setWouldHireAgain] = useState<boolean | null>(null)
  const [note, setNote] = useState('')
  const [submitted, setSubmitted] = useState(false)

  useStoreSync([subscribeFeedback], () => {
    setExisting(getExisting())
  })

  if (existing) {
    return <ThankYouView feedback={existing} />
  }

  function handleSubmit() {
    if (wouldHireAgain === null) return
    submitJobFeedback({
      jobId,
      craftsmanUserId,
      wouldHireAgain,
      note: note.trim() || undefined,
    })
    setSubmitted(true)
  }

  if (submitted) {
    const fresh = getFeedbackByJobId(jobId)
    if (fresh) return <ThankYouView feedback={fresh} />
  }

  return (
    <section className="relative overflow-hidden rounded-[28px] bg-white p-5 ring-1 ring-slate-200/70 shadow-[0_18px_40px_-28px_rgba(2,6,23,0.14)]">
      <div className="pointer-events-none absolute left-0 top-0 h-full w-[3px] rounded-l-[28px] bg-gradient-to-b from-blue-400 via-blue-300 to-blue-200" />

      {/* Eyebrow */}
      <div className="text-[12px] font-semibold uppercase tracking-[0.18em] text-slate-400">
        Dein Feedback
      </div>

      {/* Question */}
      <p className="mt-2 text-[15px] font-semibold leading-snug text-slate-900">
        Würdest du diesen Betrieb wieder beauftragen?
      </p>

      {/* Binary choice */}
      <div className="mt-3 flex gap-3">
        <button
          type="button"
          onClick={() => setWouldHireAgain(true)}
          className={`flex flex-1 items-center justify-center gap-2 rounded-2xl px-4 py-3 text-[14px] font-semibold transition-colors ${
            wouldHireAgain === true
              ? 'bg-emerald-500 text-white shadow-[0_8px_20px_-12px_rgba(16,185,129,0.6)]'
              : 'bg-slate-100 text-slate-700 hover:bg-slate-200'
          }`}
        >
          <span>👍</span> Ja, gerne wieder
        </button>
        <button
          type="button"
          onClick={() => setWouldHireAgain(false)}
          className={`flex flex-1 items-center justify-center gap-2 rounded-2xl px-4 py-3 text-[14px] font-semibold transition-colors ${
            wouldHireAgain === false
              ? 'bg-slate-700 text-white'
              : 'bg-slate-100 text-slate-700 hover:bg-slate-200'
          }`}
        >
          <span>👎</span> Eher nicht
        </button>
      </div>

      {/* Optional note */}
      {wouldHireAgain !== null && (
        <div className="mt-3">
          <textarea
            value={note}
            onChange={(e) => setNote(e.target.value.slice(0, MAX_NOTE_LENGTH))}
            placeholder="Kurze Anmerkung (optional)"
            rows={2}
            className="w-full resize-none rounded-2xl bg-slate-50 px-4 py-3 text-[13px] leading-relaxed text-slate-700 ring-1 ring-slate-200/70 placeholder:text-slate-400 focus:outline-none focus:ring-2 focus:ring-blue-300"
          />
          <div className="mt-1 text-right text-[11px] text-slate-400">
            {note.length}/{MAX_NOTE_LENGTH}
          </div>
        </div>
      )}

      {/* Submit */}
      <button
        type="button"
        disabled={wouldHireAgain === null}
        onClick={handleSubmit}
        className="mt-3 w-full rounded-full bg-[#FACC15] px-4 py-3 text-[14px] font-semibold text-slate-900 shadow-[0_12px_28px_-18px_rgba(250,204,21,0.85)] disabled:cursor-not-allowed disabled:opacity-40"
      >
        Feedback absenden
      </button>
    </section>
  )
}
