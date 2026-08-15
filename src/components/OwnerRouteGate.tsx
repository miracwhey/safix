import { useEffect, type ReactNode } from 'react'
import { Navigate } from 'react-router-dom'
import { useSession } from '../hooks/useSession'
import { useCraftsmanProfileReady } from '../hooks/useCraftsmanProfileReady'
import { ensureOwnerJoinCodeOnce } from '../lib/company/joinCode'
import { signOut } from '../lib/auth'
import ScreenSkeleton from './system/ScreenSkeleton'

type Props = { children: ReactNode }

/**
 * Route guard that allows only craftsman users with `craftsmanRole === 'owner'`
 * to access owner-only operational screens (dashboard, schedule, finance, etc.).
 *
 * Workers are redirected to their home screen at `/worker`.
 * Unauthenticated / unresolved users are redirected to `/gate`.
 * Owners whose business profile is incomplete are redirected to
 * `/onboarding/craftsman-profile` to complete onboarding.
 * Owners whose profile readiness check fails (network or query error) are
 * shown a retryable error screen instead of being routed to onboarding.
 *
 * Company join code self-heal:
 *   Once owner context and profile readiness are both confirmed, this gate
 *   fires ensureOwnerJoinCodeOnce() — a fire-and-forget call that generates
 *   a join code for the owner's company if one does not exist yet.
 *   This covers existing owners who completed onboarding before this
 *   migration was applied (their team_members row was backfilled by the
 *   migration; their join code is generated lazily here).
 *   The call is session-scoped (module-level flag) and does not affect rendering.
 */
export default function OwnerRouteGate({ children }: Props) {
  const { user, role, craftsmanRole, loading, sessionValidated } = useSession()

  // Only check profile readiness for confirmed owners; pass `enabled = false`
  // for any other state so the hook skips the async fetch entirely.
  const isConfirmedOwner =
    !loading && sessionValidated && !!user && role === 'craftsman' && craftsmanRole === 'owner'

  const [profileReadyState, retryProfileCheck] = useCraftsmanProfileReady(isConfirmedOwner)

  // Fire-and-forget join code self-heal.
  // Runs once per session via the module-level flag in ensureOwnerJoinCodeOnce.
  // Only triggers when owner context + profile readiness are both confirmed,
  // so this never fires during loading, onboarding, or for non-owner users.
  const isOwnerReady = isConfirmedOwner && profileReadyState === 'ready'
  useEffect(() => {
    if (!isOwnerReady) return
    ensureOwnerJoinCodeOnce()
  }, [isOwnerReady])

  if (loading && !sessionValidated) return <ScreenSkeleton />

  if (!user || !sessionValidated || role !== 'craftsman') {
    return <Navigate to="/gate" replace />
  }

  if (craftsmanRole === 'worker') {
    return <Navigate to="/worker" replace />
  }

  if (craftsmanRole === null) {
    return <Navigate to="/onboarding/craftsman-role" replace />
  }

  // At this point craftsmanRole === 'owner'; wait for profile readiness check.
  if (profileReadyState === 'loading') {
    return <ScreenSkeleton />
  }

  if (profileReadyState === 'error') {
    return (
      <div className="flex min-h-screen flex-col items-center justify-center bg-white px-6 text-center">
        <div className="max-w-sm">
          <div className="mb-4 text-4xl">⚠️</div>
          <h1 className="mb-2 text-xl font-semibold text-slate-800">
            Profil konnte nicht geladen werden
          </h1>
          <p className="mb-6 text-sm text-slate-500">
            Bitte prüfe deine Internetverbindung und versuche es erneut.
          </p>
          <button
            onClick={retryProfileCheck}
            className="rounded-lg bg-slate-900 px-5 py-2.5 text-sm font-medium text-white hover:bg-slate-700"
          >
            Erneut versuchen
          </button>
          <button
            onClick={() => void signOut()}
            className="mt-3 text-[13px] text-slate-400 hover:text-slate-600 transition"
          >
            Abmelden
          </button>
        </div>
      </div>
    )
  }

  if (profileReadyState === 'incomplete') {
    return <Navigate to="/onboarding/craftsman-profile" replace />
  }

  return <>{children}</>
}
