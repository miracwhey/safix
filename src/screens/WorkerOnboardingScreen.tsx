import { useCallback, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import AppShell from '../components/AppShell'
import { useSession } from '../hooks/useSession'
import { joinCompanyWithCode } from '../lib/company/joinCode'
import { invalidateWorkerMembershipCache } from '../hooks/useWorkerMembership'
import { useAsyncAction } from '../hooks/useAsyncAction'
import { signOut } from '../lib/auth'

/**
 * Worker join-code entry screen.
 *
 * Shown at /onboarding/worker when:
 *   a) worker has just chosen the worker role (first onboarding)
 *   b) worker has craftsman_role='worker' but no active team_members row
 *      (existing account, or aborted previous onboarding)
 *
 * Design decisions:
 *   - AppShell hideBottomNav: a worker without company membership must not
 *     see the worker navigation tabs. BottomNav uses resolveAppContext which
 *     would render the 5-tab worker shell for craftsmanRole='worker' — that
 *     is wrong before membership is established.
 *   - No skip button: the worker must enter a valid code to proceed.
 *     EmployeeRouteGate will redirect back here if /worker is accessed
 *     without an active membership.
 *   - Code normalization: input is forced uppercase, non-charset chars
 *     are stripped. RPC also normalizes server-side (defense-in-depth).
 */
export default function WorkerOnboardingScreen() {
  const navigate = useNavigate()
  const { user } = useSession()
  const [code, setCode] = useState('')

  const submitAction = useCallback(async () => {
    if (!user) throw new Error('Nicht angemeldet')

    // Best-effort full name from user metadata; fallback to email prefix
    const fullName =
      (user.user_metadata?.full_name as string | undefined)?.trim() ||
      (user.user_metadata?.name as string | undefined)?.trim() ||
      user.email?.split('@')[0] ||
      'Mitarbeiter'

    const result = await joinCompanyWithCode(code, fullName)

    if (!result.ok) throw new Error(result.error)

    // Invalidate gate cache so EmployeeRouteGate re-reads the new membership
    invalidateWorkerMembershipCache()

    navigate('/worker', { replace: true })
  }, [code, user, navigate])

  const { execute, isLoading, error } = useAsyncAction(submitAction)

  const isValid = code.trim().length === 6

  return (
    <AppShell hideBottomNav>
      <section className="px-4 py-6">
        <div className="mx-auto w-full max-w-[420px]">
          <div className="flex flex-col items-center text-center">
            <div className="h-16 w-16 rounded-[18px] bg-[#E6F0FF] flex items-center justify-center">
              <span className="text-[28px]">🔑</span>
            </div>

            <h1 className="mt-4 text-[22px] font-semibold text-slate-900">
              Betrieb beitreten
            </h1>
            <p className="mt-2 text-[14px] leading-relaxed text-slate-500">
              Gib den 6-stelligen Code ein, den dir dein Betriebsinhaber gegeben hat.
            </p>
          </div>

          {error ? (
            <div className="mt-4 rounded-xl bg-red-50 px-4 py-3 ring-1 ring-red-200">
              <p className="text-[13px] font-semibold text-red-700">Beitritt fehlgeschlagen</p>
              <p className="mt-0.5 text-xs text-red-600">{error}</p>
            </div>
          ) : null}

          <div className="mt-6">
            <label
              htmlFor="join-code-input"
              className="mb-1.5 block text-[13px] font-semibold text-slate-700"
            >
              Einladungscode
            </label>
            <input
              id="join-code-input"
              type="text"
              inputMode="text"
              autoCapitalize="characters"
              autoComplete="off"
              autoCorrect="off"
              spellCheck={false}
              placeholder="z. B. AB3X7K"
              value={code}
              onChange={(e) =>
                setCode(
                  e.target.value
                    .toUpperCase()
                    .replace(/[^ABCDEFGHJKLMNPQRSTUVWXYZ23456789]/g, '')
                    .slice(0, 6),
                )
              }
              className="w-full rounded-2xl bg-white px-4 py-3.5 text-[22px] font-mono font-bold tracking-[0.3em] text-center text-slate-900 placeholder:text-slate-300 placeholder:font-normal placeholder:text-[15px] placeholder:tracking-normal ring-1 ring-slate-200/70 shadow-[0_4px_12px_-8px_rgba(2,6,23,0.08)] focus:outline-none focus:ring-2 focus:ring-[#2563EB]"
              maxLength={6}
            />
          </div>

          <button
            type="button"
            onClick={execute}
            disabled={!isValid || isLoading}
            className="mt-6 w-full rounded-full bg-[#2563EB] py-3.5 text-[15px] font-semibold text-white shadow-[0_12px_28px_-18px_rgba(37,99,235,0.7)] transition disabled:opacity-50 disabled:pointer-events-none"
          >
            {isLoading ? 'Wird geprüft …' : 'Betrieb beitreten'}
          </button>

          <button
            type="button"
            onClick={() => void signOut()}
            className="mt-4 w-full py-2 text-[13px] text-slate-400 hover:text-slate-600 transition"
          >
            Abmelden
          </button>
        </div>
      </section>
    </AppShell>
  )
}
