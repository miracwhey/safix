import { useEffect, useRef, useState, useCallback } from 'react'
import InlineFeedback from '../system/InlineFeedback'
import Spinner from '../system/Spinner'
import { useAsyncAction } from '../../hooks/useAsyncAction'
import type { AvatarUploadInput } from '../../lib/providerMedia/avatarUploadService'
import { uploadProviderAvatar } from '../../lib/providerMedia/avatarUploadService'
import { useMediaPicker } from '../../lib/native/useMediaPicker'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type AvatarUploadProps = {
  /** Current avatar URL (null = no avatar yet) */
  currentAvatarUrl: string | null | undefined
  /** Business/display name used for the alt text */
  displayName: string
  /** providers.profile_id = auth.users.id */
  ownerUserId: string
  /** providers.id (DB-generated) */
  providerId: string
  /** Called after a successful upload with the new public URL */
  onUploaded?: (publicUrl: string) => void
  /**
   * Called whenever the upload status changes — `message` is the latest
   * service error string, or `null` when the error has been cleared (e.g.
   * after a fresh attempt). The host is expected to render the message in
   * a location that fits its layout. Used by the `compact` variant, which
   * has no inline feedback area of its own.
   */
  onError?: (message: string | null) => void
  /**
   * Render mode.
   *  - `default`: 80px avatar + „Tippen zum Ändern"-Label + InlineFeedback below.
   *  - `compact`: 78px avatar only — no label, no inline feedback. Errors
   *    are forwarded to the host via `onError` so they remain visible to
   *    the user instead of being swallowed silently.
   */
  variant?: 'default' | 'compact'
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

/**
 * AvatarUpload — end-to-end provider avatar upload widget.
 *
 * - Shows the current avatar (or a placeholder).
 * - Clicking the overlay opens a native file picker (images only, ≤10 MB).
 * - Displays a loading spinner while uploading.
 * - Emits success / failure feedback via InlineFeedback.
 * - On success, immediately updates the displayed avatar from the persisted
 *   public URL (not a local blob preview) so the rendered state always
 *   reflects what is stored in the backend.
 */
export default function AvatarUpload({
  currentAvatarUrl,
  displayName,
  ownerUserId,
  providerId,
  onUploaded,
  onError,
  variant = 'default',
}: AvatarUploadProps) {
  const isCompact = variant === 'compact'
  const sizeClasses = isCompact ? 'h-[78px] w-[78px]' : 'h-20 w-20'
  const ringClasses = isCompact ? 'ring-2 ring-edge' : 'ring-2 ring-slate-200/70'
  const pickedFileRef = useRef<File | null>(null)
  const [displayedUrl, setDisplayedUrl] = useState<string | null | undefined>(currentAvatarUrl)
  const [successMsg, setSuccessMsg] = useState<string | null>(null)
  const { pickMedia, inputProps } = useMediaPicker()

  const uploadAction = useCallback(async () => {
    const file = pickedFileRef.current
    pickedFileRef.current = null
    if (!file) return

    const uploadInput: AvatarUploadInput = {
      file,
      ownerUserId,
      providerId,
    }

    const result = await uploadProviderAvatar(uploadInput)

    // Update displayed URL from persisted public URL (not local blob)
    setDisplayedUrl(result.publicUrl)
    setSuccessMsg('Profilbild erfolgreich aktualisiert')
    onUploaded?.(result.publicUrl)
  }, [ownerUserId, providerId, onUploaded])

  const { execute, isLoading, error, clearError } = useAsyncAction(uploadAction)

  // Forward error transitions to the host. The host owns the rendering
  // surface in compact mode (the InstaProfileHeader has no room for an
  // inline feedback strip under the avatar), so without this hook the
  // service error.message would be lost between hooks. We notify on every
  // change including null so the host can dismiss its own banner.
  useEffect(() => {
    onError?.(error)
  }, [error, onError])

  const handleButtonClick = useCallback(async () => {
    if (isLoading) return
    setSuccessMsg(null)
    clearError()
    const file = await pickMedia({ kind: 'image' })
    if (!file) return
    pickedFileRef.current = file
    void execute()
  }, [isLoading, clearError, pickMedia, execute])

  return (
    <div className={isCompact ? '' : 'flex flex-col items-center gap-3'}>
      {/* Avatar with upload overlay */}
      <button
        type="button"
        aria-label="Profilbild ändern"
        onClick={handleButtonClick}
        disabled={isLoading}
        className="relative group rounded-full focus:outline-none focus-visible:ring-2 focus-visible:ring-[#2563EB] focus-visible:ring-offset-2"
      >
        {/* Avatar image or placeholder */}
        {displayedUrl ? (
          <img
            src={displayedUrl}
            alt={displayName}
            className={`${sizeClasses} rounded-full object-cover ${ringClasses}`}
          />
        ) : (
          <div className={`${sizeClasses} ${ringClasses} rounded-full bg-[#E6F0FF] flex items-center justify-center text-[26px] shrink-0`}>
            🏢
          </div>
        )}

        {/* Hover / loading overlay */}
        <div
          className={[
            'absolute inset-0 rounded-full flex items-center justify-center transition-opacity',
            isLoading
              ? 'bg-black/40 opacity-100'
              : 'bg-black/0 group-hover:bg-black/30 opacity-0 group-hover:opacity-100',
          ].join(' ')}
          aria-hidden="true"
        >
          {isLoading ? (
            <Spinner size="md" tone="onDark" />
          ) : (
            /* Camera icon */
            <svg
              xmlns="http://www.w3.org/2000/svg"
              className="h-6 w-6 text-white"
              fill="none"
              viewBox="0 0 24 24"
              stroke="currentColor"
              strokeWidth={2}
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                d="M3 9a2 2 0 012-2h.93a2 2 0 001.664-.89l.812-1.22A2 2 0 0110.07 4h3.86a2 2 0 011.664.89l.812 1.22A2 2 0 0018.07 7H19a2 2 0 012 2v9a2 2 0 01-2 2H5a2 2 0 01-2-2V9z"
              />
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                d="M15 13a3 3 0 11-6 0 3 3 0 016 0z"
              />
            </svg>
          )}
        </div>
      </button>

      {/* Helper label */}
      {!isCompact ? (
        <p className="text-[12px] text-slate-400">
          {isLoading ? 'Wird hochgeladen…' : 'Tippen zum Ändern'}
        </p>
      ) : null}

      {/* Hidden file input — fallback for web + native video/mixed paths. */}
      <input {...inputProps} />

      {/* Feedback (suppressed in compact mode — host renders its own) */}
      {!isCompact && error ? (
        <InlineFeedback error={error} onDismiss={clearError} className="w-full max-w-[280px]" />
      ) : !isCompact && successMsg ? (
        <InlineFeedback
          success={successMsg}
          onDismiss={() => setSuccessMsg(null)}
          className="w-full max-w-[280px]"
        />
      ) : null}
    </div>
  )
}
