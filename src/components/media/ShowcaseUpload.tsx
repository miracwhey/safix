import { useRef, useState, useCallback } from 'react'
import InlineFeedback from '../system/InlineFeedback'
import Spinner from '../system/Spinner'
import { useAsyncAction } from '../../hooks/useAsyncAction'
import { uploadShowcaseMedia } from '../../lib/providerMedia/showcaseUploadService'
import type { PersistedMediaRecord } from '../../lib/media/mediaUploadService'
import { useMediaPicker } from '../../lib/native/useMediaPicker'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type ShowcaseUploadProps = {
  /** providers.profile_id = auth.users.id */
  ownerUserId: string
  /** providers.id (DB-generated) */
  providerId: string
  /** Called after a successful upload with the new media record */
  onUploaded?: (record: PersistedMediaRecord) => void
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

/**
 * ShowcaseUpload — end-to-end provider showcase media upload widget.
 *
 * - Provides a button to open the native file picker.
 * - Accepts images (JPEG, PNG, WebP, GIF) and short videos (MP4, WebM, MOV).
 * - File size validation is enforced server-side by the media upload service.
 * - Displays a loading spinner during upload.
 * - Emits success / failure feedback via InlineFeedback.
 * - On success, calls the onUploaded callback with the persisted record.
 */
export default function ShowcaseUpload({
  ownerUserId,
  providerId,
  onUploaded,
}: ShowcaseUploadProps) {
  const pickedFileRef = useRef<File | null>(null)
  const [successMsg, setSuccessMsg] = useState<string | null>(null)
  const { pickMedia, inputProps } = useMediaPicker()

  const uploadAction = useCallback(async () => {
    const file = pickedFileRef.current
    pickedFileRef.current = null
    if (!file) return

    const result = await uploadShowcaseMedia({
      file,
      providerId,
      ownerUserId,
    })

    setSuccessMsg('Arbeitsprobe erfolgreich hochgeladen')
    onUploaded?.(result.record)
  }, [ownerUserId, providerId, onUploaded])

  const { execute, isLoading, error, clearError } = useAsyncAction(uploadAction)

  const handleButtonClick = useCallback(async () => {
    if (isLoading) return
    setSuccessMsg(null)
    clearError()
    const file = await pickMedia({ kind: 'image-or-video' })
    if (!file) return
    pickedFileRef.current = file
    void execute()
  }, [isLoading, clearError, pickMedia, execute])

  return (
    <div className="space-y-3">
      <button
        type="button"
        onClick={handleButtonClick}
        disabled={isLoading}
        className="flex w-full items-center justify-center gap-2 rounded-2xl bg-blue-50 px-4 py-3 text-[13px] font-semibold text-blue-600 ring-1 ring-blue-200/60 transition hover:bg-blue-100 active:scale-[0.98] disabled:opacity-50"
      >
        {isLoading ? (
          <>
            <Spinner size="sm" tone="current" inButton />
            Wird hochgeladen…
          </>
        ) : (
          <>
            <span className="text-[16px]">📸</span>
            Arbeitsprobe hinzufügen
          </>
        )}
      </button>

      {/* Hidden file input — images + videos via native picker on iOS. */}
      <input {...inputProps} />

      {/* Feedback */}
      {error ? (
        <InlineFeedback error={error} onDismiss={clearError} />
      ) : successMsg ? (
        <InlineFeedback
          success={successMsg}
          onDismiss={() => setSuccessMsg(null)}
        />
      ) : null}
    </div>
  )
}
