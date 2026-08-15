import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { User, Hammer } from 'lucide-react'
import AppShell from '../components/AppShell'
import { getCurrentUser, signOut } from '../lib/auth'
import { setMyRole, clearMyCraftsmanRole, type Role } from '../lib/profile'
import { refreshSession, applyRoleToSession } from '../lib/session'

function getErrorMessage(error: unknown): string {
  if (error instanceof Error) return error.message
  return 'Speichern fehlgeschlagen'
}

export default function RoleSelectionScreen() {
  const navigate = useNavigate()

  const [saving, setSaving] = useState<Role | null>(null)
  const [error, setError] = useState<string | null>(null)

  const choose = async (role: Role) => {
    setError(null)
    setSaving(role)

    try {
      const user = await getCurrentUser()

      if (!user) {
        navigate('/login', { replace: true })
        return
      }

      await setMyRole(role)

      if (role === 'customer') {
        await clearMyCraftsmanRole()
        applyRoleToSession('customer', null)
        void refreshSession()
        navigate('/gate', { replace: true })
        return
      }

      applyRoleToSession('craftsman', null)
      void refreshSession()
      navigate('/onboarding/craftsman-role', { replace: true })
    } catch (error) {
      setError(getErrorMessage(error))
    } finally {
      setSaving(null)
    }
  }

  const cardBase =
    'w-full text-left bg-surface rounded-container ring-1 ring-edge p-5 flex items-center gap-4 transition active:scale-[0.99]'
  const shadow = 'shadow-elevated'
  const disabled = 'opacity-60 pointer-events-none'

  return (
    <AppShell hideBottomNav>
      <section className="px-4 py-6">
        <div className="mx-auto w-full max-w-[420px]">
          <div className="flex flex-col items-center text-center">
            <div className="h-16 w-16 rounded-card bg-brand shadow-elevated flex items-center justify-center">
              <span className="text-white text-2xl font-extrabold">F</span>
            </div>

            <h1 className="mt-4 text-[22px] font-semibold text-ink">
              Willkommen bei SaFix
            </h1>
            <p className="mt-1 text-[14px] text-ink-muted">
              Wie möchtest du die App nutzen?
            </p>

            {error ? <p className="mt-3 text-xs text-red-600">{error}</p> : null}
          </div>

          <div className="mt-6 space-y-4">
            <button
              type="button"
              onClick={() => choose('customer')}
              disabled={!!saving}
              className={[cardBase, shadow, saving ? disabled : ''].join(' ')}
            >
              <div className="h-12 w-12 rounded-card bg-brand/10 flex items-center justify-center">
                <User size={22} className="text-brand" aria-hidden />
              </div>
              <div className="min-w-0">
                <div className="text-[16px] font-semibold text-ink">Ich bin Kunde</div>
                <div className="mt-0.5 text-[13px] text-ink-muted">
                  Handwerker suchen &amp; beauftragen
                </div>
              </div>
            </button>

            <button
              type="button"
              onClick={() => choose('craftsman')}
              disabled={!!saving}
              className={[cardBase, shadow, saving ? disabled : ''].join(' ')}
            >
              <div className="h-12 w-12 rounded-card bg-brand/10 flex items-center justify-center">
                <Hammer size={22} className="text-brand" aria-hidden />
              </div>
              <div className="min-w-0">
                <div className="text-[16px] font-semibold text-ink">Ich bin Handwerker</div>
                <div className="mt-0.5 text-[13px] text-ink-muted">
                  Aufträge finden &amp; Profil verwalten
                </div>
              </div>
            </button>
          </div>

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
