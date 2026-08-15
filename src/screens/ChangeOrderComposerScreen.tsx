/**
 * ChangeOrderComposerScreen — Nachtrag erstellen
 *
 * Craftsman-only screen for creating and immediately sending a ChangeOrder
 * (Nachtrag) for a standard Job.
 *
 * Entry point: CraftsmanJobDetailScreen → "Nachtrag erstellen" CTA
 * Route: /craftsman/nachtrag/neu?jobId=:jobId
 *
 * V1 scope: Creates and immediately sends (draft → pending in one step).
 * No separate "save as draft" path.
 *
 * Hard gates:
 *   - Job must exist and be a standard (binding_offer-origin) job
 *   - Job status must be 'in_progress' or 'waiting_payment'
 *   - Description and amount are required
 *
 * Out of scope (V1):
 *   - Scheduling / time impact fields
 *   - Attaching photos or files
 *   - Negative delta (reduction) is allowed numerically but not separately guided
 */

import { useEffect, useState } from 'react'
import { useNavigate, useSearchParams, useBlocker } from 'react-router-dom'
import { useFormDraftPersistence } from '../hooks/useFormDraftPersistence'
import AppShell from '../components/AppShell'
import ScreenSkeleton from '../components/system/ScreenSkeleton'
import ScreenError from '../components/system/ScreenError'
import InlineFeedback from '../components/system/InlineFeedback'
import { getJobById, isJobRepositoryHydrated } from '../lib/jobs'
import { getJobStatusLabel } from '../lib/jobs/helpers'
import { jobKindAllowsStandardExecution } from '../lib/offers/commercialDocumentPolicy'
import { getConversationByProjectId } from '../lib/messages'
import { createChangeOrderWorkflow } from '../lib/workflow/changeOrderWorkflow'
import { formatEuro } from '../lib/shared/formatters'
import { normalizeErrorMessage } from '../lib/diagnostics'
import { useSession } from '../hooks/useSession'
import { useSmartBack } from '../hooks/useSmartBack'
import { getPaymentForJobWorkflow } from '../lib/workflow'

// ── Price parsing ─────────────────────────────────────────────────────────────

function parsePriceInput(input: string): number | null {
  const cleaned = input
    .replace(/€/g, '')
    .replace(/\./g, '')    // German thousands separator (dots)
    .replace(',', '.')      // German decimal comma → dot
    .replace(/\s/g, '')
    .trim()
  const n = parseFloat(cleaned)
  return isNaN(n) ? null : n
}

// ── Draft persistence (Resume-Robustness Block 4) ─────────────────────────────

/** One JSON object per job — never one key per field. */
type ChangeOrderDraft = {
  leistung: string
  ursache: string
  zeitauswirkung: string
  priceInput: string
}

const CHANGE_ORDER_DRAFT_DEFAULTS: ChangeOrderDraft = {
  leistung: '',
  ursache: '',
  zeitauswirkung: '',
  priceInput: '',
}

export default function ChangeOrderComposerScreen() {
  const navigate = useNavigate()
  const goBack = useSmartBack('/craftsman/jobs')
  const [searchParams] = useSearchParams()
  const { user } = useSession()

  const jobId = searchParams.get('jobId')

  // Draft persistence (Block 4): the four form fields survive reloads and
  // WebView kills as one JSON object keyed by job. Restoring only refills
  // field state — submitting stays strictly user-initiated.
  const { restored: restoredDraft, persist: persistDraft, clear: clearDraft } =
    useFormDraftPersistence<ChangeOrderDraft>(
      jobId ? `fixup.changeorder.draft.${jobId}` : null,
      CHANGE_ORDER_DRAFT_DEFAULTS,
    )

  const [leistung, setLeistung] = useState(restoredDraft.leistung)
  const [ursache, setUrsache] = useState(restoredDraft.ursache)
  const [zeitauswirkung, setZeitauswirkung] = useState(restoredDraft.zeitauswirkung)
  const [priceInput, setPriceInput] = useState(restoredDraft.priceInput)
  const [submitting, setSubmitting] = useState(false)
  const [submitError, setSubmitError] = useState<string | null>(null)

  // Debounced write-through: persist the full field object on every change;
  // an empty form removes the entry instead of storing an empty object.
  const hasDraftContent =
    leistung.trim().length > 0 ||
    ursache.trim().length > 0 ||
    zeitauswirkung.trim().length > 0 ||
    priceInput.trim().length > 0
  useEffect(() => {
    persistDraft(
      hasDraftContent ? { leistung, ursache, zeitauswirkung, priceInput } : null,
    )
  }, [persistDraft, hasDraftContent, leistung, ursache, zeitauswirkung, priceInput])

  // Block navigation when the user has entered data but hasn't submitted.
  // Prevents accidental data loss when clicking the browser back button or
  // navigating to another route mid-form. Does not block after successful submit.
  const hasUnsavedData = (leistung.trim() || ursache.trim() || priceInput.trim()) && !submitting
  const blocker = useBlocker(
    ({ currentLocation, nextLocation }) =>
      !!hasUnsavedData && currentLocation.pathname !== nextLocation.pathname
  )

  if (!jobId) {
    return (
      <AppShell>
        <ScreenError
          title="Auftrag fehlt"
          description="Kein Auftrag für diesen Nachtrag angegeben."
          backTo="/craftsman/jobs"
          backLabel="← Zur Auftragsliste"
        />
      </AppShell>
    )
  }

  const job = getJobById(jobId)

  if (!job && isJobRepositoryHydrated()) {
    return (
      <AppShell>
        <ScreenError
          title="Auftrag nicht gefunden"
          description="Dieser Auftrag existiert nicht oder ist nicht mehr verfügbar."
          backTo="/craftsman/jobs"
          backLabel="← Zur Auftragsliste"
        />
      </AppShell>
    )
  }

  if (!job) {
    return (
      <AppShell>
        <ScreenSkeleton eyebrow="Nachtrag" lines={4} />
      </AppShell>
    )
  }

  // Hard gate: standard job only
  if (!jobKindAllowsStandardExecution(job.jobKind)) {
    return (
      <AppShell>
        <ScreenError
          title="Nachtrag nicht möglich"
          description="Nachträge sind nur für Standard-Aufträge möglich. Diagnose- und Schätzungsaufträge unterstützen diesen Pfad nicht."
          backTo={`/craftsman/jobs/${jobId}`}
          backLabel="← Zurück zum Auftrag"
        />
      </AppShell>
    )
  }

  // Hard gate: active execution state
  const allowedStatuses = new Set(['in_progress', 'waiting_payment'])
  if (!allowedStatuses.has(job.status)) {
    return (
      <AppShell>
        <ScreenError
          title="Nachtrag nicht möglich"
          description={`Ein Nachtrag kann nur erstellt werden, wenn der Auftrag in Ausführung oder in der Zahlungsphase ist. Aktueller Status: ${getJobStatusLabel(job.status)}.`}
          backTo={`/craftsman/jobs/${jobId}`}
          backLabel="← Zurück zum Auftrag"
        />
      </AppShell>
    )
  }

  const payment = getPaymentForJobWorkflow(jobId)
  const currentTotalEuros = payment?.amounts.totalAmount ?? 0

  // Live preview: current total + entered delta
  const parsedDeltaEuros = parsePriceInput(priceInput)
  const newTotalEuros =
    parsedDeltaEuros != null
      ? currentTotalEuros + parsedDeltaEuros
      : null

  const conversationId =
    job.sourceConversationId ??
    getConversationByProjectId(job.projectId)?.id

  const canSubmit =
    leistung.trim().length > 0 &&
    ursache.trim().length > 0 &&
    parsedDeltaEuros != null &&
    !submitting

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!canSubmit || !user?.id) return

    const deltaEuros = parsedDeltaEuros!
    const grossTotal = Math.round(deltaEuros * 100)
    const priceFormatted =
      deltaEuros >= 0
        ? `+${formatEuro(deltaEuros)}`
        : formatEuro(deltaEuros)

    const structuredDescription = [
      leistung.trim(),
      `Grund: ${ursache.trim()}`,
      `Termin: ${zeitauswirkung.trim() || 'Keine Angabe'}`,
    ].join('\n\n')

    setSubmitting(true)
    setSubmitError(null)

    try {
      const co = await createChangeOrderWorkflow({
        jobId,
        craftsmanUserId: user.id,
        customerUserId: job.customerUserId ?? '',
        description: structuredDescription,
        price: priceFormatted,
        grossTotal,
        sourceOfferId: job.sourceOfferId,
        conversationId,
      })
      // Submit dispatched successfully — drop the persisted draft before
      // leaving the screen (Block 4 contract: clear only on success/discard).
      clearDraft()
      navigate(`/craftsman/nachtrag/${co.id}`, { replace: true })
    } catch (err) {
      setSubmitError(`Nachtrag konnte nicht erstellt werden: ${normalizeErrorMessage(err)}`)
      setSubmitting(false)
    }
  }

  return (
    <AppShell>
      <section className="px-4 py-6">
        <div className="mx-auto w-full max-w-[420px] space-y-4">

          {/* Header */}
          <div>
            <button
              type="button"
              onClick={goBack}
              className="mb-3 text-[13px] font-medium text-blue-600 hover:text-blue-700"
            >
              ← Zurück zum Auftrag
            </button>
            <h1 className="text-[20px] font-bold text-slate-900">Nachtrag erstellen</h1>
            <p className="mt-1 text-[13px] text-slate-500">
              Erfasse Mehrarbeit oder Änderungen am laufenden Auftrag.
              Der Kunde erhält den Nachtrag zur Prüfung und muss ihn annehmen.
            </p>
          </div>

          {/* Job context */}
          <div className="rounded-card bg-slate-50 px-3 py-2.5 ring-1 ring-edge">
            <p className="text-[11px] text-slate-400">Auftrag</p>
            <p className="text-[13px] font-semibold text-slate-800">
              {job.title ?? job.description ?? jobId}
            </p>
            {currentTotalEuros > 0 && (
              <p className="mt-0.5 text-[11px] text-slate-500">
                Aktueller Gesamtbetrag: {formatEuro(currentTotalEuros)}
              </p>
            )}
          </div>

          {/* Form */}
          <form onSubmit={(e) => void handleSubmit(e)} className="space-y-4">

            {/* Leistungsänderung */}
            <div className="space-y-1.5">
              <label htmlFor="co-leistung" className="text-[13px] font-semibold text-slate-700">
                Leistungsänderung <span className="text-rose-500">*</span>
              </label>
              <p className="text-[11px] text-slate-400">
                Was ändert sich konkret? (Mehrarbeit, zusätzliches Material, entfallende Leistung …)
              </p>
              <textarea
                id="co-leistung"
                value={leistung}
                onChange={(e) => setLeistung(e.target.value)}
                placeholder="z. B. Abdichtungsarbeiten an 4 m² Feuchtigkeitsschäden hinter den Fliesen"
                rows={3}
                className="w-full rounded-card border border-slate-200 bg-white px-3 py-2.5 text-[14px] text-slate-900 placeholder:text-slate-400 focus:border-blue-400 focus:outline-none focus:ring-1 focus:ring-blue-300"
                required
              />
            </div>

            {/* Änderungsursache */}
            <div className="space-y-1.5">
              <label htmlFor="co-ursache" className="text-[13px] font-semibold text-slate-700">
                Änderungsursache <span className="text-rose-500">*</span>
              </label>
              <p className="text-[11px] text-slate-400">
                Warum war diese Änderung nötig? (unvorhergesehener Befund, Kundenwunsch, technische Anforderung …)
              </p>
              <textarea
                id="co-ursache"
                value={ursache}
                onChange={(e) => setUrsache(e.target.value)}
                placeholder="z. B. Feuchtigkeitsschäden waren erst nach Entfernen der alten Fliesen sichtbar"
                rows={2}
                className="w-full rounded-card border border-slate-200 bg-white px-3 py-2.5 text-[14px] text-slate-900 placeholder:text-slate-400 focus:border-blue-400 focus:outline-none focus:ring-1 focus:ring-blue-300"
                required
              />
            </div>

            {/* Zeitauswirkung (optional) */}
            <div className="space-y-1.5">
              <label htmlFor="co-zeit" className="text-[13px] font-semibold text-slate-700">
                Terminauswirkung <span className="text-slate-400 font-normal">(optional)</span>
              </label>
              <p className="text-[11px] text-slate-400">
                Verlängert oder verschiebt sich der Abschluss? Falls nein, leer lassen.
              </p>
              <input
                id="co-zeit"
                type="text"
                value={zeitauswirkung}
                onChange={(e) => setZeitauswirkung(e.target.value)}
                placeholder="z. B. +2 Werktage"
                className="w-full rounded-card border border-slate-200 bg-white px-3 py-2.5 text-[14px] text-slate-900 placeholder:text-slate-400 focus:border-blue-400 focus:outline-none focus:ring-1 focus:ring-blue-300"
              />
            </div>

            {/* Amount */}
            <div className="space-y-1.5">
              <label htmlFor="co-price" className="text-[13px] font-semibold text-slate-700">
                Nachtragsbetrag in € <span className="text-rose-500">*</span>
              </label>
              <p className="text-[11px] text-slate-400">
                Positiver Wert für Mehrkosten, negativer Wert (z. B. −100) für Minderkosten.
              </p>
              <input
                id="co-price"
                type="text"
                inputMode="decimal"
                value={priceInput}
                onChange={(e) => setPriceInput(e.target.value)}
                placeholder="z. B. 450"
                className="w-full rounded-card border border-slate-200 bg-white px-3 py-2.5 text-[14px] text-slate-900 placeholder:text-slate-400 focus:border-blue-400 focus:outline-none focus:ring-1 focus:ring-blue-300"
                required
              />
              {parsedDeltaEuros != null && (
                <p className={[
                  'text-[12px] font-semibold',
                  parsedDeltaEuros >= 0 ? 'text-slate-700' : 'text-rose-700',
                ].join(' ')}>
                  {parsedDeltaEuros >= 0 ? '+' : ''}{formatEuro(parsedDeltaEuros)}
                  {parsedDeltaEuros < 0 && ' (Minderkosten)'}
                </p>
              )}
            </div>

            {/* Delta preview */}
            {newTotalEuros != null && currentTotalEuros > 0 && (
              <div className="rounded-card bg-slate-50 px-3 py-2.5 ring-1 ring-edge">
                <p className="text-[11px] text-slate-400">Auswirkung auf Gesamtbetrag</p>
                <div className="mt-1 flex items-center gap-2 text-[13px]">
                  <span className="text-slate-500">{formatEuro(currentTotalEuros)}</span>
                  <span className="text-slate-400">+</span>
                  <span className={parsedDeltaEuros! >= 0 ? 'text-slate-700 font-semibold' : 'text-rose-700 font-semibold'}>
                    {parsedDeltaEuros! >= 0 ? '+' : ''}{formatEuro(parsedDeltaEuros!)}
                  </span>
                  <span className="text-slate-400">=</span>
                  <span className="font-bold text-slate-900">{formatEuro(newTotalEuros)}</span>
                </div>
                {payment && payment.state !== 'deposit_required' && (
                  <div className="mt-2 rounded-md bg-amber-50 px-2.5 py-1.5 text-[11px] text-amber-800 ring-1 ring-amber-200/60">
                    ⚠️ Die Anzahlung ist bereits gesichert. Bei Annahme dieses Nachtrags wird
                    der Zusatzbetrag als gesonderte Zahlung erforderlich (V1-Grenze).
                  </div>
                )}
              </div>
            )}

            <InlineFeedback error={submitError} onDismiss={() => setSubmitError(null)} />

            {/* Navigation blocker — shown when user tries to leave with unsaved data */}
            {blocker.state === 'blocked' && (
              <div className="rounded-card bg-amber-50 px-3 py-3 ring-1 ring-amber-200/60">
                <p className="text-[13px] font-semibold text-amber-800 mb-1">
                  Eingaben verwerfen?
                </p>
                <p className="text-[12px] text-amber-700 mb-2.5">
                  Du verlässt diesen Nachtrag — alle eingegebenen Daten gehen verloren.
                </p>
                <div className="flex gap-2">
                  <button
                    type="button"
                    onClick={() => {
                      // Explicit user discard — the dialog promises the data
                      // is gone, so the persisted draft goes with it.
                      clearDraft()
                      blocker.proceed()
                    }}
                    className="flex-1 rounded-card bg-amber-600 px-3 py-2 text-[12px] font-semibold text-white hover:bg-amber-700"
                  >
                    Ja, verlassen
                  </button>
                  <button
                    type="button"
                    onClick={() => blocker.reset()}
                    className="flex-1 rounded-card bg-white px-3 py-2 text-[12px] font-semibold text-slate-700 ring-1 ring-slate-200 hover:bg-slate-50"
                  >
                    Weiter bearbeiten
                  </button>
                </div>
              </div>
            )}

            <button
              type="submit"
              disabled={!canSubmit}
              className="w-full rounded-card bg-slate-900 px-4 py-3 text-[14px] font-semibold text-white shadow-sm transition hover:bg-slate-800 active:scale-[0.98] disabled:cursor-not-allowed disabled:opacity-50"
              data-testid="send-change-order"
            >
              {submitting ? 'Wird gesendet…' : 'Nachtrag senden'}
            </button>

            <p className="text-center text-[11px] text-slate-400">
              Der Nachtrag wird sofort an den Kunden gesendet und muss von ihm angenommen werden.
            </p>
          </form>
        </div>
      </section>
    </AppShell>
  )
}
