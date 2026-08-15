import { useEffect, useState } from 'react'
import { EyeOff } from 'lucide-react'
import Spinner from '../system/Spinner'
import {
  getMyProviderProfile,
  setProviderVisibility,
} from '../../lib/providers/providerProfileService'
import { logError } from '../../lib/observability'

/**
 * Surfaces a loud, self-service warning when the craftsman's own profile is
 * hidden from public discovery (`providers.is_public = false`).
 *
 * Why this exists: a hidden craftsman still sees their OWN reels + profile
 * (owner-read RLS), so the invisibility is silent — they have no signal that
 * nobody else can see their uploads. The review-demo seed (and any admin/
 * moderation action) can flip `is_public` to false; without this banner the
 * only recovery was a full profile re-save with no hint that it was needed.
 *
 * Renders nothing while loading, on error, or when the profile is public —
 * so it is invisible in the happy path.
 */
export default function ProfileVisibilityBanner() {
  const [hidden, setHidden] = useState(false)
  const [publishing, setPublishing] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    getMyProviderProfile()
      .then((profile) => {
        if (cancelled || !profile) return
        setHidden(profile.isPublic === false)
      })
      .catch((err) => {
        logError('ui.visibility_banner.load_failed', err, {})
      })
    return () => {
      cancelled = true
    }
  }, [])

  if (!hidden) return null

  async function handlePublish() {
    if (publishing) return
    setError(null)
    setPublishing(true)
    try {
      await setProviderVisibility(true)
      setHidden(false)
    } catch (err) {
      logError('ui.visibility_banner.publish_failed', err, {})
      setError(
        err instanceof Error
          ? err.message
          : 'Sichtbarkeit konnte nicht geändert werden.',
      )
    } finally {
      setPublishing(false)
    }
  }

  return (
    <div className="rounded-2xl bg-danger/8 px-4 py-3.5 ring-1 ring-danger/25">
      <div className="flex items-start gap-3">
        <span
          className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-danger/12 text-danger"
          aria-hidden
        >
          <EyeOff size={18} />
        </span>
        <div className="min-w-0 flex-1">
          <p className="text-[14px] font-semibold text-ink">Dein Profil ist versteckt</p>
          <p className="mt-0.5 text-[12.5px] leading-snug text-ink-muted">
            Niemand außer dir sieht aktuell deine Reels und dein Profil. Mach dich
            sichtbar, damit Kunden dich finden.
          </p>
          {error && <p className="mt-1.5 text-[12px] text-danger">{error}</p>}
          <button
            type="button"
            onClick={handlePublish}
            disabled={publishing}
            className="mt-2.5 inline-flex h-9 items-center gap-1.5 rounded-full bg-brand px-4 text-[13px] font-semibold text-white transition active:scale-[0.97] disabled:opacity-50"
          >
            {publishing && <Spinner size="sm" tone="onDark" inButton />}
            {publishing ? 'Wird sichtbar gemacht …' : 'Jetzt sichtbar machen'}
          </button>
        </div>
      </div>
    </div>
  )
}
