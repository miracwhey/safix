import { useState } from 'react'
import { Camera } from 'lucide-react'

import type { Job } from '../../lib/jobs/types'
import type { SessionState } from '../../lib/session'
import type { JobPhoto } from '../../lib/worker/dokuTypes'
import { captureJobPhotoWorkflow } from '../../lib/worker/workerDokuWorkflow'
import { useMediaPicker } from '../../lib/native/useMediaPicker'
import { logError } from '../../lib/observability'

export interface PhotoCaptureCTAProps {
  job: Job
  session: SessionState
  /** Wird nach erfolgreichem Upload mit der erzeugten Domain-Row aufgerufen.
   *  Caller hängt das in seine lokale Liste, damit Modul-Status sofort flippt
   *  ohne Re-Fetch. */
  onUploaded: (photo: JobPhoto) => void
}

/**
 * PhotoCaptureCTA · Block C.3
 *
 * Aktion-CTA für Worker im Doku-Detail. Tap → Camera (oder Mediathek auf
 * iOS Prompt) → Pre-Upload-Pipeline → Storage + DB-INSERT.
 *
 * Visuell: full-width primary button mit Camera-Icon. Während Upload
 * disabled + Spinner-Label „Wird hochgeladen…". Bei Fehler wird die
 * Service-Fehlermeldung 1:1 angezeigt (kein silent drop) — bei Network-
 * Fail informiert die Service-Layer „wird hochgeladen, sobald die
 * Verbindung wieder steht" (= Foto in Offline-Queue).
 */
export default function PhotoCaptureCTA({ job, session, onUploaded }: PhotoCaptureCTAProps) {
  const { pickMedia, inputProps } = useMediaPicker()
  const [isBusy, setIsBusy] = useState(false)
  const [errorMessage, setErrorMessage] = useState<string | null>(null)

  async function handleTap() {
    setErrorMessage(null)
    setIsBusy(true)
    try {
      const file = await pickMedia({ kind: 'image', source: 'camera' })
      if (!file) {
        // User-Cancel → kein Fehler, kein Effekt
        return
      }
      const result = await captureJobPhotoWorkflow(
        { job, file },
        session,
      )
      onUploaded(result.photo)
    } catch (err) {
      const message =
        err instanceof Error
          ? err.message
          : 'Foto konnte nicht hochgeladen werden.'
      setErrorMessage(message)
      logError(
        'worker.photo_capture.cta_failed',
        err instanceof Error ? err : undefined,
        { jobId: job.id },
      )
    } finally {
      setIsBusy(false)
    }
  }

  return (
    <div className="space-y-2">
      <button
        type="button"
        onClick={handleTap}
        disabled={isBusy}
        data-testid="worker-doku-photo-cta"
        className="flex w-full items-center justify-center gap-2 rounded-[14px] bg-blue-600 py-3 text-[14px] font-semibold text-white shadow-[0_8px_22px_-12px_rgba(37,99,235,0.55)] active:scale-[0.99] disabled:opacity-60 disabled:active:scale-100"
      >
        <Camera size={18} strokeWidth={2} />
        {isBusy ? 'Wird hochgeladen…' : 'Foto hinzufügen'}
      </button>
      {errorMessage && (
        <div
          role="alert"
          data-testid="worker-doku-photo-error"
          className="rounded-[12px] bg-amber-50 px-3 py-2 text-[12px] text-amber-800 ring-1 ring-amber-100"
        >
          {errorMessage}
        </div>
      )}
      {/* Hidden file input for non-native fallback (browser/PWA). Hook drives lifecycle. */}
      <input {...inputProps} />
    </div>
  )
}
