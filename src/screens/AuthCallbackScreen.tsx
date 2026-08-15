import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useSession } from '../hooks/useSession'
import AppShell from '../components/AppShell'
import Spinner from '../components/system/Spinner'

/**
 * Dedicated landing page for Supabase auth callbacks.
 *
 * Supabase email-confirmation and magic-link redirects land here.  The
 * Supabase client (with `detectSessionInUrl: true`) processes the URL
 * callback parameters automatically and fires `onAuthStateChange` once the
 * session is established.  This screen waits for that process to finish
 * and then redirects to the appropriate next page.
 *
 * Routes:
 *   - Authenticated + role → /gate (RoleGate routes to the correct home)
 *   - Authenticated + no role → /onboarding/role
 *   - No session after timeout → /login (callback was invalid/expired)
 */
export default function AuthCallbackScreen() {
  const navigate = useNavigate()
  const { user, role, loading, sessionValidated } = useSession()
  const [showFallback, setShowFallback] = useState(false)

  useEffect(() => {
    if (loading) return

    // Only route after the session has been validated by the server via
    // getUser().  A cached-but-unvalidated user from localStorage must NOT
    // trigger routing — the gates would bounce the user back to /login
    // because they check `sessionValidated`.
    if (user && sessionValidated) {
      if (role == null) {
        navigate('/onboarding/role', { replace: true })
      } else {
        navigate('/gate', { replace: true })
      }
      return
    }

    // No validated user and not loading — callback was invalid/expired or
    // session could not be established.  Fall back to login cleanly.
    if (!user) {
      navigate('/login', { replace: true })
    }
  }, [user, role, loading, sessionValidated, navigate])

  // Show a manual fallback link after 5 seconds if still loading.
  useEffect(() => {
    const fallbackTimer = setTimeout(() => setShowFallback(true), 5_000)
    return () => clearTimeout(fallbackTimer)
  }, [])

  // Safety timeout: if we're stuck loading for >25 seconds, route to /login.
  // 25 s covers native cold-start token exchange + resync on slow mobile networks.
  useEffect(() => {
    const timer = setTimeout(() => {
      navigate('/login', { replace: true })
    }, 25_000)
    return () => clearTimeout(timer)
  }, [navigate])

  return (
    <AppShell hideBottomNav>
      <div className="flex min-h-[calc(100svh-env(safe-area-inset-top,0px))] items-center justify-center px-4">
        <div className="w-full max-w-[320px] rounded-[24px] bg-white p-6 text-center shadow-[0_18px_40px_-28px_rgba(2,6,23,0.28)] ring-1 ring-slate-200/70">
        {/* Spinner */}
        <div className="mb-4 flex justify-center">
          <Spinner size="lg" tone="brand" />
        </div>

        <p className="text-[14px] font-medium text-slate-700">
          Anmeldung wird verarbeitet…
        </p>
        <p className="mt-1 text-[12px] text-slate-400">
          Du wirst gleich weitergeleitet.
        </p>

        {showFallback && (
          <button
            onClick={() => navigate('/login', { replace: true })}
            className="mt-4 text-[13px] font-medium text-blue-600 underline underline-offset-2"
          >
            Zurück zum Login
          </button>
        )}
        </div>
      </div>
    </AppShell>
  )
}
