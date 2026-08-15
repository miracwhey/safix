import { useState } from 'react'
import { Navigate } from 'react-router-dom'
import { useSession } from '../hooks/useSession'
import { refreshSession } from '../lib/session'
import { signOut } from '../lib/auth'
import { resolveAppContext } from '../lib/access'
import { recordOnboardingRedirect } from '../lib/onboardingLoopDetector'
import ScreenSkeleton from './system/ScreenSkeleton'
import ScreenError from './system/ScreenError'

export default function RoleGate() {
  const [isRetrying, setIsRetrying] = useState(false)
  const session = useSession()
  const { user, role, craftsmanRole, loading, error, errorKind, sessionValidated } = session

  async function handleRetry() {
    if (isRetrying) return
    setIsRetrying(true)
    try {
      await refreshSession()
    } finally {
      setIsRetrying(false)
    }
  }

  if (loading && !sessionValidated) return <ScreenSkeleton />

  if (error && (errorKind === 'network_error' || errorKind === 'profile_create_failed' || errorKind === 'profile_load_failed' || errorKind === 'profile_schema_mismatch' || errorKind === 'unknown_error')) {
    return (
      <div className="px-4 py-10 text-center">
        <p className="mb-4 text-sm text-red-600">{error}</p>
        <button
          onClick={() => void handleRetry()}
          disabled={isRetrying}
          className="rounded-lg bg-slate-900 px-5 py-2.5 text-sm font-medium text-white hover:bg-slate-700 disabled:opacity-60"
        >
          {isRetrying ? 'Wird geladen…' : 'Erneut versuchen'}
        </button>
        <button
          onClick={() => void signOut()}
          className="mt-3 text-[13px] text-slate-400 hover:text-slate-600 transition"
        >
          Abmelden
        </button>
      </div>
    )
  }

  // Redirect to login when there is no user OR when the session has not been
  // validated by the server.  Cached user data alone must never allow access
  // to the role-selection flow.
  if (!user || !sessionValidated) return <Navigate to="/login" replace />

  // Onboarding gates: incomplete role state must be resolved before context
  // routing.  resolveAppContext returns 'unknown' for these cases, but the
  // specific redirect target depends on which piece is missing.
  if (role == null) {
    if (recordOnboardingRedirect()) {
      return (
        <ScreenError
          title="Navigation hängt"
          description="Die Rollenauswahl konnte nicht abgeschlossen werden. Bitte abmelden und erneut anmelden."
          onLogout={() => void signOut()}
        />
      )
    }
    return <Navigate to="/onboarding/role" replace />
  }
  if (craftsmanRole == null && role === 'craftsman') {
    if (recordOnboardingRedirect()) {
      return (
        <ScreenError
          title="Navigation hängt"
          description="Die Rollenauswahl konnte nicht abgeschlossen werden. Bitte abmelden und erneut anmelden."
          onLogout={() => void signOut()}
        />
      )
    }
    return <Navigate to="/onboarding/craftsman-role" replace />
  }

  // Deterministic context routing — single resolver, no inline role checks.
  const context = resolveAppContext(session)
  if (context === 'customer') return <Navigate to="/" replace />
  if (context === 'owner') return <Navigate to="/" replace />
  if (context === 'employee') return <Navigate to="/worker" replace />

  // Should not be reachable given the guards above; redirect to onboarding
  // as the safest fallback rather than rendering nothing.
  return <Navigate to="/onboarding/role" replace />
}
