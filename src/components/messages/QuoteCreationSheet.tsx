/**
 * QuoteCreationSheet — Commercial Composer (Paket 3 + Paket 4a)
 *
 * Typed commercial document composer for craftsmen. Handles all three
 * OfferDocumentType values: binding_offer, estimate, diagnosis.
 *
 * Runtime path:
 *   Chat (+) → CraftsmanActionSheet (type choice) → QuoteCreationSheet
 *   → form (type-dependent) → preview (real document structure) → send
 *   → createOfferWorkflow → Offer snapshot → thread artifact
 *
 * Draft state: local form state, write-through persisted to localStorage as
 * one JSON object keyed by thread + documentType (Resume-Robustness Block 4,
 * useFormDraftPersistence). Restored on re-open, cleared after a successful
 * send or an explicit discard. Closing with content asks for confirmation
 * instead of silently discarding. No Supabase persistence for drafts —
 * Offer.status='draft' exists in the DB schema but wiring is deferred.
 *
 * Validation (Paket 4a — domain validator, same rules as offerWorkflow):
 *   binding_offer — price + scopeSummary + scopeExcluded + paymentTerms + validUntil
 *   estimate      — price + scopeSummary + assumptions + scopeExcluded + validUntil
 *   diagnosis     — price + scopeSummary + assumptions + validUntil
 *
 * All required fields are always visible — never hidden in accordions.
 * Optional fields are grouped in secondary disclosure panels.
 */

import { useState, useCallback, useEffect, useRef, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { useFormDraftPersistence } from '../../hooks/useFormDraftPersistence'
import { createOfferWorkflow } from '../../lib/workflow/offerWorkflow'
import { normalizeErrorMessage } from '../../lib/diagnostics'
import { logError } from '../../lib/observability'
import type { OfferDocumentType } from '../../lib/offers/types'
import type { Offer } from '../../lib/offers/types'
import {
  validateOfferDocument,
  getValidationMessages,
} from '../../lib/offers/offerDocumentValidator'
import { normalizeDateToISO, toDateInputValue } from '../../lib/shared/formatters'
import QuoteDetailView from '../quotes/QuoteDetailView'
import CorridorAction from '../system/CorridorAction'

/**
 * Thread-neutral composer context (Cutover Slice-2 decoupling).
 *
 * The commercial composer no longer takes a legacy `Conversation`. It receives
 * only the fields it actually needs, resolved by the caller from EITHER a legacy
 * conversation OR a chat_threads thread. This lets the composer open on cutover
 * inquiry threads (which have no legacy conversation row). `conversationId` is the
 * canonical thread id — a legacy `conversations.id` or a `chat_threads.id`.
 */
export type QuoteComposerContext = {
  conversationId: string
  craftsmanUserId?: string
  customerUserId?: string
  projectTitle?: string
  projectLocation?: string
  projectDescription?: string
  craftsmanName?: string
}

type Props = {
  context: QuoteComposerContext
  /** Leading commercial document type — required, set by CraftsmanActionSheet. */
  documentType: OfferDocumentType
  /**
   * ID of the diagnosis offer this composer was opened from (Paket 4d).
   * When set, this binding_offer is created as a follow-up to that diagnosis.
   * Shows a context banner and stamps sourceDiagnosisId on the created offer.
   */
  sourceDiagnosisId?: string
  /** Human-readable reference of the source diagnosis (e.g. 'KV-2026-XXXX'). */
  sourceDiagnosisRef?: string
  /**
   * Pre-fill value for the scope summary field (Paket 4d).
   * When coming from a diagnosis follow-up, this is populated with the
   * diagnosis scopeSummary as a starting point for the craftsman to refine.
   */
  initialScopeSummary?: string
  onCreated?: () => void
  onClose: () => void
}

type ComposerStep = 'form' | 'preview'

// ── Draft persistence (Resume-Robustness Block 4) ─────────────────────────────

/** One JSON object per thread + documentType — never one key per field. */
type QuoteDraft = {
  price: string
  scopeSummary: string
  scopeIncluded: string
  scopeExcluded: string
  assumptions: string
  paymentTerms: string
  validUntil: string
  cancellationTerms: string
  timingNote: string
  notes: string
  vatIncluded: boolean
  showOptionalDetails: boolean
}

const QUOTE_DRAFT_DEFAULTS: QuoteDraft = {
  price: '',
  scopeSummary: '',
  scopeIncluded: '',
  scopeExcluded: '',
  assumptions: '',
  paymentTerms: '',
  validUntil: '',
  cancellationTerms: '',
  timingNote: '',
  notes: '',
  vatIncluded: true,
  showOptionalDetails: false,
}

// ── Per-type UI labels ────────────────────────────────────────────────────────

const TYPE_LABEL: Record<OfferDocumentType, string> = {
  estimate: 'Schätzung',
  cost_estimate: 'Kostenvoranschlag',
  binding_offer: 'Verbindliches Angebot',
  diagnosis: 'Diagnose-Einsatz',
}

const TYPE_ICON: Record<OfferDocumentType, string> = {
  estimate: '📊',
  cost_estimate: '📄',
  binding_offer: '📋',
  diagnosis: '🔍',
}

const TYPE_PRICE_PLACEHOLDER: Record<OfferDocumentType, string> = {
  estimate: 'Schätzung (z.B. 800 – 1.200 €)',
  cost_estimate: 'Betrag (z.B. 1.200 €)',
  binding_offer: 'Betrag (z.B. 1.500 €)',
  diagnosis: 'Pauschale oder Stundensatz (z.B. 120 €)',
}

const SCOPE_LABEL: Record<OfferDocumentType, string> = {
  estimate: 'Schätzbasis',
  cost_estimate: 'Leistungsbeschreibung',
  binding_offer: 'Leistungsbeschreibung',
  diagnosis: 'Einsatzbeschreibung',
}

const SCOPE_PLACEHOLDER: Record<OfferDocumentType, string> = {
  estimate: 'Was soll geschätzt werden? (Grundlage der Schätzung)',
  cost_estimate: 'Was wird ausgeführt? (Zusammenfassung der Leistung)',
  binding_offer: 'Was wird ausgeführt? (Zusammenfassung der Leistung)',
  diagnosis: 'Was soll untersucht/geprüft werden?',
}

const ASSUMPTIONS_LABEL: Record<OfferDocumentType, string> = {
  estimate: 'Abweichungsgründe / Unsicherheiten',
  cost_estimate: 'Annahmen / Voraussetzungen',
  binding_offer: 'Annahmen / Voraussetzungen',
  diagnosis: 'Freigabegrenze / Zusatzarbeitsregel',
}

const ASSUMPTIONS_PLACEHOLDER: Record<OfferDocumentType, string> = {
  estimate: 'z.B. Preis kann abweichen wenn Schimmel gefunden wird ...',
  cost_estimate: 'z.B. Rohre zugänglich, kein Schimmelbefall ...',
  binding_offer: 'z.B. Rohre zugänglich, kein Schimmelbefall ...',
  diagnosis: 'z.B. Zusatzarbeiten bis 200 € ohne Rückfrage, darüber hinaus Rücksprache',
}

// ── Shared field CSS ──────────────────────────────────────────────────────────

const INPUT_CLS =
  'w-full rounded-lg border border-slate-200 px-3 py-2 text-[13px] text-slate-900 outline-none placeholder:text-slate-400 focus:border-blue-400 focus:ring-1 focus:ring-blue-400'
const TEXTAREA_CLS =
  'w-full resize-none rounded-lg border border-slate-200 px-3 py-2 text-[13px] text-slate-900 outline-none placeholder:text-slate-400 focus:border-blue-400 focus:ring-1 focus:ring-blue-400'
const LABEL_CLS = 'mb-1 block text-[11px] font-semibold text-slate-500 uppercase tracking-wider'

// ── Component ─────────────────────────────────────────────────────────────────

export default function QuoteCreationSheet({
  context,
  documentType,
  sourceDiagnosisId,
  sourceDiagnosisRef,
  initialScopeSummary,
  onCreated,
  onClose,
}: Props) {
  // ── Draft persistence (Block 4) ───────────────────────────────────────
  // One JSON object keyed by thread + documentType. Restoring only refills
  // field state — it never triggers a send.
  const { restored: restoredDraft, persist: persistDraft, clear: clearDraft, hasDraft } =
    useFormDraftPersistence<QuoteDraft>(
      `fixup.quote.draft.${context.conversationId}.${documentType}`,
      QUOTE_DRAFT_DEFAULTS,
    )

  // ── Form state ────────────────────────────────────────────────────────
  const [step, setStep] = useState<ComposerStep>('form')
  const [price, setPrice] = useState(restoredDraft.price)
  // A restored draft wins over the diagnosis pre-fill — including a draft whose
  // scopeSummary was explicitly cleared (Block 5: gate on hasDraft, not on the
  // truthiness of the value, so an emptied scope is not re-seeded from the
  // prefill). The reactive pre-fill effect below only applies on a fresh open.
  const [scopeSummary, setScopeSummary] = useState(
    hasDraft ? restoredDraft.scopeSummary : (initialScopeSummary ?? ''),
  )
  const [scopeIncluded, setScopeIncluded] = useState(restoredDraft.scopeIncluded)
  const [scopeExcluded, setScopeExcluded] = useState(restoredDraft.scopeExcluded)
  const [assumptions, setAssumptions] = useState(restoredDraft.assumptions)
  const [paymentTerms, setPaymentTerms] = useState(restoredDraft.paymentTerms)
  const [validUntil, setValidUntil] = useState(restoredDraft.validUntil)
  const [cancellationTerms, setCancellationTerms] = useState(restoredDraft.cancellationTerms)
  const [timingNote, setTimingNote] = useState(restoredDraft.timingNote)
  const [notes, setNotes] = useState(restoredDraft.notes)
  const [vatIncluded, setVatIncluded] = useState(restoredDraft.vatIncluded)
  const [showOptionalDetails, setShowOptionalDetails] = useState(restoredDraft.showOptionalDetails)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [validationErrors, setValidationErrors] = useState<string[]>([])
  const [confirmDiscard, setConfirmDiscard] = useState(false)
  // Synchronous re-entry guard for the send path (Block 2) — see handleSend.
  const submittingRef = useRef(false)

  // Reactive pre-fill: when initialScopeSummary arrives after mount (deferred offer
  // repo hydration), apply it to the scope field — but only if the user hasn't
  // already typed anything. This handles the case where the diagnosis offer wasn't
  // immediately available when the composer opened from a ?followUpDiagnosis param.
  useEffect(() => {
    // Block 5: also gate on !hasDraft so the deferred prefill applies only on a
    // fresh open with no stored draft — never reinstating a scope the user
    // cleared in a restored draft.
    if (initialScopeSummary && !hasDraft && !scopeSummary) {
      setScopeSummary(initialScopeSummary)
    }
    // scopeSummary intentionally excluded: we only want this to fire when the
    // prop arrives, not on every keystroke. The !scopeSummary guard prevents
    // overwriting user input if the effect runs more than once.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initialScopeSummary])

  // Draft-relevant content: any text field with user input. A scopeSummary
  // that only mirrors the diagnosis pre-fill does not count — the pre-fill
  // effect re-applies it on the next open anyway.
  const scopeSummaryDirty =
    scopeSummary.trim().length > 0 &&
    scopeSummary.trim() !== (initialScopeSummary ?? '').trim()
  const hasDraftContent =
    price.trim().length > 0 ||
    scopeSummaryDirty ||
    scopeIncluded.trim().length > 0 ||
    scopeExcluded.trim().length > 0 ||
    assumptions.trim().length > 0 ||
    paymentTerms.trim().length > 0 ||
    validUntil.trim().length > 0 ||
    cancellationTerms.trim().length > 0 ||
    timingNote.trim().length > 0 ||
    notes.trim().length > 0

  // Debounced write-through: persist the full field object on every change;
  // an empty form removes the entry instead of storing an empty object.
  useEffect(() => {
    persistDraft(
      hasDraftContent
        ? {
            price,
            scopeSummary,
            scopeIncluded,
            scopeExcluded,
            assumptions,
            paymentTerms,
            validUntil,
            cancellationTerms,
            timingNote,
            notes,
            vatIncluded,
            showOptionalDetails,
          }
        : null,
    )
  }, [
    persistDraft, hasDraftContent, price, scopeSummary, scopeIncluded,
    scopeExcluded, assumptions, paymentTerms, validUntil, cancellationTerms,
    timingNote, notes, vatIncluded, showOptionalDetails,
  ])

  // X-tap confirm (Block 4): closing with content asks instead of silently
  // discarding. 'Verwerfen' clears the persisted draft and closes;
  // 'Weiter bearbeiten' dismisses. An empty composer closes directly.
  const handleCloseRequest = useCallback(() => {
    if (hasDraftContent) {
      setConfirmDiscard(true)
      return
    }
    onClose()
  }, [hasDraftContent, onClose])

  const handleDiscard = useCallback(() => {
    clearDraft()
    onClose()
  }, [clearDraft, onClose])

  // Context hints from the thread — shown as pre-fill info
  const contextTitle = context.projectTitle ?? undefined
  const contextLocation = context.projectLocation ?? undefined

  // ── Validation (domain validator — same rules as createOfferWorkflow) ──
  const runValidation = useCallback((): string[] => {
    const result = validateOfferDocument(documentType, {
      price,
      scopeSummary,
      scopeExcluded,
      paymentTerms,
      // Validate the SAME normalized value the workflow will (Block 3): an
      // unparseable date → '' so pre-flight reports the missing Gültigkeit
      // instead of passing here and throwing commercial_document_invalid later.
      validUntil: normalizeDateToISO(validUntil) ?? '',
      assumptions,
    })
    return getValidationMessages(result)
  }, [documentType, price, scopeSummary, scopeExcluded, paymentTerms, validUntil, assumptions])

  const handlePreview = useCallback(() => {
    const errs = runValidation()
    if (errs.length > 0) {
      setValidationErrors(errs)
      return
    }
    setValidationErrors([])
    setStep('preview')
  }, [runValidation])

  const handleBackToForm = useCallback(() => {
    setStep('form')
    setError(null)
  }, [])

  // ── Send ──────────────────────────────────────────────────────────────
  const handleSend = useCallback(async () => {
    // Synchronous re-entry guard (Block 2): `disabled={busy}` only takes effect
    // after a paint, so a rapid double-tap can call handleSend twice before busy
    // flips and create two pending offers. The ref short-circuits the second
    // call synchronously, in the same frame.
    if (submittingRef.current) return

    const errs = runValidation()
    if (errs.length > 0) {
      setValidationErrors(errs)
      setStep('form')
      return
    }

    if (!context.craftsmanUserId) {
      setError('Handwerker-Identität fehlt. Bitte kontaktieren Sie den Support.')
      return
    }
    if (!context.customerUserId) {
      setError('Kunden-Identität fehlt. Anfrage kann nicht zugeordnet werden.')
      return
    }

    submittingRef.current = true
    setBusy(true)
    setError(null)

    // Only the workflow call lives in the try. Success side-effects run after it
    // (see below) so a throw from onCreated — which re-reads thread + artifacts —
    // can never be misread as a send failure that strands the sheet on an
    // emptied form while the offer is already persisted.
    let created = false
    try {
      const normalizedValidUntil = normalizeDateToISO(validUntil)
      await createOfferWorkflow({
        conversationId: context.conversationId,
        customerUserId: context.customerUserId,
        craftsmanUserId: context.craftsmanUserId,
        price: price.trim(),
        documentType,
        scopeSummary: scopeSummary.trim(),
        scopeExcluded: scopeExcluded.trim() || undefined,
        ...(scopeIncluded.trim() && { scopeIncluded: scopeIncluded.trim() }),
        ...(assumptions.trim() && { assumptions: assumptions.trim() }),
        ...(paymentTerms.trim() && { paymentTerms: paymentTerms.trim() }),
        ...(normalizedValidUntil && { validUntil: normalizedValidUntil }),
        ...(cancellationTerms.trim() && { cancellationTerms: cancellationTerms.trim() }),
        ...(timingNote.trim() && { timingNote: timingNote.trim() }),
        ...(notes.trim() && { notes: notes.trim() }),
        vatIncluded: documentType === 'binding_offer' ? vatIncluded : undefined,
        ...(contextTitle && { projectTitleSnapshot: contextTitle }),
        ...(context.projectDescription && {
          customerDescriptionSnapshot: context.projectDescription,
        }),
        ...(contextLocation && { locationSnapshot: contextLocation }),
        // Pass craftsmanName snapshot from the caller-resolved context so the
        // offer card renders the provider name even on cutover threads where
        // offerWorkflow's internal legacy lookup returns nothing.
        ...(context.craftsmanName && { craftsmanNameSnapshot: context.craftsmanName }),
        ...(sourceDiagnosisId && { sourceDiagnosisId }),
      })
      created = true
    } catch (err) {
      // Honest classification (Block 2): dispatch on the structured Postgres
      // error code where available, not on human-readable message substrings.
      // The old `invalid input syntax`/`bigint` → date branch was a
      // misattribution — offers.valid_until is TEXT and can never raise it; the
      // bigint columns are created_at/sent_at/etc. Each branch owns its own
      // setStep so a transient failure on a complete document does not eject the
      // user from the preview back to the form.
      const e = err as { code?: string }
      const code = typeof e?.code === 'string' ? e.code : ''
      const message = normalizeErrorMessage(err)
      if (message.includes('Active offer')) {
        setError('Es gibt bereits ein offenes kommerzielles Dokument in diesem Thread.')
      } else if (message.includes('commercial_document_invalid')) {
        setError('Pflichtbereiche unvollständig. Bitte alle markierten Felder ausfüllen.')
        setStep('form')
      } else if (message.includes('Missing')) {
        setError(message)
        setStep('form')
      } else if (
        code === '42501' ||
        code === 'PGRST301' ||
        message.includes('row-level security') ||
        message.includes('row level security')
      ) {
        setError('Keine Berechtigung für diese Aktion. Bitte neu anmelden und erneut versuchen.')
      } else if (message.includes('Load failed') || message.includes('Failed to fetch')) {
        setError('Verbindung fehlgeschlagen. Bitte Internetverbindung prüfen und erneut versuchen.')
      } else {
        setError('Dokument konnte nicht gesendet werden. Bitte erneut versuchen.')
      }
    } finally {
      setBusy(false)
      submittingRef.current = false
    }

    // Success side-effects run OUTSIDE the try so a callback throw is isolated
    // from send-failure handling. The offer is already persisted at this point.
    if (created) {
      clearDraft()
      try {
        onCreated?.()
      } catch (cbErr) {
        logError('quote.onCreated_failed', cbErr as Error)
      }
      onClose()
    }
  }, [
    context, documentType, runValidation,
    price, scopeSummary, scopeExcluded, scopeIncluded,
    assumptions, paymentTerms, validUntil, cancellationTerms,
    timingNote, notes, vatIncluded, contextTitle, contextLocation,
    sourceDiagnosisId, clearDraft, onCreated, onClose,
  ])

  // ── Discard confirmation panel (shared by form + preview step) ────────
  const discardConfirmPanel = confirmDiscard ? (
    <div
      className="mb-3 rounded-[10px] bg-amber-50 px-3 py-3 ring-1 ring-amber-200/70"
      data-testid="quote-discard-confirm"
    >
      <p className="mb-1 text-[13px] font-semibold text-amber-800">
        Entwurf verwerfen?
      </p>
      <p className="mb-2.5 text-[12px] text-amber-700">
        Deine Eingaben gehen verloren, wenn du das Dokument jetzt verwirfst.
      </p>
      <div className="flex gap-2">
        <button
          type="button"
          onClick={handleDiscard}
          className="flex-1 rounded-[8px] bg-amber-600 px-3 py-2 text-[12px] font-semibold text-white hover:bg-amber-700"
          data-testid="quote-discard-confirm-button"
        >
          Verwerfen
        </button>
        <button
          type="button"
          onClick={() => setConfirmDiscard(false)}
          className="flex-1 rounded-[8px] bg-white px-3 py-2 text-[12px] font-semibold text-slate-700 ring-1 ring-slate-200 hover:bg-slate-50"
          data-testid="quote-discard-keep-button"
        >
          Weiter bearbeiten
        </button>
      </div>
    </div>
  ) : null

  // ── Bottom-sheet overlay shell (Block 1) ─────────────────────────────
  // The composer renders into document.body via a portal so it escapes the
  // chat input bar's `fixed … z-40` stacking context. z-[60] lifts the sheet
  // above SyncStatusBar (z-40), BottomNav and the chat composer; the backdrop
  // covers the sync pill while the composer is open. The sheet owns its own
  // scroll (max-h-[92dvh] + overflow-y-auto) and safe-area padding, so a fully
  // expanded document plus the iOS keyboard never clips the top fields or the
  // action row. Backdrop tap routes through handleCloseRequest (discard-confirm
  // when dirty) and is inert while a send is in flight.
  const wrapInSheet = (children: ReactNode) =>
    createPortal(
      <div
        className="fixed inset-0 z-[60] flex flex-col justify-end"
        data-testid="commercial-composer-overlay"
      >
        <div
          className="absolute inset-0 bg-black/40"
          onClick={busy ? undefined : handleCloseRequest}
          aria-hidden
        />
        <div className="relative mx-auto flex max-h-[92dvh] w-full max-w-[480px] flex-col overflow-y-auto rounded-t-3xl bg-white pb-[max(16px,env(safe-area-inset-bottom))] shadow-[0_-12px_34px_-16px_rgba(2,6,23,0.18)]">
          {children}
        </div>
      </div>,
      document.body,
    )

  // ── Render: Preview step ──────────────────────────────────────────────
  if (step === 'preview') {
    // Built only on the preview step (Block 4) — previously constructed on every
    // form-step render too, including each keystroke. normalizeDateToISO is
    // computed once here instead of twice inline.
    const previewValidUntil = normalizeDateToISO(validUntil)
    const previewOffer: Offer = {
      id: 'preview',
      conversationId: context.conversationId,
      craftsmanUserId: context.craftsmanUserId ?? '',
      customerUserId: context.customerUserId ?? '',
      documentType,
      price: price.trim() || '–',
      ...(scopeSummary.trim() && { scopeSummary: scopeSummary.trim() }),
      ...(scopeIncluded.trim() && { scopeIncluded: scopeIncluded.trim() }),
      ...(scopeExcluded.trim() && { scopeExcluded: scopeExcluded.trim() }),
      ...(assumptions.trim() && { assumptions: assumptions.trim() }),
      ...(paymentTerms.trim() && { paymentTerms: paymentTerms.trim() }),
      ...(previewValidUntil && { validUntil: previewValidUntil }),
      ...(cancellationTerms.trim() && { cancellationTerms: cancellationTerms.trim() }),
      ...(timingNote.trim() && { timingNote: timingNote.trim() }),
      ...(notes.trim() && { notes: notes.trim() }),
      vatIncluded: documentType === 'binding_offer' ? vatIncluded : undefined,
      status: 'draft',
      sentAt: Date.now(),
      createdAt: Date.now(),
      updatedAt: Date.now(),
      ...(contextTitle && { projectTitleSnapshot: contextTitle }),
      ...(contextLocation && { locationSnapshot: contextLocation }),
      ...(context.craftsmanName && { craftsmanNameSnapshot: context.craftsmanName }),
      ...(sourceDiagnosisId && { sourceDiagnosisId }),
    }
    return wrapInSheet(
      <div className="p-4" data-testid="commercial-composer-preview">
        <div className="mb-3 flex items-center justify-between">
          <div className="flex items-center gap-2">
            <span className="text-[14px]">{TYPE_ICON[documentType]}</span>
            <div>
              <span className="text-[13px] font-semibold text-slate-800">
                Vorschau: {TYPE_LABEL[documentType]}
              </span>
              <p className="text-[10px] text-slate-400 mt-0.5">
                Entwurf — noch nicht gesendet
              </p>
            </div>
          </div>
          <button
            type="button"
            onClick={handleCloseRequest}
            disabled={busy}
            className="flex h-7 w-7 items-center justify-center rounded-full text-[14px] text-slate-400 transition hover:bg-slate-100 disabled:opacity-50"
            aria-label="Schließen"
          >
            ✕
          </button>
        </div>

        {discardConfirmPanel}

        <div className="mb-4 max-h-[50dvh] overflow-y-auto rounded-[12px] bg-slate-50 p-3">
          <QuoteDetailView offer={previewOffer} isCustomer={false} />
        </div>

        {error && (
          <p className="mb-2 text-[12px] text-red-500" role="alert">
            {error}
          </p>
        )}

        <div className="flex gap-2">
          <CorridorAction
            variant="ghost"
            size="sm"
            block={false}
            disabled={busy}
            onClick={handleBackToForm}
          >
            ← Bearbeiten
          </CorridorAction>
          <CorridorAction
            variant="primary"
            size="sm"
            loading={busy}
            disabled={busy}
            onClick={handleSend}
            data-testid="quote-submit-button"
          >
            {busy ? '…' : documentType === 'estimate'
              ? 'Schätzung senden'
              : documentType === 'cost_estimate'
                ? 'Kostenvoranschlag senden'
                : documentType === 'diagnosis'
                  ? 'Diagnose-Einsatz senden'
                  : 'Verbindliches Angebot senden'}
          </CorridorAction>
        </div>
      </div>
    )
  }

  // ── Render: Form step ─────────────────────────────────────────────────
  return wrapInSheet(
    <div className="p-4" data-testid="commercial-composer-form">
      {/* Header */}
      <div className="mb-3 flex items-center justify-between">
        <div className="flex items-center gap-2">
          <span className="text-[16px]">{TYPE_ICON[documentType]}</span>
          <span className="text-[14px] font-semibold text-slate-800">
            {TYPE_LABEL[documentType]} erstellen
          </span>
        </div>
        <button
          type="button"
          onClick={handleCloseRequest}
          disabled={busy}
          className="flex h-7 w-7 items-center justify-center rounded-full text-[14px] text-slate-400 transition hover:bg-slate-100 disabled:opacity-50"
          aria-label="Schließen"
        >
          ✕
        </button>
      </div>

      {discardConfirmPanel}

      {/* Folge-Angebot banner — shown when opened from a completed diagnosis */}
      {sourceDiagnosisId && documentType === 'binding_offer' && (
        <div className="mb-3 rounded-[10px] bg-purple-50 px-3 py-2.5 text-[11px] text-purple-700 ring-1 ring-purple-200/70">
          <p className="font-semibold mb-0.5">
            Folge-Angebot nach Diagnose-Einsatz
            {sourceDiagnosisRef && <span className="ml-1 opacity-70">({sourceDiagnosisRef})</span>}
          </p>
          <p className="opacity-80">
            Dieses Angebot basiert auf der abgeschlossenen Diagnose. Die Diagnose bleibt erhalten — dieses Angebot ist ein neues, eigenständiges Dokument mit eigenem Annahmepfad und Zahlungskorridor.
          </p>
        </div>
      )}

      {/* Document type hint */}
      {documentType === 'estimate' && (
        <div className="mb-3 rounded-[10px] bg-amber-50 px-3 py-2 text-[11px] text-amber-700 ring-1 ring-amber-200/70">
          Schätzungen sind unverbindlich und lösen keine Zahlungspflicht aus.
        </div>
      )}
      {documentType === 'cost_estimate' && (
        <div className="mb-3 rounded-[10px] bg-sky-50 px-3 py-2 text-[11px] text-sky-700 ring-1 ring-sky-200/70">
          Kostenvoranschlag: konkreter Preis & Leistungsumfang. Kein Auftragsabschluss — löst keinen Zahlungs- oder Zahlungskorridor aus.
        </div>
      )}
      {documentType === 'diagnosis' && (
        <div className="mb-3 rounded-[10px] bg-purple-50 px-3 py-2 text-[11px] text-purple-700 ring-1 ring-purple-200/70">
          <p className="font-semibold mb-0.5">Diagnose-Einsatz — eigener Zahlungspfad</p>
          <p className="opacity-80">Eigenständiger bezahlter Prüfeinsatz. Kein Standard-Zahlungskorridor. Bei Freigabe wird eine Sofortzahlung mit 5 % Plattformgebühr ausgelöst.</p>
        </div>
      )}

      {/* Project context hint */}
      {(contextTitle || contextLocation) && (
        <div className="mb-3 rounded-[10px] bg-slate-50 px-3 py-2 text-[11px] text-slate-500">
          {contextTitle && <p className="font-medium text-slate-600">{contextTitle}</p>}
          {contextLocation && <p>{contextLocation}</p>}
        </div>
      )}

      {/* Validation errors */}
      {validationErrors.length > 0 && (
        <div className="mb-3 rounded-[10px] bg-red-50 px-3 py-2 ring-1 ring-red-200/70">
          <p className="mb-1 text-[11px] font-semibold text-red-600">
            Pflichtbereiche unvollständig:
          </p>
          <ul className="list-disc pl-4">
            {validationErrors.map((e) => (
              <li key={e} className="text-[11px] text-red-600">{e}</li>
            ))}
          </ul>
        </div>
      )}

      {/* ── 1. Preis ───────────────────────────────────────────────────── */}
      <div className="mb-2">
        <label className={LABEL_CLS}>
          Betrag *
        </label>
        <input
          type="text"
          value={price}
          onChange={(e) => setPrice(e.target.value)}
          placeholder={TYPE_PRICE_PLACEHOLDER[documentType]}
          className={INPUT_CLS}
          disabled={busy}
          required
          data-testid="quote-price-input"
        />
      </div>

      {/* MwSt toggle — binding_offer only */}
      {documentType === 'binding_offer' && (
        <div className="mb-2 flex gap-2">
          <button
            type="button"
            onClick={() => setVatIncluded(true)}
            className={[
              'flex-1 rounded-[8px] border px-2 py-1.5 text-[11px] font-medium transition',
              vatIncluded
                ? 'border-blue-400 bg-blue-50 text-blue-700'
                : 'border-slate-200 bg-white text-slate-500',
            ].join(' ')}
          >
            Brutto (inkl. MwSt.)
          </button>
          <button
            type="button"
            onClick={() => setVatIncluded(false)}
            className={[
              'flex-1 rounded-[8px] border px-2 py-1.5 text-[11px] font-medium transition',
              !vatIncluded
                ? 'border-blue-400 bg-blue-50 text-blue-700'
                : 'border-slate-200 bg-white text-slate-500',
            ].join(' ')}
          >
            Netto (zzgl. MwSt.)
          </button>
        </div>
      )}

      {/* ── 2. Scope / Leistungsbeschreibung ───────────────────────────── */}
      <div className="mb-2">
        <label className={LABEL_CLS}>
          {SCOPE_LABEL[documentType]} *
        </label>
        <textarea
          value={scopeSummary}
          onChange={(e) => setScopeSummary(e.target.value)}
          placeholder={SCOPE_PLACEHOLDER[documentType]}
          rows={3}
          className={TEXTAREA_CLS}
          disabled={busy}
          data-testid="quote-summary-input"
        />
      </div>

      {/* ── 3. Ausschlüsse (binding_offer + cost_estimate + estimate — required) ─────── */}
      {(documentType === 'binding_offer' || documentType === 'cost_estimate' || documentType === 'estimate') && (
        <div className="mb-2">
          <label className={LABEL_CLS}>
            Nicht enthalten / Ausschlüsse *
          </label>
          <textarea
            value={scopeExcluded}
            onChange={(e) => setScopeExcluded(e.target.value)}
            placeholder={
              documentType === 'estimate'
                ? 'z.B. Material extra, Entsorgung nicht inklusive ...'
                : 'z.B. Malerarbeiten, Stemmarbeiten, Schimmelbehandlung ...'
            }
            rows={2}
            className={TEXTAREA_CLS}
            disabled={busy}
            data-testid="quote-excluded-input"
          />
        </div>
      )}

      {/* ── 4. Assumptions / Unsicherheiten / Freigabegrenze (estimate + diagnosis — required) */}
      {(documentType === 'estimate' || documentType === 'diagnosis') && (
        <div className="mb-2">
          <label className={LABEL_CLS}>
            {ASSUMPTIONS_LABEL[documentType]} *
          </label>
          <textarea
            value={assumptions}
            onChange={(e) => setAssumptions(e.target.value)}
            placeholder={ASSUMPTIONS_PLACEHOLDER[documentType]}
            rows={2}
            className={TEXTAREA_CLS}
            disabled={busy}
            data-testid="quote-assumptions-input"
          />
        </div>
      )}

      {/* ── 5. Gültigkeit (all types — required) ────────────────────── */}
      <div className="mb-2">
        <label className={LABEL_CLS}>
          Gültigkeit *
        </label>
        <input
          type="date"
          value={toDateInputValue(validUntil)}
          onChange={(e) => setValidUntil(e.target.value)}
          className={INPUT_CLS}
          disabled={busy}
          data-testid="quote-validity-input"
        />
      </div>

      {/* ── 6. Optionale Felder ─────────────────────────────────────────── */}

      {/* binding_offer: platform escrow hint + optional scopeIncluded + assumptions + storno + timing + notes */}
      {documentType === 'binding_offer' && (
        <>
          <div className="mb-3 rounded-[10px] bg-emerald-50 px-3 py-2 text-[11px] text-emerald-700 ring-1 ring-emerald-200/70">
            Sichere Zahlung über Stripe: 25 % bei Arbeitsbeginn, 75 % bei Fertigstellung. Keine eigenen Zahlungsbedingungen nötig.
          </div>
          <button
            type="button"
            onClick={() => setShowOptionalDetails(!showOptionalDetails)}
            className="mb-2 flex w-full items-center justify-between rounded-[8px] bg-slate-50 px-3 py-2 text-[12px] font-medium text-slate-600 transition hover:bg-slate-100"
            data-testid="quote-details-toggle"
          >
            <span>Optionale Details (enthalten, Annahmen, Sonderbedingungen, Storno, Zeitplan)</span>
            <span className="text-slate-400">{showOptionalDetails ? '▲' : '▼'}</span>
          </button>

          {showOptionalDetails && (
            <div className="mb-2 flex flex-col gap-2 rounded-[10px] bg-slate-50 p-3">
              <div>
                <label className="mb-1 block text-[10px] font-semibold text-slate-500 uppercase tracking-wider">
                  Was ist enthalten ✓
                </label>
                <textarea
                  value={scopeIncluded}
                  onChange={(e) => setScopeIncluded(e.target.value)}
                  placeholder="z.B. Demontage, Material, Entsorgung ..."
                  rows={2}
                  className={TEXTAREA_CLS.replace('text-[13px]', 'text-[12px]')}
                  disabled={busy}
                  data-testid="quote-included-input"
                />
              </div>
              <div>
                <label className="mb-1 block text-[10px] font-semibold text-slate-500 uppercase tracking-wider">
                  {ASSUMPTIONS_LABEL.binding_offer}
                </label>
                <textarea
                  value={assumptions}
                  onChange={(e) => setAssumptions(e.target.value)}
                  placeholder={ASSUMPTIONS_PLACEHOLDER.binding_offer}
                  rows={2}
                  className={TEXTAREA_CLS.replace('text-[13px]', 'text-[12px]')}
                  disabled={busy}
                  data-testid="quote-assumptions-input"
                />
              </div>
              <div>
                <label className="mb-1 block text-[10px] font-semibold text-slate-500 uppercase tracking-wider">
                  Sonderbedingungen / Ausführungshinweise
                </label>
                <input
                  type="text"
                  value={paymentTerms}
                  onChange={(e) => setPaymentTerms(e.target.value)}
                  placeholder="z.B. Nur nach Freigabe, Lieferzeiten beachten ..."
                  className={INPUT_CLS.replace('text-[13px]', 'text-[12px]')}
                  disabled={busy}
                  data-testid="quote-payment-terms-input"
                />
              </div>
              <div>
                <label className="mb-1 block text-[10px] font-semibold text-slate-500 uppercase tracking-wider">
                  Stornobedingungen
                </label>
                <textarea
                  value={cancellationTerms}
                  onChange={(e) => setCancellationTerms(e.target.value)}
                  placeholder="z.B. Kostenlos bis 48h vor Beginn, danach 30% Aufwandspauschale"
                  rows={2}
                  className={TEXTAREA_CLS.replace('text-[13px]', 'text-[12px]')}
                  disabled={busy}
                  data-testid="quote-cancellation-terms-input"
                />
              </div>
              <div>
                <label className="mb-1 block text-[10px] font-semibold text-slate-500 uppercase tracking-wider">
                  Zeitplanung / Verfügbarkeit
                </label>
                <input
                  type="text"
                  value={timingNote}
                  onChange={(e) => setTimingNote(e.target.value)}
                  placeholder="z.B. Umsetzung ab Mai möglich, ca. 2 Tage"
                  className={INPUT_CLS.replace('text-[13px]', 'text-[12px]')}
                  disabled={busy}
                  data-testid="quote-timing-note-input"
                />
              </div>
              <div>
                <label className="mb-1 block text-[10px] font-semibold text-slate-500 uppercase tracking-wider">
                  Hinweis / Interne Notizen
                </label>
                <textarea
                  value={notes}
                  onChange={(e) => setNotes(e.target.value)}
                  placeholder="z.B. Materiallieferung über Lieferant X ..."
                  rows={2}
                  className={TEXTAREA_CLS.replace('text-[13px]', 'text-[12px]')}
                  disabled={busy}
                  data-testid="quote-note-input"
                />
              </div>
            </div>
          )}
        </>
      )}

      {/* estimate: optional notes */}
      {documentType === 'estimate' && (
        <div className="mb-2">
          <label className={LABEL_CLS}>
            Interne Notizen
          </label>
          <textarea
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            placeholder="Interne Notizen (nur für dich sichtbar)"
            rows={2}
            className={TEXTAREA_CLS}
            disabled={busy}
            data-testid="quote-note-input"
          />
        </div>
      )}

      {/* cost_estimate: optional timing + notes */}
      {documentType === 'cost_estimate' && (
        <>
          <div className="mb-2">
            <label className={LABEL_CLS}>
              Zeitplanung / Verfügbarkeit
            </label>
            <input
              type="text"
              value={timingNote}
              onChange={(e) => setTimingNote(e.target.value)}
              placeholder="z.B. Umsetzung ab Mai möglich, ca. 2 Tage"
              className={INPUT_CLS}
              disabled={busy}
              data-testid="quote-timing-note-input"
            />
          </div>
          <div className="mb-2">
            <label className={LABEL_CLS}>
              Interne Notizen
            </label>
            <textarea
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              placeholder="Interne Notizen (nur für dich sichtbar)"
              rows={2}
              className={TEXTAREA_CLS}
              disabled={busy}
              data-testid="quote-note-input"
            />
          </div>
        </>
      )}

      {/* diagnosis: optional timingNote + notes */}
      {documentType === 'diagnosis' && (
        <>
          <div className="mb-2">
            <label className={LABEL_CLS}>
              Anfahrt / Zeitplanung
            </label>
            <input
              type="text"
              value={timingNote}
              onChange={(e) => setTimingNote(e.target.value)}
              placeholder="z.B. Anfahrtspauschale 40 €, Einsatz ca. 1–2 Std."
              className={INPUT_CLS}
              disabled={busy}
              data-testid="quote-timing-note-input"
            />
          </div>
          <div className="mb-2">
            <label className={LABEL_CLS}>
              Hinweis / Interne Notizen
            </label>
            <textarea
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              placeholder="Interne Notizen (nur für dich sichtbar)"
              rows={2}
              className={TEXTAREA_CLS}
              disabled={busy}
              data-testid="quote-note-input"
            />
          </div>
        </>
      )}

      {/* ── Actions ────────────────────────────────────────────────────── */}
      <div className="mt-3 flex gap-2">
        <CorridorAction
          variant="primary"
          size="sm"
          type="button"
          disabled={!price.trim()}
          onClick={handlePreview}
          data-testid="quote-preview-button"
        >
          Vorschau
        </CorridorAction>
        <CorridorAction
          variant="ghost"
          size="sm"
          block={false}
          disabled={busy}
          onClick={handleCloseRequest}
        >
          Abbrechen
        </CorridorAction>
      </div>

      {error && (
        <p className="mt-2 text-[12px] text-red-500" role="alert">
          {error}
        </p>
      )}
    </div>
  )
}
