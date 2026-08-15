import { type ReactNode, useEffect, useState } from 'react'
import { Navigate } from 'react-router-dom'
import { useSession } from '../hooks/useSession'
import { useWorkerMembership } from '../hooks/useWorkerMembership'
import { signOut } from '../lib/auth'
import ScreenSkeleton from './system/ScreenSkeleton'

const MEMBERSHIP_TIMEOUT_MS = 20_000

type Props = { children: ReactNode }

/**
 * Route guard for employee-only screens (/worker/*).
 *
 * Two-layer check:
 *   1. profiles.craftsman_role === 'worker' — onboarding flow signal (routing)
 *   2. Active team_members row (profile_id = user.id) — primary membership truth
 *
 * A worker who has chosen the worker role but has not yet joined a company
 * is routed to /onboarding/worker (join code screen), not given worker access.
 * This ensures craftsman_role='worker' alone is never sufficient for /worker/*.
 *
 * Role truth model:
 *   - profiles.craftsman_role is the onboarding/compat signal.
 *   - team_members membership is the primary company-internal truth.
 *   - Both must be satisfied for worker operational access.
 */
export default function EmployeeRouteGate({ children }: Props) {
  const { user, role, craftsmanRole, loading, sessionValidated } = useSession()

  // Only run the membership check once the session is confirmed as a worker.
  // Mirrors the OwnerRouteGate pattern for useCraftsmanProfileReady.
  const isConfirmedWorker =
    !loading &&
    sessionValidated &&
    !!user &&
    role === 'craftsman' &&
    craftsmanRole === 'worker'

  const [membershipState, retryMembership] = useWorkerMembership(
    isConfirmedWorker ? (user?.id ?? null) : null,
    isConfirmedWorker,
  )

  const [membershipTimedOut, setMembershipTimedOut] = useState(false)
  const [membershipRetryEpoch, setMembershipRetryEpoch] = useState(0)

  useEffect(() => {
    if (membershipState !== 'loading') {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setMembershipTimedOut(false)
      return
    }
    const t = setTimeout(() => setMembershipTimedOut(true), MEMBERSHIP_TIMEOUT_MS)
    return () => clearTimeout(t)
  }, [membershipState, membershipRetryEpoch])

  function handleRetry() {
    setMembershipTimedOut(false)
    setMembershipRetryEpoch((n) => n + 1)
    retryMembership()
  }

  if (loading && !sessionValidated) return <ScreenSkeleton />

  if (!user || !sessionValidated || role !== 'craftsman') {
    return <Navigate to="/gate" replace />
  }

  if (craftsmanRole === 'owner') {
    return <Navigate to="/craftsman/dashboard" replace />
  }

  if (craftsmanRole === null) {
    return <Navigate to="/onboarding/craftsman-role" replace />
  }

  // craftsmanRole === 'worker': enforce membership check
  if (membershipState === 'loading' && !membershipTimedOut) {
    return <ScreenSkeleton />
  }

  if (membershipState === 'not_joined') {
    // Worker has chosen the worker role but has not joined a company yet.
    // Route to the join-code screen — this is the safe bounded incomplete state.
    return <Navigate to="/onboarding/worker" replace />
  }

  if (membershipTimedOut || membershipState === 'error') {
    return (
      <div className="flex min-h-screen flex-col items-center justify-center bg-white px-6 text-center">
        <div className="max-w-sm">
          <div className="mb-4 text-4xl">⚠️</div>
          <h1 className="mb-2 text-xl font-semibold text-slate-800">
            Betrieb konnte nicht geladen werden
          </h1>
          <p className="mb-6 text-sm text-slate-500">
            Bitte prüfe deine Internetverbindung und versuche es erneut.
          </p>
          <button
            onClick={handleRetry}
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

  // membershipState === 'joined'
  return <>{children}</>
}
