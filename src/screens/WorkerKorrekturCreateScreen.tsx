import { useMemo, useState } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'
import { ArrowLeft, Link2 } from 'lucide-react'
import AppShell from '../components/AppShell'
import { type CorrectionKind } from '../lib/corrections'
import { submitCorrectionWorkflow } from '../lib/workflow/correctionWorkflow'
import { getCalendarEntryById } from '../lib/calendar/calendarStore'
import { useSmartBack } from '../hooks/useSmartBack'

// ── Kind config ───────────────────────────────────────────────────────────────

const KIND_OPTIONS: { value: CorrectionKind; label: string; hint: string }[] = [
  {
    value: 'missing_time',
    label: 'Fehlende Zeit',
    hint: 'Arbeitszeit wurde nicht erfasst',
  },
  {
    value: 'wrong_time',
    label: 'Falsche Zeit',
    hint: 'Start- oder Endzeit ist fehlerhaft',
  },
  {
    value: 'wrong_assignment',
    label: 'Falscher Einsatz',
    hint: 'Einsatz oder Ort ist falsch zugeordnet',
  },
  {
    value: 'other',
    label: 'Sonstiges',
    hint: 'Andere Abweichung',
  },
]

// ── Screen ────────────────────────────────────────────────────────────────────

export default function WorkerKorrekturCreateScreen() {
  const navigate = useNavigate()
  const goBack = useSmartBack('/worker/korrekturen')
  const [searchParams] = useSearchParams()

  // Block 7.2.7c — Pre-Fill aus Worker-Einsatz-Detail.
  // calendarEntryId aus Query → entry-Lookup. requestedDate wird aus
  // entry.dateKey vorausgefüllt, bleibt aber editierbar.
  const calendarEntryIdParam = searchParams.get('calendarEntryId') ?? ''
  const linkedEntry = useMemo(
    () => (calendarEntryIdParam ? getCalendarEntryById(calendarEntryIdParam) : undefined),
    [calendarEntryIdParam],
  )

  const [kind, setKind] = useState<CorrectionKind>('wrong_time')
  const [requestedDate, setRequestedDate] = useState(linkedEntry?.dateKey ?? '')
  const [field, setField] = useState('')
  const [currentValue, setCurrentValue] = useState('')
  const [proposedValue, setProposedValue] = useState('')
  const [reason, setReason] = useState('')
  const [description, setDescription] = useState('')
  const [isSubmitting, setIsSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const canSubmit =
    description.trim().length > 0 &&
    !isSubmitting

  async function handleSubmit() {
    if (!canSubmit) return
    setIsSubmitting(true)
    setError(null)

    try {
      await submitCorrectionWorkflow({
        kind,
        description: description.trim(),
        ...(requestedDate.trim() ? { requestedDate: requestedDate.trim() } : {}),
        ...(linkedEntry ? { calendarEntryId: linkedEntry.id } : {}),
        ...(field.trim() ? { field: field.trim() } : {}),
        ...(currentValue.trim() ? { currentValue: currentValue.trim() } : {}),
        ...(proposedValue.trim() ? { proposedValue: proposedValue.trim() } : {}),
        ...(reason.trim() ? { reason: reason.trim() } : {}),
      })
      navigate('/worker/korrekturen', { replace: true })
    } catch {
      setError('Konnte nicht gespeichert werden. Bitte erneut versuchen.')
      setIsSubmitting(false)
    }
  }

  return (
    <AppShell active="worker-konto" noSafeTop>
      <div className="px-4 pt-[max(56px,env(safe-area-inset-top))] pb-12">
        <div className="mx-auto w-full max-w-[420px] space-y-6">

          {/* Header */}
          <div className="flex items-center gap-3">
            <button
              type="button"
              onClick={goBack}
              className="h-9 w-9 shrink-0 rounded-full bg-slate-100 flex items-center justify-center active:bg-slate-200 transition-colors"
              aria-label="Zurück"
            >
              <ArrowLeft size={16} strokeWidth={2} className="text-slate-600" />
            </button>
            <div>
              <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-slate-400">
                Korrekturen
              </p>
              <h1 className="text-[20px] font-bold tracking-tight text-slate-900 leading-tight">
                Korrektur melden
              </h1>
            </div>
          </div>

          {/* Bezug-Banner (Block 7.2.7c) — sichtbar wenn aus Einsatz-Detail aufgerufen */}
          {linkedEntry && (
            <div
              data-testid="correction-linked-entry-banner"
              className="flex items-center gap-2.5 rounded-[14px] bg-blue-50 px-3.5 py-3 ring-1 ring-blue-100"
            >
              <Link2 size={14} strokeWidth={1.8} className="shrink-0 text-blue-500" />
              <div className="min-w-0 flex-1">
                <div className="text-[10px] font-semibold uppercase tracking-[0.14em] text-blue-500">
                  Bezug
                </div>
                <div className="mt-0.5 text-[13px] font-semibold text-blue-700 truncate">
                  {linkedEntry.dateLabel} · {linkedEntry.title}
                </div>
              </div>
            </div>
          )}

          {/* Form */}
          <div className="rounded-[24px] bg-white p-5 ring-1 ring-slate-200/70 shadow-[0_14px_32px_-20px_rgba(2,6,23,0.18)] space-y-5">

            {/* Kind */}
            <div>
              <label className="block text-[11px] font-semibold uppercase tracking-[0.14em] text-slate-400 mb-2">
                Art der Korrektur
              </label>
              <div className="space-y-2">
                {KIND_OPTIONS.map((opt) => (
                  <button
                    key={opt.value}
                    type="button"
                    onClick={() => setKind(opt.value)}
                    className={`w-full text-left rounded-[14px] px-3.5 py-3 ring-1 transition-colors ${
                      kind === opt.value
                        ? 'bg-slate-900 ring-slate-900'
                        : 'bg-slate-50 ring-slate-200/70 active:bg-slate-100'
                    }`}
                  >
                    <div
                      className={`text-[13px] font-semibold ${
                        kind === opt.value ? 'text-white' : 'text-slate-800'
                      }`}
                    >
                      {opt.label}
                    </div>
                    <div
                      className={`text-[11px] mt-0.5 ${
                        kind === opt.value ? 'text-slate-300' : 'text-slate-400'
                      }`}
                    >
                      {opt.hint}
                    </div>
                  </button>
                ))}
              </div>
            </div>

            {/* Date (optional) */}
            <div>
              <label
                htmlFor="requested-date"
                className="block text-[11px] font-semibold uppercase tracking-[0.14em] text-slate-400 mb-2"
              >
                Datum <span className="font-normal normal-case tracking-normal text-slate-300">(optional)</span>
              </label>
              <input
                id="requested-date"
                type="date"
                value={requestedDate}
                onChange={(e) => setRequestedDate(e.target.value)}
                className="w-full rounded-[14px] bg-slate-50 px-3.5 py-3 text-[13px] text-slate-800 ring-1 ring-slate-200/70 outline-none focus:ring-slate-400 transition-all"
              />
            </div>

            {/* Strukturierte Felder (Block 7.2.4 — alle optional) */}
            <div data-testid="correction-structured-input" className="space-y-3">
              <div>
                <label
                  htmlFor="correction-field"
                  className="block text-[11px] font-semibold uppercase tracking-[0.14em] text-slate-400 mb-2"
                >
                  Was <span className="font-normal normal-case tracking-normal text-slate-300">(optional)</span>
                </label>
                <input
                  id="correction-field"
                  type="text"
                  value={field}
                  onChange={(e) => setField(e.target.value)}
                  placeholder="z.B. Arbeitszeit Mo 28.04."
                  className="w-full rounded-[14px] bg-slate-50 px-3.5 py-3 text-[13px] text-slate-800 ring-1 ring-slate-200/70 outline-none focus:ring-slate-400 transition-all placeholder:text-slate-300"
                />
              </div>

              <div className="grid grid-cols-2 gap-2">
                <div>
                  <label
                    htmlFor="correction-current"
                    className="block text-[11px] font-semibold uppercase tracking-[0.14em] text-red-500 mb-2"
                  >
                    Aktuell
                  </label>
                  <input
                    id="correction-current"
                    type="text"
                    value={currentValue}
                    onChange={(e) => setCurrentValue(e.target.value)}
                    placeholder="z.B. 6h"
                    className="w-full rounded-[14px] bg-red-50 px-3.5 py-3 text-[13px] text-red-700 ring-1 ring-red-200 outline-none focus:ring-red-300 transition-all placeholder:text-red-300"
                  />
                </div>
                <div>
                  <label
                    htmlFor="correction-proposed"
                    className="block text-[11px] font-semibold uppercase tracking-[0.14em] text-emerald-600 mb-2"
                  >
                    Vorschlag
                  </label>
                  <input
                    id="correction-proposed"
                    type="text"
                    value={proposedValue}
                    onChange={(e) => setProposedValue(e.target.value)}
                    placeholder="z.B. 8h"
                    className="w-full rounded-[14px] bg-emerald-50 px-3.5 py-3 text-[13px] text-emerald-700 ring-1 ring-emerald-200 outline-none focus:ring-emerald-300 transition-all placeholder:text-emerald-300"
                  />
                </div>
              </div>

              <div>
                <label
                  htmlFor="correction-reason"
                  className="block text-[11px] font-semibold uppercase tracking-[0.14em] text-slate-400 mb-2"
                >
                  Begründung <span className="font-normal normal-case tracking-normal text-slate-300">(optional)</span>
                </label>
                <input
                  id="correction-reason"
                  type="text"
                  value={reason}
                  onChange={(e) => setReason(e.target.value)}
                  placeholder="z.B. Foto-Zeitstempel zeigt 7:30–15:30"
                  className="w-full rounded-[14px] bg-slate-50 px-3.5 py-3 text-[13px] text-slate-800 ring-1 ring-slate-200/70 outline-none focus:ring-slate-400 transition-all placeholder:text-slate-300"
                />
              </div>
            </div>

            {/* Description */}
            <div>
              <label
                htmlFor="description"
                className="block text-[11px] font-semibold uppercase tracking-[0.14em] text-slate-400 mb-2"
              >
                Beschreibung
              </label>
              <textarea
                id="description"
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                placeholder="Was ist falsch erfasst worden?"
                rows={4}
                className="w-full resize-none rounded-[14px] bg-slate-50 px-3.5 py-3 text-[13px] text-slate-800 ring-1 ring-slate-200/70 outline-none focus:ring-slate-400 transition-all placeholder:text-slate-300"
              />
            </div>

            {/* Error */}
            {error && (
              <p className="text-[12px] text-red-500">{error}</p>
            )}

          </div>

          {/* Submit */}
          <button
            type="button"
            onClick={handleSubmit}
            disabled={!canSubmit}
            className={`w-full rounded-[16px] py-3.5 text-[14px] font-semibold transition-colors ${
              canSubmit
                ? 'bg-slate-900 text-white active:bg-slate-700'
                : 'bg-slate-100 text-slate-300 cursor-not-allowed'
            }`}
          >
            {isSubmitting ? 'Wird gesendet…' : 'Korrektur einreichen'}
          </button>

        </div>
      </div>
    </AppShell>
  )
}
