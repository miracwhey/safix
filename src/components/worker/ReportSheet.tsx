import { useEffect, useRef, useState } from 'react'

import BottomSheet from '../ui/BottomSheet'
import type { Job } from '../../lib/jobs/types'
import type { SessionState } from '../../lib/session'
import type { JobReport } from '../../lib/worker/dokuTypes'
import {
  addJobReportWorkflow,
  updateJobReportWorkflow,
} from '../../lib/worker/workerDokuWorkflow'
import { logError } from '../../lib/observability'

const MAX_LENGTH = 10000
const MIN_LENGTH = 1

export interface ReportSheetProps {
  open: boolean
  onClose: () => void
  job: Job
  session: SessionState
  /** Callback nach erfolgreichem Submit. Caller hängt die neue Row in die
   *  lokale Liste, damit Modul-Status sofort flippt. */
  onSubmitted: (report: JobReport) => void
  /**
   * Block FU-A · Wenn gesetzt, schaltet das Sheet in Edit-Mode:
   * Body-Init aus dem Report, Submit-Button heißt „Aktualisieren",
   * Workflow ruft `updateJobReportWorkflow`. Für RBAC-pre-Check + 24 h-
   * Window. Caller (WorkerDokuDetailScreen) prüft schon ob der Report
   * editierbar ist, bevor er das Sheet öffnet — Sheet selbst doppelt-
   * prüft nur via Workflow.
   */
  existingReport?: JobReport
  /** Callback nach erfolgreichem Update — analog zu onSubmitted, aber
   *  Caller ersetzt die Row in der lokalen Liste statt prepend. */
  onUpdated?: (report: JobReport) => void
}

/**
 * ReportSheet · Block C.3
 *
 * BottomSheet mit free-form Textarea. Submit triggert
 * addJobReportWorkflow → server-side INSERT, danach onSubmitted +
 * automatisches Schließen.
 *
 * Pflicht-Validierung client-seitig: nicht-leer, max 10000 Zeichen
 * (spiegelt DB-CHECK). Sofortiges Form-Feedback statt 23514 nach
 * Round-Trip.
 *
 * Kein Discard-Confirm — BottomSheet-Wrapper closet on backdrop +
 * Escape. Form-State wird beim Schließen verworfen, was der Worker
 * erwarten kann (kein localStorage-Draft im MVP).
 */
export default function ReportSheet({
  open,
  onClose,
  job,
  session,
  onSubmitted,
  existingReport,
  onUpdated,
}: ReportSheetProps) {
  const [body, setBody] = useState('')
  const [isSubmitting, setIsSubmitting] = useState(false)
  const [errorMessage, setErrorMessage] = useState<string | null>(null)
  // Ref-based atomic lock prevents double-submit within the same React render
  // window before setIsSubmitting(true) flushes (state update is async, ref is sync).
  const submitLockRef = useRef(false)

  const isEditMode = existingReport !== undefined

  // Reset form whenever the sheet (re-)opens. Im Edit-Mode initialisieren
  // wir mit dem bestehenden Bericht-Body; sonst leerer Draft.
  useEffect(() => {
    if (open) {
      setBody(existingReport?.body ?? '')
      setErrorMessage(null)
    }
  }, [open, existingReport])

  const trimmedLength = body.trim().length
  const isValid = trimmedLength >= MIN_LENGTH && body.length <= MAX_LENGTH
  const charCount = body.length
  const isOverLimit = charCount > MAX_LENGTH

  async function handleSubmit() {
    if (!isValid || isSubmitting || submitLockRef.current) return
    submitLockRef.current = true
    setErrorMessage(null)
    setIsSubmitting(true)
    try {
      if (isEditMode && existingReport) {
        const updated = await updateJobReportWorkflow(
          { job, report: existingReport, body },
          session,
        )
        onUpdated?.(updated)
      } else {
        const report = await addJobReportWorkflow({ job, body }, session)
        onSubmitted(report)
      }
      onClose()
    } catch (err) {
      const message =
        err instanceof Error
          ? err.message
          : 'Bericht konnte nicht gespeichert werden.'
      setErrorMessage(message)
      logError(
        'worker.report_submit.failed',
        err instanceof Error ? err : undefined,
        { jobId: job.id, mode: isEditMode ? 'update' : 'create' },
      )
    } finally {
      submitLockRef.current = false
      setIsSubmitting(false)
    }
  }

  const sheetTitle = isEditMode ? 'Bericht bearbeiten' : 'Bericht erfassen'
  const sheetDescription = isEditMode
    ? 'Du kannst deinen eigenen Bericht innerhalb von 24 Stunden anpassen.'
    : 'Was wurde gemacht? Beobachtungen, Materialien, offene Punkte.'
  const submitLabel = isEditMode
    ? isSubmitting
      ? 'Wird aktualisiert…'
      : 'Aktualisieren'
    : isSubmitting
      ? 'Wird gespeichert…'
      : 'Bericht speichern'

  return (
    <BottomSheet
      open={open}
      onClose={onClose}
      title={sheetTitle}
      description={sheetDescription}
    >
      <div className="mt-4 space-y-3">
        <textarea
          data-testid="worker-doku-report-body"
          value={body}
          onChange={(e) => setBody(e.target.value)}
          rows={6}
          placeholder="Bauteil X getauscht; Funktion verifiziert. Kunde war anwesend."
          className="w-full resize-none rounded-[16px] border border-slate-200 bg-white px-4 py-3 text-[14px] leading-relaxed text-slate-800 placeholder:text-slate-400 focus:border-blue-400 focus:outline-none focus:ring-2 focus:ring-blue-100"
          disabled={isSubmitting}
        />
        <div className="flex items-center justify-between text-[11px]">
          <span className={isOverLimit ? 'text-red-600' : 'text-slate-400'}>
            {charCount} / {MAX_LENGTH} Zeichen
          </span>
        </div>

        {errorMessage && (
          <div
            role="alert"
            data-testid="worker-doku-report-error"
            className="rounded-[12px] bg-amber-50 px-3 py-2 text-[12px] text-amber-800 ring-1 ring-amber-100"
          >
            {errorMessage}
          </div>
        )}

        <div className="flex flex-col gap-2 pt-2">
          <button
            type="button"
            onClick={handleSubmit}
            disabled={!isValid || isSubmitting}
            data-testid="worker-doku-report-submit"
            className="h-12 rounded-[14px] bg-blue-600 text-[15px] font-semibold text-white shadow-[0_8px_22px_-12px_rgba(37,99,235,0.55)] active:scale-[0.99] disabled:opacity-60 disabled:active:scale-100"
          >
            {submitLabel}
          </button>
          <button
            type="button"
            onClick={onClose}
            disabled={isSubmitting}
            data-testid="worker-doku-report-cancel"
            className="h-12 rounded-[14px] bg-slate-100 text-[15px] font-medium text-slate-700 disabled:opacity-60"
          >
            Abbrechen
          </button>
        </div>
      </div>
    </BottomSheet>
  )
}
