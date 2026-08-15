/**
 * WorkerSickReportSheet — Block 3 + Sick-Note Upload.
 *
 * Modal sheet a Worker uses to report a sick absence. Defaults: type='sick',
 * startDate=today, endDate=today (single-day). Optional: free-text reason
 * note + Attest-Upload (Foto oder PDF).
 *
 * Upload flow:
 *   1. Worker picks a file (image/* or PDF) via native file picker.
 *   2. On submit, the absence is inserted first (gives us the absenceId).
 *   3. Then the file is uploaded via submitSickNoteWorkflow.
 *   4. Upload failure is shown as a non-blocking warning — the absence itself
 *      already landed and the worker can re-upload from the status card.
 */

import { useRef, useState } from 'react'
import { FileText, Paperclip, X } from 'lucide-react'

import Spinner from '../system/Spinner'
import { reportAbsenceWorkflow, submitSickNoteWorkflow } from '../../lib/workflow/absenceWorkflow'

type Props = {
  open: boolean
  memberId: string
  providerId: string
  /** YYYY-MM-DD, used to pre-fill the start date. */
  todayKey: string
  onClose: () => void
  onReported: () => void
}

export function WorkerSickReportSheet({
  open,
  memberId,
  providerId,
  todayKey,
  onClose,
  onReported,
}: Props) {
  const [endDate, setEndDate] = useState<string>(todayKey)
  const [reasonNote, setReasonNote] = useState<string>('')
  const [selectedFile, setSelectedFile] = useState<File | null>(null)
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [uploadWarning, setUploadWarning] = useState<string | null>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)

  if (!open) return null

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0] ?? null
    setSelectedFile(file)
    setUploadWarning(null)
  }

  const handleRemoveFile = () => {
    setSelectedFile(null)
    if (fileInputRef.current) fileInputRef.current.value = ''
  }

  const handleSubmit = async () => {
    setSubmitting(true)
    setError(null)
    setUploadWarning(null)
    try {
      const result = await reportAbsenceWorkflow(memberId, providerId, {
        type: 'sick',
        startDate: todayKey,
        endDate: endDate < todayKey ? todayKey : endDate,
        reasonNote: reasonNote.trim() || null,
      })

      // Upload the document after the absence row exists (need absenceId for path).
      if (selectedFile) {
        try {
          await submitSickNoteWorkflow(result.absence.id, selectedFile)
        } catch {
          // Non-blocking: absence is already recorded. Worker can re-upload
          // from the status card via "Attest nachreichen".
          setUploadWarning('Krankmeldung gesendet, aber Attest-Upload fehlgeschlagen. Bitte über "Attest nachreichen" erneut versuchen.')
        }
      }

      onReported()
      setEndDate(todayKey)
      setReasonNote('')
      setSelectedFile(null)
      if (fileInputRef.current) fileInputRef.current.value = ''
      if (!uploadWarning) onClose()
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Unbekannter Fehler'
      setError(msg)
    } finally {
      setSubmitting(false)
    }
  }

  const fileSizeLabel = selectedFile
    ? selectedFile.size > 1_048_576
      ? `${(selectedFile.size / 1_048_576).toFixed(1)} MB`
      : `${Math.round(selectedFile.size / 1024)} KB`
    : null

  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/50">
      <div className="w-full max-w-[420px] rounded-t-3xl bg-white p-5 pb-[max(20px,env(safe-area-inset-bottom))]">
        <div className="flex items-start justify-between">
          <div>
            <p className="text-[12px] font-semibold uppercase tracking-[0.14em] text-amber-600">
              Krank
            </p>
            <h2 className="mt-1 text-[20px] font-semibold text-slate-900">Krank melden</h2>
          </div>
          <button
            type="button"
            onClick={onClose}
            disabled={submitting}
            className="rounded-full p-1.5 text-slate-400 hover:bg-slate-100 disabled:opacity-50"
            aria-label="Schließen"
          >
            <X className="h-5 w-5" />
          </button>
        </div>

        <div className="mt-4 space-y-4">
          <div>
            <label className="text-[12px] font-medium text-slate-600" htmlFor="sick-end-date">
              Bis (optional)
            </label>
            <input
              id="sick-end-date"
              type="date"
              value={endDate}
              min={todayKey}
              onChange={(e) => setEndDate(e.target.value)}
              disabled={submitting}
              className="mt-1 w-full rounded-2xl border border-slate-200 bg-white px-3 py-2 text-[14px] text-slate-900 focus:border-amber-500 focus:outline-none"
            />
            <p className="mt-1 text-[11px] text-slate-400">
              Standard: nur heute. Bis-Datum optional setzen, wenn du es schon weißt.
            </p>
          </div>

          <div>
            <label className="text-[12px] font-medium text-slate-600" htmlFor="sick-reason">
              Grund (optional)
            </label>
            <input
              id="sick-reason"
              type="text"
              value={reasonNote}
              onChange={(e) => setReasonNote(e.target.value)}
              disabled={submitting}
              placeholder='z.B. "Erkältung"'
              className="mt-1 w-full rounded-2xl border border-slate-200 bg-white px-3 py-2 text-[14px] text-slate-900 focus:border-amber-500 focus:outline-none"
              maxLength={140}
            />
          </div>

          {/* Attest-Upload */}
          <div>
            <p className="text-[12px] font-medium text-slate-600">
              Krankmeldung hochladen (optional)
            </p>
            {selectedFile ? (
              <div className="mt-1 flex items-center gap-2 rounded-2xl border border-amber-200 bg-amber-50 px-3 py-2.5">
                <FileText className="h-4 w-4 shrink-0 text-amber-600" />
                <div className="min-w-0 flex-1">
                  <p className="truncate text-[13px] font-medium text-amber-900">
                    {selectedFile.name}
                  </p>
                  {fileSizeLabel && (
                    <p className="text-[11px] text-amber-600">{fileSizeLabel}</p>
                  )}
                </div>
                <button
                  type="button"
                  onClick={handleRemoveFile}
                  disabled={submitting}
                  className="shrink-0 rounded-full p-0.5 text-amber-500 hover:text-amber-700 disabled:opacity-50"
                  aria-label="Datei entfernen"
                >
                  <X className="h-4 w-4" />
                </button>
              </div>
            ) : (
              <button
                type="button"
                onClick={() => fileInputRef.current?.click()}
                disabled={submitting}
                className="mt-1 flex w-full items-center gap-2 rounded-2xl border border-dashed border-slate-300 bg-slate-50 px-3 py-3 text-left text-[13px] text-slate-500 hover:border-amber-300 hover:bg-amber-50 hover:text-amber-700 disabled:opacity-50"
              >
                <Paperclip className="h-4 w-4 shrink-0" />
                <span>Foto oder PDF auswählen</span>
              </button>
            )}
            <input
              ref={fileInputRef}
              type="file"
              accept="image/*,.pdf"
              className="sr-only"
              onChange={handleFileChange}
              disabled={submitting}
            />
            <p className="mt-1 text-[11px] text-slate-400">
              Foto der AU-Bescheinigung oder PDF. Max. 10 MB. Auch später nachreichbar.
            </p>
          </div>

          {error && (
            <p className="rounded-xl bg-red-50 px-3 py-2 text-[12px] text-red-700">{error}</p>
          )}
          {uploadWarning && (
            <div className="rounded-xl bg-amber-50 px-3 py-2">
              <p className="text-[12px] text-amber-800">{uploadWarning}</p>
              <button
                type="button"
                onClick={onClose}
                className="mt-1.5 text-[12px] font-semibold text-amber-700 underline"
              >
                Schließen
              </button>
            </div>
          )}
        </div>

        {!uploadWarning && (
          <div className="mt-5 flex gap-2">
            <button
              type="button"
              onClick={onClose}
              disabled={submitting}
              className="flex-1 rounded-2xl border border-slate-200 bg-white px-4 py-2.5 text-[14px] font-medium text-slate-700 hover:bg-slate-50 disabled:opacity-50"
            >
              Abbrechen
            </button>
            <button
              type="button"
              onClick={handleSubmit}
              disabled={submitting}
              className="flex flex-1 items-center justify-center gap-2 rounded-2xl bg-amber-500 px-4 py-2.5 text-[14px] font-semibold text-white hover:bg-amber-600 disabled:opacity-50"
            >
              {submitting && <Spinner size="sm" tone="current" inButton />}
              <span>Melden</span>
            </button>
          </div>
        )}
      </div>
    </div>
  )
}
