import { useState } from 'react'
import { Navigate } from 'react-router-dom'
import { useSession } from '../hooks/useSession'
import { useCraftsmanProfileReady } from '../hooks/useCraftsmanProfileReady'
import { resolveAppContext } from '../lib/access'
import CustomerHomeScreen from '../screens/CustomerHomeScreen'
import { refreshSession } from '../lib/session'
import { signOut } from '../lib/auth'
import { recordOnboardingRedirect } from '../lib/onboardingLoopDetector'
import ScreenSkeleton from './system/ScreenSkeleton'
import ScreenError from './system/ScreenError'

export default function HomeGate() {
  const [isRetrying, setIsRetrying] = useState(false)
  const session = useSession()
  const { user, role, craftsmanRole, loading, error, errorKind, sessionValidated, tosAcceptedAt } = session
  const context = resolveAppContext(session)

  async function handleRetry() {
    if (isRetrying) return
    setIsRetrying(true)
    try {
      await refreshSession()
    } finally {
      setIsRetrying(false)
    }
  }

  // Profile readiness check is only relevant for confirmed owners.
  // Passing context === 'owner' ensures the async check is skipped until
  // the session is validated and the actor is fully resolved.
  const [profileReadyState, retryProfileCheck] = useCraftsmanProfileReady(context === 'owner' && !!tosAcceptedAt)

  if (loading && !sessionValidated) {
    return <ScreenSkeleton />
  }

  if (error && (errorKind === 'network_error' || errorKind === 'profile_create_failed' || errorKind === 'profile_load_failed' || errorKind === 'profile_schema_mismatch' || errorKind === 'unknown_error')) {
    const subtitle =
      errorKind === 'profile_create_failed'
        ? 'Dein Profil konnte nicht erstellt werden. Bitte versuche es erneut.'
        : errorKind === 'profile_load_failed'
          ? 'Dein Profil konnte nicht geladen werden. Bitte versuche es erneut.'
          : 'Bitte prüfe deine Internetverbindung und versuche es erneut.'

    return (
      <ScreenError
        title="Sitzung konnte nicht geladen werden"
        description={subtitle}
        onRetry={handleRetry}
        retrying={isRetrying}
        onLogout={() => void signOut()}
      />
    )
  }

  // Unauthenticated or session not yet validated by the server — redirect
  // to the login screen.  Cached user data must never drive post-auth
  // routing before server validation completes.
  if (!user || !sessionValidated) {
    return <Navigate to="/login" replace />
  }

  // Deterministic context routing — single resolver, no inline role checks.
  if (context === 'customer') {
    return <CustomerHomeScreen />
  }

  if (context === 'owner') {
    if (profileReadyState === 'loading') {
      return <ScreenSkeleton />
    }
    if (profileReadyState === 'error') {
      return (
        <ScreenError
          title="Profil konnte nicht geladen werden"
          onRetry={retryProfileCheck}
        />
      )
    }
    if (profileReadyState === 'incomplete') {
      if (recordOnboardingRedirect()) {
        return (
          <ScreenError
            title="Navigation hängt"
            description="Der Onboarding-Schritt konnte nicht abgeschlossen werden. Bitte abmelden und erneut anmelden."
            onLogout={() => void signOut()}
          />
        )
      }
      return <Navigate to="/onboarding/craftsman-profile" replace />
    }
    return <Navigate to="/craftsman/dashboard" replace />
  }

  if (context === 'employee') {
    return <Navigate to="/worker" replace />
  }

  // context === 'unknown': session validated but role data is incomplete —
  // route to onboarding.  Distinguish which piece is missing for the correct
  // onboarding step.
  if (role == null) return <Navigate to="/onboarding/role" replace />
  if (craftsmanRole == null) return <Navigate to="/onboarding/craftsman-role" replace />

  // Unreachable — all known-unknown cases are covered above.
  return <Navigate to="/onboarding/role" replace />
}
