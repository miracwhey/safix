/**
 * WorkerSickStatusCard — Block 3 + Sick-Note Upload.
 *
 * Sits underneath the Worker time-tracking hero. Three states:
 *
 *   1. Not sick → compact "Krank melden" CTA (amber accent).
 *   2. Sick, Attest angefordert, noch nicht hochgeladen →
 *      "Du bist krankgemeldet" + "Attest nachreichen" CTA (file picker).
 *   3. Sick → "Du bist krankgemeldet (Tag N) — Zurücknehmen".
 *      If Attest already uploaded: shows green confirmation badge.
 */

import { useRef, useState } from 'react'
import { CheckCircle2, FileText, Paperclip, Stethoscope } from 'lucide-react'

import Spinner from '../system/Spinner'
import { cancelAbsenceWorkflow, submitSickNoteWorkflow } from '../../lib/workflow/absenceWorkflow'

type Props = {
  activeSick: {
    absenceId: string
    dayCount: number
    sickNoteRequested: boolean
    sickNoteUrl: string | null
  } | null
  onReportClick: () => void
  onCancelled?: () => void
}

export function WorkerSickStatusCard({ activeSick, onReportClick, onCancelled }: Props) {
  const [cancelling, setCancelling] = useState(false)
  const [uploading, setUploading] = useState(false)
  const [cancelError, setCancelError] = useState<string | null>(null)
  const [uploadError, setUploadError] = useState<string | null>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)

  if (activeSick) {
    const handleCancel = async () => {
      setCancelling(true)
      setCancelError(null)
      try {
        await cancelAbsenceWorkflow(activeSick.absenceId)
        onCancelled?.()
      } catch (err) {
        setCancelError(err instanceof Error ? err.message : 'Unbekannter Fehler')
      } finally {
        setCancelling(false)
      }
    }

    const handleFileChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
      const file = e.target.files?.[0]
      if (!file) return
      setUploading(true)
      setUploadError(null)
      try {
        await submitSickNoteWorkflow(activeSick.absenceId, file)
      } catch (err) {
        setUploadError(err instanceof Error ? err.message : 'Upload fehlgeschlagen')
      } finally {
        setUploading(false)
        if (fileInputRef.current) fileInputRef.current.value = ''
      }
    }

    const needsAttest = activeSick.sickNoteRequested && !activeSick.sickNoteUrl
    const attestSubmitted = !!activeSick.sickNoteUrl

    return (
      <div className="rounded-3xl bg-amber-50 p-4 ring-1 ring-amber-200">
        <div className="flex items-center gap-3">
          <div className="flex h-10 w-10 items-center justify-center rounded-2xl bg-amber-100 text-amber-700">
            <Stethoscope className="h-5 w-5" />
          </div>
          <div className="flex-1 min-w-0">
            <p className="text-[14px] font-semibold text-amber-900">Du bist krankgemeldet</p>
            <p className="text-[12px] text-amber-700">Tag {activeSick.dayCount}</p>
          </div>
          <button
            type="button"
            onClick={handleCancel}
            disabled={cancelling}
            className="shrink-0 flex items-center gap-2 rounded-2xl border border-amber-300 bg-white px-3 py-1.5 text-[12px] font-medium text-amber-700 hover:bg-amber-100 disabled:opacity-50"
          >
            {cancelling && <Spinner size="sm" tone="current" inButton />}
            <span>Zurücknehmen</span>
          </button>
        </div>

        {/* Attest nachreichen — shown when owner requested but not yet submitted */}
        {needsAttest && (
          <div className="mt-3 rounded-2xl border border-amber-200 bg-white p-3">
            <div className="flex items-start gap-2">
              <FileText className="mt-0.5 h-4 w-4 shrink-0 text-amber-500" />
              <div className="flex-1 min-w-0">
                <p className="text-[13px] font-semibold text-amber-900">Attest angefordert</p>
                <p className="text-[11px] text-amber-600 mt-0.5">
                  Dein Chef hat eine AU-Bescheinigung angefragt.
                </p>
              </div>
            </div>
            <button
              type="button"
              onClick={() => fileInputRef.current?.click()}
              disabled={uploading}
              className="mt-2.5 flex w-full items-center justify-center gap-2 rounded-xl bg-amber-500 px-3 py-2 text-[13px] font-semibold text-white hover:bg-amber-600 disabled:opacity-50"
            >
              {uploading ? (
                <Spinner size="sm" tone="current" inButton />
              ) : (
                <Paperclip className="h-4 w-4" />
              )}
              <span>{uploading ? 'Wird hochgeladen…' : 'Attest hochladen'}</span>
            </button>
            <input
              ref={fileInputRef}
              type="file"
              accept="image/*,.pdf"
              className="sr-only"
              onChange={handleFileChange}
              disabled={uploading}
            />
            {uploadError && (
              <p className="mt-2 text-[11px] text-red-700">{uploadError}</p>
            )}
          </div>
        )}

        {/* Attest already submitted */}
        {attestSubmitted && (
          <div className="mt-2 flex items-center gap-1.5">
            <CheckCircle2 className="h-3.5 w-3.5 text-green-600" />
            <p className="text-[11px] font-medium text-green-700">Attest eingereicht</p>
          </div>
        )}

        {cancelError && (
          <p className="mt-2 text-[12px] text-red-700">{cancelError}</p>
        )}
      </div>
    )
  }

  return (
    <button
      type="button"
      onClick={onReportClick}
      className="flex w-full items-center gap-3 rounded-2xl border border-amber-200 bg-amber-50/60 px-4 py-2.5 text-left transition-colors hover:bg-amber-50"
    >
      <div className="flex h-8 w-8 items-center justify-center rounded-xl bg-amber-100 text-amber-700">
        <Stethoscope className="h-4 w-4" />
      </div>
      <div className="flex-1">
        <p className="text-[13px] font-medium text-amber-900">Krank melden</p>
        <p className="text-[11px] text-amber-600">Schnell-Aktion · meldet Owner automatisch</p>
      </div>
    </button>
  )
}
