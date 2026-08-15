import { useCallback, useRef } from 'react'
import { useNavigate } from 'react-router-dom'
import type { CustomerContext } from '../../lib/customer/customerContextStore'
import type { CustomerSetupViewModel } from '../../lib/customer/customerSetupSelectors'
import { uploadCustomerAvatar } from '../../lib/customer/customerAvatarService'
import { useSession } from '../../hooks/useSession'
import { useMediaPicker } from '../../lib/native/useMediaPicker'
import { useAsyncAction } from '../../hooks/useAsyncAction'
import InlineFeedback from '../system/InlineFeedback'
import Spinner from '../system/Spinner'
import Avatar from '../messages/Avatar'

type Props = {
  context: CustomerContext
  setup: CustomerSetupViewModel
}

/**
 * Identity header for the customer Konto: avatar (tap to choose/take a photo)
 * + display name + city.
 *
 * Name/city are a PROJECTION of the canonical personal-data record
 * (customer_billing_profiles) — editing happens in the "Persönliche Daten" form
 * (`/account/billing-profile`), never in an in-memory store.
 *
 * Avatar upload mirrors the proven provider `AvatarUpload` primitives:
 * `useMediaPicker` (native Camera prompt "Mediathek / Aufnehmen", with the
 * required hidden `<input>` for web + the iOS system-picker fallback),
 * `useAsyncAction` for loading + surfaced errors, and `InlineFeedback` so a
 * failed upload is never silent. On success `uploadCustomerAvatar` write-throughs
 * the projection, so the avatar updates without a reload.
 */
export default function CustomerContextCard({ context, setup }: Props) {
  const { user } = useSession()
  const userId = user?.id
  const navigate = useNavigate()
  const { pickMedia, inputProps } = useMediaPicker()
  const pickedFileRef = useRef<File | null>(null)

  const uploadAction = useCallback(async () => {
    const file = pickedFileRef.current
    pickedFileRef.current = null
    if (!file || !userId) return
    await uploadCustomerAvatar(file, userId)
  }, [userId])

  const { execute, isLoading, error, clearError } = useAsyncAction(uploadAction)

  const handleAvatarTap = useCallback(async () => {
    if (isLoading || !userId) return
    clearError()
    const file = await pickMedia({ kind: 'image' })
    if (!file) return
    pickedFileRef.current = file
    void execute()
  }, [isLoading, userId, clearError, pickMedia, execute])

  const hasName = Boolean(context.displayName)
  const hasCity = Boolean(context.city)
  const goToPersonalData = () => navigate('/account/billing-profile')

  return (
    <div className="rounded-container bg-surface p-4 ring-1 ring-edge shadow-elevated">
      <div className="flex items-center gap-3">
        {/* Avatar — tap to choose from library or take a photo */}
        <button
          type="button"
          aria-label="Profilbild auswählen oder aufnehmen"
          onClick={handleAvatarTap}
          disabled={isLoading}
          className="relative shrink-0 rounded-full focus:outline-none focus-visible:ring-2 focus-visible:ring-brand focus-visible:ring-offset-2"
        >
          <Avatar
            src={context.avatarUrl}
            name={context.displayName || 'K'}
            size="lg"
            className={isLoading ? 'opacity-50' : ''}
          />
          <span className="absolute bottom-0 right-0 flex h-5 w-5 items-center justify-center rounded-full bg-brand text-white ring-2 ring-surface">
            {isLoading ? (
              <Spinner size="sm" tone="onDark" />
            ) : (
              <span className="text-[12px] leading-none">+</span>
            )}
          </span>
        </button>

        {/* Name + city — tap to edit personal data */}
        <button type="button" onClick={goToPersonalData} className="min-w-0 flex-1 text-left">
          <div className="truncate text-[15px] font-semibold text-ink">
            {hasName ? context.displayName : 'Name hinzufügen'}
          </div>
          <div className="mt-0.5 text-[13px] text-ink-muted">
            {hasCity ? context.city : 'Persönliche Daten ergänzen'}
          </div>
        </button>

        {setup.isComplete ? (
          <span className="shrink-0 text-[12px] font-semibold text-ok">Vollständig</span>
        ) : (
          <button
            type="button"
            onClick={goToPersonalData}
            className="shrink-0 rounded-chip bg-brand/10 px-2.5 py-1 text-[11px] font-semibold text-brand"
          >
            Ausfüllen
          </button>
        )}
      </div>

      {/* Hidden picker input — required by useMediaPicker for the web path and
          the iOS system-picker fallback if the native Camera plugin is absent. */}
      <input {...inputProps} />

      {error ? <InlineFeedback error={error} onDismiss={clearError} className="mt-3" /> : null}
    </div>
  )
}
