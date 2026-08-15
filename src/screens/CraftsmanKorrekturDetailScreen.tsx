import { useEffect, useState } from 'react'
import { useParams, useSearchParams } from 'react-router-dom'
import { ArrowLeft } from 'lucide-react'
import AppShell from '../components/AppShell'
import { useCorrections } from '../hooks/useCorrections'
import { type CorrectionKind, type CorrectionStatus } from '../lib/corrections'
import { getTeamMembers } from '../lib/jobs'
import {
  approveCorrectionWorkflow,
  rejectCorrectionWorkflow,
  CorrectionWorkflowError,
} from '../lib/workflow/correctionWorkflow'
import { RbacError } from '../lib/auth/rbacGuards'
import CorrectionApplyBadge from '../components/corrections/CorrectionApplyBadge'
import CorrectionApproveSheet from '../components/notifications/CorrectionApproveSheet'
import CorrectionRejectSheet from '../components/notifications/CorrectionRejectSheet'
import { emitSuccessNotif } from '../lib/notifications/pushActionFeedback'
import { useSmartBack } from '../hooks/useSmartBack'

// ── Labels ────────────────────────────────────────────────────────────────────

const KIND_LABELS: Record<CorrectionKind, string> = {
  missing_time: 'Fehlende Zeit',
  wrong_time: 'Falsche Zeit',
  wrong_assignment: 'Falscher Einsatz',
  other: 'Sonstiges',
}

const STATUS_CONFIG: Record<
  CorrectionStatus,
  { label: string; bg: string; text: string }
> = {
  open: { label: 'Offen', bg: 'bg-amber-50', text: 'text-amber-600' },
  in_review: { label: 'In Prüfung', bg: 'bg-blue-50', text: 'text-blue-600' },
  resolved: { label: 'Erledigt', bg: 'bg-emerald-50', text: 'text-emerald-700' },
  rejected: { label: 'Abgelehnt', bg: 'bg-slate-100', text: 'text-slate-500' },
}

// ── Error helper ──────────────────────────────────────────────────────────────

function buildApprovalErrorMessage(err: unknown): string {
  if (err instanceof RbacError) return 'Du bist nicht berechtigt, diese Korrektur zu bearbeiten.'
  if (err instanceof CorrectionWorkflowError) {
    if (err.code === 'correction_owner_note_required') return 'Bitte gib eine Begründung ein.'
    if (err.code === 'correction_state_terminal') return 'Diese Korrektur ist bereits abgeschlossen.'
    if (err.code === 'correction_not_found') return 'Korrektur nicht gefunden.'
  }
  return 'Speichern fehlgeschlagen. Bitte erneut versuchen.'
}

// ── Field component ───────────────────────────────────────────────────────────

function Field({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-[14px] bg-slate-50 px-3.5 py-3 ring-1 ring-slate-100">
      <div className="text-[10px] font-semibold uppercase tracking-[0.14em] text-slate-400">
        {label}
      </div>
      <div className="mt-0.5 text-[13px] text-slate-700">{value}</div>
    </div>
  )
}

// ── Screen ────────────────────────────────────────────────────────────────────

export default function CraftsmanKorrekturDetailScreen() {
  const { id } = useParams<{ id: string }>()
  const goBack = useSmartBack('/craftsman/korrekturen')
  const [searchParams, setSearchParams] = useSearchParams()
  const { requests } = useCorrections()

  const request = requests.find((r) => r.id === id)

  const [ownerNote, setOwnerNote] = useState(request?.ownerNote ?? '')
  const [isSaving, setIsSaving] = useState(false)
  const [saveError, setSaveError] = useState<string | null>(null)
  const [saved, setSaved] = useState(false)

  // Block A · Push-Action Sheet-Mount via ?action=approve|reject.
  // Dispatcher (Layer 2) hat schon Schema/Expiry/Role/Idempotenz validiert.
  // Dieser Screen mountet nur den UI-Layer + Workflow-Aufruf nach explizitem
  // User-Confirm im Sheet. URL-Param wird beim Schließen gestrippt, damit ein
  // Reload nicht das Sheet erneut öffnet.
  const sheetMode = searchParams.get('action')
  const showApproveSheet = sheetMode === 'approve' && !!request
  const showRejectSheet = sheetMode === 'reject' && !!request
  const [pushNote, setPushNote] = useState('')
  const [pushSubmitting, setPushSubmitting] = useState(false)
  const [pushError, setPushError] = useState<string | null>(null)
  const isTerminal = request?.status === 'resolved' || request?.status === 'rejected'
  const trimmedNote = ownerNote.trim()

  function clearActionParam() {
    const next = new URLSearchParams(searchParams)
    next.delete('action')
    setSearchParams(next, { replace: true })
  }

  async function handlePushApprove() {
    if (!request) return
    setPushSubmitting(true)
    setPushError(null)
    try {
      await approveCorrectionWorkflow(request.id, undefined)
      await emitSuccessNotif({
        entityType: 'correction',
        entityId: request.id,
        action: 'APPROVE',
      })
      clearActionParam()
    } catch (err) {
      setPushError(buildApprovalErrorMessage(err))
    } finally {
      setPushSubmitting(false)
    }
  }

  async function handlePushReject() {
    if (!request) return
    setPushSubmitting(true)
    setPushError(null)
    try {
      await rejectCorrectionWorkflow(request.id, pushNote.trim())
      await emitSuccessNotif({
        entityType: 'correction',
        entityId: request.id,
        action: 'REJECT',
      })
      clearActionParam()
    } catch (err) {
      setPushError(buildApprovalErrorMessage(err))
    } finally {
      setPushSubmitting(false)
    }
  }

  // Reset Push-Sheet-State beim Param-Wechsel (z.B. von ?action=approve →
  // ?action=reject ohne Reload).
  useEffect(() => {
    setPushNote('')
    setPushError(null)
    setPushSubmitting(false)
  }, [sheetMode])

  if (!request) {
    return (
      <AppShell active="verwaltung" noSafeTop>
        <div className="px-4 pt-[max(56px,env(safe-area-inset-top))] pb-12">
          <div className="mx-auto w-full max-w-[420px]">
            <div className="flex items-center gap-3 mb-6">
              <button
                type="button"
                onClick={goBack}
                className="h-9 w-9 shrink-0 rounded-full bg-slate-100 flex items-center justify-center"
                aria-label="Zurück"
              >
                <ArrowLeft size={16} strokeWidth={2} className="text-slate-600" />
              </button>
            </div>
            <div className="rounded-[24px] bg-white p-5 ring-1 ring-slate-200/70">
              <p className="text-[13px] text-slate-400">Korrektur nicht gefunden.</p>
            </div>
          </div>
        </div>
      </AppShell>
    )
  }

  const teamMembers = getTeamMembers()
  const workerName =
    teamMembers.find((m) => m.id === request.workerTeamMemberId)?.name ??
    request.workerTeamMemberId

  const statusCfg = STATUS_CONFIG[request.status]
  const dateLabel = request.requestedDate
    ? new Date(request.requestedDate + 'T12:00:00').toLocaleDateString('de-DE', {
        weekday: 'long',
        day: 'numeric',
        month: 'long',
        year: 'numeric',
      })
    : null
  const submittedLabel = new Date(request.createdAt).toLocaleDateString('de-DE', {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
  })

  const canApprove = !isTerminal && !isSaving
  const canReject = !isTerminal && !isSaving && trimmedNote.length > 0

  async function handleApprove() {
    if (!request || !canApprove) return
    setIsSaving(true)
    setSaveError(null)
    setSaved(false)
    try {
      await approveCorrectionWorkflow(
        request.id,
        trimmedNote.length > 0 ? { ownerNote: trimmedNote } : undefined,
      )
      setSaved(true)
    } catch (err) {
      setSaveError(buildApprovalErrorMessage(err))
    } finally {
      setIsSaving(false)
    }
  }

  async function handleReject() {
    if (!request || !canReject) return
    setIsSaving(true)
    setSaveError(null)
    setSaved(false)
    try {
      await rejectCorrectionWorkflow(request.id, trimmedNote)
      setSaved(true)
    } catch (err) {
      setSaveError(buildApprovalErrorMessage(err))
    } finally {
      setIsSaving(false)
    }
  }

  return (
    <AppShell active="verwaltung" noSafeTop>
      <div className="px-4 pt-[max(56px,env(safe-area-inset-top))] pb-12">
        <div className="mx-auto w-full max-w-[420px] space-y-5">

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
                Detail
              </h1>
            </div>
          </div>

          {/* Current status + submitted */}
          <div className={`rounded-[18px] px-4 py-3 flex items-center gap-3 ${statusCfg.bg}`}>
            <span className={`text-[13px] font-semibold ${statusCfg.text}`}>
              {statusCfg.label}
            </span>
            <span className="ml-auto text-[11px] text-slate-400">
              {submittedLabel}
            </span>
          </div>

          {/* Auto-Apply-Badge (Block 7.2.7b) — nur bei resolved */}
          <CorrectionApplyBadge request={request} />

          {/* Request details */}
          <div className="space-y-3">
            <Field label="Mitarbeiter" value={workerName} />
            <Field label="Art" value={KIND_LABELS[request.kind]} />
            {dateLabel && <Field label="Datum" value={dateLabel} />}
            <div className="rounded-[14px] bg-slate-50 px-3.5 py-3 ring-1 ring-slate-100">
              <div className="text-[10px] font-semibold uppercase tracking-[0.14em] text-slate-400">
                Beschreibung
              </div>
              <p className="mt-1 text-[13px] text-slate-700 whitespace-pre-wrap">
                {request.description}
              </p>
            </div>
          </div>

          {/* Strukturierte Felder (Block 7.2.3) — nur wenn vorhanden */}
          {(request.field || request.currentValue || request.proposedValue || request.reason) && (
            <div data-testid="correction-structured-fields" className="space-y-2">
              {request.field && <Field label="Was" value={request.field} />}
              {request.currentValue && (
                <div className="rounded-[14px] bg-red-50 border border-red-200 px-3.5 py-3">
                  <div className="text-[10px] font-semibold uppercase tracking-[0.14em] text-red-500">
                    Aktuell
                  </div>
                  <div className="mt-0.5 text-[13px] font-semibold text-red-700">
                    {request.currentValue}
                  </div>
                </div>
              )}
              {request.proposedValue && (
                <div className="rounded-[14px] bg-emerald-50 border border-emerald-200 px-3.5 py-3">
                  <div className="text-[10px] font-semibold uppercase tracking-[0.14em] text-emerald-600">
                    Vorschlag
                  </div>
                  <div className="mt-0.5 text-[13px] font-semibold text-emerald-700">
                    {request.proposedValue}
                  </div>
                </div>
              )}
              {request.reason && <Field label="Begründung" value={request.reason} />}
            </div>
          )}

          {/* Review section */}
          <div className="rounded-[24px] bg-white p-5 ring-1 ring-slate-200/70 shadow-[0_14px_32px_-20px_rgba(2,6,23,0.14)] space-y-4">
            <div className="text-[11px] font-semibold uppercase tracking-[0.18em] text-slate-400">
              Bearbeitung
            </div>

            {/* Owner note (optional bei Approve, Pflicht bei Reject) */}
            <div>
              <label
                htmlFor="owner-note"
                className="block text-[11px] font-semibold uppercase tracking-[0.12em] text-slate-400 mb-2"
              >
                Notiz {isTerminal ? null : (
                  <span className="font-normal normal-case tracking-normal text-slate-300">
                    (Pflicht bei Ablehnung)
                  </span>
                )}
              </label>
              <textarea
                id="owner-note"
                value={ownerNote}
                onChange={(e) => { setOwnerNote(e.target.value); setSaved(false) }}
                placeholder="Interne Anmerkung oder Rückmeldung an den Mitarbeiter…"
                rows={3}
                disabled={isTerminal}
                className="w-full resize-none rounded-[14px] bg-slate-50 px-3.5 py-3 text-[13px] text-slate-800 ring-1 ring-slate-200/70 outline-none focus:ring-slate-400 transition-all placeholder:text-slate-300 disabled:opacity-60"
              />
            </div>

            {/* Error / success */}
            {saveError && (
              <p className="text-[12px] text-red-500">{saveError}</p>
            )}
            {saved && !saveError && (
              <p className="text-[12px] text-emerald-600">Gespeichert.</p>
            )}

            {/* Approve / Reject CTAs (Block 7.2.3) */}
            {!isTerminal && (
              <div className="grid grid-cols-2 gap-2">
                <button
                  type="button"
                  onClick={handleApprove}
                  disabled={!canApprove}
                  className={`rounded-[14px] py-3 text-[13px] font-semibold transition-colors ${
                    canApprove
                      ? 'bg-emerald-600 text-white active:bg-emerald-700'
                      : 'bg-slate-100 text-slate-300 cursor-not-allowed'
                  }`}
                >
                  {isSaving ? 'Wird übernommen…' : 'Übernehmen'}
                </button>
                <button
                  type="button"
                  onClick={handleReject}
                  disabled={!canReject}
                  className={`rounded-[14px] py-3 text-[13px] font-semibold transition-colors ${
                    canReject
                      ? 'bg-red-50 text-red-700 ring-1 ring-red-200 active:bg-red-100'
                      : 'bg-slate-100 text-slate-300 cursor-not-allowed'
                  }`}
                >
                  Ablehnen
                </button>
              </div>
            )}
          </div>

        </div>
      </div>

      {request && (
        <>
          <CorrectionApproveSheet
            open={showApproveSheet}
            correction={request}
            workerName={workerName}
            isSubmitting={pushSubmitting}
            errorMessage={pushError}
            onConfirm={handlePushApprove}
            onCancel={clearActionParam}
          />
          <CorrectionRejectSheet
            open={showRejectSheet}
            correction={request}
            workerName={workerName}
            note={pushNote}
            isSubmitting={pushSubmitting}
            errorMessage={pushError}
            onNoteChange={setPushNote}
            onConfirm={handlePushReject}
            onCancel={clearActionParam}
          />
        </>
      )}
    </AppShell>
  )
}
