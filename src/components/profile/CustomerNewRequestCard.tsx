import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { startCategoryInquiryWorkflow } from '../../lib/workflow'
import type { NewRequestReadinessViewModel } from '../../lib/customer/customerSetupSelectors'

/** Service categories sourced from the existing explore reel dataset. */
const SERVICE_CATEGORIES = [
  'Elektrik',
  'Bad',
  'Fliesen',
  'Schreinerei',
  'Sanitär',
]

type Props = {
  /**
   * New-request readiness derived from the customer context.
   * Provides pre-fill values and the optional setup nudge.
   */
  readiness: NewRequestReadinessViewModel
}

export default function CustomerNewRequestCard({ readiness }: Props) {
  const navigate = useNavigate()

  const [category, setCategory] = useState(SERVICE_CATEGORIES[0])
  const [description, setDescription] = useState('')
  const [location, setLocation] = useState(readiness.prefillLocation)
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // Keep location in sync with readiness.prefillLocation while the user hasn't
  // typed anything yet (e.g. when they go back and save their city).
  // We only sync when the field is still empty so we don't overwrite manual input.
  const syncedLocation =
    location === '' ? readiness.prefillLocation : location

  async function handleSubmit() {
    if (!description.trim()) {
      setError('Bitte beschreibe kurz, was du benötigst.')
      return
    }
    setError(null)
    setSubmitting(true)

    try {
      const threadId = await startCategoryInquiryWorkflow(
        category,
        description.trim(),
        syncedLocation
      )

      navigate(`/messages/${threadId}`)
    } catch (err) {
      // startCategoryInquiryWorkflow now throws errors instead of returning null
      // Extract user-friendly error message if available
      const message = err instanceof Error ? err.message : 'Anfrage konnte nicht gestartet werden. Bitte versuche es erneut.'
      setError(message)
      setSubmitting(false)
    }
  }

  return (
    <div className="rounded-[28px] bg-white p-5 ring-1 ring-slate-200/70 shadow-[0_18px_40px_-28px_rgba(2,6,23,0.28)]">
      <div className="text-[12px] font-semibold uppercase tracking-[0.18em] text-slate-400">
        Neue Anfrage starten
      </div>

      {readiness.setupNudge && (
        <div className="mt-3 rounded-[14px] bg-amber-50 px-4 py-2.5 ring-1 ring-amber-200/60">
          <p className="text-[12px] text-amber-800">{readiness.setupNudge}</p>
        </div>
      )}

      <div className="mt-4 space-y-3">
        {/* Category */}
        <div>
          <label className="mb-1 block text-[12px] font-semibold text-slate-500">
            Art der Arbeit
          </label>
          <div className="flex flex-wrap gap-2">
            {SERVICE_CATEGORIES.map((cat) => (
              <button
                key={cat}
                type="button"
                onClick={() => setCategory(cat)}
                className={`rounded-full px-3.5 py-1.5 text-[13px] font-semibold transition active:scale-[0.96] ${
                  category === cat
                    ? 'bg-[#2563EB] text-white shadow-[0_8px_20px_-12px_rgba(37,99,235,0.65)]'
                    : 'bg-slate-100 text-slate-600 ring-1 ring-slate-200/60'
                }`}
              >
                {cat}
              </button>
            ))}
          </div>
        </div>

        {/* Description */}
        <div>
          <label className="mb-1 block text-[12px] font-semibold text-slate-500">
            Was benötigst du?
          </label>
          <textarea
            rows={3}
            value={description}
            onChange={(e) => {
              setDescription(e.target.value)
              if (error) setError(null)
            }}
            placeholder="z. B. Sicherungskasten modernisieren, ca. 60 m² Fliesen legen…"
            className="w-full resize-none rounded-[16px] bg-slate-50 px-4 py-3 text-[15px] text-slate-900 ring-1 ring-slate-200/70 placeholder:text-slate-400 focus:outline-none focus:ring-2 focus:ring-[#2563EB]/40"
          />
          {error && (
            <p className="mt-1 text-[12px] text-red-500">{error}</p>
          )}
        </div>

        {/* Location */}
        <div>
          <label className="mb-1 block text-[12px] font-semibold text-slate-500">
            Ort
          </label>
          <input
            type="text"
            value={syncedLocation}
            onChange={(e) => setLocation(e.target.value)}
            placeholder="z. B. Hannover"
            className="w-full rounded-[16px] bg-slate-50 px-4 py-3 text-[15px] text-slate-900 ring-1 ring-slate-200/70 placeholder:text-slate-400 focus:outline-none focus:ring-2 focus:ring-[#2563EB]/40"
          />
        </div>
      </div>

      <button
        onClick={handleSubmit}
        disabled={submitting}
        className="mt-4 w-full rounded-[18px] bg-[#2563EB] py-3.5 text-[15px] font-semibold text-white shadow-[0_18px_40px_-28px_rgba(37,99,235,0.65)] transition active:scale-[0.99] disabled:opacity-60"
      >
        {submitting ? 'Anfrage wird gesendet…' : 'Anfrage abschicken →'}
      </button>

      <p className="mt-3 text-center text-[12px] text-slate-400">
        Eine passende Fachkraft in deiner Nähe wird benachrichtigt.
      </p>
    </div>
  )
}
